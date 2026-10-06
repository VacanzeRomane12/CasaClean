// Modules
const mongoose = require('mongoose');

// Models
const Booking = require('../models/booking.model');
const SpecialRequest = require('../models/specialRequest.model');
const CleaningTool = require('../models/cleaningTool.model');
const User = require('../models/user.model');
const Worker = require('../models/worker.model');

// Utils
const catchAsync = require('../utils/catchAsync.util');
const AppError = require('../utils/appError.util');
const sendEmail = require('../utils/email.util');

// Shared booking logic (service/city + add-on resolution, pricing, emails) lives
// in the service layer so the payment controller can reuse it.
const {
  resolveServiceAndCity,
  resolveSpecialRequests,
  resolveCleaningTools,
  assertBookingWindow,
  computeBookingTotal,
  renderBookingConfirmationEmail,
  renderRefundEmail,
  renderBookingStatusEmail,
  formatEuro
} = require('../services/booking.service');

// Catalogue prices are VAT-exclusive; VAT is added on top unless the customer is
// a verified business.
const { priceForCustomer, applyTaxTreatment } = require('../utils/tax.util');

// Local-midnight date helpers — booking dates are YYYY-MM-DD strings, so a
// plain string comparison against today is a correct date comparison.
const { todayString } = require('../utils/date.util');
// A booking's length is total minutes; durationInMinutes also reads the legacy
// `hours` field on records written before that change.
const { durationInMinutes } = require('../utils/duration.util');

// Refund policy for a customer self-cancellation: a full refund when made at
// least CANCELLATION_WINDOW_HOURS before the appointment, and inside that window
// a refund of everything except a retained one-hour fee. Both rules live in
// utils/cancellation.util.js.
const {
  CANCELLATION_WINDOW_HOURS,
  isLateCancellation,
  lateCancellationSettlement
} = require('../utils/cancellation.util');

// Refund helper lives in the payment controller (it talks to Stripe). Used when
// a paid booking is cancelled (by the user or an admin).
const { refundBookingPayment } = require('../controllers/payment.controller');

/**
 * Validate the cleaning staff assigned to a booking.
 *
 * Admin-only at the call site. Fail-closed: every id must be a valid ObjectId
 * pointing to an existing Worker. Unlike special requests we do NOT require the
 * worker to be `enabled` — disabling a worker (e.g. on leave) shouldn't make an
 * existing booking impossible to re-save. Ids are de-duplicated and returned as
 * ObjectIds ready to store on the booking. An empty/absent list resolves to [].
 */
const resolveWorkers = async (ids) => {
  if (!ids) return [];

  if (!Array.isArray(ids)) {
    throw new AppError("workers must be an array of ids!", 400);
  }

  if (ids.length === 0) return [];

  const uniqueIds = [...new Set(ids.map(String))];

  if (!uniqueIds.every((id) => mongoose.Types.ObjectId.isValid(id))) {
    throw new AppError("One or more worker ids are invalid!", 400);
  }

  const foundDocs = await Worker.find({ _id: { $in: uniqueIds } })
    .select("_id")
    .lean();

  if (foundDocs.length !== uniqueIds.length) {
    throw new AppError("One or more selected workers do not exist!", 400);
  }

  return foundDocs.map((w) => w._id);
};

