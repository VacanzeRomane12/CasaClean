const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

const User = require("../models/user.model");
const {
    VERIFICATION_TOKEN_TTL_HOURS,
    PASSWORD_RESET_TTL_MINUTES,
    MAX_LOGIN_ATTEMPTS,
    LOCK_TIME_MINUTES
} = require("../models/user.model");
const Booking = require("../models/booking.model");
const Review = require("../models/review.model");
const Subscription = require("../models/subscription.model");
const { isProduction } = require("../utils/env.util");
const AppError = require("../utils/appError.util");
const catchAsync = require("../utils/catchAsync.util");
const sendEmail = require("../utils/email.util");
const { verificationEmail, passwordResetEmail } = require("../utils/emailTemplates.util");
// VAT registration goes through Stripe's (free) tax-id verification — see
// services/tax.service.js. Only a verified number removes VAT from a charge.
const {
    registerVatNumber,
    clearVatNumber,
    refreshVatStatus,
    normaliseVatNumber
} = require("../services/tax.service");
const { resolveTaxTreatment } = require("../utils/tax.util");

// Cost-12 hash of a random value, computed once at boot. signin compares
// against it when the email doesn't exist so both branches do the same bcrypt
// work (anti user-enumeration via timing). Never matches a real password.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString("hex"), 12);

// Auth-cookie lifetime in days. assertEnv() guarantees COOKIE_EXPIRES is a
// positive number at boot; the fallback only guards direct requires of this
// module outside the normal startup path. Coerced once — an unvalidated string
// in the maxAge arithmetic would yield NaN and an invalid cookie.
const COOKIE_TTL_DAYS = Number(process.env.COOKIE_EXPIRES) > 0 ? Number(process.env.COOKIE_EXPIRES) : 7;

/**
 * Issue a fresh verification token for a user, persist it and email the link.
 *
 * Shared by signup and the "resend" endpoint. If sending fails we roll back the
 * token fields so a stale, never-delivered token can't linger on the account.
 *
 * @param {import("mongoose").Document} user - a local (non-Google) user
 */
const sendVerificationEmail = async (user) => {
    // Raw token goes in the URL; only its hash is stored on the user.
    const rawToken = user.createVerificationToken();
    await user.save({ validateBeforeSave: false });

    // The link points at the API, which verifies then redirects to the client.
    const verificationUrl = `${process.env.SERVER_URL}/api/v1/auth/verify-email/${rawToken}`;

    const { subject, html, text } = verificationEmail({
        fullname: user.fullname,
        url: verificationUrl,
        expiresInHours: VERIFICATION_TOKEN_TTL_HOURS
    });

    try {
        await sendEmail({ email: user.email, subject, html, text });
    } catch (err) {
        // Undo the token so the user can cleanly request a new one later.
        user.verificationToken = undefined;
        user.verificationTokenExpires = undefined;
        await user.save({ validateBeforeSave: false });

        throw new AppError("We couldn't send the verification email. Please try again later.", 502);
    }
};

/**
 * Signs a JWT for a given user.
 * Only the user id and the session-revocation counter go into the payload.
 * Deliberately NO role claim: the protect middleware re-loads the user and
 * authorizes on the DB role, so a role in the token would only be a stale
 * value waiting to be misused. The `v` claim mirrors user.tokenVersion —
 * bumping the DB value invalidates every token minted before the bump.
 * Callers must load the user WITH tokenVersion (it's select:false) so a
 * post-change login doesn't mint an already-dead token.
 */
const signToken = (user) => {
    return jwt.sign({ id: user._id, v: user.tokenVersion ?? 0 }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN
    });
};

/**
 * Signs a JWT for the user and sets it as the secure http-only auth cookie.
 * Shared by signin (JSON response) and email verification (redirect response),
 * so both establish a session identically.
 *
 * `remember` controls cookie persistence: when true (default) we set a maxAge
 * so the session survives a browser restart; when false we omit it, making it a
 * session cookie the browser drops on close so the user isn't kept signed in.
 */
