import { z } from "zod";
import { isValidPhone } from "@/lib/phone";
import { isValidPersonalId } from "@/lib/personalId";
import { todayDateString } from "../utils/recurrence";
import {
  MAX_DURATION_HOURS_PART,
  MAX_DURATION_MINUTES,
  MAX_INTERVAL_DAYS,
  MAX_MINUTES_PART,
  MIN_DURATION_MINUTES,
} from "../constants";
import { combineDuration } from "../utils/duration";

/*
 * Booking validation
 * ------------------
 * One schema describing the entire booking. The wizard validates a subset of
 * fields per step (see BOOKING_STEPS.fields), but a single schema keeps the
 * rules in one place and gives us a fully-typed payload at submission.
 */

const todayISO = () => todayDateString();

/*
 * Duration
 * --------
 * Collected as two numeric inputs and carried as two form fields, then combined
 * into TOTAL MINUTES at submission (`durationMinutesOf`). The pair is validated
 * field-by-field for shape — a whole number of hours, 0–59 minutes — and the
 * combined TOTAL is checked in a schema-level refinement, because "at least an
 * hour, at most six" is a statement about the pair rather than either half.
 *
 * The refinement reports on `durationMins`: it is the field a customer most
 * often has to fix, and an error has to land on a real field to be rendered.
 *
 * Whether a duration also fits the chosen city's remaining working hours needs
 * the city and the start time, which a flat field schema can't see — the
 * schedule step applies that rule (utils/timeWindow.js) and the server enforces
 * it (assertBookingWindow).
 */
const durationHoursField = z.coerce
  .number({ message: "Enter the hours as a number" })
  .int("Enter whole hours")
  .min(0, "Hours can't be negative")
  .max(MAX_DURATION_HOURS_PART, "Choose a shorter booking");

const durationMinsField = z.coerce
  .number({ message: "Enter the minutes as a number" })
  .int("Enter whole minutes")
  .min(0, "Minutes can't be negative")
  .max(MAX_MINUTES_PART, `Minutes must be between 0 and ${MAX_MINUTES_PART}`);

/** The wizard's duration pair as the total minutes the API takes. */
export function durationMinutesOf(values) {
  return combineDuration(values?.durationHours, values?.durationMins);
}

export const bookingSchema = z.object({
  // Step 1 — property
  cityId: z.string().min(1, "Select a city"),
  street: z.string().trim().min(2, "Enter the street name"),
  houseNumber: z.string().trim().min(1, "Enter the house number"),
  propertySize: z
    .string()
    .min(1, "Enter the property size")
    .refine((v) => Number(v) > 0, "Size must be greater than 0"),
  doorbellName: z.string().trim().min(1, "Enter the name on the doorbell"),

  // Step 2 — preferences
  serviceId: z.string().min(1, "Choose a service"),
  // Bounds mirror the duration constants / CLEANERS_RANGE in ../constants.js and
  // the server's createBookingSchema. Keep them in step.
  durationHours: durationHoursField,
  durationMins: durationMinsField,
  cleaners: z.coerce.number().int().min(1, "Select cleaners").max(3),
  additionalServices: z.array(z.string()).default([]),
  cleaningTools: z.array(z.string()).default([]),

  // Step 3 — schedule
  date: z
    .string()
    .min(1, "Pick a date")
    .refine((v) => v >= todayISO(), "Choose a future date"),
  // The customer types the arrival time, to the minute, so the FORMAT is checked
  // here. Whether that minute fits the chosen city's working hours needs the city
  // and the duration, which a flat field schema can't see — ScheduleStep applies
  // that rule (utils/timeWindow.js) and the server enforces it.
  time: z
    .string()
    .min(1, "Pick a start time")
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter a time as HH:MM"),
  // 0 is the one-time sentinel; anything above it is a repeat cadence in days.
  // The upper bound mirrors the server's; whether the chosen service allows that
  // exact cadence is a per-service rule ScheduleStep applies (recurrenceChoices)
  // and the server enforces.
  intervalDays: z.coerce.number().int().min(0).max(MAX_INTERVAL_DAYS).default(0),

  // Step 4 — contact
  name: z.string().trim().min(2, "Enter your full name"),
  email: z.string().trim().email("Enter a valid email"),
  // Required here even though it is optional on the account: this is the number
  // the crew rings at the door, and the API refuses a booking without one
  // (server/services/booking.service.js).
  phone: z
    .string()
    .trim()
    .refine(isValidPhone, "Enter a valid phone number, including the country prefix"),
  // Same posture as the phone: optional on the account, required on the
  // booking — the API refuses a booking without one (lib/personalId.js
  // mirrors server/utils/personalId.util.js).
  personalId: z
    .string()
    .trim()
    .refine(isValidPersonalId, "Enter your personal ID number (5–20 letters or digits)"),
  notes: z.string().trim().max(500, "Keep notes under 500 characters").optional(),
}).superRefine((values, ctx) => {
  // The combined duration, checked once the two halves are individually sane.
  // A pair that failed its own field rules produces NaN here; reporting a
  // second error for it would just duplicate the one already shown.
  const total = durationMinutesOf(values);
  if (!Number.isFinite(total)) return;

  if (total < MIN_DURATION_MINUTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["durationMins"],
      message: `A booking must be at least ${MIN_DURATION_MINUTES} minutes`,
    });
    return;
  }

  if (total > MAX_DURATION_MINUTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["durationMins"],
      message: "Choose a shorter booking",
    });
  }
});

export const bookingDefaults = {
  cityId: "",
  street: "",
  houseNumber: "",
  propertySize: "",
  doorbellName: "",
  serviceId: "",
  // Two hours, spelled as the pair the two inputs hold.
  durationHours: 2,
  durationMins: 0,
  cleaners: 1,
  additionalServices: [],
  cleaningTools: [],
  date: "",
  time: "",
  intervalDays: 0,
  name: "",
  email: "",
  phone: "",
  personalId: "",
  notes: "",
};
