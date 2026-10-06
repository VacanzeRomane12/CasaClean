/*
 * Personal ID numbers
 * -------------------
 * One place that decides what a personal identification number IS, so the
 * Mongoose validator, the Zod schemas and the booking guard can't drift apart
 * (same posture as utils/phone.util.js).
 *
 * The product sells into Georgia (an 11-digit personal number), Italy (a
 * 16-character codice fiscale), Greece, Russia and the rest of Europe, and the
 * booking form has no country selector for the document. A per-country checksum
 * would therefore reject legitimate customers, so the rule is deliberately
 * format-generic: after normalisation the value is 5–20 letters or digits.
 * That still rejects the mistakes that matter (blank, punctuation only, a
 * sentence typed into the field) while accepting every national format we sell to.
 */

// After normalisation: 5–20 uppercase letters (of any script — Greek ID cards
// and Cyrillic document series are real inputs here) or digits. Matched AFTER
// toUpperCase, hence \p{Lu}.
const PERSONAL_ID_REGEX = /^[\p{Lu}\p{Nd}]{5,20}$/u;

/**
 * Reduce a typed identifier to the canonical stored form.
 *
 * Uppercases and strips the separators people type or paste between groups
 * (spaces, dots and every dash a keyboard can produce), so "ab 12-34 cd" and
 * "AB1234CD" reach the database as one value.
 *
 * @param {unknown} value raw input, any type (non-strings become "")
 * @returns {string} the normalised identifier, or "" when there is nothing to store
 */
const normalizePersonalId = (value) => {
    if (typeof value !== "string") return "";
    return value
        .replace(/[\s.‐-―−-]/g, "")
        .toUpperCase();
};

/**
 * @param {unknown} value raw or normalised input
 * @returns {boolean} true when the value is a storable identification number
 */
const isValidPersonalId = (value) => PERSONAL_ID_REGEX.test(normalizePersonalId(value));

// The one wording every surface uses.
const PERSONAL_ID_ERROR_MESSAGE =
    "Enter a valid personal ID number: 5 to 20 letters or digits!";

module.exports = {
    PERSONAL_ID_REGEX,
    PERSONAL_ID_ERROR_MESSAGE,
    normalizePersonalId,
    isValidPersonalId
};
