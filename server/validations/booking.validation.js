// Modules
const { z } = require("zod");
const mongoose = require("mongoose");

const {
    MIN_DURATION_MINUTES,
    MAX_DURATION_MINUTES
} = require("../utils/duration.util");

// A duration is TOTAL MINUTES — the canonical representation everywhere (see
// utils/duration.util.js). The wizard collects it as an "Hours + Minutes" pair
// and combines the two before sending, so the wire format has exactly one
// spelling of "1 h 25 min" and no float can express it wrongly.
//
// The bounds are the platform's; whether a duration also FITS the chosen city's
// working hours needs the city and the start time, which a flat field schema
// can't see — assertBookingWindow (services/booking.service.js) enforces that.
const durationMinutesField = () =>
    z
        .number()
        .int({ message: "Duration must be a whole number of minutes!" })
        .min(MIN_DURATION_MINUTES, {
            message: `A booking must be at least ${MIN_DURATION_MINUTES} minutes!`
        })
        .max(MAX_DURATION_MINUTES, {
            message: `A booking cannot exceed ${MAX_DURATION_MINUTES} minutes!`
        });

const { phoneField } = require("./phone.validation");
const { personalIdField } = require("./personalId.validation");

const objectId = z
    .string()
    .trim()
    .refine((id) => mongoose.Types.ObjectId.isValid(id), { message: "Invalid ID" })

// HH:MM 24-hour clock — same pattern used in city.model.js
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

// YYYY-MM-DD calendar date
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Same-day bookings are allowed; only past dates are rejected. We compare
// calendar dates at LOCAL midnight (never raw `new Date("YYYY-MM-DD")`, which is
// parsed as UTC midnight and shifts by timezone) so "today" is always valid.
const isTodayOrFuture = (val) => {
  const [y, m, d] = val.split("-").map(Number);
  const booking = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return booking >= today;
};

// Schema for validate create booking request body
const createBookingSchema = z.object({
    serviceId: objectId,

    cityId: objectId,

    // Customer identity. For a normal user these are IGNORED by the controller and
    // always taken from req.user (a user can't book under someone else's name).
    // They are only honoured for an ADMIN booking on a customer's behalf, alongside
    // the optional `userId` that links the booking to a registered account. Being
    // optional here, a regular user supplying them is harmless — the controller
    // never reads them for non-admins.
    customerName: z
        .string()
        .trim()
        .min(1, { message: "Customer name can't be empty!" })
        .optional(),

    customerEmail: z
        .string()
        .trim()
        .toLowerCase()
        .email({ message: "Customer email must be a valid email address!" })
        .optional(),

    // Optional registered account to attach the booking to (admin-on-behalf).
    userId: objectId.optional(),

    // Optional in the SCHEMA, required for the booking: it falls back to
    // req.user.phone, and the controller refuses the booking when neither the
    // request nor the account carries a number (an account can be created
    // without one — the crew still has to be able to ring someone).
    customerPhone: phoneField().optional(),

    // Same posture as the phone: optional in the SCHEMA, required for a
    // customer booking — buildValidatedBookingDraft falls back to
    // req.user.personalId and refuses when neither carries one. An admin
    // recording a walk-in may omit it.
    customerPersonalId: personalIdField().optional(),

    streetName: z
        .string()
        .trim()
        .min(1, { message: "Street name is required!" }),

    houseNumber: z
        .string()
        .trim()
        .min(1, { message: "The house number must be greater then 0!" }),

    propertySize: z
        .string()
        .trim()
        .min(1, { message: "The property size must be greater then 0!" }),

    bookingDate: z
        .string()
        .trim()
        .regex(DATE_REGEX, { message: "bookingDate must be in YYYY-MM-DD format!" })
        .refine(isTodayOrFuture, {
            message: "Booking date can't be in the past!"
        }),

    bookingTime: z
        .string()
        .trim()
        .regex(TIME_REGEX, { message: "bookingTime must be in HH:MM (24-hour) format!" }),

    doorbellName: z
        .string()
        .trim()
        .min(1, { message: "Doorbell name can't be empty!" }),

    // An explicit ceiling as well as a floor: assertBookingWindow already caps
    // the duration against the city's closing time, but that is a per-city rule;
    // without a hard bound here an absurd value reaches the pricing maths and
    // the Stripe amount before anything rejects it.
    durationMinutes: durationMinutesField(),

    cleaners: z
        .number()
        .int({ message: "Cleaners must be a whole number!" })
        .min(1, { message: "A booking must have at least 1 cleaner!" })
        .max(10, { message: "A booking cannot have more than 10 cleaners!" }),

    // totalAmount is now server-managed (computed from service.pricePerHour pro-rated
    // + sum of specialRequest prices). It is intentionally absent from this schema
    // so the Zod .strict() guard rejects any client-supplied value.

    notes: z
        .string()
        .trim()
        .max(2000, { message: "Notes can't exceed 2000 characters!" })
        .optional()
        .nullable(),

    specialRequests: z
        .array(objectId)
        .optional(),

    // Catalogue-backed tools (CleaningTool ids). Validated server-side against
    // enabled tools usable on the chosen service.
    cleaningTools: z
        .array(objectId)
        .max(50, { message: "Cleaning tools list can't exceed 50 items!" })
        .optional(),

    // Assigned cleaning staff. Honoured by the controller only for admin
    // requests (a normal customer can't assign workers to their own booking).
    workers: z
        .array(objectId)
        .max(50, { message: "Workers list can't exceed 50 items!" })
        .optional(),

    supplies: z
        .array(
            z.string()
            .trim()
            .min(1, { message: "Supply name can't be empty!" })
            .max(100, { message: "Supply name can't exceed 100 characters!" })
        )
        .max(50, { message: "Supplies list can't exceed 50 items!" })
        .optional()

}).strict({ message: "Unknown fields are not allowed!" });

