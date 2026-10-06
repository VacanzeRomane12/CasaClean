const mongoose = require('mongoose');

const stripe = require('../config/stripe.config');
const Subscription = require('../models/subscription.model');
const Booking = require('../models/booking.model');
const User = require('../models/user.model');
const catchAsync = require('../utils/catchAsync.util');
const AppError = require('../utils/appError.util');
const {
  addDaysToDateString,
  localMidnight,
  todayString
} = require('../utils/date.util');
const {
  getChargeLeadDays,
  renderSubscriptionCancelledEmail,
  sendBestEffortEmail,
  projectOccurrences,
  MAX_OCCURRENCE_SPAN_DAYS
} = require('../services/subscription.service');
const { durationInMinutes } = require('../utils/duration.util');

const CUSTOMER_SUBSCRIPTION_FIELDS = [
  'serviceId', 'cityId', 'intervalDays', 'status', 'pausedReason',
  'nextServiceDate', 'nextChargeAt', 'failedAttempts', 'lastChargeStatus',
  'lastChargeAt', 'lastError', 'lastCycleAmount', 'chargeAttempts',
  'createdAt', 'updatedAt', 'cancelledAt'
].join(' ');

const ADMIN_SUBSCRIPTION_FIELDS = [
  'user', 'serviceId', 'cityId', 'customerName', 'customerEmail',
  'customerPhone', 'customerPersonalId', 'streetName', 'houseNumber', 'propertySize',
  'doorbellName', 'bookingTime', 'durationMinutes', 'hours', 'cleaners', 'notes',
  'specialRequests', 'cleaningTools', 'supplies', 'intervalDays', 'status',
  'pausedReason', 'nextServiceDate', 'nextChargeAt', 'failedAttempts',
  'lastChargeStatus', 'lastChargeAt', 'lastError', 'lastCycleAmount',
  'chargeAttempts', 'processingAt', 'pausedAt', 'cancelledAt', 'createdAt',
  'updatedAt'
].join(' ');

const assertObjectId = (id, next) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    next(new AppError('Invalid subscription id!', 400));
    return false;
  }
  return true;
};

const getOwnedSubscription = async (req, res, next) => {
  const { id } = req.params;
  if (!assertObjectId(id, next)) return null;

  const subscription = await Subscription.findOne({ _id: id, user: req.user._id });
  if (!subscription) {
    next(new AppError('Subscription not found!', 404));
    return null;
  }
  return subscription;
};

const customerResponse = (subscription) => subscription?.toObject
  ? subscription.toObject()
  : subscription;

const assertNoChargeInProgress = (subscription) => {
  if (subscription.processingAt) {
    throw new AppError('A subscription charge is currently in progress. Please try again shortly.', 409);
  }
};

const getResumeSchedule = (subscription) => {
  const today = todayString();
  let nextServiceDate = subscription.nextServiceDate;

  // A paused subscription must never revive a service date in the past. Start
  // a fresh interval from today instead of resurrecting an old cadence/visit.
  if (nextServiceDate < today) {
    nextServiceDate = addDaysToDateString(today, subscription.intervalDays);
  }

  const chargeDate = addDaysToDateString(nextServiceDate, -getChargeLeadDays());
  return { nextServiceDate, nextChargeAt: localMidnight(chargeDate) };
};

const verifyStoredPaymentMethod = async (subscription) => {
  let paymentMethod;
  try {
    paymentMethod = await stripe.paymentMethods.retrieve(subscription.paymentMethodId);
  } catch {
    return false;
  }
  const customerId = typeof paymentMethod?.customer === 'string'
    ? paymentMethod.customer
    : paymentMethod?.customer?.id;
  return customerId === subscription.stripeCustomerId;
};

const resumeSubscription = async (subscription) => {
  if (subscription.status !== 'paused') {
    throw new AppError('Only paused subscriptions can be resumed.', 400);
  }

  if (!(await verifyStoredPaymentMethod(subscription))) {
    throw new AppError('Please update your card first.', 400);
  }

  const schedule = getResumeSchedule(subscription);
  const resumed = await Subscription.findOneAndUpdate(
    { _id: subscription._id, status: 'paused' },
    {
      $set: {
        status: 'active',
        pausedReason: null,
        nextServiceDate: schedule.nextServiceDate,
        nextChargeAt: schedule.nextChargeAt,
        failedAttempts: 0,
        lastChargeStatus: null,
        lastError: null,
        processingAt: null
      },
      $unset: { pausedAt: '' }
    },
    { returnDocument: 'after' }
  ).select(CUSTOMER_SUBSCRIPTION_FIELDS);

  if (!resumed) {
    throw new AppError('Subscription state changed; please try again.', 409);
  }
  return resumed;
};