const setTokenCookie = (user, res, remember = true) => {
    const token = signToken(user);

    res.cookie("lt", token, {
        // Persistent cookie only when "Remember me" is checked; otherwise a
        // session cookie (no maxAge) that's cleared when the browser closes.
        ...(remember
            ? { maxAge: COOKIE_TTL_DAYS * 24 * 60 * 60 * 1000 }
            : {}),
        // isProduction is fail-secure (anything not explicitly a dev env is
        // treated as production — see utils/env.util.js). Cross-site cookies
        // must be SameSite=None AND Secure; SameSite=None alone would disable
        // the browser's CSRF protection, which is why every state-changing
        // request additionally requires the X-Requested-With header
        // (middlewares/csrf.middleware.js).
        sameSite: isProduction ? "None" : "Lax",
        httpOnly: true,        // not readable from JS -> mitigates XSS token theft
        secure: isProduction   // only sent over HTTPS in production
    });
};

/**
 * Sets the auth cookie and sends the signed-in JSON response.
 * Centralised so signup/signin/refresh all behave identically.
 */
const createSendToken = (user, res, statusCode = 200, remember = true) => {
    setTokenCookie(user, res, remember);

    // Never leak the password hash or the internal auth counters, even though
    // they're select:false by default (signin opts back in to read them).
    user.password = undefined;
    user.tokenVersion = undefined;
    user.failedLoginAttempts = undefined;
    user.lockUntil = undefined;

    res.status(statusCode).json({
        status: "success",
        message: "Successfully signed in!",
        data: { user }
    });
};

// POST /api/v1/auth/signup -> creates a new (unverified) user and emails a
// verification link. The account stays inactive until the link is clicked.
const signup = catchAsync(async (req, res, next) => {
    const { fullname, email, phone, password } = req.body;

    // One lookup covers both uniqueness checks (email OR phone) instead of two
    // sequential round-trips; the matched field decides which message to return.
    //
    // The phone clause is added only when there IS a number — the field is
    // optional now, and `{ phone: undefined }` is not a filter that matches
    // phone-less accounts: Mongoose drops undefined values, leaving an empty
    // `{}` inside the $or, which matches the first user in the collection and
    // would reject every signup as a duplicate.
    const existing = await User.findOne({ $or: phone ? [{ email }, { phone }] : [{ email }] })
        .select("email phone")
        .lean();

    if (existing) {
        // One generic message regardless of WHICH field collided — mirroring the
        // anti-enumeration posture of signin/resend, a signup probe mustn't
        // reveal whether a specific email or phone number is registered.
        // (The admin-only createUser below keeps per-field messages: that
        // endpoint sits behind protect + restrictTo("admin").)
        return next(new AppError("An account with that email or phone number already exists.", 400));
    }

    // Whitelist fields explicitly so a client can't inject role/isVerified.
    const user = await User.create({ fullname, email, password, ...(phone ? { phone } : {}) });

    // Generate + email the verification link (throws an AppError on send failure,
    // which catchAsync forwards to the global error handler).
    await sendVerificationEmail(user);

    res.status(201).json({
        status: "success",
        message: "Account created! Please check your email to verify your account."
    });
});

