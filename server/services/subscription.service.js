// Recurring subscription domain service
// --------------------------------------
// This module deliberately contains plain async functions instead of Express
// handlers: both the cron worker and Stripe webhook need the same idempotent
// charge/booking logic without a req/res lifecycle.

const mongoose = require('mongoose');

const stripe = require('../config/stripe.config');
const Booking = require('../models/booking.model');
const Subscription = require('../models/subscription.model');
const User = require('../models/user.model');
const sendEmail = require('../utils/email.util');
const AppError = require('../utils/appError.util');
const { toMinorUnits, fromMinorUnits } = require('../utils/money.util');
const {
  isValidIntervalDays,
  addDaysToDateString,
  localMidnight,
  todayString
} = require('../utils/date.util');
const {
  resolveServiceAndCity,
  resolveSpecialRequests,
  resolveCleaningTools,
  assertRecurrenceAllowed,
  computeBookingTotal,
  renderBookingConfirmationEmail,
  formatEuro
} = require('./booking.service');
const { notifyAdminsOfNewBooking } = require('./bookingAlert.service');
// Catalogue prices are VAT-exclusive; VAT is added on top unless the customer is
// a verified business.
const { priceForCustomer } = require('../utils/tax.util');
// A plan's visit length is total minutes; durationInMinutes also reads the
// legacy `hours` field on plans created before that change.
const { durationInMinutes } = require('../utils/duration.util');

const CURRENCY = 'eur';

const getChargeLeadDays = () => {
  const value = Number(process.env.CHARGE_LEAD_DAYS);
  return Number.isInteger(value) && value >= 0 ? value : 1;
};

const getMaxAttempts = () => {
  const value = Number(process.env.SUBSCRIPTION_MAX_ATTEMPTS);
  return Number.isInteger(value) && value > 0 ? value : 3;
};

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const stripeId = (value) => (typeof value === 'string' ? value : value?.id);

const getErrorCode = (err) => err?.code || err?.decline_code || err?.raw?.code || null;
const getErrorMessage = (err) =>
  err?.message || err?.raw?.message || 'Your saved card could not be charged.';
const getErrorPaymentIntentId = (err) => stripeId(err?.payment_intent) || err?.raw?.payment_intent;
const isMissingPaymentMethodError = (err) =>
  err?.code === 'resource_missing' ||
  err?.statusCode === 404 ||
  err?.raw?.statusCode === 404 ||
  /(?:no such payment method|payment method.*(?:not found|missing)|card.*not found)/i
    .test(String(err?.message || err?.raw?.message || ''));

const getNextSchedule = (serviceDate, intervalDays) => {
  const nextServiceDate = addDaysToDateString(serviceDate, intervalDays);
  const chargeDate = addDaysToDateString(nextServiceDate, -getChargeLeadDays());
  return {
    nextServiceDate,
    nextChargeAt: localMidnight(chargeDate)
  };
};

// The widest date range a single occurrence projection may span. The admin
// calendar shows at most six padded weeks, so 62 days covers any month view;
// the cap exists so no caller can ask for an unbounded expansion.
const MAX_OCCURRENCE_SPAN_DAYS = 62;

/**
 * Project the upcoming visits of one recurring plan inside a date range,
 * WITHOUT writing anything.
 *
 * A plan stores one rule (intervalDays) and a single forward pointer
 * (nextServiceDate, the first date NOT yet charged — markCycleSucceeded moves
 * it past every charged cycle), and a Booking document exists for a cycle only
 * once its charge has succeeded, which runs CHARGE_LEAD_DAYS before the visit.
 * The calendar therefore cannot read later occurrences from the bookings
 * collection; it asks for them here instead. Because the walk starts at the
 * first uncharged date, a projected date can never coincide with a charged
 * cycle's Booking, which is what keeps the calendar free of duplicates.
 *
 * Dates before today are skipped: an active plan whose nextServiceDate has
 * slipped into the past is paused by the next charge sweep (cycle_missed), and
 * until then it must not paint the calendar's past.
 *
 * The arithmetic is addDaysToDateString — the same local-calendar maths the
 * charge worker advances the schedule with — so DST and month ends land on the
 * dates the worker will actually use.
 *
 * @param {Object} subscription a lean/hydrated Subscription (status is NOT
 *   checked here — the caller selects active plans)
 * @param {string} from "YYYY-MM-DD", inclusive
 * @param {string} to   "YYYY-MM-DD", inclusive
 * @returns {string[]} service dates inside [max(from, today), to], ascending
 */
