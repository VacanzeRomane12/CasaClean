// Payment controller (Stripe)
// ---------------------------
// Owns the customer-facing money flow:
//   - POST /payment/booking/intent    create a PaymentIntent for a booking
//   - POST /payment/booking/finalize  promote a paid intent into a real booking
//   - GET  /payment/methods           list the user's saved cards
//   - POST /payment/methods/setup-intent  add a card (SetupIntent)
//   - DELETE /payment/methods/:id     remove a saved card
//
// It also exports promotePendingBooking and refundBookingPayment, which are
// reused by the webhook handler and the booking controller respectively.

const crypto = require('crypto');

const Sentry = require('@sentry/node');

const stripe = require('../config/stripe.config');

const Booking = require('../models/booking.model');
const PaymentAttempt = require('../models/paymentAttempt.model');
const PendingBooking = require('../models/pendingBooking.model');
const Subscription = require('../models/subscription.model');
const User = require('../models/user.model');

const catchAsync = require('../utils/catchAsync.util');
const AppError = require('../utils/appError.util');
const { toMinorUnits, fromMinorUnits } = require('../utils/money.util');
const { buildValidatedBookingDraft, renderBookingConfirmationEmail } = require('../services/booking.service');
const { ensureStripeCustomer } = require('../services/stripeCustomer.service');
const sendEmail = require('../utils/email.util');
const { notifyAdminsOfNewBooking } = require('../services/bookingAlert.service');
const { createSubscriptionFromFirstBooking } = require('../services/subscription.service');

const CURRENCY = 'eur';

/* --------------------------------------------------------- helpers -------- */

/**
 * Stable fingerprint of "this exact booking, paid with this exact card".
 *
 * Two submissions of the same checkout hash identically, so they can be
 * collapsed onto one charge; changing the slot, any priced field, or the card
 * produces a different key and is correctly treated as a new payment. Add-on and
 * tool ids are sorted so a reordered array isn't mistaken for a different
 * booking.
 *
 * Note this covers the *priced* draft, not the raw request: notes, doorbell name
 * and the like can't affect what is charged, so they must not be able to defeat
 * duplicate detection either.
 */
const bookingAttemptKey = (draft, paymentMethodId) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify([
      String(draft.user),
      String(draft.serviceId),
      String(draft.cityId),
      draft.bookingDate,
      draft.bookingTime,
      draft.durationMinutes,
      draft.cleaners,
      draft.totalAmount,
      (draft.specialRequests || []).map(String).sort(),
      (draft.cleaningTools || []).map(String).sort(),
      paymentMethodId
    ]))
    .digest('hex');

/**
 * Claim the idempotency key for a saved-card charge, creating the ledger record
 * on first use. Concurrent claimants converge on the same document — the unique
 * index rejects the loser's insert and it re-reads the winner.
 */
