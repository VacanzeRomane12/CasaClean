// Booking domain service
// ----------------------
// Shared, fail-closed booking logic used by both the booking controller (admin
// manual bookings, edits) and the payment controller (customer online bookings).
// Centralising it here means service/city/add-on resolution and SERVER-SIDE
// pricing live in exactly one place and are never duplicated or bypassed.

const mongoose = require('mongoose');

const SpecialRequest = require('../models/specialRequest.model');
const CleaningTool = require('../models/cleaningTool.model');
const City = require('../models/city.model');
const Service = require('../models/service.model');

const AppError = require('../utils/appError.util');
const {
  MIN_INTERVAL_DAYS,
  MAX_INTERVAL_DAYS,
  isValidIntervalDays
} = require('../utils/date.util');
// Durations are total minutes; formatDuration keeps raw minute counts out of
// customer text ("1 h 25 min", never "85").
const { formatDuration, durationInMinutes } = require('../utils/duration.util');
// Every booking waits out the advance notice unless its service opts out.
const {
  ADVANCE_BOOKING_HOURS,
  allowsInstantBooking,
  earliestBookableStart,
  meetsAdvanceNotice
} = require('../utils/leadTime.util');
// Pricing crosses to integer cents so an exact-minute duration lands on a real
// amount of money rather than a float that later rounds twice.
const { toMinorUnits, fromMinorUnits } = require('../utils/money.util');
// Catalogue prices are VAT-exclusive; VAT is added on top for whoever owes it,
// which depends on their (verified) tax status. See utils/tax.util.js.
const { priceForCustomer } = require('../utils/tax.util');
// The refund email states the window a late cancellation fell inside.
const { CANCELLATION_WINDOW_HOURS } = require('../utils/cancellation.util');

/**
 * Single source of truth for booking price. Cleaners multiply labour only.
 *
 * A duration is an exact number of MINUTES, so the labour is a per-hour rate
 * pro-rated over the minutes booked: €20/h × 85 min × 1 cleaner = €28.33. The
 * whole calculation runs in integer cents and rounds exactly once, at the end of
 * the labour term — pro-rating in euros and rounding later lets the usual float
 * artefacts (85/60 × 20 = 28.333333333333336) reach a charged amount.
 *
 * Add-on and tool prices are flat catalogue amounts; they are converted to cents
 * and summed rather than added as floats, so the total is cent-exact whatever
 * the catalogue holds.
 *
 * @returns {number} the NET (VAT-exclusive) catalogue total, in decimal euros
 */
const computeBookingTotal = ({
  service,
  durationMinutes,
  cleaners,
  specialRequests = [],
  cleaningTools = []
}) => {
  const minutes = Number(durationMinutes);
  const crew = Number(cleaners);
  const rateCents = toMinorUnits(service.pricePerHour);

  // One rounding, on the whole labour term. Multiplying first keeps every digit
  // of the minute fraction in play before it is resolved to a cent.
  const labourCents = Math.round((rateCents * minutes * crew) / 60);

  const extrasCents = [...specialRequests, ...cleaningTools].reduce(
    (sum, item) => sum + toMinorUnits(item.price),
    0
  );

  return fromMinorUnits(labourCents + extrasCents);
};

/**
 * Validate the service/city pair selected for a booking.
 *
 * Fail-closed: both ids MUST be valid ObjectIds that resolve to an existing,
 * *enabled* Service/City document. When the service is offered only in specific
 * cities (allCities === false), the chosen city must be one of them.
 *
 * Returns { service, city } so callers can use service.pricePerHour for pricing
 * and city.workingHour* for the time-window check. `allowInstantBooking` comes
 * along for the same reason: whether the 48-hour notice applies is a property of
 * the SERVICE, and must be read from the stored document rather than the request.
 */