// POST /api/v1/auth/signin -> authenticates a user and issues a token
const signin = catchAsync(async (req, res, next) => {
    const { email, password, remember } = req.body;

    // Guard against missing credentials before hitting the DB.
    if (!email || !password) {
        return next(new AppError("Please provide email and password!", 400));
    }

    // password/lock fields are select:false on the schema, so opt back in.
    // tokenVersion is needed so the issued JWT carries the live `v` claim.
    const user = await User.findOne({ email })
        .select("+password +tokenVersion +failedLoginAttempts +lockUntil");

    // Per-ACCOUNT lockout (complements the per-IP signinLimiter, which a
    // distributed credential-stuffing run can sidestep). Still burn one bcrypt
    // compare so a locked account isn't distinguishable by response timing.
    const isLocked = user?.lockUntil && user.lockUntil > Date.now();
    if (isLocked) {
        await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    }

    // Constant-work comparison: ALWAYS run one bcrypt compare, even when the
    // email doesn't exist (against a dummy hash). Short-circuiting would make
    // "unknown email" measurably faster than "wrong password", letting an
    // attacker enumerate registered emails via response timing. (Google
    // accounts have no local password and take the dummy branch too.)
    let passwordMatches = false;
    if (!isLocked && user && user.password) {
      passwordMatches = await user.comparePassword(password);
    } else if (!isLocked) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    }

    // Use one generic message for both branches so we don't reveal whether
    // an email exists (prevents user enumeration).
    if (!user || !passwordMatches) {
        // Count the failure against the account and lock it after too many.
        // Atomic $inc (no read-modify-write race between parallel attempts);
        // fire-and-forget correctness isn't enough here, so we await it.
        if (user && !isLocked) {
            const attempts = (user.failedLoginAttempts || 0) + 1;
            await User.updateOne(
                { _id: user._id },
                attempts >= MAX_LOGIN_ATTEMPTS
                    ? {
                        $set: { lockUntil: new Date(Date.now() + LOCK_TIME_MINUTES * 60 * 1000), failedLoginAttempts: 0 }
                    }
                    : { $inc: { failedLoginAttempts: 1 } }
            );
        }
        return next(new AppError("Credentials are incorrect!", 401));
    }

    // Successful sign-in clears any accumulated failure state.
    if (user.failedLoginAttempts || user.lockUntil) {
        await User.updateOne(
            { _id: user._id },
            { $set: { failedLoginAttempts: 0 }, $unset: { lockUntil: "" } }
        );
    }

    // Block local accounts that haven't confirmed their email yet. (Google
    // users are created with isVerified:true, so they pass straight through.)
    if (!user.isVerified) {
        return next(new AppError("Please verify your email before signing in.", 403));
    }

    // Persist the session only when the user opted into "Remember me".
    createSendToken(user, res, 200, Boolean(remember));
});

// POST /api/v1/auth/logout -> clears the auth cookie
const logout = (req, res) => {
    // Overwrite the cookie with an already-expired one to remove it.
    res.cookie("lt", "", {
        maxAge: 0,
        httpOnly: true,
        sameSite: isProduction ? "None" : "Lax",
        secure: isProduction
    });

    res.status(200).json({
        status: "success",
        message: "Successfully logged out!"
    });
};

// GET /api/v1/auth/me -> returns the currently authenticated user
// (req.user is populated by the protect middleware)
//
// Also returns how this customer will be taxed on their next booking. It is
// DERIVED here rather than reimplemented on the client so the rule and the rate
// live in exactly one place: the booking wizard can then show a total that
// matches what it is about to charge, instead of quoting the catalogue price to
// an individual who will actually be billed that price plus VAT.
//
// It also reports whether the account has a local password (`hasPassword`).
// The client needs it to decide between "set a password" and "change your
// password", and to know whether deleting the account needs one — `provider`
// can't answer that any more, because a Google account may have added one.
// The hash itself is select:false and must never leave the server, so we ask
// the database for the ANSWER rather than for the value.
const getMe = catchAsync(async (req, res, next) => {
    const treatment = resolveTaxTreatment(req.user);

    const hasPassword = Boolean(await User.exists({
        _id: req.user._id,
        password: { $exists: true, $ne: null }
    }));

    res.status(200).json({
        status: "success",
        data: {
            // req.user is a lean object (see protect), so this is a plain copy
            // with one derived field added — no Mongoose document is exposed.
            user: { ...req.user, hasPassword },
            tax: {
                treatment: treatment.treatment,
                reverseCharge: treatment.treatment === 'reverse-charge',
                // The rate this customer is charged (0 under the reverse charge)
                // — what the client adds on top of the catalogue subtotal.
                vatRate: treatment.vatRate,
                // The configured rate, regardless of treatment. Lets the client
                // say "0% — reverse charge" instead of hiding the VAT line.
                catalogueVatRate: treatment.catalogueVatRate
            }
        }
    });
});