const claimPaymentAttempt = async (key, userId) => {
  try {
    return await PaymentAttempt.findOneAndUpdate(
      { key },
      { $setOnInsert: { key, user: userId } },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    if (err.code !== 11000) throw err;
    return PaymentAttempt.findOne({ key });
  }
};

/**
 * Refund a payment that can never become a booking.
 *
 * Shared by the finalize endpoint and the webhook so both release the money the
 * same way and under the same idempotency key — a retried finalize, a redelivered
 * webhook, or one of each must together produce exactly one refund. Stripe
 * replays the original refund for a repeated key rather than issuing a second.
 *
 * @returns {Promise<boolean>} true when the refund was accepted by Stripe
 */
const refundOrphanedPayment = async (paymentIntentId) => {
  try {
    await stripe.refunds.create(
      { payment_intent: paymentIntentId },
      { idempotencyKey: `refund:intent:${paymentIntentId}` }
    );
    return true;
  } catch (err) {
    console.error('Orphaned-payment refund error:', err.message);
    Sentry.captureException(err, {
      extra: { stage: 'refundOrphanedPayment', paymentIntentId }
    });
    return false;
  }
};

/**
 * Promote a successfully-paid PaymentIntent's PendingBooking draft into a real
 * Booking. Shared by the finalize endpoint (instant UX) and the webhook
 * (backstop) — so it MUST be idempotent: the sparse-unique paymentIntentId index
 * on Booking guarantees a given intent produces at most one booking, and a
 * concurrent duplicate create is caught and resolved to the existing booking.
 *
 * @param {string} paymentIntentId
 * @param {Object} [paymentIntent]  the Stripe PI object (for stripeStatus)
 * @returns {Promise<Object|null>} the booking, or null if there's nothing to do
 */
/**
 * Create the recurring template for an already-created, already-PAID booking.
 *
 * The money has moved and the reservation exists by the time this runs, so a
 * failure here must never propagate: throwing would hand the customer an error
 * for a booking they were correctly charged for, and — because the caller only
 * deletes the PendingBooking on the success path — would leave the draft behind
 * so Stripe retries the webhook into the same failure forever.
 *
 * Instead we swallow, report to Sentry, and let the missing subscription be
 * reconciled out-of-band. The booking itself is already correct and complete.
 */
const attachSubscriptionSafely = async ({ pending, booking, paymentIntent }) => {
  try {
    return await createSubscriptionFromFirstBooking({ pending, booking, paymentIntent });
  } catch (err) {
    console.error(
      `Recurring template creation failed for paid booking ${booking?._id} ` +
      `(intent ${pending?.paymentIntentId}):`,
      err.message
    );
    Sentry.captureException(err, {
      extra: {
        stage: 'createSubscriptionFromFirstBooking',
        bookingId: String(booking?._id),
        paymentIntentId: pending?.paymentIntentId
      }
    });
    return null;
  }
};

const promotePendingBooking = async (paymentIntentId, paymentIntent = null) => {
  // Already promoted? Return the existing booking (idempotent).
  const existing = await Booking.findOne({ paymentIntentId });
  if (existing) {
    // Repair the narrow crash window after Booking.create but before the
    // recurring template was created. The first PI's unique Subscription index
    // keeps this safe across finalize/webhook races.
    const existingPending = await PendingBooking.findOne({ paymentIntentId });
    if (existingPending?.recurrence?.intervalDays) {
      await attachSubscriptionSafely({
        pending: existingPending,
        booking: existing,
        paymentIntent
      });
    }
    if (existingPending) {
      await PendingBooking.deleteOne({ paymentIntentId }).catch(() => {});
    }
    return Booking.findById(existing._id);
  }

  const pending = await PendingBooking.findOne({ paymentIntentId });
  if (!pending) return null; // expired/never existed and no booking — nothing to do

  const d = pending.draft;

  let booking;
  try {
    booking = await Booking.create({
      user: pending.user,
      serviceId: d.serviceId,
      cityId: d.cityId,
      customerName: d.customerName,
      customerEmail: d.customerEmail,
      customerPhone: d.customerPhone,
      customerPersonalId: d.customerPersonalId,
      streetName: d.streetName,
      houseNumber: d.houseNumber,
      propertySize: d.propertySize,
      doorbellName: d.doorbellName,
      bookingDate: d.bookingDate,
      bookingTime: d.bookingTime,
      durationMinutes: d.durationMinutes,
      cleaners: d.cleaners,
      totalAmount: d.totalAmount,
      // The VAT treatment the charge was actually priced under — copied, not
      // re-resolved, so a profile change between paying and promotion can never
      // restate a completed transaction.
      tax: d.tax,
      notes: d.notes ?? null,
      specialRequests: d.specialRequests || [],
      cleaningTools: d.cleaningTools || [],
      supplies: d.supplies || [],
      status: 'confirmed',
      paymentIntentId,
      paymentMethod: 'card',
      paymentStatus: 'paid',
      amountPaid: d.totalAmount,
      currency: CURRENCY,
      paidAt: new Date(),
      stripeStatus: paymentIntent?.status || 'succeeded'
    });
  } catch (err) {
    // Concurrent promotion (finalize + webhook race): the unique index rejects
    // the duplicate. Treat as already promoted.
    if (err.code === 11000) {
      const alreadyPromoted = await Booking.findOne({ paymentIntentId });
      if (pending.recurrence?.intervalDays && alreadyPromoted) {
        await attachSubscriptionSafely({
          pending,
          booking: alreadyPromoted,
          paymentIntent
        });
      }
      await PendingBooking.deleteOne({ paymentIntentId }).catch(() => {});
      return Booking.findOne({ paymentIntentId });
    }
    throw err;
  }

  // First-cycle payment and Booking creation succeeded. Only now create the
  // recurring template; helper-level firstPaymentIntentId idempotency handles
  // a concurrent finalize/webhook promotion. A failure here is contained — the
  // paid booking stands on its own.
  if (pending.recurrence?.intervalDays) {
    const subscription = await attachSubscriptionSafely({
      pending,
      booking,
      paymentIntent
    });
    if (subscription) booking.subscriptionId = subscription._id;
  }

  // Draft fulfilled — remove it so it isn't reaped/processed again.
  await PendingBooking.deleteOne({ paymentIntentId }).catch(() => {});

  // Email the booking confirmation. Best-effort and deliberately NOT awaited:
  // this runs inside the Stripe webhook (and the finalize request), and a
  // slow/unreachable SMTP host must not delay the response past Stripe's
  // delivery timeout. Exactly one customer email per payment.
  try {
    const { subject, html, text } = renderBookingConfirmationEmail({
      customerName: d.customerName,
      serviceName: d.serviceName,
      bookingDate: d.bookingDate,
      bookingTime: d.bookingTime,
      durationMinutes: d.durationMinutes,
      cleaners: d.cleaners,
      streetName: d.streetName,
      houseNumber: d.houseNumber,
      totalAmount: d.totalAmount,
      recurring: Boolean(booking.subscriptionId)
    });
    sendEmail({ email: d.customerEmail, subject, html, text }).catch((err) =>
      console.error('Confirmation email error:', err.message)
    );
  } catch (err) {
    console.error('Confirmation email render error:', err.message);
  }

  // Tell the team a booking just landed. Sits on the fresh-create path only —
  // the idempotent returns above are the finalize/webhook race resolving, and a
  // second alert for the same booking would read as a second booking.
  // Fire-and-forget for the same reason as the confirmation email above.
  notifyAdminsOfNewBooking({ booking, serviceName: d.serviceName }).catch((err) =>
    console.error('Admin booking notification error:', err.message)
  );

  return booking;
};

/**
 * Refund a paid card booking and return the fields to persist.
 *
 * Refunds the whole charge by default. Pass `amount` (in euros) to return only
 * part of it — that is how a late self-cancellation gives back everything except
 * the retained one-hour fee (utils/cancellation.util.js). An `amount` that
 * covers the full charge is treated as a full refund, so callers never have to
 * special-case the boundary.
 *
 * No-op (returns null) for manual/offline bookings, unpaid bookings, those
 * already refunded, and a partial amount that rounds to nothing. Throws on a
 * Stripe failure so the caller can abort the cancellation rather than mark a
 * booking cancelled without releasing the money.
 *
 * @param {Object} booking          a booking doc/object with payment fields
 * @param {Object} [options]
 * @param {number} [options.amount] euros to return; omit for the full charge
 * @returns {Promise<Object|null>} { paymentStatus, refundId, refundAmount, refundedAt, stripeStatus? } | null
 */
const refundBookingPayment = async (booking, { amount } = {}) => {
  if (
    booking.paymentMethod !== 'card' ||
    booking.paymentStatus !== 'paid' ||
    !booking.paymentIntentId
  ) {
    return null;
  }

  // Stripe works in integer cents; our totals are decimal euros.
  const chargedCents = toMinorUnits(booking.totalAmount);
  const requestedCents = amount === undefined ? chargedCents : toMinorUnits(amount);

  // Nothing to give back (the fee swallowed the whole charge) — the caller keeps
  // the booking's payment fields as they are.
  if (!(requestedCents > 0)) return null;

  const partial = requestedCents < chargedCents;

  // Idempotency key scoped to the booking, mirroring the subscription charge
  // worker. Callers already claim the cancellation atomically, but two requests
  // that slip through (or a retried request) must never produce two refunds —
  // Stripe replays the original refund for a repeated key instead. The amount is
  // part of a partial key so two genuinely different partial refunds aren't
  // collapsed onto one, while a retry of the same one still is.
  const refund = await stripe.refunds.create(
    partial
      ? { payment_intent: booking.paymentIntentId, amount: requestedCents }
      : { payment_intent: booking.paymentIntentId },
    {
      idempotencyKey: partial
        ? `refund:booking:${booking._id}:${requestedCents}`
        : `refund:booking:${booking._id}`
    }
  );

  return {
    paymentStatus: partial ? 'partially-refunded' : 'refunded',
    refundId: refund.id,
    refundAmount: fromMinorUnits(requestedCents),
    refundedAt: new Date(),
    // stripeStatus mirrors the raw charge state, and Stripe leaves a partially
    // refunded charge as 'succeeded' — only a full reversal changes it.
    ...(partial ? {} : { stripeStatus: 'refunded' })
  };
};

/* ------------------------------------------------------- controllers ------ */

// POST /api/v1/payment/booking/intent
// Validate + price the booking server-side, store a PendingBooking draft, and
// create a Stripe PaymentIntent. Returns the clientSecret for the SPA to confirm.
const createBookingIntent = catchAsync(async (req, res, next) => {
  const { savePaymentMethod, savedPaymentMethodId, intervalDays } = req.body;
  const isRecurring = intervalDays !== undefined;

  if (isRecurring && !savedPaymentMethodId && !savePaymentMethod) {
    return next(new AppError("A recurring booking requires a saved card.", 400));
  }

  // Fail-closed validation + server-side pricing (never trusts client totals).
  const draft = await buildValidatedBookingDraft(req.body, req.user);

  const customerId = await ensureStripeCustomer(req.user);

  // The draft as it is stored against an intent. Hoisted because both the
  // normal path and the duplicate-submission path below need to persist it.
  const { user: _draftUser, ...draftFields } = draft;
  const persistDraft = async (paymentIntentId) => {
    try {
      await PendingBooking.create({
        user: req.user._id,
        paymentIntentId,
        savePaymentMethod: Boolean(savePaymentMethod || savedPaymentMethodId),
        recurrence: isRecurring ? { intervalDays } : null,
        draft: draftFields
      });
    } catch (err) {
      // A concurrent duplicate can reach this with the SAME intent (Stripe
      // handed both callers one object). The unique paymentIntentId index
      // rejects the second write, which is success, not failure — the draft it
      // wanted is already there.
      if (err.code !== 11000) throw err;
    }
  };

  // Base PaymentIntent params. allow_redirects:'never' keeps us to inline
  // (no-redirect) methods so the SPA can confirm with redirect:'if_required'
  // and we never need to build hosted return-url pages.
  const params = {
    amount: toMinorUnits(draft.totalAmount),
    currency: CURRENCY,
    customer: customerId,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    // Stripe sends its own payment receipt on success (on top of our branded
    // confirmation email) — an independent paper trail for the customer.
    receipt_email: draft.customerEmail,
    metadata: {
      type: 'booking',
      userId: String(req.user._id),
      ...(isRecurring
        ? { recurring: 'true', intervalDays: String(intervalDays) }
        : {})
    }
  };

  // Save the card on the customer for future bookings if requested.
  if (isRecurring || savePaymentMethod || savedPaymentMethodId) {
    params.setup_future_usage = 'off_session';
  }

  // Paying with a previously-saved card: verify it belongs to this customer,
  // then confirm server-side. The customer is actively in checkout, so this is
  // an ON-SESSION confirm (no off_session flag) — if the card needs 3DS, the
  // intent comes back as 'requires_action' and the client completes it inline,
  // rather than Stripe erroring as it would for a true off-session charge.
  if (savedPaymentMethodId) {
    let pm;
    try {
      pm = await stripe.paymentMethods.retrieve(savedPaymentMethodId);
    } catch {
      return next(new AppError("That saved card could not be found.", 400));
    }
    if (pm.customer !== customerId) {
      return next(new AppError("That payment method does not belong to your account.", 403));
    }
    params.payment_method = savedPaymentMethodId;
    params.confirm = true;
  }

  // `confirm: true` above means Stripe captures the moment this call returns, so
  // the saved-card path is the one place a duplicate request becomes a duplicate
  // CHARGE. It gets a ledger-backed idempotency key; the new-card path does not
  // need one, because its intent is created unconfirmed and a spare simply
  // expires unused. See models/paymentAttempt.model.js.
  let attempt = null;
  if (savedPaymentMethodId) {
    const key = bookingAttemptKey(draft, savedPaymentMethodId);
    attempt = await claimPaymentAttempt(key, req.user._id);

    // This exact booking, on this exact card, already produced an intent — a
    // resubmitted or retried request, not a second purchase. Report the existing
    // intent's current state instead of charging again.
    if (attempt?.paymentIntentId) {
      const existingIntent = await stripe.paymentIntents.retrieve(attempt.paymentIntentId);

      // The earlier request may have created (and charged) that intent but died
      // before persisting its draft. Re-persist it, or this retry would answer
      // "success" for money that can never become a booking. Skipped once a
      // booking exists, because promotion has already consumed the draft and
      // re-adding it would resurrect a record that is meant to be gone.
      const alreadyBooked = await Booking.exists({ paymentIntentId: existingIntent.id });
      if (!alreadyBooked) await persistDraft(existingIntent.id);

      if (existingIntent.status === 'succeeded') {
        await promotePendingBooking(existingIntent.id, existingIntent);
      }
      return res.status(201).json({
        status: "success",
        message: "Payment intent created.",
        data: {
          clientSecret: existingIntent.client_secret,
          paymentIntentId: existingIntent.id,
          paymentStatus: existingIntent.status,
          amount: draft.totalAmount,
          currency: CURRENCY
        }
      });
    }
  }

  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.create(
      params,
      // Two genuinely simultaneous requests both reach here with the same key
      // (neither saw the other's paymentIntentId yet); Stripe returns ONE intent
      // to both. The attempt counter keeps a retry after a decline from being
      // served the replayed decline.
      attempt
        ? { idempotencyKey: `booking:${attempt.key}:a${attempt.attempts}` }
        : undefined
    );
  } catch (err) {
    // Record the decline so the customer's next attempt on this card mints a
    // fresh key rather than replaying this failure back at them.
    if (attempt && err?.type === 'StripeCardError') {
      await PaymentAttempt.updateOne({ _id: attempt._id }, { $inc: { attempts: 1 } })
        .catch((incErr) => console.error('Payment attempt increment error:', incErr.message));
    }
    throw err;
  }

  if (attempt) {
    // Remember the intent so a later duplicate takes the reuse branch above.
    // Scoped to the unclaimed state so the loser of a concurrent create can't
    // overwrite the winner's id (they are the same intent anyway).
    await PaymentAttempt.updateOne(
      { _id: attempt._id, paymentIntentId: null },
      { $set: { paymentIntentId: paymentIntent.id } }
    ).catch((err) => console.error('Payment attempt record error:', err.message));
  }

  // Persist the validated draft keyed to this intent. Promotion happens only
  // once the intent succeeds (finalize endpoint or webhook backstop).
  await persistDraft(paymentIntent.id);

  // A saved card is confirmed server-side and can succeed immediately. Stripe
  // may deliver its webhook before the draft above exists; promote it here once
  // persistence is complete so an ACKed early webhook can never strand a paid
  // first booking (or its recurring Subscription) waiting on client finalize.
  if (paymentIntent.status === 'succeeded') {
    await promotePendingBooking(paymentIntent.id, paymentIntent);
  }

  res.status(201).json({
    status: "success",
    message: "Payment intent created.",
    data: {
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      paymentStatus: paymentIntent.status,
      amount: draft.totalAmount,
      currency: CURRENCY
    }
  });
});