const resolveServiceAndCity = async (serviceId, cityId) => {
  if (
    !mongoose.Types.ObjectId.isValid(serviceId) ||
    !mongoose.Types.ObjectId.isValid(cityId)
  ) {
    throw new AppError("Invalid service or city id!", 400);
  }

  const [service, city] = await Promise.all([
    Service.findById(serviceId)
      .select("name enabled allCities cities allSpecialRequests specialRequests pricePerHour recurringEnabled recurringIntervalDays allowInstantBooking")
      .lean(),
    City.findById(cityId)
      .select("enabled workingHourStarts workingHourEnds")
      .lean()
  ]);

  // Combined existence/enabled message so we don't leak existing-but-disabled
  // vs. non-existent.
  if (!service || !service.enabled) {
    throw new AppError("The selected service does not exist or is unavailable!", 400);
  }
  if (!city || !city.enabled) {
    throw new AppError("The selected city does not exist or is unavailable!", 400);
  }

  // Coverage: a city-restricted service must actually serve the chosen city.
  if (!service.allCities) {
    const covered = (service.cities || []).some(
      (c) => String(c) === String(cityId)
    );
    if (!covered) {
      throw new AppError("The selected service is not available in the chosen city!", 400);
    }
  }

  return { service, city };
};

/**
 * Validate a booking's recurrence CHOICE — including the choice not to repeat —
 * against the service being booked.
 *
 * `recurringEnabled` is EXCLUSIVE, not additive: it doesn't add a repeating
 * option alongside the one-off one, it replaces it. A service that offers a
 * plan is sold *only* as a plan, so this guard fails closed in both directions:
 * a cadence on a one-off service is refused, and so is a one-off booking of a
 * recurring service. A service that pins an explicit cadence list may only
 * repeat on one of those; with no list the customer chooses freely inside
 * MIN_INTERVAL_DAYS..MAX_INTERVAL_DAYS.
 *
 * Called for every path that can create or continue a recurring plan — the
 * first on-session payment AND each unattended cycle — so turning recurrence off
 * on a service stops future charges instead of only hiding the option in the UI.
 *
 * @param {Object} service       resolved Service doc (from resolveServiceAndCity)
 * @param {number} [intervalDays] requested cadence in days; omitted/0 = one-off
 */
const assertRecurrenceAllowed = (service, intervalDays) => {
  const requested = Number(intervalDays);
  // Absent, null or 0 all mean "book this once". The wizard's one-time sentinel
  // is 0 and the API omits the field entirely; both land here.
  const wantsRecurrence = intervalDays !== undefined && intervalDays !== null && requested > 0;

  if (!service?.recurringEnabled) {
    // A one-off service booked once is the ordinary case — nothing to check.
    if (!wantsRecurrence) return;
    throw new AppError("The selected service can't be booked on a recurring schedule!", 400);
  }

  if (!wantsRecurrence) {
    throw new AppError("The selected service can only be booked on a recurring schedule!", 400);
  }

  const allowed = (service.recurringIntervalDays || []).map(Number);

  if (allowed.length > 0) {
    if (!allowed.includes(requested)) {
      throw new AppError(
        `This service can only repeat every ${allowed.join(', ')} days!`,
        400
      );
    }
    return;
  }

  if (!isValidIntervalDays(requested)) {
    throw new AppError(
      `A recurring booking must repeat every ${MIN_INTERVAL_DAYS} to ${MAX_INTERVAL_DAYS} days!`,
      400
    );
  }
};

// "HH:MM" -> minutes since midnight. Inputs are zero-padded and pre-validated
// (Zod TIME_REGEX / the city model's match rule), so a simple split is safe.
const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
};

// "YYYY-MM-DD" for a Date, in local time (the same calendar the stored booking
// date strings are written in).
const toDateStr = (date) => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, "0"),
  String(date.getDate()).padStart(2, "0")
].join("-");

