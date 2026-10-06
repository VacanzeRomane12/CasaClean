import { describe, test, expect } from "vitest";
import {
  bookingSchema,
  bookingDefaults,
  durationMinutesOf,
} from "./bookingSchema";
import { todayDateString } from "../utils/recurrence";

const todayISO = () => todayDateString();

const validValues = {
  cityId: "city1",
  street: "Via Roma",
  houseNumber: "12",
  propertySize: "80",
  doorbellName: "Rossi",
  serviceId: "svc1",
  durationHours: 3,
  durationMins: 0,
  cleaners: 2,
  additionalServices: [],
  cleaningTools: [],
  date: todayISO(),
  time: "10:00",
  name: "Mario Rossi",
  email: "mario@example.com",
  phone: "+39 331 234 5678",
  personalId: "01001012345",
  notes: "",
};

const errorsOf = (result) =>
  Object.fromEntries(
    (result.error?.issues || []).map((i) => [i.path.join("."), i.message])
  );

describe("bookingSchema", () => {
  test("accepts a complete, valid wizard state", () => {
    const result = bookingSchema.safeParse(validValues);
    expect(result.success).toBe(true);
  });

  test("coerces the duration pair and cleaners from their input strings", () => {
    const result = bookingSchema.safeParse({
      ...validValues,
      durationHours: "1",
      durationMins: "25",
      cleaners: "2",
    });
    expect(result.success).toBe(true);
    expect(result.data.durationHours).toBe(1);
    expect(result.data.durationMins).toBe(25);
    expect(result.data.cleaners).toBe(2);
    // And the pair reads as the one total the API takes.
    expect(durationMinutesOf(result.data)).toBe(85);
  });

  test("defaults a one-time booking frequency and accepts recurring intervals", () => {
    const oneTime = bookingSchema.safeParse(validValues);
    expect(oneTime.success).toBe(true);
    expect(oneTime.data.intervalDays).toBe(0);

    const recurring = bookingSchema.safeParse({ ...validValues, intervalDays: "7" });
    expect(recurring.success).toBe(true);
    expect(recurring.data.intervalDays).toBe(7);
  });

  test("bounds the combined duration to 1–6 hours and cleaners to 1–3", () => {
    const duration = (durationHours, durationMins) =>
      bookingSchema.safeParse({ ...validValues, durationHours, durationMins });

    // 0h 0m is not a booking; neither is anything under the hour.
    expect(duration(0, 0).success).toBe(false);
    expect(duration(0, 59).success).toBe(false);
    // Exactly the minimum, and exactly the maximum.
    expect(duration(1, 0).success).toBe(true);
    expect(duration(6, 0).success).toBe(true);
    // One minute past the ceiling.
    expect(duration(6, 1).success).toBe(false);

    expect(bookingSchema.safeParse({ ...validValues, cleaners: 0 }).success).toBe(false);
    expect(bookingSchema.safeParse({ ...validValues, cleaners: 4 }).success).toBe(false);
  });

  test("accepts any whole minute, so an odd length is bookable", () => {
    for (const [h, m, total] of [[1, 25, 85], [2, 10, 130], [3, 45, 225]]) {
      const result = bookingSchema.safeParse({
        ...validValues,
        durationHours: h,
        durationMins: m,
      });
      expect(result.success).toBe(true);
      expect(durationMinutesOf(result.data)).toBe(total);
    }
  });

  test("rejects a minutes value outside 0–59", () => {
    const minutes = (durationMins) =>
      bookingSchema.safeParse({ ...validValues, durationHours: 1, durationMins });

    expect(minutes(0).success).toBe(true);
    expect(minutes(59).success).toBe(true);
    // 60 minutes is one more hour, not a minutes value.
    expect(minutes(60).success).toBe(false);
    expect(minutes(-1).success).toBe(false);
  });

  test("rejects a fractional or non-numeric duration outright", () => {
    expect(
      bookingSchema.safeParse({ ...validValues, durationHours: 1.5, durationMins: 0 }).success
    ).toBe(false);
    expect(
      bookingSchema.safeParse({ ...validValues, durationHours: 1, durationMins: 25.5 }).success
    ).toBe(false);
    // Free-form text was never an accepted spelling of a duration.
    expect(
      bookingSchema.safeParse({ ...validValues, durationHours: "1h", durationMins: "25m" }).success
    ).toBe(false);
    expect(
      bookingSchema.safeParse({ ...validValues, durationHours: "", durationMins: 25 }).success
    ).toBe(false);
  });

  test("requires a start time in HH:MM, since the customer types it", () => {
    expect(bookingSchema.safeParse({ ...validValues, time: "12:20" }).success).toBe(true);
    expect(bookingSchema.safeParse({ ...validValues, time: "" }).success).toBe(false);
    expect(bookingSchema.safeParse({ ...validValues, time: "9:00" }).success).toBe(false);
    expect(bookingSchema.safeParse({ ...validValues, time: "24:10" }).success).toBe(false);
    // Whether that minute fits the city's working hours is ScheduleStep's rule
    // (utils/timeWindow.js), not this schema's.
  });

  test("rejects a past date but allows today", () => {
    const past = bookingSchema.safeParse({ ...validValues, date: "2020-01-01" });
    expect(past.success).toBe(false);
    expect(errorsOf(past).date).toMatch(/future/i);

    expect(bookingSchema.safeParse({ ...validValues, date: todayISO() }).success).toBe(true);
  });

  test("requires a positive property size", () => {
    const zero = bookingSchema.safeParse({ ...validValues, propertySize: "0" });
    expect(zero.success).toBe(false);
    expect(errorsOf(zero).propertySize).toMatch(/greater than 0/i);
  });

  test("validates the phone format", () => {
    expect(bookingSchema.safeParse({ ...validValues, phone: "not-a-phone" }).success).toBe(false);
    expect(bookingSchema.safeParse({ ...validValues, phone: "+39 (331) 234-5678" }).success).toBe(true);
    // Georgian and other European numbers, not only Italian ones.
    expect(bookingSchema.safeParse({ ...validValues, phone: "+995 555 12 34 56" }).success).toBe(true);
  });

  // Optional on the account, required here: this is the number a crew rings.
  test("requires a phone number, with its country prefix", () => {
    const missing = bookingSchema.safeParse({ ...validValues, phone: "" });
    expect(missing.success).toBe(false);

    const noPrefix = bookingSchema.safeParse({ ...validValues, phone: "331 234 5678" });
    expect(noPrefix.success).toBe(false);
    expect(errorsOf(noPrefix).phone).toMatch(/country prefix/i);
  });

  test("validates the email format", () => {
    const bad = bookingSchema.safeParse({ ...validValues, email: "nope" });
    expect(bad.success).toBe(false);
    expect(errorsOf(bad).email).toMatch(/valid email/i);
  });

  test("caps notes at 500 characters", () => {
    expect(bookingSchema.safeParse({ ...validValues, notes: "x".repeat(501) }).success).toBe(false);
    expect(bookingSchema.safeParse({ ...validValues, notes: "x".repeat(500) }).success).toBe(true);
  });

  test("the defaults fail validation until the wizard is filled in", () => {
    // Defaults intentionally start empty; submission must be impossible.
    expect(bookingSchema.safeParse(bookingDefaults).success).toBe(false);
  });
});