// GET /api/v1/booking (admin) — paginated list, newest first.
// Optional filters: ?status=confirmed  ?from=2026-07-01  ?to=2026-07-31
// (from/to bound bookingDate; "YYYY-MM-DD" strings compare lexicographically).
const getBookings = catchAsync(async (req, res, next) => {
  // Query params arrive as strings; sanitise into safe, bounded numbers so a
  // missing/garbage value can't turn the skip/limit maths into NaN.
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));

  // Filters are whitelisted/format-checked at the point of use (req.query is
  // not covered by sanitizeMongo) — never passed into the filter raw.
  const filter = {};
  const VALID_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed'];
  if (VALID_STATUSES.includes(req.query.status)) {
    filter.status = req.query.status;
  }
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const from = DATE_RE.test(String(req.query.from)) ? req.query.from : null;
  const to = DATE_RE.test(String(req.query.to)) ? req.query.to : null;
  if (from || to) {
    filter.bookingDate = {
      ...(from ? { $gte: from } : {}),
      ...(to ? { $lte: to } : {})
    };
  }

  const hasFilter = Object.keys(filter).length > 0;

  // Run the page query and the total count in parallel (independent reads).
  const [bookings, bookingCount] = await Promise.all([
    Booking.find(filter)
      .populate('serviceId', 'name')
      .populate('cityId', 'name')
      .populate('specialRequests', 'name price')
      .populate('cleaningTools', 'name price')
      .populate('workers', 'fullname')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    // No filter -> estimatedDocumentCount reads collection metadata (O(1))
    // instead of scanning every document like countDocuments() would.
    hasFilter ? Booking.countDocuments(filter) : Booking.estimatedDocumentCount()
  ]);

  res.status(200).json({
    status: "success",
    message: "Bookings returned successfully!",
    bookingCount,
    data: { bookings }
  });
});

// GET /api/v1/booking/my — the signed-in user's own bookings, newest first
const getMyBookings = catchAsync(async (req, res, next) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));

  // Scoped to req.user so a user only ever sees their own bookings.
  const filter = { user: req.user._id };

  const [bookings, bookingCount] = await Promise.all([
    Booking.find(filter)
      .populate('serviceId', 'name')
      .populate('cityId', 'name')
      .populate('specialRequests', 'name price')
      .populate('cleaningTools', 'name price')
      .populate('workers', 'fullname')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Booking.countDocuments(filter)
  ]);

  res.status(200).json({
    status: "success",
    message: "Your bookings returned successfully!",
    bookingCount,
    data: { bookings }
  });
});

// GET /api/v1/booking/:id (admin) — single booking (404 if missing, 400 if id malformed)
const getBookingById = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const booking = await Booking.findById(id)
    .populate('serviceId', 'name')
    .populate('cityId', 'name')
    .populate('specialRequests', 'name price')
    .populate('cleaningTools', 'name price')
    .populate('workers', 'fullname')
    .lean();

  if (!booking) {
    return next(new AppError("Booking not found!", 404));
  }

  res.status(200).json({
    status: "success",
    message: "Booking returned successfully!",
    data: { booking }
  });
});