/**
 * Validate a booking's slot: the advance notice, the city's working hours, and
 * the duration fitting inside them.
 *
 * This is THE authority on when a booking may start — the wizard mirrors it
 * (client/src/features/booking/utils/timeWindow.js) so the customer hears about
 * a bad slot early, but every path that can create or move a booking comes
 * through here. Fail-closed rules, in the order a customer would hit them:
 *
 *   1. ADVANCE NOTICE — the start must be at least ADVANCE_BOOKING_HOURS away,
 *      measured to the minute (16 Aug 15:00 → 18 Aug 15:00 at the earliest), so
 *      the visit can be staffed. A service with `allowInstantBooking` skips
 *      this rule and ONLY this rule.
 *   2. Not already past. Only reachable for an instant service, since rule 1
 *      otherwise puts the start two days out; it is what stops "today at 08:00"
 *      being bookable at 15:00.
 *   3. The START falls inside the chosen city's working hours.
 *   4. The END (start + duration) does not run past closing — checking only the
 *      start would let 16:30 × 8 h through a 09:00–17:30 window. Ending exactly
 *      at closing is fine; one minute later is not.
 *
 * The city carries a single daily schedule (models/city.model.js has no per-day
 * hours), so the same window applies to every date. If per-day schedules are
 * ever added, resolving them for `bookingDate` belongs right here.
 *
 * @param {Object} city             city doc with workingHourStarts/workingHourEnds
 * @param {string} bookingDate      "YYYY-MM-DD"
 * @param {string} bookingTime      "HH:MM"
 * @param {number} durationMinutes  visit length in total minutes
 * @param {Object} [options]
 * @param {Object} [options.service] the resolved service, for allowInstantBooking
 * @param {Date}   [options.now]     injectable clock (tests)
 */
const assertBookingWindow = (
  city,
  bookingDate,
  bookingTime,
  durationMinutes,
  { service = null, now = new Date() } = {}
) => {
  const start = toMinutes(bookingTime);
  const opens = toMinutes(city.workingHourStarts);
  const closes = toMinutes(city.workingHourEnds);
  const minutes = Number(durationMinutes);

  const instant = allowsInstantBooking(service);

  // Rule 1 — the notice period, unless this service sells same-day slots.
  if (!instant && !meetsAdvanceNotice(bookingDate, bookingTime, now)) {
    const earliest = earliestBookableStart(now);
    throw new AppError(
      `Bookings must be made at least ${ADVANCE_BOOKING_HOURS} hours in advance — ` +
      `the earliest slot for this service is ${toDateStr(earliest)} at ` +
      `${String(earliest.getHours()).padStart(2, "0")}:${String(earliest.getMinutes()).padStart(2, "0")}.`,
      400
    );
  }

  // Rule 2 — a start that has already gone. Same-day only; `<=` because the
  // current minute is already being lived through.
  if (
    bookingDate === toDateStr(now) &&
    start <= now.getHours() * 60 + now.getMinutes()
  ) {
    throw new AppError("Booking time for today must be in the future!", 400);
  }

  // Rule 3 — inside the working day at all.
  if (start < opens || start >= closes) {
    throw new AppError("Booking time is outside city working hours", 400);
  }

  // Rule 4 — long enough before closing to actually finish.
  if (start + minutes > closes) {
    throw new AppError(
      `A ${formatDuration(minutes)} booking starting at ${bookingTime} would run past the city's closing time (${city.workingHourEnds}).`,
      400
    );
  }
};

/**
 * Validate the special-request add-ons selected for a booking.
 *
 * Returns the full resolved SpecialRequest documents (so callers can sum their
 * `price`). All ids must resolve to real, *enabled* catalogue items; when a
 * `service` is supplied and it restricts its add-ons (allSpecialRequests ===
 * false), every selected id must be one the service actually offers.
 */