// GET /api/v1/auth/users -> list every account (admin only). The password hash
// is select:false on the schema, so it's never returned. Newest first, so the
// admin panel shows the most recent sign-ups at the top.
const getAllUsers = catchAsync(async (req, res, next) => {
    // Bounded pagination, same pattern as every other list endpoint — an
    // unpaginated find() would grow linearly with signups.
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));

    // .lean() — the list is read-only (serialised straight to JSON), so plain
    // objects avoid the cost of hydrating a Mongoose document per user.
    const [users, userCount] = await Promise.all([
        User.find()
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        // No filter -> estimatedDocumentCount reads collection metadata (O(1))
        // instead of scanning every document like countDocuments() would.
        User.estimatedDocumentCount()
    ]);

    res.status(200).json({
        status: "success",
        message: "Users returned successfully!",
        userCount,
        data: { users }
    });
});

/**
 * Apply a phone change to a user document, guarding the unique index.
 *
 * Three cases, because the field is optional: absent means "leave it alone",
 * "" means "remove the stored number" (the schema lets that through on purpose),
 * and anything else is a change that must not collide with another account.
 * Nothing is saved here — the caller owns the write.
 *
 * @param {import("mongoose").Document} user the document being edited
 * @param {string|undefined} phone the validated, normalised value from the body
 * @returns {Promise<AppError|null>} the conflict to forward, or null when applied
 */
const applyPhoneChange = async (user, phone) => {
    if (phone === undefined || phone === user.phone) return null;

    if (phone === "") {
        // Unsets the path (the schema's setter maps "" to undefined), which is
        // what keeps the sparse unique index from collecting empty strings.
        user.phone = undefined;
        return null;
    }

    if (await User.exists({ phone, _id: { $ne: user._id } })) {
        return new AppError("An account with that phone number already exists.", 409);
    }

    user.phone = phone;
    return null;
};

/**
 * Apply a personal ID change to a user document — the phone's three cases
 * (absent = untouched, "" = cleared, otherwise set) without the uniqueness
 * guard, because the field is deliberately not unique (see user.model.js).
 *
 * @param {import("mongoose").Document} user the document being edited
 * @param {string|undefined} personalId the validated, normalised value from the body
 */
const applyPersonalIdChange = (user, personalId) => {
    if (personalId === undefined) return;
    // The schema setter maps "" to undefined, which unsets the path.
    user.personalId = personalId === "" ? undefined : personalId;
};

// POST /api/v1/auth/users -> admin creates an account directly. Unlike signup,
// no verification email is sent; the admin decides the role and whether the
// account is already verified.
const createUser = catchAsync(async (req, res, next) => {
    const { fullname, email, phone, personalId, password, role, isVerified } = req.body;

    // Phone and personal ID are deliberately not in this list: an account needs
    // an identity and a credential, and both numbers are collected when a
    // booking actually needs them.
    if (!fullname || !email || !password) {
        return next(new AppError("Please provide fullname, email and password!", 400));
    }

    // One lookup covers both uniqueness checks (email OR phone) instead of two
    // sequential round-trips; the matched field decides which message to return.
    // The phone clause is only added when there is a number to check — see the
    // note in signup on why `{ phone: undefined }` must never reach the filter.
    const existing = await User.findOne({ $or: phone ? [{ email }, { phone }] : [{ email }] })
        .select("email phone")
        .lean();

    if (existing) {
        if (existing.email === email) {
            return next(new AppError("An account with that email already exists.", 409));
        }
        return next(new AppError("An account with that phone number already exists.", 409));
    }

    // Whitelist fields explicitly — an admin may set role/isVerified, but nothing
    // else (e.g. googleId/provider) can be injected.
    const user = await User.create({
        fullname,
        email,
        password,
        ...(phone ? { phone } : {}),
        ...(personalId ? { personalId } : {}),
        role: role === "admin" ? "admin" : "user",
        isVerified: Boolean(isVerified)
    });

    // Never leak the hash, even though it's select:false on normal queries.
    user.password = undefined;

    res.status(201).json({
        status: "success",
        message: "User created successfully!",
        data: { user }
    });
});