// POST /api/v1/booking — create a booking (requires a signed-in user)
const createBooking = catchAsync(async (req, res, next) => {
  const isAdmin = req.user.role === 'admin';

  // "On behalf" = an admin explicitly booking FOR a customer, signalled by
  // supplying a linked account (userId) and/or typed customer name/email.
  // Everything else is a SELF-booking owned by req.user with their own details:
  //  • any normal user (body name/email are ignored — no identity spoofing), and
  //  • an admin booking through the public wizard for themselves (which sends no
  //    customer-identity fields). This is why we key off the supplied data, not
  //    the role alone — otherwise an admin could never book for themselves.
  const onBehalf =
    isAdmin && Boolean(req.body.userId || req.body.customerName || req.body.customerEmail);

  let owner = req.user._id;
  let profile = req.user;

  if (onBehalf) {
    if (req.body.userId) {
      // The tax fields come along because the booking is priced against the
      // LINKED customer's VAT status, not the admin's.
      const linked = await User.findById(req.body.userId)
        .select('fullname email phone personalId customerType vatNumber vatStatus companyName');
      if (!linked) {
        return next(new AppError("The linked customer account does not exist!", 400));
      }
      owner = linked._id;
      profile = linked;
    } else {
      owner = undefined; // walk-in / phone booking not tied to an account
      profile = null;
    }
  }

  const customerName = onBehalf
    ? (req.body.customerName || profile?.fullname)
    : req.user.fullname;
  const customerEmail = onBehalf
    ? (req.body.customerEmail || profile?.email)
    : req.user.email;
  const customerPhone = onBehalf
    ? (req.body.customerPhone || profile?.phone)
    : (req.body.customerPhone || req.user.phone);
  // Resolved like the phone but never refused: this admin-only path is the
  // escape hatch for recording a walk-in, and the number may not be at hand.
  // The customer self-service path (buildValidatedBookingDraft) requires it.
  const customerPersonalId = onBehalf
    ? (req.body.customerPersonalId || profile?.personalId)
    : (req.body.customerPersonalId || req.user.personalId);

  // Booking-specific fields — the only things the wizard actually collects.
  const {
    serviceId, cityId, streetName, houseNumber, propertySize,
    doorbellName, bookingDate, bookingTime, durationMinutes, cleaners,
    notes, specialRequests, cleaningTools, supplies, workers
  } = req.body;

  // Required-field guard. Numeric fields are compared against undefined (not
  // truthiness) so a legitimate 0 isn't rejected.
  if (
    serviceId === undefined || cityId === undefined || !streetName ||
    !houseNumber || !propertySize || !doorbellName || !bookingDate ||
    !bookingTime || durationMinutes === undefined || cleaners === undefined
  ) {
    return next(new AppError("Please provide all required fields for booking!", 400));
  }

  if (!customerName || !customerEmail) {
    return next(new AppError("Please provide the customer's name and email!", 400));
  }

  if (!customerPhone) {
    return next(new AppError("Please add a phone number to your profile or provide one for this booking!", 400));
  }

  // Validate the service/city pair (existence, enabled state, coverage).
  // Now returns both the service (for price computation) and the city
  // (for working-hours check). Fix 1 + Fix 3.
  const { service, city } = await resolveServiceAndCity(serviceId, cityId);

  // Advance notice (unless the service sells same-day), start inside working
  // hours, end before closing, and nothing in the past. An admin booking is held
  // to the same slot rules as a customer's: the crew still has to get there.
  assertBookingWindow(city, bookingDate, bookingTime, durationMinutes, { service });

  // Make sure any selected add-ons are real, enabled, and offered by the
  // service. Returns full documents so we can sum prices (Fix 1).
  // Same fail-closed gate for the tool catalogue: every tool must be real,
  // enabled and usable on the chosen service. And worker assignment is an
  // admin-only concern — a normal customer's `workers` (even if smuggled past
  // the optional schema) is ignored; only an admin creating a booking on a
  // customer's behalf can assign staff.
  //
  // All three are independent of one another (the first two need only `service`,
  // resolved above), so they are resolved in one parallel batch instead of three
  // serial round trips.
  const [resolvedSpecialRequests, resolvedCleaningTools, assignedWorkers] = await Promise.all([
    resolveSpecialRequests(specialRequests, service),
    resolveCleaningTools(cleaningTools, service),
    isAdmin ? resolveWorkers(workers) : []
  ]);

  // Fix 1: compute the booking total on the server — never trust the client.
  // specialRequests/cleaningTools now contain full documents with a `price` field.
  const netTotal = computeBookingTotal({
    service,
    durationMinutes,
    cleaners,
    specialRequests: resolvedSpecialRequests,
    cleaningTools: resolvedCleaningTools
  });

  // Apply the customer's VAT treatment to the net catalogue total. `profile` is
  // the LINKED account for an on-behalf booking, the admin for a self-booking,
  // and null for a walk-in — a walk-in has no verified VAT number, so it falls
  // through to the standard treatment, which is the right default.
  const { totalAmount: computedTotal, tax } = priceForCustomer(netTotal, profile);

  // Extract just the ids for storage (the Booking model stores ObjectId refs).
  const requestIds = resolvedSpecialRequests.map((sr) => sr._id);
  const toolIds = resolvedCleaningTools.map((ct) => ct._id);

  // Status is server-managed (the create schema rejects any client-supplied
  // value). An admin booking on a customer's behalf starts as 'pending' so it
  // can be reviewed/confirmed by staff; an admin booking for themselves is
  // 'confirmed' immediately (matching the model default).
  const status = onBehalf ? 'pending' : 'confirmed';

  // This endpoint is admin-only (customers pay online via /payment/booking/*),
  // so every booking created here is a MANUAL / offline (cash) booking:
  // no Stripe charge is taken. The money is settled out-of-band.
  // Whitelist exactly what we persist — we never spread req.body, so a caller
  // can't mass-assign server-managed fields (user/paymentIntentId/totalAmount).
  const booking = await Booking.create({
    user: owner,
    serviceId,
    cityId,
    customerName,
    customerEmail,
    customerPhone,
    ...(customerPersonalId ? { customerPersonalId } : {}),
    streetName,
    houseNumber,
    propertySize,
    doorbellName,
    bookingDate,
    bookingTime,
    durationMinutes,
    cleaners,
    totalAmount: computedTotal,
    tax,
    status,
    paymentMethod: 'manual',
    paymentStatus: 'manual',
    notes: notes ?? null,
    specialRequests: requestIds,
    cleaningTools: toolIds,
    supplies: Array.isArray(supplies) ? supplies : [],
    workers: assignedWorkers
  });

  // Confirmation email is best-effort: a mail failure must not fail the booking
  // that was already saved.
  try {
    const { subject, html, text } = renderBookingConfirmationEmail({
      customerName,
      serviceName: service?.name,
      bookingDate,
      bookingTime,
      durationMinutes,
      cleaners,
      streetName,
      houseNumber,
      totalAmount: computedTotal
    });
    await sendEmail({ email: customerEmail, subject, html, text });
  } catch (emailError) {
    console.error('Email send error:', emailError.message);
  }

  res.status(201).json({
    status: "success",
    message: "Booking created successfully!",
    data: { booking }
  });
});

