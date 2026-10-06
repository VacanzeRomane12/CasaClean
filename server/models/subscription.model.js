const mongoose = require('mongoose');

const { MIN_INTERVAL_DAYS, MAX_INTERVAL_DAYS } = require('../utils/date.util');

// A recurring-cleaning template. Prices intentionally do not live here: every
// cycle is re-resolved against the current enabled catalogue before charging.
const chargeAttemptSchema = new mongoose.Schema({
  at: { type: Date, required: true },
  serviceDate: { type: String, required: true },
  status: { type: String, enum: ['succeeded', 'failed'], required: true },
  paymentIntentId: { type: String },
  amount: { type: Number, min: 0 },
  errorCode: { type: String },
  errorMessage: { type: String }
}, { _id: false });

const subscriptionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  serviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service',
    required: true
  },
  cityId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'City',
    required: true
  },

  // Template snapshot. These fields mirror PendingBooking.draft except for the
  // service date and the server-computed price, which must be fresh per cycle.
  customerName: { type: String, required: true, trim: true },
  customerEmail: { type: String, required: true, trim: true, lowercase: true },
  customerPhone: { type: String, required: true, trim: true },
  // Snapshotted like the phone; absent on plans created before the field
  // existed, in which case each cycle falls back to the customer's current
  // profile value (createBookingFromSubscription).
  customerPersonalId: { type: String, trim: true },
  streetName: { type: String, required: true, trim: true },
  houseNumber: { type: String, required: true, trim: true },
  propertySize: { type: String, required: true, trim: true },
  doorbellName: { type: String, required: true, trim: true },
  bookingTime: { type: String, required: true },
  // Total minutes per visit. `hours` is the legacy field on plans created
  // before durations went to the minute; read via durationInMinutes().
  durationMinutes: {
    type: Number,
    min: 1,
    // Required for anything written now; a legacy plan that carries `hours`
    // instead is still a valid document, so it isn't required outright.
    required: [function () { return this.hours === undefined; }, 'Duration is required!']
  },
  hours: { type: Number, min: 0 },
  cleaners: { type: Number, required: true, min: 1 },
  notes: { type: String, trim: true, maxlength: 2000, default: null },
  specialRequests: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SpecialRequest' }],
    default: []
  },
  cleaningTools: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'CleaningTool' }],
    default: []
  },
  supplies: { type: [String], default: [] },

  // The cadence the customer chose, already checked against the service's own
  // recurrence rules (Service.recurringEnabled / recurringIntervalDays). Only
  // the platform-wide bounds are re-asserted here.
  intervalDays: {
    type: Number,
    required: true,
    min: MIN_INTERVAL_DAYS,
    max: MAX_INTERVAL_DAYS,
    validate: {
      validator: Number.isInteger,
      message: 'intervalDays must be a whole number of days!'
    }
  },
  status: {
    type: String,
    enum: ['active', 'paused', 'cancelled'],
    default: 'active'
  },
  pausedReason: {
    type: String,
    enum: ['payment-failed', 'card-removed', 'service-unavailable', 'user-request', null],
    default: null
  },

  nextServiceDate: { type: String, required: true },
  nextChargeAt: { type: Date, required: true },

  stripeCustomerId: { type: String, required: true },
  paymentMethodId: { type: String, required: true },
  // No default null: this remains sparse so unrelated/migrated documents do
  // not collide. It is the idempotency anchor for first-cycle creation.
  firstPaymentIntentId: { type: String },

  failedAttempts: { type: Number, default: 0, min: 0 },
  lastChargeStatus: {
    type: String,
    enum: ['succeeded', 'failed', null],
    default: null
  },
  lastChargeAt: { type: Date },
  lastError: { type: String, default: null },
  lastCycleAmount: { type: Number, min: 0 },
  chargeAttempts: { type: [chargeAttemptSchema], default: [] },
  // Claimed atomically by the scheduler. A stale lock is reclaimable so a
  // process crash cannot hold a cycle forever.
  processingAt: { type: Date, default: null },
  // When the scheduler last CLAIMED this subscription, set in the same atomic
  // update as processingAt and never cleared. processingAt alone can't answer
  // "did this sweep already try this one?", because a transient failure clears
  // the lock while leaving nextChargeAt due — which is exactly the case that
  // would otherwise make one sweep spin on the same document forever.
  // See jobs/subscriptionCharge.job.js.
  lastAttemptAt: { type: Date, default: null },
  pausedAt: { type: Date },
  cancelledAt: { type: Date }
}, { timestamps: true, collection: 'subscriptions' });

subscriptionSchema.index({ user: 1, createdAt: -1 });
// The scheduler's claim query: the due-and-active set, oldest due first.
subscriptionSchema.index({ status: 1, nextChargeAt: 1 });
// The admin list filters on status but sorts on createdAt, which the index above
// can't serve (its second key is nextChargeAt) — that combination was falling
// back to an in-memory sort of every matching subscription.
subscriptionSchema.index({ status: 1, createdAt: -1 });
// The admin calendar projects upcoming visits from every ACTIVE plan whose next
// uncharged date falls on or before the end of the visible range
// (GET /subscription/occurrences) — a status + nextServiceDate range scan.
subscriptionSchema.index({ status: 1, nextServiceDate: 1 });
subscriptionSchema.index({ firstPaymentIntentId: 1 }, { unique: true, sparse: true });

const Subscription = mongoose.model('Subscription', subscriptionSchema);
module.exports = Subscription;