// POST /api/v1/payment/booking/finalize
// Called by the client right after a successful payment for instant feedback.
// The webhook is the backstop; both funnel through the idempotent promote.
const finalizeBooking = catchAsync(async (req, res, next) => {
  const { paymentIntentId } = req.body;

  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  } catch {
    return next(new AppError("Payment not found.", 404));
  }

  if (paymentIntent.status !== 'succeeded') {
    return next(new AppError("Payment has not been completed yet.", 400));
  }

  // Ownership: the intent must belong to this user's Stripe customer. A caller
  // with no stripeCustomerId can't own ANY customer-attached intent (intent
  // creation always ensures a customer first), so a missing id is a mismatch —
  // not a pass — otherwise a fresh account could drive the refund path below
  // against another user's orphaned payment.
  const fresh = await User.findById(req.user._id).select('stripeCustomerId');
  if (paymentIntent.customer && paymentIntent.customer !== fresh?.stripeCustomerId) {
    return next(new AppError("This payment does not belong to your account.", 403));
  }

  // Defense-in-depth: if the draft is still around, the captured amount must
  // match what we computed (the client can't change a server-created amount,
  // but we re-check anyway).
  const pending = await PendingBooking.findOne({ paymentIntentId });
  if (pending) {
    if (String(pending.user) !== String(req.user._id)) {
      return next(new AppError("This payment does not belong to your account.", 403));
    }
    if (paymentIntent.amount !== toMinorUnits(pending.draft.totalAmount)) {
      return next(new AppError("Payment amount mismatch.", 400));
    }
  }

  const booking = await promotePendingBooking(paymentIntentId, paymentIntent);

  if (!booking) {
    // No draft and no booking: the draft TTL-expired before the payment landed.
    // The customer HAS been charged, so never keep the money against nothing —
    // refund immediately instead of parking it on "contact support".
    const refunded = await refundOrphanedPayment(paymentIntentId);
    if (refunded) {
      return next(new AppError(
        "Your booking request expired before the payment completed, so the charge has been refunded. Please book again.",
        409
      ));
    }
    // Refund failed — fall back to support (already reported to Sentry).
    return next(new AppError("This booking could not be finalised. Please contact support.", 409));
  }

  // Only return the booking to its owner (a promoted webhook booking has a user).
  if (booking.user && String(booking.user) !== String(req.user._id)) {
    return next(new AppError("This payment does not belong to your account.", 403));
  }

  res.status(201).json({
    status: "success",
    message: "Booking created successfully!",
    data: { booking }
  });
});