const resolveSpecialRequests = async (ids, service = null) => {
  // Nothing selected is perfectly valid — special requests are optional.
  if (!ids) return [];

  if (!Array.isArray(ids)) {
    throw new AppError("specialRequests must be an array of ids!", 400);
  }

  if (ids.length === 0) return [];

  // Drop duplicates (e.g. the same add-on sent twice from the UI).
  const uniqueIds = [...new Set(ids.map(String))];

  if (!uniqueIds.every((id) => mongoose.Types.ObjectId.isValid(id))) {
    throw new AppError("One or more special request ids are invalid!", 400);
  }

  const foundDocs = await SpecialRequest.find({
    _id: { $in: uniqueIds },
    enabled: true
  }).select("_id price").lean();

  if (foundDocs.length !== uniqueIds.length) {
    throw new AppError("One or more selected special requests do not exist or are unavailable!", 400);
  }

  // Service/add-on compatibility: a service that lists explicit add-ons may only
  // be booked with those add-ons.
  if (service && !service.allSpecialRequests) {
    const allowed = new Set((service.specialRequests || []).map(String));
    if (!uniqueIds.every((id) => allowed.has(id))) {
      throw new AppError("One or more selected special requests are not available for this service!", 400);
    }
  }

  return foundDocs;
};

/**
 * Validate the cleaning tools selected for a booking.
 *
 * Returns the full resolved CleaningTool documents (so callers can sum their
 * `price`). All ids must resolve to real, *enabled* catalogue items. The
 * service restriction lives on the TOOL side (the mirror of special requests):
 * a tool with an explicit `services` list may only be booked with one of those
 * services; an empty list means the tool is usable on every service.
 */
const resolveCleaningTools = async (ids, service = null) => {
  // Nothing selected is perfectly valid — cleaning tools are optional.
  if (!ids) return [];

  if (!Array.isArray(ids)) {
    throw new AppError("cleaningTools must be an array of ids!", 400);
  }

  if (ids.length === 0) return [];

  // Drop duplicates (e.g. the same tool sent twice from the UI).
  const uniqueIds = [...new Set(ids.map(String))];

  if (!uniqueIds.every((id) => mongoose.Types.ObjectId.isValid(id))) {
    throw new AppError("One or more cleaning tool ids are invalid!", 400);
  }

  const foundDocs = await CleaningTool.find({
    _id: { $in: uniqueIds },
    enabled: true
  }).select("_id price services").lean();

  if (foundDocs.length !== uniqueIds.length) {
    throw new AppError("One or more selected cleaning tools do not exist or are unavailable!", 400);
  }

  // Service/tool compatibility: a tool that lists explicit services may only be
  // used with one of them.
  if (service) {
    const incompatible = foundDocs.some(
      (tool) =>
        (tool.services || []).length > 0 &&
        !tool.services.some((s) => String(s) === String(service._id))
    );
    if (incompatible) {
      throw new AppError("One or more selected cleaning tools are not available for this service!", 400);
    }
  }

  return foundDocs;
};

/**
 * Validate, resolve and PRICE a customer self-booking, returning a fully-formed
 * draft ready to store (PendingBooking) and later persist (Booking.create).
 *
 * This is the single fail-closed entry point for the online payment flow: the
 * total is computed here from DB prices and is NEVER trusted from the client.
 * The customer is always the signed-in user — admin "on behalf" bookings go
 * through the separate manual-booking path — so identity is taken from `user`.
 *
 * @param {Object} payload  validated booking body (createBookingSchema shape)
 * @param {Object} user     req.user (the signed-in customer)
 * @returns {Promise<Object>} draft booking fields incl. server-computed totalAmount
 */