// Schema for validate edit booking request body
//
// serviceId / cityId are deliberately ABSENT. They used to be accepted here
// while editBooking's field whitelist ignored them, so a request to move a
// booking to another service returned 200 and changed nothing — a silent
// no-op, and one that would have re-priced against the OLD service anyway.
// With .strict() below, sending either now fails loudly instead of lying.
// Re-pointing a booking at a different service/city means re-resolving add-on
// and tool eligibility and re-settling an already-captured charge; until that
// is designed, cancel and re-book.
const editBookingSchema = z.object({
    customerPhone: phoneField().optional(),

    // An admin may correct a mistyped number; blanking it is not offered.
    customerPersonalId: personalIdField().optional(),

    streetName: z
        .string()
        .trim()
        .min(1, { message: "Street name is required!" })
        .optional(),

    houseNumber: z
        .string()
        .trim()
        .min(1, { message: "The house number must be greater then 0!" })
        .optional(),

    propertySize: z
        .string()
        .trim()
        .min(1, { message: "The property size must be greater then 0!" })
        .optional(),

    // Format only — the "not in the past" rule deliberately does NOT live here.
    // An edit re-sends the booking's own date, and most bookings an admin
    // manages are already past (marking them completed, adding notes, assigning
    // staff after the fact). Refusing a past date at the schema level rejected
    // every such edit even though the date was untouched. editBooking compares
    // the incoming date against the stored one and only rejects an actual
    // RESCHEDULE into the past.
    bookingDate: z
        .string()
        .trim()
        .regex(DATE_REGEX, { message: "bookingDate must be in YYYY-MM-DD format!" })
        .optional(),

    bookingTime: z
        .string()
        .trim()
        .regex(TIME_REGEX, { message: "bookingTime must be in HH:MM (24-hour) format!" })
        .optional(),

    doorbellName: z
        .string()
        .trim()
        .min(1, { message: "Doorbell name can't be empty!" })
        .optional(),

    durationMinutes: durationMinutesField().optional(),

    cleaners: z
        .number()
        .int({ message: "Cleaners must be a whole number!" })
        .min(1, { message: "A booking must have at least 1 cleaner!" })
        .max(10, { message: "A booking cannot have more than 10 cleaners!" })
        .optional(),

    // totalAmount is server-managed — intentionally absent from editBookingSchema
    // as well. An admin editing a booking should not be able to override the
    // computed price without going through the proper recalculation path.

    status: z
        .enum(['pending', 'confirmed', 'cancelled', 'completed'])
        .optional(),

    notes: z
        .string()
        .trim()
        .max(2000, { message: "Notes can't exceed 2000 characters!" })
        .optional()
        .nullable(),

    specialRequests: z
        .array(objectId)
        .optional(),

    // Catalogue-backed tools (CleaningTool ids). Sending an empty array clears
    // the current selection; ids are re-validated against the booking's service.
    cleaningTools: z
        .array(objectId)
        .max(50, { message: "Cleaning tools list can't exceed 50 items!" })
        .optional(),

    // Assigned cleaning staff (admin-managed). Sending an empty array clears the
    // current assignment.
    workers: z
        .array(objectId)
        .max(50, { message: "Workers list can't exceed 50 items!" })
        .optional(),

    supplies: z
        .array(
            z.string()
            .trim()
            .min(1, { message: "Supply name can't be empty!" })
            .max(100, { message: "Supply name can't exceed 100 characters!" })
        )
        .max(50, { message: "Supplies list can't exceed 50 items!" })
        .optional()

}).strict({ message: "Unknown fields are not allowed!" });

module.exports = { createBookingSchema, editBookingSchema };