const projectOccurrences = (subscription, from, to) => {
  const intervalDays = Number(subscription?.intervalDays);
  const start = subscription?.nextServiceDate;
  if (!isValidIntervalDays(intervalDays) || typeof start !== 'string' || !from || !to || to < from) {
    return [];
  }

  const floor = from > todayString() ? from : todayString();
  // Bounded by construction: a daily plan over the widest span is 63 dates.
  const maxCount = Math.floor(MAX_OCCURRENCE_SPAN_DAYS / intervalDays) + 1;

  const dates = [];
  let date = start;
  for (let i = 0; date <= to && i <= maxCount; i += 1) {
    if (date >= floor) dates.push(date);
    date = addDaysToDateString(date, intervalDays);
  }
  return dates;
};

const pushChargeAttempt = (attempt) => ({
  $push: {
    chargeAttempts: {
      $each: [attempt],
      $slice: -20
    }
  }
});

const sendBestEffortEmail = ({ email, subject, html, text }) => {
  sendEmail({ email, subject, html, text }).catch((err) => {
    console.error('Subscription email send error:', err.message);
  });
};

const renderChargeFailedEmail = ({ subscription, attemptNumber, errorMessage }) => {
  const maxAttempts = getMaxAttempts();
  const name = escapeHtml(subscription.customerName || 'there');
  const message = escapeHtml(errorMessage);
  const profileUrl = `${process.env.CLIENT_URL || ''}/profile`;
  const safeProfileUrl = escapeHtml(profileUrl);
  const subject = 'CasaClean — We could not charge your recurring cleaning';

  return {
    subject,
    html: `<!DOCTYPE html><html lang="en"><body style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.55;">
      <p>Hello ${name},</p>
      <p>We could not charge the saved card for your recurring CasaClean visit (attempt ${attemptNumber} of ${maxAttempts}).</p>
      <p>${message}</p>
      <p>We’ll retry tomorrow. You can update your saved card at <a href="${safeProfileUrl}">${safeProfileUrl}</a>.</p>
      <p>— CasaClean</p>
    </body></html>`,
    text:
      `Hello ${subscription.customerName || 'there'},\n\n` +
      `We could not charge your saved card for your recurring CasaClean visit (attempt ${attemptNumber} of ${maxAttempts}).\n` +
      `${errorMessage}\n\n` +
      `We'll retry tomorrow. Update your saved card at ${profileUrl}.\n\n— CasaClean`
  };
};

const renderSubscriptionPausedEmail = ({ subscription, reason, errorMessage }) => {
  const name = escapeHtml(subscription.customerName || 'there');
  const profileUrl = `${process.env.CLIENT_URL || ''}/profile`;
  const safeProfileUrl = escapeHtml(profileUrl);
  const reasonCopy = {
    'payment-failed': 'we could not charge your saved card after three attempts',
    'card-removed': 'the saved card is no longer available',
    'service-unavailable': 'the selected service, city, or add-on is no longer available'
  }[reason] || 'this cycle could not be completed';
  const safeReason = escapeHtml(reasonCopy);
  const detail = errorMessage ? `<p>${escapeHtml(errorMessage)}</p>` : '';
  const subject = 'CasaClean — Your recurring cleaning is paused';

  return {
    subject,
    html: `<!DOCTYPE html><html lang="en"><body style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.55;">
      <p>Hello ${name},</p>
      <p>Your recurring CasaClean service is paused because ${safeReason}.</p>
      ${detail}
      <p>Please review your subscription and saved card at <a href="${safeProfileUrl}">${safeProfileUrl}</a>, then resume it when ready.</p>
      <p>— CasaClean</p>
    </body></html>`,
    text:
      `Hello ${subscription.customerName || 'there'},\n\n` +
      `Your recurring CasaClean service is paused because ${reasonCopy}.\n` +
      `${errorMessage ? `${errorMessage}\n` : ''}\n` +
      `Review your subscription and saved card at ${profileUrl}, then resume it when ready.\n\n— CasaClean`
  };
};