// PATCH /api/v1/auth/users/:id -> admin edits an account. Only the supplied
// fields change; a blank/absent password leaves the existing one untouched.
const updateUser = catchAsync(async (req, res, next) => {
    const { id } = req.params;
    const { fullname, email, phone, personalId, password, role, isVerified } = req.body;

    const user = await User.findById(id);

    if (!user) {
        return next(new AppError("User not found to edit!", 404));
    }

    // Guard uniqueness only when the value actually changes, excluding this user
    // so re-saving the same email/phone isn't flagged as a duplicate.
    if (email && email !== user.email) {
        if (await User.findOne({ email, _id: { $ne: id } })) {
            return next(new AppError("An account with that email already exists.", 409));
        }
        user.email = email;
    }

    const phoneConflict = await applyPhoneChange(user, phone);
    if (phoneConflict) return next(phoneConflict);
    applyPersonalIdChange(user, personalId);

    if (fullname) user.fullname = fullname;
    if (role === "user" || role === "admin") user.role = role;
    if (isVerified === true || isVerified === false) user.isVerified = isVerified;
    // Only set a new password when one is provided; the pre-save hook hashes it.
    // Bumping tokenVersion revokes every outstanding session for the account —
    // an admin rotating a compromised password must also kick the attacker out.
    if (password) {
        user.password = password;
        await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
    }

    await user.save();

    user.password = undefined;

    res.status(200).json({
        status: "success",
        message: "User edited successfully!",
        data: { user }
    });
});

// DELETE /api/v1/auth/users/:id -> admin removes an account.
const deleteUser = catchAsync(async (req, res, next) => {
    const { id } = req.params;

    // An admin can't delete their own account out from under themselves.
    if (String(req.user._id) === String(id)) {
        return next(new AppError("You can't delete your own account!", 400));
    }

    const user = await User.findById(id);

    if (!user) {
        return next(new AppError("User not found to delete!", 404));
    }

    // A deleted account must never remain eligible for an unattended charge.
    // Do this before removing the User so an update failure leaves the account
    // intact rather than orphaning an active subscription.
    //
    // Only ACTIVE plans are touched, deliberately: the charge sweep already
    // filters on status 'active', so a paused plan cannot bill anyone, and
    // rewriting its pausedReason/pausedAt would destroy why it stopped. See
    // tests/integration/subscriptionAccountDeletion.test.js.
    await Subscription.updateMany(
        { user: user._id, status: "active" },
        { $set: { status: "cancelled", cancelledAt: new Date(), processingAt: null } }
    );
    await User.deleteOne({ _id: user._id });

    res.status(200).json({
        status: "success",
        message: "User deleted successfully!"
    });
});

const googleCallback = catchAsync(async (req, res, next) => {
    // Passport loads the user without tokenVersion (select:false); re-read it so
    // the issued JWT carries the live `v` claim — signing with a defaulted 0
    // would mint an instantly-dead token for anyone who ever reset a password.
    const fresh = await User.findById(req.user._id).select("+tokenVersion").lean();
    setTokenCookie(fresh || req.user, res);
    res.redirect(`${process.env.CLIENT_URL}/`);
});

// GET /api/v1/auth/verify-email/:token -> confirms a user's email.
// This URL is opened directly from the email in a browser, so on completion we
// sign the user in (set the auth cookie) and REDIRECT them straight to the
// client home page — no separate sign-in step needed.
const verifyEmail = catchAsync(async (req, res, next) => {
    // Re-hash the raw token from the URL to match what we stored at signup.
    const hashedToken = crypto
        .createHash("sha256")
        .update(req.params.token)
        .digest("hex");

    // Must match the hash AND still be within the expiry window.
    const user = await User.findOne({
        verificationToken: hashedToken,
        verificationTokenExpires: { $gt: Date.now() }
    }).select("+verificationToken +verificationTokenExpires +tokenVersion");

    if (!user) {
        return res.redirect(`${process.env.CLIENT_URL}/signin?verified=failed`);
    }

    // Flip the account to verified and clear the now-used token.
    user.isVerified = true;
    user.verificationToken = undefined;
    user.verificationTokenExpires = undefined;
    await user.save({ validateBeforeSave: false });

    // Auto-login: set the session cookie, then drop the user on the home page
    // already authenticated (the client reads the cookie via GET /auth/me).
    setTokenCookie(user, res);
    res.redirect(`${process.env.CLIENT_URL}/`);
});

