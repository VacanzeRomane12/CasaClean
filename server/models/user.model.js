const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const { normalizePhone, isValidPhone, PHONE_ERROR_MESSAGE } = require('../utils/phone.util');
const { normalizePersonalId, isValidPersonalId, PERSONAL_ID_ERROR_MESSAGE } = require('../utils/personalId.util');

// How long an email-verification link stays valid (in hours).
const VERIFICATION_TOKEN_TTL_HOURS = 24;

// How long a password-reset link stays valid (in minutes). Deliberately much
// shorter than the verification window — a reset link is a live credential.
const PASSWORD_RESET_TTL_MINUTES = 30;

// Signin lockout: after this many consecutive failed password attempts the
// account is locked for LOCK_TIME_MINUTES (on top of the per-IP rate limit,
// which a distributed credential-stuffing run can sidestep).
const MAX_LOGIN_ATTEMPTS = 10;
const LOCK_TIME_MINUTES = 15;

const userSchema = new mongoose.Schema({
    fullname: {
        type: String,
        required: [true, "Fullname is required!"]
    },
    email: {
        type: String,
        required: [true, "Email is required!"],
        unique: true,
        lowercase: true,                 // normalise so logins are case-insensitive
        trim: true
    },
    // Optional on the ACCOUNT. Registration asks for an email and a password —
    // the two things signing in needs — and nothing else; a phone number is only
    // load-bearing when a crew has to reach someone at a door, so it is required
    // at BOOKING time instead (booking.service.js / booking.controller.js, which
    // fall back to this field and refuse the booking when it is empty too).
    //
    // The setter is what keeps that optionality safe: it normalises the number
    // to international form and turns a blank into `undefined`, so the field is
    // absent rather than "" and the sparse unique index below skips it. Without
    // it the second phone-less signup would collide on "" (E11000).
    phone: {
        type: String,
        trim: true,
        set: (value) => {
            const normalized = normalizePhone(value);
            return normalized === "" ? undefined : normalized;
        },
        validate: {
            validator: (value) => value == null || isValidPhone(value),
            message: PHONE_ERROR_MESSAGE
        },
        // sparse: Google users are created without a phone, and so is anyone who
        // skips the field at signup. A non-sparse unique index puts every one of
        // those documents into the index as null, so the SECOND such account
        // would collide and be unable to sign up.
        unique: true,
        sparse: true
    },
    // Personal identification number. Optional on the ACCOUNT, required on the
    // BOOKING — exactly the phone's posture: the booking draft falls back to this
    // field and refuses the booking when it is empty too. The setter normalises
    // and maps a blank to `undefined` so a cleared field is absent rather than
    // "". Deliberately NOT unique: nothing keys on it, and a unique index would
    // turn an admin typo into a lock-out for the next customer.
    personalId: {
        type: String,
        trim: true,
        set: (value) => {
            const normalized = normalizePersonalId(value);
            return normalized === "" ? undefined : normalized;
        },
        validate: {
            validator: (value) => value == null || isValidPersonalId(value),
            message: PERSONAL_ID_ERROR_MESSAGE
        }
    },
    password: {
        type: String,
        required: [function () { return this.provider === "local" }, "Password is required!"],
        minlength: [8, "Password must be at least 8 characters!"],
        select: false                    // never returned by default queries
    },
    role: {
        type: String,
        enum: ["user", "admin"],
        default: "user"
    },
    isVerified: {
        type: Boolean,
        default: false
    },
    // Only the SHA-256 *hash* of the verification token is stored. The raw token
    // travels in the email link, so even a DB leak can't be used to verify
    // accounts. select:false keeps it out of normal query results.
    verificationToken: {
        type: String,
        select: false
    },
    verificationTokenExpires: {
        type: Date,
        select: false
    },
    // Password reset — same hashed-token pattern as email verification: only
    // the SHA-256 hash is stored, the raw token lives in the emailed link.
    passwordResetToken: {
        type: String,
        select: false
    },
    passwordResetExpires: {
        type: Date,
        select: false
    },
    // Session revocation. The JWT carries this number as its `v` claim; the
    // protect middleware rejects tokens whose claim doesn't match the live
    // value. Incrementing it (on password change/reset) instantly invalidates
    // every outstanding session for the account.
    tokenVersion: {
        type: Number,
        default: 0,
        select: false
    },
    // Per-account signin throttling (complements the per-IP rate limiter).
    failedLoginAttempts: {
        type: Number,
        default: 0,
        select: false
    },
    lockUntil: {
        type: Date,
        select: false
    },
    googleId: {
        type: String,
        unique: true,
        sparse: true
    },
    provider: {
        type: String,
        enum: ["local", "google"],
        default: "local"
    },
    avatar: String,
    // --- Payments (Stripe) ------------------------------------------------------
    // The user's Stripe Customer id, created lazily on their first payment (see
    // ensureStripeCustomer). Saved cards and PaymentIntents are attached to it.
    // sparse+unique: most users won't have one until they pay, and null values
    // must not collide on the unique index.
    stripeCustomerId: {
        type: String,
        unique: true,
        sparse: true
    },
    // The card the user picked as their default for one-click future bookings.
    // A Stripe PaymentMethod id ("pm_..."); cleared if that card is removed.
    defaultPaymentMethodId: {
        type: String
    },
    // --- VAT / tax profile ------------------------------------------------------
    // Catalogue prices are VAT-exclusive and VAT is added on top. A business
    // whose VAT number Stripe has VERIFIED against VIES has none added (EU
    // reverse charge) — see utils/tax.util.js, which reads these three fields
    // and nothing else.
    //
    // All three are server-managed in the sense that matters: the customer may
    // set customerType/vatNumber, but `vatStatus` is only ever written from
    // Stripe's verification result, so claiming to be a business can never by
    // itself remove the VAT from a charge.
    customerType: {
        type: String,
        enum: ["individual", "business"],
        default: "individual"
    },
    // Stored uppercase and space-free ("IT01234567890") — the format Stripe and
    // VIES expect.
    vatNumber: {
        type: String,
        trim: true,
        uppercase: true,
        default: ""
    },
    // Mirrors Stripe's tax-ID verification state. Only "verified" grants the
    // reverse charge; "pending" (VIES has not answered yet) is charged VAT
    // normally, which is the safe direction to be wrong in.
    vatStatus: {
        type: String,
        enum: ["none", "pending", "verified", "unverified"],
        default: "none"
    },
    // The Stripe Tax ID object ("txi_...") backing the number above, so the
    // webhook can match Stripe's verification callback to this user and a
    // replaced number can have its predecessor deleted.
    stripeTaxIdId: {
        type: String
    },
    // Registered company name, kept alongside the personal name when the
    // customer is a business.
    companyName: {
        type: String,
        trim: true,
        default: ""
    }
}, {
    timestamps: true
});