// GET /api/v1/payment/methods — the user's saved cards.
const listPaymentMethods = catchAsync(async (req, res, next) => {
  const fresh = await User.findById(req.user._id).select('stripeCustomerId defaultPaymentMethodId');

  if (!fresh?.stripeCustomerId) {
    return res.status(200).json({
      status: "success",
      message: "No saved cards.",
      data: { paymentMethods: [] }
    });
  }

  // Stripe's list default is 10; a long-standing customer can accumulate more
  // than that, and a card missing from this list is a card they cannot pay with
  // or delete. 100 is the maximum Stripe allows in one page.
  const { data } = await stripe.paymentMethods.list({
    customer: fresh.stripeCustomerId,
    type: 'card',
    limit: 100
  });

  const paymentMethods = data.map((pm) => ({
    id: pm.id,
    brand: pm.card?.brand,
    last4: pm.card?.last4,
    expMonth: pm.card?.exp_month,
    expYear: pm.card?.exp_year,
    isDefault: pm.id === fresh.defaultPaymentMethodId
  }));

  res.status(200).json({
    status: "success",
    message: "Saved cards returned successfully!",
    data: { paymentMethods }
  });
});

// POST /api/v1/payment/methods/setup-intent — add a card without a charge.
const createSetupIntent = catchAsync(async (req, res, next) => {
  const customerId = await ensureStripeCustomer(req.user);

  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    usage: 'off_session',
    // The saved-card UI only stores and renders card PaymentMethods. Keeping
    // this card-only also avoids Dashboard-enabled redirect methods requiring
    // return_url during stripe.confirmSetup().
    payment_method_types: ['card']
  });

  res.status(201).json({
    status: "success",
    message: "Setup intent created.",
    data: { clientSecret: setupIntent.client_secret }
  });
});