// GET /api/v1/subscription/my
//
// Bounded like every other list endpoint. This was the last customer-facing read
// with no ceiling at all: no skip, no limit, and `subscriptionCount` derived from
// the returned array, which only "worked" because the query was unbounded.
// The default limit is deliberately high rather than the usual 10 — the current
// client fetches this in one shot and renders the lot, so a low default would
// silently hide plans. `subscriptionCount` is now a real count, so a client can
// tell when there is more than it asked for.
const getMySubscriptions = catchAsync(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));

  const filter = { user: req.user._id };

  const [subscriptions, subscriptionCount] = await Promise.all([
    Subscription.find(filter)
      .select(CUSTOMER_SUBSCRIPTION_FIELDS)
      .populate('serviceId', 'name')
      .populate('cityId', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Subscription.countDocuments(filter)
  ]);

  res.status(200).json({
    status: 'success',
    message: 'Your subscriptions returned successfully!',
    subscriptionCount,
    data: { subscriptions }
  });
});

// PATCH /api/v1/subscription/:id/pause
const pauseMySubscription = catchAsync(async (req, res, next) => {
  const subscription = await getOwnedSubscription(req, res, next);
  if (!subscription) return;
  if (subscription.status !== 'active') {
    return next(new AppError('Only active subscriptions can be paused.', 400));
  }
  try {
    assertNoChargeInProgress(subscription);
  } catch (err) {
    return next(err);
  }

  const paused = await Subscription.findOneAndUpdate(
    {
      _id: subscription._id,
      user: req.user._id,
      status: 'active',
      processingAt: null
    },
    {
      $set: {
        status: 'paused',
        pausedReason: 'user-request',
        pausedAt: new Date(),
        processingAt: null
      }
    },
    { returnDocument: 'after' }
  ).select(CUSTOMER_SUBSCRIPTION_FIELDS);

  if (!paused) return next(new AppError('Subscription state changed; please try again.', 409));

  res.status(200).json({
    status: 'success',
    message: 'Subscription paused successfully!',
    data: { subscription: customerResponse(paused) }
  });
});

// PATCH /api/v1/subscription/:id/resume
const resumeMySubscription = catchAsync(async (req, res, next) => {
  const subscription = await getOwnedSubscription(req, res, next);
  if (!subscription) return;

  const resumed = await resumeSubscription(subscription);
  res.status(200).json({
    status: 'success',
    message: 'Subscription resumed successfully!',
    data: { subscription: customerResponse(resumed) }
  });
});

const cancelSubscription = async ({ subscription, ownerId = null }) => {
  if (subscription.status === 'cancelled') {
    throw new AppError('This subscription is already cancelled.', 400);
  }
  assertNoChargeInProgress(subscription);

  const filter = ownerId
    ? {
      _id: subscription._id,
      user: ownerId,
      status: { $ne: 'cancelled' },
      processingAt: null
    }
    : {
      _id: subscription._id,
      status: { $ne: 'cancelled' },
      processingAt: null
    };
  const cancelled = await Subscription.findOneAndUpdate(
    filter,
    {
      $set: {
        status: 'cancelled',
        cancelledAt: new Date(),
        processingAt: null
      }
    },
    { returnDocument: 'after' }
  );

  if (!cancelled) {
    throw new AppError('Subscription state changed; please try again.', 409);
  }

  // Do not cancel or refund already-created paid Bookings here. Those are
  // independently managed through cancelMyBooking and the existing policy.
  sendBestEffortEmail({
    email: cancelled.customerEmail,
    ...renderSubscriptionCancelledEmail({ subscription: cancelled })
  });

  return cancelled;
};

// PATCH /api/v1/subscription/:id/cancel
const cancelMySubscription = catchAsync(async (req, res, next) => {
  const subscription = await getOwnedSubscription(req, res, next);
  if (!subscription) return;

  const cancelled = await cancelSubscription({ subscription, ownerId: req.user._id });
  res.status(200).json({
    status: 'success',
    message: 'Subscription cancelled successfully!',
    data: { subscription: customerResponse(cancelled) }
  });
});