const buildValidatedBookingDraft = async (payload, user) => {
  const {
    serviceId, cityId, streetName, houseNumber, propertySize,
    doorbellName, bookingDate, bookingTime, durationMinutes, cleaners,
    notes, specialRequests, cleaningTools, supplies
  } = payload;

  // Required-field guard (numeric fields checked against undefined so a legit 0
  // wouldn't be rejected — the Zod min rules already reject 0 upstream).
  if (
    serviceId === undefined || cityId === undefined || !streetName ||
    !houseNumber || !propertySize || !doorbellName || !bookingDate ||
    !bookingTime || durationMinutes === undefined || cleaners === undefined
  ) {
    throw new AppError("Please provide all required fields for booking!", 400);
  }

  const customerName = user.fullname;
  const customerEmail = user.email;
  const customerPhone = payload.customerPhone || user.phone;
  // The identification number has the phone's posture: offered on the
  // account, required here, with the request winning over the profile.
  const customerPersonalId = payload.customerPersonalId || user.personalId;

  if (!customerName || !customerEmail) {
    throw new AppError("Your account is missing a name or email — please update your profile.", 400);
  }
  if (!customerPhone) {
    throw new AppError("Please add a phone number to your profile or provide one for this booking!", 400);
  }
  if (!customerPersonalId) {
    throw new AppError("Please add your personal ID number to your profile or provide one for this booking!", 400);
  }

  const { service, city } = await resolveServiceAndCity(serviceId, cityId);

  // The recurrence choice — including its absence — has to match what THIS
  // service sells: a cadence only exists if the service repeats, and a service
  // that repeats is sold only as a plan. Checked here, inside the single
  // fail-closed entry point, so the payment controller can't create an intent
  // for a plan that can never repeat, nor for a one-off of a plan-only service.
  assertRecurrenceAllowed(service, payload.intervalDays);

  // 48 hours' notice (unless the service sells same-day), a start inside the
  // city's working hours, an end before closing, and nothing in the past.
  assertBookingWindow(city, bookingDate, bookingTime, durationMinutes, { service });

  // Independent lookups (both only need `service`, already resolved above), so
  // they go out together — this is on the path of every payment intent.
  const [resolvedSpecialRequests, resolvedCleaningTools] = await Promise.all([
    resolveSpecialRequests(specialRequests, service),
    resolveCleaningTools(cleaningTools, service)
  ]);

  // Server-side price: pricePerHour pro-rated over the booked minutes + the
  // add-on and tool prices. Never trusted from the client. This is the NET
  // catalogue total — VAT-exclusive, exactly what the site advertises.
  const netTotal = computeBookingTotal({
    service,
    durationMinutes,
    cleaners,
    specialRequests: resolvedSpecialRequests,
    cleaningTools: resolvedCleaningTools
  });

  // Then the VAT treatment. Everyone pays the catalogue price plus VAT, except a
  // business whose VAT number Stripe has verified — no VAT is added and they
  // account for it themselves (EU reverse charge). Resolved from the STORED user
  // document — a body claiming to be a business would otherwise be a
  // self-service discount.
  const { totalAmount, tax } = priceForCustomer(netTotal, user);

  return {
    user: user._id,
    serviceId,
    cityId,
    serviceName: service.name,
    customerName,
    customerEmail,
    customerPhone,
    customerPersonalId,
    streetName,
    houseNumber,
    propertySize,
    doorbellName,
    bookingDate,
    bookingTime,
    durationMinutes,
    cleaners,
    totalAmount,
    tax,
    notes: notes ?? null,
    specialRequests: resolvedSpecialRequests.map((sr) => sr._id),
    cleaningTools: resolvedCleaningTools.map((ct) => ct._id),
    supplies: Array.isArray(supplies) ? supplies : []
  };
};

/* ----------------------------------------------------- Email rendering ---- */

// Escape user-provided values before interpolating them into HTML email so a
// name/address/etc. can never inject markup.
const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatEuro = (n) =>
  new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(
    Number(n) || 0
  );

/**
 * Build the booking-confirmation email (branded, email-client-safe HTML + a
 * plain-text fallback). All interpolated user values pass through escapeHtml.
 * Now also surfaces that payment has been received.
 */