// PATCH /api/v1/payment/methods/:id/default — mark a saved card as the default
// for one-click future bookings (ownership-checked, same rules as delete).
const setDefaultPaymentMethod = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const fresh = await User.findById(req.user._id).select('stripeCustomerId');
  if (!fresh?.stripeCustomerId) {
    return next(new AppError("No saved cards yet.", 404));
  }

  let pm;
  try {
    pm = await stripe.paymentMethods.retrieve(id);
  } catch {
    return next(new AppError("Card not found.", 404));
  }

  // Never point the default at a card that isn't this user's.
  if (pm.customer !== fresh.stripeCustomerId) {
    return next(new AppError("Card not found.", 404));
  }

  await User.findByIdAndUpdate(req.user._id, { defaultPaymentMethodId: id });

  res.status(200).json({
    status: "success",
    message: "Default card updated successfully!"
  });
});

// DELETE /api/v1/payment/methods/:id — remove a saved card (ownership-checked).
const deletePaymentMethod = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const fresh = await User.findById(req.user._id).select('stripeCustomerId defaultPaymentMethodId');
  if (!fresh?.stripeCustomerId) {
    return next(new AppError("No saved cards to remove.", 404));
  }

  let pm;
  try {
    pm = await stripe.paymentMethods.retrieve(id);
  } catch {
    return next(new AppError("Card not found.", 404));
  }

  // Never detach a card that isn't this user's.
  if (pm.customer !== fresh.stripeCustomerId) {
    return next(new AppError("Card not found.", 404));
  }

  // Do not detach a card that an active or paused recurring plan still needs.
  // A customer must update that subscription's card (or cancel it) first.
  const usedBySubscription = await Subscription.exists({
    user: req.user._id,
    paymentMethodId: id,
    status: { $in: ['active', 'paused'] }
  });
  if (usedBySubscription) {
    return next(new AppError(
      "This card is used by a recurring subscription. Switch that subscription's card first.",
      400
    ));
  }

  await stripe.paymentMethods.detach(id);

  // Clear the default pointer if we just removed the default card.
  if (fresh.defaultPaymentMethodId === id) {
    await User.findByIdAndUpdate(req.user._id, { $unset: { defaultPaymentMethodId: "" } });
  }

  res.status(200).json({
    status: "success",
    message: "Card removed successfully!"
  });
});

module.exports = {
  createBookingIntent,
  finalizeBooking,
  listPaymentMethods,
  createSetupIntent,
  setDefaultPaymentMethod,
  deletePaymentMethod,
  // Shared with the webhook handler and booking controller.
  promotePendingBooking,
  refundBookingPayment,
  refundOrphanedPayment
};