// Hash the password before saving, but only when it actually changed
// (otherwise updates would re-hash an already-hashed value).
userSchema.pre('save', async function() {
    if(!this.isModified('password')) return;
    this.password = await bcrypt.hash(this.password, 12);
});

// Instance method to compare a plaintext candidate against the stored hash.
userSchema.methods.comparePassword = async function (candidate) {
    return await bcrypt.compare(candidate, this.password);
};

/**
 * Generate a one-time email-verification token.
 *
 * Returns the RAW token (to be embedded in the email link) while persisting
 * only its SHA-256 hash on the document, together with an expiry timestamp.
 * The caller is responsible for saving the document afterwards.
 *
 * @returns {string} the raw, un-hashed token for the verification URL
 */
userSchema.methods.createVerificationToken = function () {
    const rawToken = crypto.randomBytes(32).toString("hex");

    this.verificationToken = crypto
        .createHash("sha256")
        .update(rawToken)
        .digest("hex");

    this.verificationTokenExpires = Date.now() + VERIFICATION_TOKEN_TTL_HOURS * 60 * 60 * 1000;

    return rawToken;
};

/**
 * Generate a one-time password-reset token (same pattern as the verification
 * token: the raw value goes in the emailed link, only its hash is persisted).
 * The caller is responsible for saving the document afterwards.
 *
 * @returns {string} the raw, un-hashed token for the reset URL
 */
userSchema.methods.createPasswordResetToken = function () {
    const rawToken = crypto.randomBytes(32).toString("hex");

    this.passwordResetToken = crypto
        .createHash("sha256")
        .update(rawToken)
        .digest("hex");

    this.passwordResetExpires = Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000;

    return rawToken;
};

// --- Indexes ----------------------------------------------------------------
// The four unique constraints (email, phone, googleId, stripeCustomerId) are
// declared inline on their fields above; everything here backs a query that
// would otherwise scan the collection.
//
// Admin user list — the whole collection sorted newest-first. Without this the
// sort is done in memory over every user document and aborts past 32 MB.
userSchema.index({ createdAt: -1 });
// Admin booking alerts resolve "every account with role: admin" on every paid
// booking and every recurring cycle (services/bookingAlert.service.js).
userSchema.index({ role: 1 });
// Stripe's customer.tax_id.* webhooks find the user by the stored tax-id id.
// Sparse: only business accounts that submitted a VAT number ever have one.
userSchema.index({ stripeTaxIdId: 1 }, { sparse: true });
// Email verification and password reset look a user up by the SHA-256 hash of
// the token in the emailed link. Sparse: both fields are cleared once used, so
// the overwhelming majority of documents have neither.
userSchema.index({ verificationToken: 1 }, { sparse: true });
userSchema.index({ passwordResetToken: 1 }, { sparse: true });

const User = mongoose.model('User', userSchema);

module.exports = User;
module.exports.VERIFICATION_TOKEN_TTL_HOURS = VERIFICATION_TOKEN_TTL_HOURS;
module.exports.PASSWORD_RESET_TTL_MINUTES = PASSWORD_RESET_TTL_MINUTES;
module.exports.MAX_LOGIN_ATTEMPTS = MAX_LOGIN_ATTEMPTS;
module.exports.LOCK_TIME_MINUTES = LOCK_TIME_MINUTES;