const renderBookingConfirmationEmail = ({
  customerName, serviceName, bookingDate, bookingTime,
  durationMinutes, hours, cleaners, streetName, houseNumber, totalAmount,
  recurring = false
}) => {
  const subject = "CasaClean — Your booking is confirmed 🎉";
  const name = escapeHtml(customerName);
  // Callers pass minutes; `hours` is tolerated for a legacy record being
  // re-rendered (see durationInMinutes).
  const minutes = durationInMinutes({ durationMinutes, hours });
  const total = formatEuro(totalAmount);
  const address =
    [streetName, houseNumber ? `No. ${houseNumber}` : ""].filter(Boolean).join(", ");

  const rows = [
    ["Service", serviceName || "Cleaning service"],
    ["Date", bookingDate],
    ["Time", bookingTime],
    ["Duration", `${formatDuration(minutes)} · ${cleaners} cleaner(s)`],
    ["Address", address || "—"],
    ...(recurring ? [["Plan", "Recurring service"]] : []),
    ["Payment", `${total} — paid`],
  ];

  const detailRows = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:12px 0;color:#64748b;font-size:14px;">${escapeHtml(label)}</td>
          <td style="padding:12px 0;color:#0f172a;font-size:14px;font-weight:600;text-align:right;">${escapeHtml(value)}</td>
        </tr>`
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.08);">
            <tr>
              <td style="background-color:#0f766e;padding:32px 40px;text-align:center;">
                <div style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:0.5px;">CasaClean</div>
                <div style="color:#99f6e4;font-size:14px;margin-top:4px;">Booking Confirmation</div>
              </td>
            </tr>
            <tr>
              <td style="padding:36px 40px 8px;text-align:center;">
                <div style="width:56px;height:56px;line-height:56px;border-radius:28px;background-color:#ecfdf5;color:#0d9488;font-size:28px;margin:0 auto;">&#10003;</div>
                <h1 style="margin:20px 0 6px;color:#0f172a;font-size:22px;font-weight:700;">Thank you, ${name}!</h1>
                <p style="margin:0;color:#64748b;font-size:15px;">Your reservation has been successfully confirmed and paid.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 40px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;">
                  ${detailRows}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 8px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0fdfa;border-radius:12px;">
                  <tr>
                    <td style="padding:16px 20px;color:#0f766e;font-size:15px;font-weight:600;">Total paid</td>
                    <td style="padding:16px 20px;color:#0f766e;font-size:20px;font-weight:700;text-align:right;">${escapeHtml(total)}</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 40px 36px;text-align:center;">
                <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.6;">
                  Need to make a change? Just reply to this email and our team will help.<br />
                  &copy; ${new Date().getFullYear()} CasaClean. All rights reserved.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text =
    `Hello ${customerName},\n\n` +
    `Your CasaClean booking is confirmed and paid.\n\n` +
    `Service:  ${serviceName || "Cleaning service"}\n` +
    `Date:     ${bookingDate}\n` +
    `Time:     ${bookingTime}\n` +
    `Duration: ${formatDuration(minutes)} (${cleaners} cleaner(s))\n` +
    `Address:  ${address || "—"}\n` +
    `${recurring ? "Plan:     Recurring service\n" : ""}` +
    `Paid:     ${total}\n\n` +
    `Thank you for choosing CasaClean!`;

  return { subject, html, text };
};

/**
 * Build the cancellation/refund email. Sent (best-effort) when a paid booking is
 * cancelled and its charge is refunded.
 *
 * `amount` is what was actually returned. A late cancellation keeps a one-hour
 * fee out of the charge, so pass `fee` (and the `charged` total it came out of)
 * to have the email account for the difference — a customer who sees less back
 * than they paid must be told why in the same message, not left to work it out.
 */
const renderRefundEmail = ({ customerName, serviceName, bookingDate, amount, fee = 0, charged }) => {
  const partial = Number(fee) > 0;
  const subject = partial
    ? "CasaClean — Your booking was cancelled & partially refunded"
    : "CasaClean — Your booking was cancelled & refunded";
  const name = escapeHtml(customerName);
  const total = formatEuro(amount);
  const feeNote = partial
    ? ` As the cancellation came within ${CANCELLATION_WINDOW_HOURS} hours of the appointment, ` +
      `a late-cancellation fee of ${formatEuro(fee)} (one hour of the booked cleaning) was kept ` +
      `from the ${formatEuro(charged ?? Number(amount) + Number(fee))} paid.`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.08);">
            <tr>
              <td style="background-color:#0f766e;padding:32px 40px;text-align:center;">
                <div style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:0.5px;">CasaClean</div>
                <div style="color:#99f6e4;font-size:14px;margin-top:4px;">Booking Cancelled</div>
              </td>
            </tr>
            <tr>
              <td style="padding:36px 40px;text-align:center;">
                <h1 style="margin:0 0 8px;color:#0f172a;font-size:22px;font-weight:700;">Hello ${name},</h1>
                <p style="margin:0;color:#64748b;font-size:15px;line-height:1.6;">
                  Your booking for <strong>${escapeHtml(serviceName || "Cleaning service")}</strong>
                  on <strong>${escapeHtml(bookingDate)}</strong> has been cancelled.
                  A refund of <strong>${escapeHtml(total)}</strong> has been issued to your
                  original payment method and should appear within a few business days.${escapeHtml(feeNote)}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 36px;text-align:center;">
                <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.6;">
                  &copy; ${new Date().getFullYear()} CasaClean. All rights reserved.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text =
    `Hello ${customerName},\n\n` +
    `Your CasaClean booking for ${serviceName || "Cleaning service"} on ${bookingDate} has been cancelled.\n` +
    `A refund of ${total} has been issued to your original payment method and should appear within a few business days.` +
    `${feeNote}\n\n` +
    `— CasaClean`;

  return { subject, html, text };
};

/**
 * Copy for each status a booking can be moved into, keyed by the stored enum
 * value (models/booking.model.js). One entry per status so the set can't drift:
 * a status with no entry here simply doesn't notify, rather than emailing an
 * empty shell.
 *
 * Each entry is written from the CUSTOMER's side of the change — "we're
 * reviewing it", not "an admin set status=pending" — because that is who reads
 * it. `headline` is the coloured strip under the logo, `lead` the sentence that
 * carries the news, and `note` the one thing they might need to do next.
 */
const STATUS_EMAIL_COPY = {
  pending: {
    label: "Awaiting confirmation",
    subject: "CasaClean — Your booking is being reviewed",
    lead: "is now waiting on our confirmation. We're checking crew availability for that slot and will write again as soon as it's settled.",
    note: "No action is needed from you in the meantime."
  },
  confirmed: {
    label: "Booking confirmed",
    subject: "CasaClean — Your booking is confirmed",
    lead: "is confirmed. Our team is scheduled and will arrive at the address below on the day.",
    note: "Please make sure someone can let the cleaners in, or leave access instructions by replying to this email."
  },
  completed: {
    label: "Cleaning completed",
    subject: "CasaClean — Your cleaning is complete",
    lead: "is now marked as completed. Thank you for having us — we hope the place looks exactly as you wanted.",
    note: "You can rate this visit from your bookings page; it takes a minute and it's how we keep our crews sharp."
  },
  cancelled: {
    label: "Booking cancelled",
    subject: "CasaClean — Your booking was cancelled",
    lead: "has been cancelled and the slot released. No cleaners will come to the address.",
    note: "If this is unexpected, just reply to this email and we'll sort it out."
  }
};

/**
 * Build the "your booking's status changed" email.
 *
 * Sent when the team moves a booking to a new state from the admin panel —
 * confirming a pending request, marking a visit completed, cancelling a slot.
 * It is deliberately NOT sent for the two moments that already have a dedicated
 * message: the confirmation-and-receipt on first payment, and the refund email
 * when a cancellation returns money. A customer should get one email per thing
 * that happened, not two describing it differently.
 *
 * Returns null for a status with no copy above, which is the caller's signal to
 * send nothing at all.
 *
 * @param {Object}  opts
 * @param {string}  opts.status         the NEW status (booking enum value)
 * @param {string}  [opts.previousStatus] where it came from, shown as context
 * @returns {{ subject: string, html: string, text: string }|null}
 */
const renderBookingStatusEmail = ({
  customerName, serviceName, bookingDate, bookingTime,
  durationMinutes, hours, cleaners, streetName, houseNumber,
  status, previousStatus
}) => {
  const copy = STATUS_EMAIL_COPY[status];
  if (!copy) return null;

  const name = escapeHtml(customerName);
  const service = serviceName || "Cleaning service";
  const minutes = durationInMinutes({ durationMinutes, hours });
  const address =
    [streetName, houseNumber ? `No. ${houseNumber}` : ""].filter(Boolean).join(", ");

  const rows = [
    ["Service", service],
    ["Date", bookingDate],
    ["Time", bookingTime],
    // A cancelled booking has no crew to describe any more, so the operational
    // rows are dropped rather than stated in the past tense.
    ...(status === "cancelled"
      ? []
      : [
          ["Duration", `${formatDuration(minutes)} · ${cleaners} cleaner(s)`],
          ["Address", address || "—"]
        ]),
    ["Status", copy.label],
    ...(previousStatus && previousStatus !== status
      ? [["Previously", STATUS_EMAIL_COPY[previousStatus]?.label || previousStatus]]
      : [])
  ];

  const detailRows = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:12px 0;color:#64748b;font-size:14px;">${escapeHtml(label)}</td>
          <td style="padding:12px 0;color:#0f172a;font-size:14px;font-weight:600;text-align:right;">${escapeHtml(value)}</td>
        </tr>`
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.08);">
            <tr>
              <td style="background-color:#0f766e;padding:32px 40px;text-align:center;">
                <div style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:0.5px;">CasaClean</div>
                <div style="color:#99f6e4;font-size:14px;margin-top:4px;">${escapeHtml(copy.label)}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:36px 40px 8px;">
                <h1 style="margin:0 0 10px;color:#0f172a;font-size:22px;font-weight:700;">Hello ${name},</h1>
                <p style="margin:0;color:#64748b;font-size:15px;line-height:1.6;">
                  Your booking for <strong style="color:#0f172a;">${escapeHtml(service)}</strong>
                  on <strong style="color:#0f172a;">${escapeHtml(bookingDate)}</strong>
                  ${escapeHtml(copy.lead)}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 40px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;">
                  ${detailRows}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0fdfa;border-radius:12px;">
                  <tr>
                    <td style="padding:16px 20px;color:#0f766e;font-size:14px;line-height:1.6;">${escapeHtml(copy.note)}</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 40px 36px;text-align:center;">
                <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.6;">
                  Need to make a change? Just reply to this email and our team will help.<br />
                  &copy; ${new Date().getFullYear()} CasaClean. All rights reserved.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text =
    `Hello ${customerName},\n\n` +
    `Your CasaClean booking for ${service} on ${bookingDate} ${copy.lead}\n\n` +
    `Service:  ${service}\n` +
    `Date:     ${bookingDate}\n` +
    `Time:     ${bookingTime}\n` +
    (status === "cancelled"
      ? ""
      : `Duration: ${formatDuration(minutes)} (${cleaners} cleaner(s))\n` +
        `Address:  ${address || "—"}\n`) +
    `Status:   ${copy.label}\n\n` +
    `${copy.note}\n\n` +
    `— CasaClean`;

  return { subject: copy.subject, html, text };
};

module.exports = {
  computeBookingTotal,
  resolveServiceAndCity,
  resolveSpecialRequests,
  resolveCleaningTools,
  assertBookingWindow,
  assertRecurrenceAllowed,
  buildValidatedBookingDraft,
  renderBookingConfirmationEmail,
  renderRefundEmail,
  renderBookingStatusEmail,
  formatEuro
};