const renderSubscriptionCancelledEmail = ({ subscription }) => {
  const name = escapeHtml(subscription.customerName || 'there');
  const subject = 'CasaClean — Your recurring cleaning is cancelled';

  return {
    subject,
    html: `<!DOCTYPE html><html lang="en"><body style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.55;">
      <p>Hello ${name},</p>
      <p>Your recurring CasaClean service has been cancelled. Already-created paid bookings are unchanged and can be managed separately from your profile.</p>
      <p>— CasaClean</p>
    </body></html>`,
    text:
      `Hello ${subscription.customerName || 'there'},\n\n` +
      `Your recurring CasaClean service has been cancelled. Already-created paid bookings are unchanged and can be managed separately from your profile.\n\n— CasaClean`
  };
};

/**
 * Notify the customer for one charged cycle.
 *
 * Every cycle is a separate payment, so every cycle sends its own confirmation
 * email. Rendering and sending are best-effort and fire-and-forget: an
 * unreachable SMTP host must never stall the charge worker or leave a captured
 * payment half-processed.
 */
const sendCycleReceipt = ({ subscription, booking, serviceName, serviceDate, amount }) => {
  // Every charged cycle creates a real, confirmed visit, so the team is told
  // about it exactly like a one-off booking. Called from the single place both
  // cycle paths (the charge worker and the webhook backstop) converge on, and
  // only once the schedule advance won, so a redelivered event can't re-alert.
  notifyAdminsOfNewBooking({
    booking: booking?._id
      ? booking
      : // The cycle booking couldn't be located (defensive — the charge worker
        // creates it synchronously). The plan still holds everything the team
        // needs to staff the visit, so alert from that rather than stay silent.
        {
          serviceId: subscription.serviceId,
          cityId: subscription.cityId,
          customerName: subscription.customerName,
          customerEmail: subscription.customerEmail,
          customerPhone: subscription.customerPhone,
          customerPersonalId: subscription.customerPersonalId,
          streetName: subscription.streetName,
          houseNumber: subscription.houseNumber,
          propertySize: subscription.propertySize,
          doorbellName: subscription.doorbellName,
          bookingDate: serviceDate,
          bookingTime: subscription.bookingTime,
          durationMinutes: durationInMinutes(subscription),
          cleaners: subscription.cleaners,
          totalAmount: amount,
          notes: subscription.notes,
          paymentMethod: 'card',
          paymentStatus: 'paid'
        },
    serviceName,
    recurring: true
  }).catch((err) => console.error('Admin booking notification error:', err.message));

  const fallback = {
    customerName: subscription.customerName,
    customerEmail: subscription.customerEmail,
    serviceName,
    bookingDate: serviceDate,
    bookingTime: subscription.bookingTime,
    durationMinutes: durationInMinutes(subscription),
    cleaners: subscription.cleaners,
    streetName: subscription.streetName,
    houseNumber: subscription.houseNumber,
    totalAmount: amount
  };

  try {
    const { subject, html, text } = renderBookingConfirmationEmail({
      ...fallback,
      recurring: true
    });
    sendBestEffortEmail({ email: subscription.customerEmail, subject, html, text });
  } catch (err) {
    console.error('Subscription receipt render error:', err.message);
  }
};

/**
 * Creates the recurring template once the first on-session payment has
 * succeeded. `firstPaymentIntentId` makes this safe across finalize/webhook
 * races; the winning Subscription is always backfilled onto the first Booking.
 */