// POST /api/v1/auth/resend-verification -> re-sends the verification link.
// Responds with the SAME generic message in every case so the endpoint can't be
// used to discover which emails are registered (prevents user enumeration).
const resendVerificationEmail = catchAsync(async (req, res, next) => {
    const { email } = req.body;

    if (!email) {
        return next(new AppError("Please provide an email address.", 400));
    }

    const genericResponse = {
        status: "success",
        message: "If an unverified account exists for that email, a new verification link has been sent."
    };

    const user = await User.findOne({ email });

    // Silently no-op for unknown emails, Google accounts and already-verified
    // users — but always reply identically.
    if (!user || user.provider !== "local" || user.isVerified) {
        return res.status(200).json(genericResponse);
    }

    await sendVerificationEmail(user);

    res.status(200).json(genericResponse);
});

// POST /api/v1/auth/forgot-password -> emails a one-time reset link.
// Mirrors the anti-enumeration posture of resend-verification: the response is
// IDENTICAL whether the email exists, is a Google account, or is unknown.
const forgotPassword = catchAsync(async (req, res, next) => {
    const { email } = req.body;

    const genericResponse = {
        status: "success",
        message: "If an account exists for that email, a password-reset link has been sent."
    };

    const user = await User.findOne({ email }).select("+password");

    // The gate is the stored password, not the provider: a Google account that
    // added a local password (PATCH /me/password) owns a credential like any
    // other and must be able to reset it. An account with no password has
    // nothing to reset — it signs in with Google — and unknown emails no-op.
    // All three reply identically to prevent user enumeration.
    if (!user || !user.password) {
        return res.status(200).json(genericResponse);
    }

    // Raw token goes in the URL; only its hash is stored on the user.
    const rawToken = user.createPasswordResetToken();
    await user.save({ validateBeforeSave: false });

    // The link opens the client's reset page, which collects the new password
    // and POSTs it to /auth/reset-password/:token.
    const resetUrl = `${process.env.CLIENT_URL}/reset-password/${rawToken}`;

    const { subject, html, text } = passwordResetEmail({
        fullname: user.fullname,
        url: resetUrl,
        expiresInMinutes: PASSWORD_RESET_TTL_MINUTES
    });

    try {
        await sendEmail({ email: user.email, subject, html, text });
    } catch (err) {
        // Undo the token so the user can cleanly request a new one later.
        user.passwordResetToken = undefined;
        user.passwordResetExpires = undefined;
        await user.save({ validateBeforeSave: false });

        return next(new AppError("We couldn't send the password-reset email. Please try again later.", 502));
    }

    res.status(200).json(genericResponse);
});

// POST /api/v1/auth/reset-password/:token -> sets a new password.
// Consumes the one-time token, revokes every outstanding session (tokenVersion
// bump), clears any signin lockout, and signs the user straight in.
const resetPassword = catchAsync(async (req, res, next) => {
    const hashedToken = crypto
        .createHash("sha256")
        .update(req.params.token)
        .digest("hex");

    const user = await User.findOne({
        passwordResetToken: hashedToken,
        passwordResetExpires: { $gt: Date.now() }
    }).select("+passwordResetToken +passwordResetExpires +tokenVersion");

    if (!user) {
        return next(new AppError("The reset link is invalid or has expired. Please request a new one.", 400));
    }

    user.password = req.body.password; // pre-save hook hashes it
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    // Revoke all existing sessions and clear any failed-attempt lockout.
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    user.failedLoginAttempts = 0;
    user.lockUntil = undefined;
    // Owning the inbox proves the address — a still-unverified account is
    // implicitly verified by completing the reset.
    user.isVerified = true;
    await user.save();

    createSendToken(user, res, 200);
});

