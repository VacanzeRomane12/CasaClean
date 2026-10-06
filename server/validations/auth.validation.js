// Modules
const { z } = require("zod");

const { phoneField } = require("./phone.validation");
const { personalIdField } = require("./personalId.validation");

/*
 * A phone number is optional on an ACCOUNT.
 *
 * Signing in needs an email and a password; a number is what a crew rings on the
 * day, so it is required where that matters — the booking — and merely offered
 * here. `allowEmpty` lets a profile edit clear one that was stored earlier; on
 * signup an empty string is simply the same as leaving the field out.
 */
const accountPhone = phoneField({ allowEmpty: true }).optional();

// The personal ID number has the same posture as the phone: offered on the
// account, required on the booking (which falls back to it). "" clears it.
const accountPersonalId = personalIdField({ allowEmpty: true }).optional();

// Schema for validate register request body
const signupSchema = z.object({
    fullname: z
        .string()
        .trim()
        .min(5, { message: "Fullname must contain at least 5 characters!" })
        .max(50, { message: "Fullname is too long!" }),

    email: z
        .string()
        .trim()
        .email({ message: "Invalid email address!" }),

    phone: accountPhone,

    password: z
        .string()
        .trim()
        .min(8, { message: "Password must contain at least 8 characters!" })
        .max(50, { message: "Password is too long!" })

}).strict({ message: "Unknown fields are not allowed!" });

// Schema for validate login request body
const signinSchema = z.object({
    email: z
        .string()
        .trim()
        .email({ message: "Invalid email address!" }),

    password: z
        .string()
        .trim()
        .min(1, { message: "Password must contain at least 1 character!" })
        .max(50, { message: "Password is too long!" }),

    // Optional: the client sends this to choose a persistent vs. session-only
    // cookie. The schema is .strict(), so it must be allowed explicitly or the
    // whole request is rejected ("Validation failed!").
    remember: z
        .boolean()
        .optional()

}).strict({ message: "Unknown fields are not allowed!" });

// Schema for validate resend email verification request body
const resendEmailVerificationSchema = z.object({
    email: z
        .string()
        .trim()
        .email({ message: "Invalid email adress!" })

}).strict({ message: "Unknown fields are not allowed!" })

// Admin: POST /auth/users. Mirrors signupSchema (every value must be a plain
// string — rejecting objects also blocks NoSQL operator injection like
// `email: { "$ne": null }`) plus the admin-only role/isVerified flags.
const createUserSchema = z.object({
    fullname: z
        .string()
        .trim()
        .min(5, { message: "Fullname must contain at least 5 characters!" })
        .max(50, { message: "Fullname is too long!" }),

    email: z
        .string()
        .trim()
        .email({ message: "Invalid email address!" }),

    phone: accountPhone,

    personalId: accountPersonalId,

    password: z
        .string()
        .trim()
        .min(8, { message: "Password must contain at least 8 characters!" })
        .max(50, { message: "Password is too long!" }),

    role: z
        .enum(["user", "admin"])
        .optional(),

    isVerified: z
        .boolean()
        .optional()

}).strict({ message: "Unknown fields are not allowed!" });

// Admin: PATCH /auth/users/:id — same fields, all optional (partial update).
const updateUserSchema = createUserSchema.partial()
    .strict({ message: "Unknown fields are not allowed!" });

// POST /auth/forgot-password — just the account email.
const forgotPasswordSchema = z.object({
    email: z
        .string()
        .trim()
        .email({ message: "Invalid email address!" })

}).strict({ message: "Unknown fields are not allowed!" });

// POST /auth/reset-password/:token — the new password (token travels in the URL).
const resetPasswordSchema = z.object({
    password: z
        .string()
        .trim()
        .min(8, { message: "Password must contain at least 8 characters!" })
        .max(50, { message: "Password is too long!" })

}).strict({ message: "Unknown fields are not allowed!" });

// PATCH /auth/me — a user edits their own profile. Email changes are
// deliberately NOT supported here (they'd need a re-verification flow); role
// and isVerified are server-managed and rejected by .strict().
const updateMeSchema = z.object({
    fullname: z
        .string()
        .trim()
        .min(5, { message: "Fullname must contain at least 5 characters!" })
        .max(50, { message: "Fullname is too long!" })
        .optional(),

    // "" is meaningful here: it removes the stored number (see updateMe).
    phone: accountPhone,

    // Same clearing semantics as the phone.
    personalId: accountPersonalId

}).strict({ message: "Unknown fields are not allowed!" });

// A customer switching between a personal and a business account.
//
// Note what is NOT here: `vatStatus`. Verification is Stripe's answer, not the
// customer's claim, so the field is unwritable through the API by construction —
// .strict() rejects the request outright if it appears in the body.
const updateMyTaxProfileSchema = z.object({
    customerType: z
        .enum(["individual", "business"], {
            message: "Customer type must be either 'individual' or 'business'!"
        })
        .optional(),

    companyName: z
        .string()
        .trim()
        .max(120, { message: "Company name is too long!" })
        .optional(),

    // An empty string is meaningful: it clears the registration (and detaches the
    // number from Stripe), so it must survive validation rather than be rejected
    // as a too-short string.
    vatNumber: z
        .string()
        .trim()
        .max(20, { message: "VAT number is too long!" })
        .optional()

}).strict({ message: "Unknown fields are not allowed!" });

// Pulling the verification result from Stripe takes no client input at all.
const refreshMyTaxStatusSchema = z
    .object({})
    .strict({ message: "This action does not accept a request body." });

// PATCH /auth/me/password — change own password, or SET a first one.
//
// `currentPassword` is optional here only so a Google account that has never had
// a local password can add one. It is not optional in effect: the controller
// reads the account's stored hash and demands a matching current password
// whenever one exists, so an omitted field can never bypass the check on an
// account that has a password to protect.
const updateMyPasswordSchema = z.object({
    currentPassword: z
        .string()
        .trim()
        .min(1, { message: "Current password is required!" })
        .max(50, { message: "Password is too long!" })
        .optional(),

    newPassword: z
        .string()
        .trim()
        .min(8, { message: "Password must contain at least 8 characters!" })
        .max(50, { message: "Password is too long!" })

}).strict({ message: "Unknown fields are not allowed!" });

// DELETE /auth/me — password confirmation for local accounts (Google accounts
// have no local password and may omit it).
const deleteMeSchema = z.object({
    password: z
        .string()
        .trim()
        .max(50, { message: "Password is too long!" })
        .optional()

}).strict({ message: "Unknown fields are not allowed!" });

module.exports = {
    signupSchema,
    signinSchema,
    resendEmailVerificationSchema,
    createUserSchema,
    updateUserSchema,
    forgotPasswordSchema,
    resetPasswordSchema,
    updateMeSchema,
    updateMyTaxProfileSchema,
    refreshMyTaxStatusSchema,
    updateMyPasswordSchema,
    deleteMeSchema
};
