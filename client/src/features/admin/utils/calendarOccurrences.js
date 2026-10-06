/*
 * Calendar occurrences
 * --------------------
 * The admin calendar shows two kinds of entry: real bookings (documents the
 * bookings feed returns) and PROJECTED visits of recurring plans (what
 * GET /subscription/occurrences derives from each plan's rule, because a
 * cycle's booking only exists once it has been charged, the day before).
 *
 * The server projection starts at each plan's first UNCHARGED date, so a
 * projected date never coincides with a charged cycle. The one gap is on the
 * client: the bookings collection is fetched once per session, so right after
 * a charge an admin may hold a stale list without the new booking while a
 * fresh occurrences request already excludes that date — or the reverse. The
 * merge below keeps the real booking and drops the projection whenever both
 * describe the same plan on the same day, so a visit is never shown twice.
 */

import { PROJECTED_STATUS } from "../constants";

/** Stable identity of a plan's visit on a given day. */
const planDayKey = (subscriptionId, bookingDate) => `${subscriptionId}:${bookingDate}`;

/**
 * Adapt one projected occurrence (API shape) to the snake_case booking shape
 * the calendar renders, flagged so chips and the detail dialog can tell it
 * apart from a booking document.
 *
 * @param {Object} o an item of GET /subscription/occurrences
 */
export function occurrenceFromApi(o) {
  const subscriptionId = String(o.subscriptionId);
  const serviceId = o.serviceId && typeof o.serviceId === "object" ? o.serviceId._id : o.serviceId;
  const cityId = o.cityId && typeof o.cityId === "object" ? o.cityId._id : o.cityId;
  return {
    // No document exists, so synthesise a key that is unique per plan and day.
    _id: planDayKey(subscriptionId, o.bookingDate),
    projected: true,
    status: PROJECTED_STATUS,
    subscription_id: subscriptionId,
    interval_days: Number(o.intervalDays) || 0,
    customer_name: o.customerName,
    customer_email: o.customerEmail,
    customer_phone: o.customerPhone,
    customer_personal_id: o.customerPersonalId ?? "",
    service_id: serviceId,
    city_id: cityId,
    service_name: (o.serviceId && o.serviceId.name) || "—",
    city_name: (o.cityId && o.cityId.name) || "—",
    street_name: o.streetName,
    house_number: o.houseNumber,
    property_size: o.propertySize,
    doorbell_name: o.doorbellName,
    booking_date: o.bookingDate,
    booking_time: o.bookingTime,
    duration_minutes: Number(o.durationMinutes) || 0,
    cleaners: o.cleaners,
    notes: o.notes ?? "",
    worker_names: [],
  };
}

/**
 * Real bookings first, then every projection that does not duplicate a real
 * booking of the same plan on the same day.
 *
 * @param {Object[]} bookings    mapped booking documents (bookingFromApi shape)
 * @param {Object[]} occurrences mapped projections (occurrenceFromApi shape)
 * @returns {Object[]}
 */
export function mergeBookingsWithOccurrences(bookings, occurrences) {
  const taken = new Set();
  for (const b of bookings) {
    if (b.subscription_id && b.booking_date) {
      taken.add(planDayKey(b.subscription_id, b.booking_date));
    }
  }
  const projected = (occurrences || []).filter(
    (o) => !taken.has(planDayKey(o.subscription_id, o.booking_date))
  );
  return [...bookings, ...projected];
}