// PATCH /api/v1/auth/me -> a user edits their own profile (name/phone only;
// email changes would need a re-verification flow and are not supported here).
const updateMe = catchAsync(async (req, res, next) => {
    const { fullname, phone, personalId } = req.body;

    if (fullname === undefined && phone === undefined && personalId === undefined) {
        return next(new AppError("Please provide a field to update (fullname, phone or personalId).", 400));
    }

    const user = await User.findById(req.user._id);
    if (!user) {
        return next(new AppError("The user for this session no longer exists!", 401));
    }

    // Sending "" removes the number — the customer added it once and wants it
    // gone; the next booking will ask for one again.
    const phoneConflict = await applyPhoneChange(user, phone);
    if (phoneConflict) return next(phoneConflict);
    // Same semantics: "" removes the stored number.
    applyPersonalIdChange(user, personalId);

    if (fullname) user.fullname = fullname;

    await user.save();

    res.status(200).json({
        status: "success",
        message: "Profile updated successfully!",
        data: { user }
    });
});

// PATCH /api/v1/auth/me/tax-profile -> a customer switches between a personal
// and a business account, and registers the VAT number that goes with it.
//
// The customer controls `customerType`, `companyName` and `vatNumber`. They do
// NOT control `vatStatus` — that is written only from Stripe's VIES
// verification, which is what stops "I'm a business" from being a self-service
// 22% discount. Until Stripe answers `verified`, the account is charged VAT
// exactly like a consumer.
const updateMyTaxProfile = catchAsync(async (req, res, next) => {
    const { customerType, companyName, vatNumber } = req.body;

    const user = await User.findById(req.user._id);
    if (!user) {
        return next(new AppError("The user for this session no longer exists!", 401));
    }

    if (companyName !== undefined) user.companyName = companyName;

    // Switching back to a personal account drops the VAT registration entirely —
    // leaving a verified number attached to an individual would be a standing
    // invitation to flip the type back and skip the tax.
    if (customerType === 'individual') {
        Object.assign(user, await clearVatNumber(user));
        user.customerType = 'individual';
        user.companyName = '';
    } else {
        if (customerType === 'business') user.customerType = 'business';

        if (vatNumber !== undefined) {
            const cleared = String(vatNumber).trim() === '';
            if (cleared) {
                Object.assign(user, await clearVatNumber(user));
            } else if (normaliseVatNumber(vatNumber) !== user.vatNumber) {
                // Only re-register when the number actually changed — resubmitting
                // the same one would otherwise reset a verified status to pending.
                Object.assign(user, await registerVatNumber(user, vatNumber));
            }
        }

        if (user.customerType === 'business' && !user.vatNumber) {
            // Allowed: a business can exist before its number is entered. It is
            // simply charged VAT until one is registered and verified.
            user.vatStatus = 'none';
        }
    }

    await user.save();

    res.status(200).json({
        status: "success",
        message: user.vatStatus === 'pending'
            ? "VAT number saved. We're verifying it — VAT is still charged until it's confirmed."
            : "Tax profile updated successfully!",
        data: { user }
    });
});

// POST /api/v1/auth/me/tax-profile/refresh -> pull the VAT verification result
// straight from Stripe.
//
// The `customer.tax_id.updated` webhook is the normal path. This exists for when
// one is missed (delivery failure, or local dev with no tunnel) so a genuinely
// verified business is never stuck paying VAT because an event went astray.
const refreshMyTaxStatus = catchAsync(async (req, res, next) => {
    const user = await User.findById(req.user._id);
    if (!user) {
        return next(new AppError("The user for this session no longer exists!", 401));
    }

    const refreshed = await refreshVatStatus(user);

    res.status(200).json({
        status: "success",
        message: "VAT status refreshed.",
        data: { user: refreshed || user }
    });
});

