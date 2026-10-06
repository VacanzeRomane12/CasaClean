const { normalizePersonalId, isValidPersonalId } = require("../../utils/personalId.util");

describe("normalizePersonalId", () => {
    test("uppercases and strips the separators people type between groups", () => {
        expect(normalizePersonalId(" rss mra 85 m01 h501 u ")).toBe("RSSMRA85M01H501U");
        expect(normalizePersonalId("01-001-012345")).toBe("01001012345");
        expect(normalizePersonalId("ab.12 34–cd")).toBe("AB1234CD");
    });

    test("returns an empty string for anything that isn't text", () => {
        expect(normalizePersonalId(undefined)).toBe("");
        expect(normalizePersonalId(null)).toBe("");
        expect(normalizePersonalId({ $ne: null })).toBe("");
        expect(normalizePersonalId(12345)).toBe("");
    });
});

describe("isValidPersonalId", () => {
    test("accepts the national formats of the markets this product sells in", () => {
        expect(isValidPersonalId("01001012345")).toBe(true);        // Georgia (11 digits)
        expect(isValidPersonalId("RSSMRA85M01H501U")).toBe(true);   // Italy (codice fiscale)
        expect(isValidPersonalId("rssmra85m01h501u")).toBe(true);   // lowercase input
        expect(isValidPersonalId("AK 123456")).toBe(true);          // Greece (ID card)
        expect(isValidPersonalId("4512 345678")).toBe(true);        // Russia (passport)
    });

    test("rejects blanks, symbols-only input and lengths outside 5–20", () => {
        expect(isValidPersonalId("")).toBe(false);
        expect(isValidPersonalId("   ")).toBe(false);
        expect(isValidPersonalId("--.--")).toBe(false);
        expect(isValidPersonalId("1234")).toBe(false);
        expect(isValidPersonalId("A".repeat(21))).toBe(false);
        expect(isValidPersonalId("ID#12345")).toBe(false);
        expect(isValidPersonalId("my id is 123456")).toBe(true); // spaces strip to MYIDIS123456
        expect(isValidPersonalId("ΑΚ 123456")).toBe(true);        // Greek letters are letters too
    });
});