// PATCH /api/v1/booking/:id (admin) — partial update
const editBooking = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  // Whitelist editable fields so an admin request can't overwrite ownership or
  // payment fields (user/paymentIntentId/...) by including them in the body.
  // totalAmount is intentionally excluded — price is server-managed (Fix 1).
  const editableFields = [
    'status', 'bookingDate', 'bookingTime', 'durationMinutes', 'cleaners',
    'streetName', 'houseNumber', 'propertySize',
    'doorbellName', 'customerPhone', 'customerPersonalId', 'notes', 'supplies'
  ];

  const updates = {};
  for (const field of editableFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }

  const srChanged = req.body.specialRequests !== undefined;
  const ctChanged = req.body.cleaningTools !== undefined;
  const statusChanged = updates.status !== undefined;
  const durationChanged = updates.durationMinutes !== undefined;
  const cleanersChanged = updates.cleaners !== undefined;
  const timeChanged = updates.bookingTime !== undefined;
  const dateChanged = updates.bookingDate !== undefined;

  // We only need the existing booking + its service/city when a change affects
  // add-on/tool eligibility, the price, or the working-hours window. For a pure
  // status/notes/address edit we skip the extra reads entirely.
  let existing = null;
  let service = null;
  let city = null;
  if (srChanged || ctChanged || durationChanged || cleanersChanged || timeChanged || dateChanged) {
    existing = await Booking.findById(id)
      // `tax` comes along so a reprice re-applies the treatment this booking was
      // originally priced under (see the reprice block below).
      // `hours` comes along beside `durationMinutes` so a booking written
      // before minute-level durations can still be re-priced and re-windowed.
      // `status` comes along so a status edit bundled with a reschedule can tell
      // a real transition from the admin form re-sending the value it already had.
      .select('serviceId cityId durationMinutes hours cleaners bookingDate bookingTime specialRequests cleaningTools tax status')
      .lean();
    if (!existing) {
      return next(new AppError("Booking not found!", 404));
    }
    // Re-use the booking's own service/city (already validated at create time)
    // to recover pricePerHour and the city working-hours window.
    ({ service, city } = await resolveServiceAndCity(
      String(existing.serviceId),
      String(existing.cityId)
    ));
  }

  // The status the booking is moving AWAY from. The panel re-sends every field
  // on each save, so `status` being present in the body says nothing on its own —
  // only a value that differs from this one is a transition worth telling the
  // customer about. Read from `existing` when a price/window change already
  // loaded it; otherwise one narrow projection, and only when status was sent.
  let previousStatus = null;
  if (statusChanged) {
    if (existing) {
      previousStatus = existing.status;
    } else {
      const current = await Booking.findById(id).select('status').lean();
      if (!current) {
        return next(new AppError("Booking not found!", 404));
      }
      previousStatus = current.status;
    }
  }

  // Only an actual RESCHEDULE into the past is rejected. The admin form
  // re-sends the booking's own date on every edit, and past bookings are
  // exactly the ones being marked completed / annotated / staffed after the
  // fact — so a blanket "no past dates" rule (which used to live in
  // editBookingSchema) made those edits impossible. An unchanged date always
  // passes, whatever it is.
  if (dateChanged && updates.bookingDate !== existing.bookingDate) {
    if (updates.bookingDate < todayString()) {
      return next(new AppError("Booking date can't be in the past!", 400, {
        bookingDate: ["Booking date can't be in the past!"]
      }));
    }
  }

  // Re-validate the working-hours window when the date, time OR duration
  // changes — a longer booking can run past closing even with the same start.
  if ((timeChanged || durationChanged || dateChanged) && city) {
    assertBookingWindow(
      city,
      dateChanged ? updates.bookingDate : existing.bookingDate,
      timeChanged ? updates.bookingTime : existing.bookingTime,
      durationChanged ? updates.durationMinutes : durationInMinutes(existing),
      // An admin RESCHEDULE is held to the working-hours rules, but not to the
      // advance notice: staffing a booking the team is already looking at is
      // exactly the judgement call the panel exists to make, and the 48-hour
      // rule would otherwise make it impossible to move tomorrow's visit an
      // hour later. The "not in the past" guard above still applies.
      { service: { allowInstantBooking: true } }
    );
  }

  // Changed references must still pass their fail-closed gates: special requests
  // and cleaning tools against the service compatibility rules (resolve* returns
  // full docs so we can also re-price below), and workers by existence. All three
  // are independent, so an edit touching several of them costs one round trip
  // rather than three. Each stays null/undefined when its field wasn't sent,
  // which is what the re-pricing block below keys off.
  const [resolvedSpecialRequests, resolvedCleaningTools, resolvedWorkers] = await Promise.all([
    srChanged ? resolveSpecialRequests(req.body.specialRequests, service) : null,
    ctChanged ? resolveCleaningTools(req.body.cleaningTools, service) : null,
    req.body.workers !== undefined ? resolveWorkers(req.body.workers) : undefined
  ]);

  if (srChanged) {
    updates.specialRequests = resolvedSpecialRequests.map((sr) => sr._id);
  }
  if (ctChanged) {
    updates.cleaningTools = resolvedCleaningTools.map((ct) => ct._id);
  }
  // An empty array clears the current assignment; ids are validated fail-closed.
  if (req.body.workers !== undefined) {
    updates.workers = resolvedWorkers;
  }

  // Recompute the server-managed total whenever a price input (duration,
  // cleaners, add-ons or tools) changes — otherwise the stored amount would
  // drift out of sync with the booking. Price = pricePerHour pro-rated over the
  // booked minutes + sum(add-on prices) + sum(tool surcharges).
  if ((durationChanged || cleanersChanged || srChanged || ctChanged) && service) {
    const finalMinutes = durationChanged
      ? updates.durationMinutes
      : durationInMinutes(existing);
    const finalCleaners = cleanersChanged ? updates.cleaners : existing.cleaners;

    let finalSpecialRequests;
    if (srChanged) {
      finalSpecialRequests = resolvedSpecialRequests;
    } else {
      // Something else changed but the add-ons didn't — price the existing ones.
      // Look up by id only (no `enabled` filter) so a since-disabled add-on
      // still counts.
      const existingDocs = await SpecialRequest
        .find({ _id: { $in: existing.specialRequests || [] } })
        .select('price')
        .lean();
      finalSpecialRequests = existingDocs;
    }

    // Same pattern for the tools: price the incoming selection when it changed,
    // otherwise the booking's existing ones (again without an `enabled` filter).
    let finalCleaningTools;
    if (ctChanged) {
      finalCleaningTools = resolvedCleaningTools;
    } else {
      const existingTools = await CleaningTool
        .find({ _id: { $in: existing.cleaningTools || [] } })
        .select('price')
        .lean();
      finalCleaningTools = existingTools;
    }

    const repricedNet = computeBookingTotal({
      service,
      durationMinutes: finalMinutes,
      cleaners: finalCleaners,
      specialRequests: finalSpecialRequests,
      cleaningTools: finalCleaningTools
    });

    // Re-apply the booking's OWN stored treatment rather than re-resolving it
    // from the customer's current profile. An edit changes what is owed, not who
    // the customer was when they booked — a business that has since let its VAT
    // registration lapse must not have an existing booking silently re-taxed.
    const repriced = applyTaxTreatment(repricedNet, existing.tax);
    updates.totalAmount = repriced.totalAmount;
    updates.tax = repriced.tax;
  }

  // Set once a refund email has gone out, so the status-change notification
  // below stands down: a cancellation that returned money is one event, and the
  // refund email already tells the customer the booking is off. Two emails about
  // the same cancellation read as two cancellations.
  let refundEmailSent = false;

  // An admin cancelling a booking must release the money too — a status flip to
  // 'cancelled' here can't be allowed to bypass the refund. Load the booking's
  // payment fields, refund a paid card booking, and merge the resulting payment
  // fields into the update so they persist atomically with the status change.
  if (updates.status === 'cancelled') {
    // Same atomic claim as the customer cancel path: exactly one caller may
    // transition a booking into 'cancelled', and only that caller performs the
    // refund. Without this, two concurrent admin cancels both see paymentStatus
    // 'paid' and both call Stripe. `returnDocument: 'before'` returns the
    // pre-update document.
    const claimed = await Booking.findOneAndUpdate(
      { _id: id, status: { $ne: 'cancelled' } },
      { $set: { status: 'cancelled' } },
      { returnDocument: 'before' }
    )
      .select('paymentMethod paymentStatus paymentIntentId status customerName customerEmail bookingDate totalAmount serviceId')
      .populate('serviceId', 'name');

    if (!claimed) {
      // Either the booking is gone, or it was already cancelled (in which case
      // there is nothing left to refund and the remaining edits still apply).
      const exists = await Booking.exists({ _id: id });
      if (!exists) {
        return next(new AppError("Booking not found!", 404));
      }
      // Losing the claim means somebody else performed this transition. Their
      // request is the one that notifies; drop ours so a double-click can't send
      // the customer two cancellation emails.
      previousStatus = 'cancelled';
    } else {
      // The claim read the document at the instant it changed, so this is the
      // authoritative "before" — more trustworthy than the projection above,
      // which was taken earlier in the request.
      previousStatus = claimed.status;

      let refundUpdate = null;
      try {
        refundUpdate = await refundBookingPayment(claimed);
      } catch (refundError) {
        // Never leave a booking cancelled while the customer is still charged.
        await Booking.updateOne({ _id: id }, { $set: { status: claimed.status } });
        return next(refundError);
      }

      if (refundUpdate) {
        Object.assign(updates, refundUpdate);

        // Best-effort refund email.
        try {
          const { subject, html, text } = renderRefundEmail({
            customerName: claimed.customerName,
            serviceName: claimed.serviceId?.name,
            bookingDate: claimed.bookingDate,
            amount: claimed.totalAmount
          });
          await sendEmail({ email: claimed.customerEmail, subject, html, text });
          refundEmailSent = true;
        } catch (emailError) {
          console.error('Refund email send error:', emailError.message);
        }
      }
    }
  }

  const booking = await Booking.findByIdAndUpdate(id, updates, {
    returnDocument: 'after',
    runValidators: true
  })
    .populate('serviceId', 'name')
    .populate('cityId', 'name')
    .populate('specialRequests', 'name price')
    .populate('cleaningTools', 'name price')
    .populate('workers', 'fullname');

  if (!booking) {
    return next(new AppError("Booking not found!", 404));
  }

  // Tell the customer their booking moved. Only on a REAL transition — the panel
  // re-sends every field on save, so an admin correcting a phone number while
  // the status stays 'confirmed' must not read as a fresh confirmation. Skipped
  // when the refund email above already covered this cancellation.
  //
  // Best-effort, and last: the edit is persisted by this point, so a dead SMTP
  // host costs the notification, never the change the admin just made.
  if (statusChanged && booking.status !== previousStatus && !refundEmailSent) {
    try {
      const rendered = renderBookingStatusEmail({
        customerName: booking.customerName,
        serviceName: booking.serviceId?.name,
        bookingDate: booking.bookingDate,
        bookingTime: booking.bookingTime,
        durationMinutes: durationInMinutes(booking),
        cleaners: booking.cleaners,
        streetName: booking.streetName,
        houseNumber: booking.houseNumber,
        status: booking.status,
        previousStatus
      });
      // null for a status the template has no copy for — send nothing rather
      // than an empty shell.
      if (rendered) {
        await sendEmail({
          email: booking.customerEmail,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text
        });
      }
    } catch (emailError) {
      console.error('Booking status email send error:', emailError.message);
    }
  }

  res.status(200).json({
    status: "success",
    message: "Booking updated successfully!",
    data: { booking }
  });
});