const createSubscriptionFromFirstBooking = async ({ pending, booking, paymentIntent }) => {
  const intervalDays = Number(pending?.recurrence?.intervalDays);
  if (!isValidIntervalDays(intervalDays)) return null;

  const paymentIntentId = paymentIntent?.id || pending.paymentIntentId;
  let resolvedPaymentIntent = paymentIntent;
  if (!stripeId(resolvedPaymentIntent?.customer) || !stripeId(resolvedPaymentIntent?.payment_method)) {
    resolvedPaymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  }

  const stripeCustomerId = stripeId(resolvedPaymentIntent?.customer);
  const paymentMethodId = stripeId(resolvedPaymentIntent?.payment_method);
  if (!stripeCustomerId || !paymentMethodId) {
    throw new AppError('A recurring booking requires a saved card.', 400);
  }

  const draft = pending.draft;
  const schedule = getNextSchedule(draft.bookingDate, intervalDays);

  let subscription;
  try {
    subscription = await Subscription.create({
      user: pending.user,
      serviceId: draft.serviceId,
      cityId: draft.cityId,
      customerName: draft.customerName,
      customerEmail: draft.customerEmail,
      customerPhone: draft.customerPhone,
      customerPersonalId: draft.customerPersonalId,
      streetName: draft.streetName,
      houseNumber: draft.houseNumber,
      propertySize: draft.propertySize,
      doorbellName: draft.doorbellName,
      bookingTime: draft.bookingTime,
      durationMinutes: draft.durationMinutes,
      cleaners: draft.cleaners,
      notes: draft.notes ?? null,
      specialRequests: draft.specialRequests || [],
      cleaningTools: draft.cleaningTools || [],
      supplies: draft.supplies || [],
      intervalDays,
      nextServiceDate: schedule.nextServiceDate,
      nextChargeAt: schedule.nextChargeAt,
      stripeCustomerId,
      paymentMethodId,
      firstPaymentIntentId: paymentIntentId
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
    subscription = await Subscription.findOne({ firstPaymentIntentId: paymentIntentId });
  }

  if (subscription && booking?._id) {
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { subscriptionId: subscription._id } }
    );
  }

  return subscription;
};

/**
 * Resolve all live references and calculate the amount for one cycle. This
 * intentionally does NOT call assertBookingWindow: the customer chose the
 * fixed slot on the first booking, and a retry on service morning must not be
 * rejected merely because the clock has passed that slot.
 */
const priceSubscriptionCycle = async (subscription) => {
  const { service, city } = await resolveServiceAndCity(
    String(subscription.serviceId),
    String(subscription.cityId)
  );

  // An admin can stop offering recurrence on a service (or narrow its cadences)
  // long after a plan was created. Re-check it per cycle, alongside the rest of
  // reference resolution, so the plan pauses instead of quietly charging on a
  // cadence the service no longer sells. The caller turns this AppError into a
  // 'service-unavailable' pause and notifies the customer.
  assertRecurrenceAllowed(service, subscription.intervalDays);

  // These three reads are mutually independent — the add-ons and tools both need
  // `service` (already resolved above) and the customer needs only the plan's own
  // user id — so they go out together rather than in series. This runs unattended
  // for every due plan on every sweep, so three round trips became one.
  //
  // The VAT treatment is re-resolved per cycle rather than frozen on the plan,
  // for the same reason recurrence eligibility is re-checked above: a customer
  // who registers a VAT number should stop paying VAT from the next charge, and
  // one whose registration lapses must start paying it again. Reading the user
  // fresh also means a status the webhook updated is picked up immediately.
  const [specialRequests, cleaningTools, customer] = await Promise.all([
    resolveSpecialRequests(subscription.specialRequests, service),
    resolveCleaningTools(subscription.cleaningTools, service),
    subscription.user
      ? User.findById(subscription.user)
          // `personalId` rides along so a plan created before the field
          // existed can stamp the customer's current number on each cycle.
          .select('customerType vatNumber vatStatus companyName personalId')
          .lean()
      : null
  ]);

  const netTotal = computeBookingTotal({
    service,
    // Re-priced every cycle from the plan's own duration, so an exact-minute
    // visit charges the same pro-rated amount each time.
    durationMinutes: durationInMinutes(subscription),
    cleaners: subscription.cleaners,
    specialRequests,
    cleaningTools
  });

  const { totalAmount, tax } = priceForCustomer(netTotal, customer);

  return { service, city, specialRequests, cleaningTools, totalAmount, tax, customer };
};