// PATCH /api/v1/subscription/:id/payment-method
const updateMySubscriptionCard = catchAsync(async (req, res, next) => {
  const subscription = await getOwnedSubscription(req, res, next);
  if (!subscription) return;
  // A cancelled plan will never charge again — refuse to re-point its card so
  // the action can't silently succeed against dead state (the UI already hides
  // it, this closes the direct-API path).
  if (subscription.status === 'cancelled') {
    return next(new AppError('This subscription is cancelled.', 400));
  }
  try {
    assertNoChargeInProgress(subscription);
  } catch (err) {
    return next(err);
  }

  const freshUser = await User.findById(req.user._id).select('stripeCustomerId');
  if (!freshUser?.stripeCustomerId) {
    return next(new AppError('No saved cards yet.', 404));
  }

  let paymentMethod;
  try {
    paymentMethod = await stripe.paymentMethods.retrieve(req.body.paymentMethodId);
  } catch {
    return next(new AppError('Card not found.', 404));
  }
  const paymentMethodCustomerId = typeof paymentMethod.customer === 'string'
    ? paymentMethod.customer
    : paymentMethod.customer?.id;
  if (paymentMethodCustomerId !== freshUser.stripeCustomerId) {
    return next(new AppError('Card not found.', 404));
  }

  const updated = await Subscription.findOneAndUpdate(
    { _id: subscription._id, user: req.user._id, status: { $ne: 'cancelled' }, processingAt: null },
    {
      $set: {
        paymentMethodId: req.body.paymentMethodId,
        stripeCustomerId: freshUser.stripeCustomerId,
        failedAttempts: 0,
        lastError: null
      }
    },
    { returnDocument: 'after' }
  ).select(CUSTOMER_SUBSCRIPTION_FIELDS);

  // A charge may have claimed the doc (or its state changed) between the guard
  // and the write — never report success when nothing was updated.
  if (!updated) {
    return next(new AppError('Subscription state changed; please try again.', 409));
  }

  res.status(200).json({
    status: 'success',
    message: 'Subscription card updated successfully!',
    data: { subscription: customerResponse(updated) }
  });
});

// GET /api/v1/subscription (admin)
const getSubscriptions = catchAsync(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
  const statuses = ['active', 'paused', 'cancelled'];
  const filter = statuses.includes(req.query.status) ? { status: req.query.status } : {};
  const hasFilter = Object.keys(filter).length > 0;

  const [subscriptions, subscriptionCount] = await Promise.all([
    Subscription.find(filter)
      .select(ADMIN_SUBSCRIPTION_FIELDS)
      .populate('user', 'fullname email')
      .populate('serviceId', 'name')
      .populate('cityId', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    hasFilter ? Subscription.countDocuments(filter) : Subscription.estimatedDocumentCount()
  ]);

  res.status(200).json({
    status: 'success',
    message: 'Subscriptions returned successfully!',
    subscriptionCount,
    data: { subscriptions }
  });
});

// GET /api/v1/subscription/occurrences?from=YYYY-MM-DD&to=YYYY-MM-DD (admin)
//
// The upcoming visits of every ACTIVE plan inside a date range, projected from
// each plan's rule rather than read from the bookings collection — a cycle's
// Booking only exists once it has been charged (one day ahead), so this is the
// only way the admin calendar can show what is coming. Nothing is written:
// pausing or cancelling a plan removes its projections on the next request,
// and a charged cycle drops out of the projection because the charge advanced
// nextServiceDate past it (see projectOccurrences).
//
// Both bounds are required and the span is capped so the expansion is bounded
// no matter what the caller asks for. Dates are "YYYY-MM-DD" strings, compared
// lexicographically like every other date in this codebase.
const OCCURRENCE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const getSubscriptionOccurrences = catchAsync(async (req, res, next) => {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');

  if (!OCCURRENCE_DATE_RE.test(from) || !OCCURRENCE_DATE_RE.test(to)) {
    return next(new AppError('Please provide from and to dates in YYYY-MM-DD format!', 400));
  }
  if (to < from) {
    return next(new AppError('The to date must not be before the from date!', 400));
  }
  // Span check through the same local-calendar helper the projection uses.
  if (addDaysToDateString(from, MAX_OCCURRENCE_SPAN_DAYS) < to) {
    return next(new AppError(
      `The date range cannot exceed ${MAX_OCCURRENCE_SPAN_DAYS} days!`,
      400
    ));
  }

  // Only plans that still have a visit to come on or before the end of the
  // range. Paused and cancelled plans schedule nothing, by definition.
  const subscriptions = await Subscription.find({
    status: 'active',
    nextServiceDate: { $lte: to }
  })
    .select(
      'serviceId cityId customerName customerEmail customerPhone customerPersonalId ' +
      'streetName houseNumber propertySize doorbellName bookingTime durationMinutes ' +
      'hours cleaners intervalDays nextServiceDate notes'
    )
    .populate('serviceId', 'name')
    .populate('cityId', 'name')
    .lean();

  const occurrences = [];
  for (const subscription of subscriptions) {
    for (const bookingDate of projectOccurrences(subscription, from, to)) {
      occurrences.push({
        subscriptionId: subscription._id,
        bookingDate,
        bookingTime: subscription.bookingTime,
        durationMinutes: durationInMinutes(subscription),
        cleaners: subscription.cleaners,
        customerName: subscription.customerName,
        customerEmail: subscription.customerEmail,
        customerPhone: subscription.customerPhone,
        customerPersonalId: subscription.customerPersonalId,
        streetName: subscription.streetName,
        houseNumber: subscription.houseNumber,
        propertySize: subscription.propertySize,
        doorbellName: subscription.doorbellName,
        serviceId: subscription.serviceId,
        cityId: subscription.cityId,
        intervalDays: subscription.intervalDays,
        notes: subscription.notes ?? null,
        // No price: every cycle is re-priced against the live catalogue when it
        // is charged, so a projected amount would be a promise we don't make.
        projected: true
      });
    }
  }
  occurrences.sort((a, b) =>
    a.bookingDate < b.bookingDate ? -1 : a.bookingDate > b.bookingDate ? 1 : 0
  );

  res.status(200).json({
    status: 'success',
    message: 'Upcoming recurring visits returned successfully!',
    occurrenceCount: occurrences.length,
    data: { occurrences }
  });
});