// PATCH /api/v1/auth/me/password -> change own password, or SET a first one.
//
// Two cases, told apart by the stored hash — never by the request:
//   - the account HAS a password  -> the current one must be supplied and match
//     (a hijacked session must not be able to lock the owner out).
//   - the account has NONE (signed up through Google) -> it may add one, with
//     no current password to prove, because there is nothing to prove. The
//     session cookie is the authority, exactly as it already is for deleting a
//     Google account (deleteMe). Afterwards the account can sign in either way,
//     and every later change takes the branch above.
//
// Both paths revoke every other session and re-issue this one's cookie.
const updateMyPassword = catchAsync(async (req, res, next) => {
    const { currentPassword, newPassword } = req.body;

    const user = await User.findById(req.user._id).select("+password +tokenVersion");
    if (!user) {
        return next(new AppError("The user for this session no longer exists!", 401));
    }

    if (user.password) {
        if (!currentPassword) {
            return next(new AppError("Please provide your current password.", 400));
        }

        if (!(await user.comparePassword(currentPassword))) {
            return next(new AppError("Your current password is incorrect!", 401));
        }
    } else if (currentPassword) {
        // Nothing to compare against: this account has never had a password.
        // Reject rather than silently ignore, so a client that sent one isn't
        // led to believe it was verified.
        return next(new AppError("This account has no password yet — leave the current password empty to set one.", 400));
    }

    user.password = newPassword; // pre-save hook hashes it
    // Kill every other session (stolen cookies included); the fresh cookie
    // below keeps THIS session alive with the new version.
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await user.save();

    createSendToken(user, res, 200);
});

// DELETE /api/v1/auth/me -> a user deletes their own account.
// Local accounts must confirm with their password (a hijacked session alone
// can't destroy the account); Google accounts have none to confirm.
// Blocked while the user still has upcoming (pending/confirmed) bookings —
// those hold money/scheduling and must be cancelled first.
const deleteMe = catchAsync(async (req, res, next) => {
    const user = await User.findById(req.user._id).select("+password");
    if (!user) {
        return next(new AppError("The user for this session no longer exists!", 401));
    }

    if (user.password) {
        if (!req.body.password || !(await user.comparePassword(req.body.password))) {
            return next(new AppError("Please confirm your password to delete your account.", 401));
        }
    }

    const activeBookings = await Booking.countDocuments({
        user: user._id,
        status: { $in: ["pending", "confirmed"] }
    });
    if (activeBookings > 0) {
        return next(new AppError("Please cancel your upcoming bookings before deleting your account.", 409));
    }

    // Reviews are the user's own content — remove them. Past bookings are kept
    // as business/financial records (they already carry the customer details
    // they need) but are detached from the deleted account.
    // Stop every still-active recurring plan before detaching/deleting the
    // account. Paused plans cannot charge (the sweep filters on 'active') and
    // are left exactly as they are so their pause reason survives as history.
    await Subscription.updateMany(
        { user: user._id, status: "active" },
        { $set: { status: "cancelled", cancelledAt: new Date(), processingAt: null } }
    );

    await Review.deleteMany({ user: user._id });
    await Booking.updateMany({ user: user._id }, { $unset: { user: "" } });
    await User.deleteOne({ _id: user._id });

    // Clear the session cookie.
    res.cookie("lt", "", {
        maxAge: 0,
        httpOnly: true,
        sameSite: isProduction ? "None" : "Lax",
        secure: isProduction
    });

    res.status(200).json({
        status: "success",
        message: "Your account has been deleted."
    });
});

module.exports = {
    signup,
    signin,
    logout,
    getMe,
    getAllUsers,
    createUser,
    updateUser,
    deleteUser,
    googleCallback,
    verifyEmail,
    resendVerificationEmail,
    forgotPassword,
    resetPassword,
    updateMe,
    updateMyTaxProfile,
    refreshMyTaxStatus,
    updateMyPassword,
    deleteMe
};