// Create a paid cycle booking directly. There is no PendingBooking for an
// unattended charge; the existing sparse-unique paymentIntentId index is the
// idempotency boundary and resolves job/webhook races.
const createBookingFromSubscription = async ({
  subscription,
  paymentIntent,
  serviceDate,
  totalAmount,
  tax,
  specialRequests,
  cleaningTools,
  customer
}) => {
  const existing = await Booking.findOne({ paymentIntentId: paymentIntent.id });
  if (existing) return existing;

  // The plan's snapshot wins; a legacy plan with none falls back to the
  // customer's current profile value (read by priceSubscriptionCycle), so
  // adding the number to the profile is enough to get it onto future cycles.
  const customerPersonalId = subscription.customerPersonalId || customer?.personalId;

  try {
    return await Booking.create({
      user: subscription.user,
      serviceId: subscription.serviceId,
      cityId: subscription.cityId,
      customerName: subscription.customerName,
      customerEmail: subscription.customerEmail,
      customerPhone: subscription.customerPhone,
      ...(customerPersonalId ? { customerPersonalId } : {}),
      streetName: subscription.streetName,
      houseNumber: subscription.houseNumber,
      propertySize: subscription.propertySize,
      doorbellName: subscription.doorbellName,
      bookingDate: serviceDate,
      bookingTime: subscription.bookingTime,
      durationMinutes: durationInMinutes(subscription),
      cleaners: subscription.cleaners,
      totalAmount,
      // The treatment this cycle was priced under. Undefined on the webhook
      // repair path (which only knows the captured amount) — the schema
      // defaults then describe a standard-rate charge, which is what an amount
      // recovered from Stripe with no other context has to be assumed to be.
      tax,
      notes: subscription.notes ?? null,
      specialRequests: specialRequests?.map((item) => item._id) || subscription.specialRequests || [],
      cleaningTools: cleaningTools?.map((item) => item._id) || subscription.cleaningTools || [],
      supplies: subscription.supplies || [],
      status: 'confirmed',
      paymentIntentId: paymentIntent.id,
      subscriptionId: subscription._id,
      paymentMethod: 'card',
      paymentStatus: 'paid',
      amountPaid: totalAmount,
      currency: CURRENCY,
      paidAt: new Date(),
      stripeStatus: paymentIntent.status || 'succeeded'
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
    return Booking.findOne({ paymentIntentId: paymentIntent.id });
  }
};

// Exactly one caller may advance a service date. A job and its Stripe webhook
// can both see the same successful PI, but the schedule predicate prevents the
// second caller from skipping an additional cycle.
const markCycleSucceeded = async ({ subscription, serviceDate, paymentIntent, totalAmount }) => {
  const now = new Date();
  const schedule = getNextSchedule(serviceDate, subscription.intervalDays);
  return Subscription.findOneAndUpdate(
    {
      _id: subscription._id,
      status: 'active',
      nextServiceDate: serviceDate,
      processingAt: subscription.processingAt
    },
    {
      $set: {
        nextServiceDate: schedule.nextServiceDate,
        nextChargeAt: schedule.nextChargeAt,
        failedAttempts: 0,
        lastChargeStatus: 'succeeded',
        lastChargeAt: now,
        lastError: null,
        lastCycleAmount: totalAmount,
        processingAt: null
      },
      ...pushChargeAttempt({
        at: now,
        serviceDate,
        status: 'succeeded',
        paymentIntentId: paymentIntent.id,
        amount: totalAmount
      })
    },
    { returnDocument: 'after' }
  );
};

const clearProcessingAt = async (subscription) => {
  await Subscription.updateOne(
    { _id: subscription._id, processingAt: subscription.processingAt },
    { $set: { processingAt: null } }
  );
};

const pauseSubscription = async ({
  subscription,
  reason = null,
  errorMessage,
  errorCode = null,
  paymentIntentId = undefined,
  amount = undefined,
  recordAttempt = true
}) => {
  const now = new Date();
  const set = {
    status: 'paused',
    pausedReason: reason,
    pausedAt: now,
    processingAt: null,
    lastChargeStatus: 'failed',
    lastChargeAt: now,
    lastError: errorMessage || null
  };

  const update = { $set: set };
  if (recordAttempt) {
    Object.assign(update, pushChargeAttempt({
      at: now,
      serviceDate: subscription.nextServiceDate,
      status: 'failed',
      paymentIntentId,
      amount,
      errorCode,
      errorMessage
    }));
  }

  return Subscription.findOneAndUpdate(
    {
      _id: subscription._id,
      status: 'active',
      nextServiceDate: subscription.nextServiceDate,
      processingAt: subscription.processingAt
    },
    update,
    { returnDocument: 'after' }
  );
};

/**
 * Record a Stripe card decline. failedAttempts counts *previous* failures, so
 * the first PI key is a0 and the third total decline pauses the subscription.
 */
const handleChargeFailure = async (subscription, err, amount = undefined) => {
  const now = new Date();
  const attemptNumber = Number(subscription.failedAttempts || 0) + 1;
  const maxAttempts = getMaxAttempts();
  const errorCode = getErrorCode(err);
  const errorMessage = getErrorMessage(err);
  const paymentIntentId = getErrorPaymentIntentId(err);
  const attempt = {
    at: now,
    serviceDate: subscription.nextServiceDate,
    status: 'failed',
    paymentIntentId,
    amount,
    errorCode,
    errorMessage
  };

  const set = {
    failedAttempts: attemptNumber,
    lastChargeStatus: 'failed',
    lastChargeAt: now,
    lastError: errorMessage,
    processingAt: null
  };

  if (attemptNumber >= maxAttempts) {
    set.status = 'paused';
    set.pausedReason = 'payment-failed';
    set.pausedAt = now;
  } else {
    set.nextChargeAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }

  const updated = await Subscription.findOneAndUpdate(
    {
      _id: subscription._id,
      status: 'active',
      nextServiceDate: subscription.nextServiceDate,
      processingAt: subscription.processingAt
    },
    {
      $set: set,
      ...pushChargeAttempt(attempt)
    },
    { returnDocument: 'after' }
  );

  if (!updated) return null;

  if (attemptNumber >= maxAttempts) {
    sendBestEffortEmail({
      email: updated.customerEmail,
      ...renderSubscriptionPausedEmail({
        subscription: updated,
        reason: 'payment-failed',
        errorMessage
      })
    });
  } else {
    sendBestEffortEmail({
      email: updated.customerEmail,
      ...renderChargeFailedEmail({
        subscription: updated,
        attemptNumber,
        errorMessage
      })
    });
  }

  return updated;
};

/**
 * Charge exactly one already-claimed active subscription. All failures are
 * contained here so the scheduler can continue sweeping other subscriptions.
 */
const chargeSubscriptionCycle = async (subscription) => {
  try {
    // A customer/admin may pause or cancel after the scheduler claims this
    // document. Do not let a stale worker create a new unattended charge after
    // that state change; a stale-lock takeover also gets the same protection.
    const stillClaimed = await Subscription.exists({
      _id: subscription._id,
      status: 'active',
      processingAt: subscription.processingAt
    });
    if (!stillClaimed) return { outcome: 'claim-released' };

    const serviceDate = subscription.nextServiceDate;
    if (serviceDate < todayString()) {
      await pauseSubscription({
        subscription,
        errorMessage: 'This recurring service date was missed and will not be charged.',
        errorCode: 'cycle_missed',
        recordAttempt: false
      });
      return { outcome: 'paused-cycle-missed' };
    }

    let paymentMethod;
    try {
      paymentMethod = await stripe.paymentMethods.retrieve(subscription.paymentMethodId);
    } catch (err) {
      // Only a genuinely missing card pauses the subscription. A network/API
      // outage is a non-Stripe processing error: clear the claim and retry on
      // the next sweep without moving nextChargeAt or failure state.
      if (!isMissingPaymentMethodError(err)) throw err;
      const paused = await pauseSubscription({
        subscription,
        reason: 'card-removed',
        errorMessage: 'The saved card could not be found.',
        errorCode: getErrorCode(err) || 'payment_method_missing'
      });
      if (paused) {
        sendBestEffortEmail({
          email: paused.customerEmail,
          ...renderSubscriptionPausedEmail({
            subscription: paused,
            reason: 'card-removed',
            errorMessage: paused.lastError
          })
        });
      }
      return { outcome: 'paused-card-removed' };
    }

    if (!paymentMethod || stripeId(paymentMethod.customer) !== subscription.stripeCustomerId) {
      const paused = await pauseSubscription({
        subscription,
        reason: 'card-removed',
        errorMessage: 'The saved card is no longer attached to your account.',
        errorCode: 'payment_method_customer_mismatch'
      });
      if (paused) {
        sendBestEffortEmail({
          email: paused.customerEmail,
          ...renderSubscriptionPausedEmail({
            subscription: paused,
            reason: 'card-removed',
            errorMessage: paused.lastError
          })
        });
      }
      return { outcome: 'paused-card-removed' };
    }

    let priced;
    try {
      priced = await priceSubscriptionCycle(subscription);
    } catch (err) {
      if (!(err instanceof AppError) && !err?.isOperational) throw err;

      const paused = await pauseSubscription({
        subscription,
        reason: 'service-unavailable',
        errorMessage: err.message,
        errorCode: 'service_unavailable'
      });
      if (paused) {
        sendBestEffortEmail({
          email: paused.customerEmail,
          ...renderSubscriptionPausedEmail({
            subscription: paused,
            reason: 'service-unavailable',
            errorMessage: paused.lastError
          })
        });
      }
      return { outcome: 'paused-service-unavailable' };
    }

    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create(
        {
          amount: toMinorUnits(priced.totalAmount),
          currency: CURRENCY,
          customer: subscription.stripeCustomerId,
          payment_method: subscription.paymentMethodId,
          off_session: true,
          confirm: true,
          receipt_email: subscription.customerEmail,
          metadata: {
            type: 'subscription-cycle',
            subscriptionId: String(subscription._id),
            serviceDate,
            userId: String(subscription.user)
          }
        },
        {
          // Attempts deliberately form part of the key: Stripe replays a
          // failed response for a reused key, so a retry must be a1/a2/etc.
          idempotencyKey: `subcycle:${subscription._id}:${serviceDate}:a${subscription.failedAttempts}`
        }
      );
    } catch (err) {
      // authentication_required is a StripeCardError too. Off-session 3DS is
      // impossible, so it is intentionally treated as an ordinary decline.
      if (err?.type === 'StripeCardError') {
        await handleChargeFailure(subscription, err, priced.totalAmount);
        return { outcome: 'card-declined' };
      }
      throw err;
    }

    if (paymentIntent.status !== 'succeeded') {
      throw new Error(`Subscription PaymentIntent ${paymentIntent.id} returned ${paymentIntent.status}.`);
    }

    const cycleBooking = await createBookingFromSubscription({
      subscription,
      paymentIntent,
      serviceDate,
      totalAmount: priced.totalAmount,
      tax: priced.tax,
      specialRequests: priced.specialRequests,
      cleaningTools: priced.cleaningTools,
      customer: priced.customer
    });

    const advanced = await markCycleSucceeded({
      subscription,
      serviceDate,
      paymentIntent,
      totalAmount: priced.totalAmount
    });

    if (advanced) {
      sendCycleReceipt({
        subscription: advanced,
        booking: cycleBooking,
        serviceName: priced.service.name,
        serviceDate,
        amount: priced.totalAmount
      });
      return { outcome: 'succeeded', subscription: advanced };
    }

    // A webhook may have won the conditional schedule advance. Its own update
    // clears the lock, but make that invariant explicit for other race paths.
    await clearProcessingAt(subscription);
    return { outcome: 'already-succeeded' };
  } catch (err) {
    // Transient/non-Stripe errors must neither increment failure state nor move
    // nextChargeAt. The next hourly sweep gets another chance.
    console.error('Subscription charge error:', err.message);
    await clearProcessingAt(subscription).catch((clearErr) => {
      console.error('Subscription lock clear error:', clearErr.message);
    });
    return { outcome: 'error', error: err };
  }
};

/**
 * Webhook backstop for a successful subscription-cycle PaymentIntent. The job
 * normally creates the booking synchronously, but a crash between Stripe's
 * success and the direct Booking.create must still never leave a paid cycle
 * without a reservation.
 */
const ensureSubscriptionCycleBooking = async (paymentIntent) => {
  const metadata = paymentIntent?.metadata || {};
  const subscriptionId = metadata.subscriptionId;
  const serviceDate = metadata.serviceDate;

  if (
    !mongoose.Types.ObjectId.isValid(subscriptionId) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(String(serviceDate || ''))
  ) {
    return null;
  }

  const subscription = await Subscription.findById(subscriptionId);
  if (!subscription) return null;

  // Metadata is written only by this server and Stripe signs the event, but
  // keep reference resolution fail-closed before attaching a paid booking.
  if (
    String(subscription.user) !== String(metadata.userId) ||
    stripeId(paymentIntent.customer) !== subscription.stripeCustomerId
  ) {
    return null;
  }

  const amount = fromMinorUnits(paymentIntent.amount);
  if (!Number.isFinite(amount) || amount < 0) return null;

  // Idempotent fast path: the charge worker normally created this cycle's
  // booking synchronously, so a duplicate/late delivery just returns it.
  const existing = await Booking.findOne({ paymentIntentId: paymentIntent.id });
  if (existing) return existing;

  // Nothing exists yet, so this really is the crash-repair path. Only create a
  // booking if the plan is STILL on this exact cycle — the same predicate
  // markCycleSucceeded uses. Without this gate a late webhook retry could add a
  // fresh confirmed booking to a subscription the customer has since paused or
  // cancelled (the schedule advance would correctly refuse, leaving the two
  // records disagreeing about whether the cycle happened).
  if (subscription.status !== 'active' || subscription.nextServiceDate !== serviceDate) {
    return null;
  }

  const booking = await createBookingFromSubscription({
    subscription,
    paymentIntent,
    serviceDate,
    totalAmount: amount
  });
  const advanced = await markCycleSucceeded({
    subscription,
    serviceDate,
    paymentIntent,
    totalAmount: amount
  });

  if (advanced) {
    sendCycleReceipt({
      subscription: advanced,
      booking,
      serviceName: 'Cleaning service',
      serviceDate,
      amount
    });
  }

  return booking;
};

module.exports = {
  createSubscriptionFromFirstBooking,
  priceSubscriptionCycle,
  chargeSubscriptionCycle,
  handleChargeFailure,
  ensureSubscriptionCycleBooking,
  createBookingFromSubscription,
  renderChargeFailedEmail,
  renderSubscriptionPausedEmail,
  renderSubscriptionCancelledEmail,
  sendBestEffortEmail,
  getNextSchedule,
  projectOccurrences,
  MAX_OCCURRENCE_SPAN_DAYS,
  getChargeLeadDays,
  getMaxAttempts,
  formatEuro
};
