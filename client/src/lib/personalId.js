/*
 * Personal ID numbers
 * -------------------
 * The client half of server/utils/personalId.util.js: the same canonical form
 * (uppercase letters and digits, no separators) and the same bounds, so the
 * wizard and the profile refuse exactly what the API would refuse.
 *
 * The rule is deliberately format-generic. The product sells into Georgia (an
 * 11-digit personal number), Italy (a 16-character codice fiscale), Greece,
 * Russia and the rest of Europe, and the form carries no document-country
 * selector, so a per-country checksum would reject legitimate customers.
 */

// Letters of any script (Greek ID cards, Cyrillic document series) and digits,
// matched AFTER toUpperCase — hence \p{Lu}.
export const PERSONAL_ID_REGEX = /^[\p{Lu}\p{Nd}]{5,20}$/u;

/**
 * Reduce a typed identifier to the canonical form: uppercase, with the spaces,
 * dots and dashes people type between groups removed.
 *
 * @param {unknown} value
 * @returns {string} normalised identifier, or "" when there is nothing to store
 */
export function normalizePersonalId(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\s.‐-―−-]/g, "").toUpperCase();
}

/** @param {unknown} value @returns {boolean} */
export function isValidPersonalId(value) {
  return PERSONAL_ID_REGEX.test(normalizePersonalId(value));
}