// PATCH /api/v1/booking/:id/cancel — a user cancels their OWN booking.
// Scoped to req.user so it can't touch anyone else's booking (admins use the
// admin PATCH route to change any status). Only a pending/confirmed booking can
// be cancelled — completed work and already-cancelled bookings are rejected.
const cancelMyBooking = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return next(new AppError("Invalid booking id!", 400));
  }

  // Claim the cancellation ATOMICALLY before touching Stripe. Two concurrent
  // cancels (a double-clicked button is enough) would otherwise both read
  // paymentStatus 'paid' and both issue a refund. `returnDocument: 'before'`
  // returns the PRE-update document, which carries the payment fields we need
  // plus the status to restore if the refund fails.
  // Ownership is enforced in the query itself: a booking that isn't the user's
  // simply isn't found (no information leak about other users' bookings).
  const booking = await Booking.findOneAndUpdate(
    { _id: id, user: req.user._id, status: { $in: ['pending', 'confirmed'] } },
    { $set: { status: 'cancelled' } },
    { returnDocument: 'before' }
  );

  if (!booking) {
    // Losing the claim is not automatically a 404 — distinguish "not yours /
    // doesn't exist" from a booking that simply isn't in a cancellable state.
    const current = await Booking.findOne({ _id: id, user: req.user._id })
      .select('status')
      .lean();
    if (!current) {
      return next(new AppError("Booking not found!", 404));
    }
    if (current.status === 'cancelled') {
      return next(new AppError("This booking is already cancelled.", 400));
    }
    return next(new AppError("A completed booking can't be cancelled.", 400));
  }

  const previousStatus = booking.status;

  // Refund policy: cancelling at least CANCELLATION_WINDOW_HOURS before the
  // appointment returns the whole charge. Inside the window the slot is already
  // burned, so we keep a fee worth one hour of the booked crew and return the
  // rest. Add-on prices are needed to work out what that hour is worth, and they
  // live on the referenced catalogue documents.
  const late = isLateCancellation(booking);
  let settlement = null;
  if (late) {
    await booking.populate([
      { path: 'specialRequests', select: 'price' },
      { path: 'cleaningTools', select: 'price' }
    ]);
    settlement = lateCancellationSettlement(booking);
  }

  // Release the money. On a Stripe failure we roll the status back to what it
  // was and abort — a booking must never be left cancelled while the customer
  // is still charged. It's a no-op for manual/offline or unpaid bookings, and
  // for a late cancellation whose fee swallows the entire charge (a one-hour
  // booking), which leaves the payment exactly as it was.
  let refundUpdate = null;
  try {
    refundUpdate = await refundBookingPayment(
      booking,
      settlement ? { amount: settlement.refundAmount } : {}
    );
  } catch (refundError) {
    await Booking.updateOne({ _id: id }, { $set: { status: previousStatus } });
    return next(refundError);
  }

  if (refundUpdate) {
    Object.assign(booking, refundUpdate);
    await Booking.updateOne({ _id: id }, { $set: refundUpdate });
  }
  booking.status = 'cancelled';

  // Read the finished booking back ONCE, after the refund fields have been
  // written, and use it for both the refund email and the response. This used to
  // be two separate reads of the same document — one that fetched the whole
  // booking just to resolve `serviceId.name` for the email, and one for the
  // response — on top of the claim above.
  const populated = await Booking.findById(booking._id)
    .populate('serviceId', 'name')
    .populate('cityId', 'name')
    .populate('specialRequests', 'name price')
    .populate('cleaningTools', 'name price')
    .populate('workers', 'fullname')
    .lean();

  // Best-effort refund email (only when an actual refund was issued).
  if (refundUpdate) {
    try {
      const { subject, html, text } = renderRefundEmail({
        customerName: booking.customerName,
        serviceName: populated?.serviceId?.name,
        bookingDate: booking.bookingDate,
        amount: refundUpdate.refundAmount,
        fee: settlement?.fee || 0,
        charged: booking.totalAmount
      });
      await sendEmail({ email: booking.customerEmail, subject, html, text });
    } catch (emailError) {
      console.error('Refund email send error:', emailError.message);
    }
  }

  // Message reflects the money outcome: fully refunded, refunded minus the
  // one-hour late-cancellation fee, entirely kept (a late cancellation of a
  // booking no longer than that hour), or nothing to refund (manual/unpaid).
  const wasPaidCard =
    booking.paymentMethod === 'card' &&
    ['paid', 'refunded', 'partially-refunded'].includes(booking.paymentStatus);
  let message = "Booking cancelled successfully!";
  if (refundUpdate && refundUpdate.paymentStatus === 'partially-refunded') {
    message =
      `Booking cancelled and ${formatEuro(refundUpdate.refundAmount)} refunded. ` +
      `Cancellations within ${CANCELLATION_WINDOW_HOURS} hours of the appointment keep a ` +
      `late-cancellation fee of ${formatEuro(settlement.fee)} — one hour of the booked cleaning.`;
  } else if (refundUpdate) {
    message = "Booking cancelled and refunded successfully!";
  } else if (late && wasPaidCard) {
    message =
      `Booking cancelled. Cancellations within ${CANCELLATION_WINDOW_HOURS} hours of the ` +
      `appointment keep a late-cancellation fee of one hour of the booked cleaning, which ` +
      `covers this booking in full — please contact support if you think that's wrong.`;
  }

  res.status(200).json({
    status: "success",
    message,
    data: { booking: populated }
  });
});

// DELETE /api/v1/booking/:id (admin)
const deleteBooking = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const booking = await Booking.findByIdAndDelete(id);

  if (!booking) {
    return next(new AppError("Booking not found!", 404));
  }

  res.status(200).json({
    status: "success",
    message: "Booking deleted successfully!"
  });
});

module.exports = {
  getBookings,
  getMyBookings,
  getBookingById,
  createBooking,
  editBooking,
  cancelMyBooking,
  deleteBooking
};
