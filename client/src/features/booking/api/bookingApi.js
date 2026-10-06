import { request } from "@/services/api";
import { durationMinutesOf } from "../validation/bookingSchema";

/*
 * Booking API
 * -----------
 * Maps the wizard's form values onto the backend `booking` payload (camelCase,
 * exactly what createBooking reads) and posts it to the real endpoint. The
 * booking page is auth-guarded, so the session cookie authorises the request
 * and the booking is tied to the signed-in customer. Selected add-ons are the
 * chosen special-request ids; the service/city ids are sent as-is.
 */

const ref = (id) => `CC-${String(id).slice(-6).toUpperCase()}`;

export function toBookingPayload(values) {
  const payload = {
    serviceId: values.serviceId,
    cityId: values.cityId,
    // Name and email are NOT sent: the server derives them from the signed-in
    // account (a user can't book under someone else's identity) and rejects them
    // as unknown fields. Phone is allowed (falls back to the account's number).
    customerPhone: values.phone,
    // Same posture as the phone: the server falls back to the account's value
    // and refuses the booking when neither carries one.
    customerPersonalId: values.personalId,
    streetName: values.street,
    houseNumber: values.houseNumber,
    propertySize: String(values.propertySize),
    doorbellName: values.doorbellName,
    bookingDate: values.date,
    bookingTime: values.time,
    // The wizard collects an Hours and a Minutes field; the API takes the one
    // canonical total (1 h 25 m -> 85). See utils/duration.js.
    durationMinutes: durationMinutesOf(values),
    cleaners: Number(values.cleaners),
    // totalAmount is computed and stored server-side from the service price,
    // the booked minutes and the selected add-ons — never trusted from the client.
    notes: values.notes || null,
    // Add-ons are SpecialRequest ids (validated server-side against enabled items).
    specialRequests: values.additionalServices || [],
    // Requested tools are CleaningTool ids (validated server-side against
    // enabled tools usable on the chosen service).
    cleaningTools: values.cleaningTools || [],
  };

  // `intervalDays: 0` is a UI-only one-time sentinel. The payment schema is
  // strict, so omit it completely unless this is actually a recurring booking.
  const intervalDays = Number(values.intervalDays);
  if (Number.isInteger(intervalDays) && intervalDays > 0) {
    payload.intervalDays = intervalDays;
  }

  return payload;
}

/*
 * There is deliberately no `createBooking` here.
 *
 * Customers book through the pay-first flow (features/booking/api/paymentApi.js:
 * createBookingIntent -> Stripe confirm -> finalizeBooking), which is the only
 * path that guarantees "no charge, no booking". `POST /booking` is now
 * admin-only (server/routers/booking.router.js) for manual walk-in/phone
 * bookings, so a customer-side helper for it could only ever return 403.
 *
 * The old helper also faked a `status: "confirmed"` result whenever the network
 * was unreachable, which would have shown a customer a confirmation for a
 * booking that was never created and never paid for.
 */

/**
 * Cancel one of the signed-in user's own bookings. The server enforces ownership
 * and only allows cancelling a pending/confirmed booking.
 */
export async function cancelMyBooking(id) {
  const res = await request({ method: "PATCH", url: `/booking/${id}/cancel` });
  const b = res?.booking ?? res;
  return { _id: b._id, status: b.status };
}

/**
 * Fetch the signed-in user's bookings (newest first) for the profile history,
 * straight from the database. Service/city ids are returned so the caller can
 * resolve their names from the live catalogues.
 */
export async function getMyBookings() {
  const res = await request({ method: "GET", url: "/booking/my" });
  const list = res?.bookings ?? res?.data?.bookings ?? [];
  // serviceId/cityId may be raw ids or populated `{ _id, name }` objects — keep
  // the id (the profile page resolves names from the live catalogues).
  const idOf = (v) => (v && typeof v === "object" ? v._id : v);
  return list.map((b) => ({
    _id: b._id,
    reference: ref(b._id),
    service_id: idOf(b.serviceId),
    city_id: idOf(b.cityId),
    booking_date: b.bookingDate,
    booking_time: b.bookingTime,
    total_amount: b.totalAmount,
    status: b.status,
    special_requests: b.specialRequests ?? [],
  }));
}
