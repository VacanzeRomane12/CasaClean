// Modules
const { z } = require("zod");

const {
    normalizePersonalId,
    isValidPersonalId,
    PERSONAL_ID_ERROR_MESSAGE
} = require("../utils/personalId.util");

/*
 * The one Zod description of a personal ID number, so the account field and the
 * booking field accept exactly the same thing (utils/personalId.util.js owns the
 * rule itself, and the Mongoose validator reads it too).
 *
 * Every schema built here NORMALISES: what reaches the controller — and so the
 * stored document — is the canonical uppercase, separator-free form, whichever
 * way the customer spaced it.
 */

/**
 * Build the personal ID field.
 *
 * @param {object} [options]
 * @param {boolean} [options.allowEmpty=false] accept "" as a deliberate
 *   *clearing* of a stored number (profile edits) rather than as a mistake.
 * @returns {import("zod").ZodType} a schema producing a normalised identifier
 */
const personalIdField = ({ allowEmpty = false } = {}) =>
    z
        .string()
        .trim()
        // Bound the RAW string before normalising: 20 characters plus whatever
        // grouping the customer typed still fits comfortably.
        .max(40, { message: "Personal ID number is too long!" })
        .transform(normalizePersonalId)
        .refine((value) => (allowEmpty && value === "") || isValidPersonalId(value), {
            message: PERSONAL_ID_ERROR_MESSAGE
        });

module.exports = { personalIdField };