// Optional on the account, required here: the reservation carries the
// customer's personal ID number and the API refuses one without it.
describe("bookingSchema — personal ID", () => {
  test("requires a personal ID number", () => {
    const missing = bookingSchema.safeParse({ ...validValues, personalId: "" });
    expect(missing.success).toBe(false);
    expect(errorsOf(missing).personalId).toMatch(/personal id/i);
  });

  test("accepts the national formats of the markets this product sells in, however spaced", () => {
    expect(bookingSchema.safeParse({ ...validValues, personalId: "01001012345" }).success).toBe(true);
    expect(bookingSchema.safeParse({ ...validValues, personalId: "rss mra 85m01 h501u" }).success).toBe(true);
    expect(bookingSchema.safeParse({ ...validValues, personalId: "AK-123456" }).success).toBe(true);
  });

  test("rejects symbols and lengths outside 5–20", () => {
    expect(bookingSchema.safeParse({ ...validValues, personalId: "1234" }).success).toBe(false);
    expect(bookingSchema.safeParse({ ...validValues, personalId: "ID#12345" }).success).toBe(false);
    expect(bookingSchema.safeParse({ ...validValues, personalId: "A".repeat(21) }).success).toBe(false);
  });

  test("has an empty personal ID in the defaults", () => {
    expect(bookingDefaults.personalId).toBe("");
  });
});