// GET /api/v1/subscription/:id (admin)
const getSubscriptionById = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!assertObjectId(id, next)) return;

  // The cycle history grows by one booking per charge, forever — a weekly plan
  // running three years is 156 populated bookings and there was no ceiling at
  // all. Bounded to the most recent cycles, newest first (the index
  // { subscriptionId: 1, createdAt: -1 } serves exactly this). The cap is high
  // rather than the usual 10 because the admin panel renders the history as one
  // flat list; `bookingCount` reports the true total so the UI can say how much
  // of it is on screen.
  const bookingPage = Math.max(1, Number(req.query.bookingPage) || 1);
  const bookingLimit = Math.min(200, Math.max(1, Number(req.query.bookingLimit) || 100));

  const [subscription, bookings, bookingCount] = await Promise.all([
    Subscription.findById(id)
      .select(ADMIN_SUBSCRIPTION_FIELDS)
      .populate('user', 'fullname email')
      .populate('serviceId', 'name')
      .populate('cityId', 'name')
      .lean(),
    Booking.find({ subscriptionId: id })
      .populate('serviceId', 'name')
      .populate('cityId', 'name')
      .sort({ createdAt: -1 })
      .skip((bookingPage - 1) * bookingLimit)
      .limit(bookingLimit)
      .lean(),
    Booking.countDocuments({ subscriptionId: id })
  ]);

  if (!subscription) return next(new AppError('Subscription not found!', 404));

  res.status(200).json({
    status: 'success',
    message: 'Subscription returned successfully!',
    bookingCount,
    data: { subscription, bookings }
  });
});

const adminPauseSubscription = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!assertObjectId(id, next)) return;

  const subscription = await Subscription.findById(id);
  if (!subscription) return next(new AppError('Subscription not found!', 404));
  if (subscription.status !== 'active') {
    return next(new AppError('Only active subscriptions can be paused.', 400));
  }
  try {
    assertNoChargeInProgress(subscription);
  } catch (err) {
    return next(err);
  }

  const paused = await Subscription.findOneAndUpdate(
    { _id: subscription._id, status: 'active', processingAt: null },
    {
      $set: {
        status: 'paused',
        pausedReason: null,
        pausedAt: new Date(),
        processingAt: null
      }
    },
    { returnDocument: 'after' }
  ).select(ADMIN_SUBSCRIPTION_FIELDS);
  if (!paused) return next(new AppError('Subscription state changed; please try again.', 409));

  res.status(200).json({
    status: 'success',
    message: 'Subscription paused successfully!',
    data: { subscription: paused }
  });
});

// The approved client plan includes an admin Resume action. It uses the same
// stored-card, stale-date, and failure-reset safeguards as customer resume.
const adminResumeSubscription = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!assertObjectId(id, next)) return;

  const subscription = await Subscription.findById(id);
  if (!subscription) return next(new AppError('Subscription not found!', 404));
  const resumed = await resumeSubscription(subscription);

  res.status(200).json({
    status: 'success',
    message: 'Subscription resumed successfully!',
    data: { subscription: resumed }
  });
});

const adminCancelSubscription = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!assertObjectId(id, next)) return;

  const subscription = await Subscription.findById(id);
  if (!subscription) return next(new AppError('Subscription not found!', 404));
  const cancelled = await cancelSubscription({ subscription });

  res.status(200).json({
    status: 'success',
    message: 'Subscription cancelled successfully!',
    data: { subscription: cancelled }
  });
});

module.exports = {
  getMySubscriptions,
  pauseMySubscription,
  resumeMySubscription,
  cancelMySubscription,
  updateMySubscriptionCard,
  getSubscriptions,
  getSubscriptionOccurrences,
  getSubscriptionById,
  adminPauseSubscription,
  adminResumeSubscription,
  adminCancelSubscription
};
