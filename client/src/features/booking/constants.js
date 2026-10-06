/*
 * Booking constants
 * -----------------
 * Step definitions and the option sets that drive the wizard. Field lists per
 * step power per-step validation (we only validate the current slice before
 * advancing). Shapes align with the backend `booking` model.
 */

export const BOOKING_STEPS = [
  {
    // City and service live together here on purpose: they constrain each other,
    // so separating them is what let a pre-selected service disappear silently
    // one step later. See PropertyStep for the one-way filtering rule.
    id: "property",
    title: "Service & address",
    subtitle: "What you need and where",
    fields: [
      "cityId",
      "serviceId",
      "street",
      "houseNumber",
      "propertySize",
      "doorbellName",
    ],
  },
  {
    id: "preferences",
    title: "Cleaning preferences",
    subtitle: "Tailor the turnover",
    // Duration is collected as two numeric fields, an Hours and a Minutes, and
    // combined into total minutes at submission (utils/duration.js). Both are
    // listed so a per-step validation surfaces an error on either one.
    fields: [
      "durationHours",
      "durationMins",
      "cleaners",
      "additionalServices",
      "cleaningTools",
    ],
  },
  {
    id: "schedule",
    title: "Schedule",
    subtitle: "Pick a date and time",
    fields: ["date", "time", "intervalDays"],
  },
  {
    id: "contact",
    title: "Your details",
    subtitle: "Where to reach you",
    fields: ["name", "email", "phone", "personalId", "notes"],
  },
  {
    id: "review",
    title: "Review",
    subtitle: "Confirm everything looks right",
    fields: [],
  },
  {
    id: "payment",
    title: "Payment",
    subtitle: "Secure checkout to confirm your booking",
    fields: [],
  },
];

// Start times are NOT a constant, and no longer a list at all: the customer
// types the time they want the crew to arrive (12:20 is a real arrival time),
// and utils/timeWindow.js validates it against the chosen city's working hours
// and the booking's duration — exactly the rules the server enforces.

// Add-ons and cleaning tools come from the live catalogue via
// useSpecialRequests / useCleaningTools; there is no static fallback list.

// Duration bounds, in TOTAL MINUTES. There is deliberately no list of
// selectable durations: the customer types an Hours and a Minutes value and any
// whole minute between these bounds is bookable, because a 1 h 25 min visit is
// an ordinary request that a dropdown of round numbers silently refuses.
//
// MIN mirrors the server's MIN_DURATION_MINUTES exactly. The 6-hour ceiling is
// this wizard's and is stricter than the server's 12 — an admin can book a
// longer job by hand.
export const MIN_DURATION_MINUTES = 60;
export const MAX_DURATION_MINUTES = 360;

// The minutes half of the pair. Sixty minutes is one more hour, not a valid
// minutes value, so the pair has exactly one spelling of every duration.
export const MAX_MINUTES_PART = 59;

// The largest whole hour the Hours input accepts — the minutes field can add up
// to 59 more, which the total bound above then catches.
export const MAX_DURATION_HOURS_PART = Math.floor(MAX_DURATION_MINUTES / 60);

// How far ahead a booking must be placed, unless its service allows instant
// (same-day) booking. Mirrors ADVANCE_BOOKING_HOURS in the server's
// utils/leadTime.util.js, which is the authority and re-checks every booking.
export const ADVANCE_BOOKING_HOURS = 48;

// Selectable cleaner counts, mirrored by the `cleaners` bound in
// validation/bookingSchema.js and by the max on the PreferencesStep input.
export const CLEANERS_RANGE = [1, 2, 3];

// Recurrence is decided per service, not globally: a service opts in
// (`recurringEnabled`) and may pin the exact cadences it repeats on
// (`recurringIntervalDays`). When it pins none, the customer picks any whole
// number of days in this range — mirrored by MIN/MAX_INTERVAL_DAYS in the
// server's utils/date.util.js, which rejects anything outside it.
export const MIN_INTERVAL_DAYS = 1;
export const MAX_INTERVAL_DAYS = 14;

/**
 * The cadences (in days) a service can be booked on, for the frequency picker.
 * Returns [] when the service can't repeat at all, so the caller can hide the
 * control entirely rather than render a one-option group. `0` — the one-time
 * sentinel — is added by the step itself, not here.
 */
export function recurrenceChoices(service) {
  if (!service?.recurringEnabled) return [];

  const pinned = (service.recurringIntervalDays || [])
    .map(Number)
    .filter((days) => Number.isInteger(days) && days >= MIN_INTERVAL_DAYS && days <= MAX_INTERVAL_DAYS);

  if (pinned.length > 0) return [...new Set(pinned)].sort((a, b) => a - b);

  return Array.from(
    { length: MAX_INTERVAL_DAYS - MIN_INTERVAL_DAYS + 1 },
    (_, index) => MIN_INTERVAL_DAYS + index
  );
}

export const BOOKING_STORAGE_KEY = "casaclean:booking-draft";
