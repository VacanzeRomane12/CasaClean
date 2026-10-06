const mongoose = require('mongoose');

const {
  isValidDurationMinutes,
  MIN_DURATION_MINUTES,
  MAX_DURATION_MINUTES
} = require('../utils/duration.util');

// Booking
// -------
// A single cleaning reservation made by a signed-in user. Field names use
// camelCase to stay consistent with the rest of the Mongoose models in this
// codebase (user/city/service). The public create flow is validated up-front by
// the Zod schema in validations/booking.validation.js, so the controller never
// trusts raw req.body for writes.
//
// `serviceId` and `cityId` reference the database-backed Service/City documents
// the booking wizard selects. They are ObjectId refs and required — a booking
// must always resolve to a real, enabled service and city (validated in the
// controller via resolveServiceAndCity before the document is created).
const bookingSchema = new mongoose.Schema({
  // Owner of the booking. For customer self-service bookings this is always the
  // signed-in user (set by the controller, used for "my bookings" and auditing).
  // It is intentionally OPTIONAL: an admin may create a booking on a customer's
  // behalf without linking it to a registered account (walk-in / phone booking),
  // in which case the customer identity lives only in the customerName/email/phone
  // fields below. The controller enforces that customer self-bookings are always
  // owned by req.user.
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  serviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Service",
    required: [true, "Service ID is required!"]
  },
  cityId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "City",
    required: [true, "City ID is required!"]
  },
  customerName: {
    type: String,
    required: true,
    trim: [true, "Customer Name is required!"]
  },
  customerEmail: {
    type: String,
    required: [true, "Customer email is required!"],
    trim: true,
    lowercase: true
  },
  customerPhone: {
    type: String,
    required: [true, "Customer phone number is required!"],
    trim: true
  },
  // The customer's personal identification number as it read when the booking
  // was made (utils/personalId.util.js owns the format). Required for every
  // customer booking — enforced in buildValidatedBookingDraft, which falls back
  // to User.personalId — but NOT required here: bookings written before the
  // field existed carry none and must still save (the cancel path calls
  // save()), and an admin recording a walk-in may not have the number at hand.
  customerPersonalId: {
    type: String,
    trim: true
  },
  streetName: {
    type: String,
    required: [true, "Street name is required!"],
    trim: true
  },
  houseNumber: {
    type: String,
    required: [true, "House number is required!"],
    trim: true
  },
  propertySize: {
    type: String,
    required: [true, "House property size is required!"],
    trim: true
  },
  doorbellName: {
    type: String,
    required: [true, "Doorbell name is required!"],
    trim: true
  },
  // Stored as strings ("2026-02-04" / "14:00"). Format is enforced by the Zod
  // validation layer; kept as strings to match the client contract.
  bookingDate: {
    type: String,
    required: [true, "Booking date is required!"]
  },
  bookingTime: {
    type: String,
    required: [true, "Booking time is required!"]
  },
  // How long the visit lasts, in TOTAL MINUTES — 85 is a 1 h 25 min booking.
  // The bounds live in utils/duration.util.js so the Zod layer and this one
  // can't drift, and minutes are what every downstream calculation reads
  // (pricing, the working-hours window, the cancellation fee).
  durationMinutes: {
    type: Number,
    required: [true, "Booking duration is required!"],
    validate: {
      validator: isValidDurationMinutes,
      message: `A booking's duration must be a whole number of minutes between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES}.`
    }
  },
  // LEGACY. Durations used to be stored as whole/half hours; records written
  // before minutes existed still carry this and no `durationMinutes`. Nothing
  // writes it any more — read a duration with `durationInMinutes(booking)`,
  // which understands both shapes.
  hours: {
    type: Number,
    min: [0, "Duration can't be negative."]
  },
  cleaners: {
    type: Number,
    required: [true, "Cleaners count is required!"],
    min: [1, "A booking must have at least 1 cleaner."]
  },
  // What the customer actually owes, after the VAT treatment below has been
  // applied to the gross catalogue price. For an individual this IS the
  // catalogue price; for a reverse-charge business it's the net.
  totalAmount: {
    type: Number,
    required: [true, "Total amount is required!"],
    min: [0, "Total amount can't be negative."]
  },
  // --- VAT treatment (snapshot) -----------------------------------------------
  // Resolved server-side from the customer's stored, Stripe-verified profile at
  // pricing time (utils/tax.util.js) and frozen here, so the record states what
  // was actually charged rather than re-deriving it from configuration that may
  // have changed since. `netAmount + vatAmount === totalAmount` in both
  // treatments. Absent on bookings made before VAT handling existed — readers
  // fall back to splitting totalAmount at the configured rate.
  tax: {
    // 'standard'       — charged the catalogue price plus VAT on top.
    // 'reverse-charge' — verified EU business; no VAT added to the charge, and
    //                    it is accounted for by the customer.
    treatment: {
      type: String,
      enum: ['standard', 'reverse-charge'],
      default: 'standard'
    },
    customerType: {
      type: String,
      enum: ['individual', 'business'],
      default: 'individual'
    },
    // The customer's VAT number as it read at booking time (reverse charge only)
    // — the record keeps the number the relief was granted against.
    vatNumber: { type: String, default: '' },
    // Registered company name at booking time, kept alongside the contact's
    // personal name when it's set.
    companyName: { type: String, default: '' },
    // The rate catalogue prices are taxed at, as it stood when this booking was
    // priced. Kept so a later rate change can't restate a completed transaction.
    catalogueVatRate: { type: Number, default: 0, min: 0 },
    // The rate actually charged: catalogueVatRate normally, 0 on reverse charge.
    vatRate: { type: Number, default: 0, min: 0 },
    netAmount: { type: Number, min: 0 },
    vatAmount: { type: Number, min: 0, default: 0 }
  },
  notes: {
    type: String,
    trim: true,
    maxlength: [2000, "Notes can't exceed 2000 characters."],
    default: null
  },
  // Add-on requests (e.g. "Fridge Cleaning"). References to SpecialRequest
  // documents so each item is a real, priced catalogue entry rather than an
  // arbitrary string. Renamed from the old `additional_services`.
  specialRequests: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SpecialRequest' }],
    default: []
  },
  // Catalogue-backed tools the customer asks the cleaners to bring (e.g. "Mop",
  // "Vacuum cleaner"). References to CleaningTool documents so each item is a
  // real, priced entry — resolved fail-closed against the chosen service before
  // the booking is created (resolveCleaningTools in booking.service.js).
  cleaningTools: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'CleaningTool' }],
    default: []
  },
  // Equipment/consumables the customer asks the cleaners to bring. Still a free
  // list of slugs from the UI (no catalogue model needed for these yet).
  supplies: {
    type: [String],
    default: []
  },
  // Cleaning staff assigned to this booking. Admin-managed only — references to
  // Worker documents so each entry is a real staff member. Customers never set
  // this; the controller only honours it for admin requests (resolveWorkers
  // validates the ids before they're stored).
  workers: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Worker' }],
    default: []
  },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'cancelled', 'completed'],
    default: 'confirmed'
  },
  // --- Payment fields ---------------------------------------------------------
  // All server-managed (never accepted from the public create endpoint). For a
  // customer online booking they're populated when the PaymentIntent succeeds
  // (promotePendingBooking); for an admin walk-in/phone booking the payment is
  // recorded as 'manual' with no Stripe involvement.
  //
  // No `default: null` on paymentIntentId: the sparse unique index below only
  // ignores documents where this field is ABSENT, not where it's null.
  // Defaulting to null would put every manual/payment-less booking into the
  // index as null and collide on the second one — so the field stays unset until
  // a real payment id exists.
  paymentIntentId: {
    type: String
  },
  // Present only for bookings created from a recurring subscription. Like the
  // payment intent field, leave this absent (rather than defaulting to null)
  // for one-off/manual bookings.
  subscriptionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subscription'
  },
  // How the booking was paid for: an online card charge, or a manual/offline
  // (cash) booking entered by an admin.
  paymentMethod: {
    type: String,
    enum: ['card', 'manual'],
    default: 'card'
  },
  // Lifecycle of the money: unpaid (no charge yet), paid (captured), refunded
  // (charge reversed on cancellation), partially-refunded (a late cancellation
  // that kept the one-hour fee — see utils/cancellation.util.js), or manual
  // (offline booking, no Stripe).
  //
  // 'partially-refunded' is deliberately its own state rather than 'refunded':
  // money was kept, so the booking must not read as if the customer got
  // everything back. It also can't be 'paid', or a support view would show a
  // charge that no longer stands.
  paymentStatus: {
    type: String,
    enum: ['unpaid', 'paid', 'refunded', 'partially-refunded', 'manual'],
    default: 'unpaid'
  },
  // Amount actually captured, in decimal euros (mirrors totalAmount at pay time).
  amountPaid: {
    type: Number,
    min: [0, "Amount paid can't be negative."]
  },
  currency: {
    type: String,
    default: 'eur'
  },
  // Stripe refund id, set when a paid booking is cancelled & refunded.
  refundId: {
    type: String
  },
  // How much was actually returned, in decimal euros. Equals totalAmount for a
  // full refund; for a late cancellation it is the charge minus the retained
  // one-hour fee, so `totalAmount - refundAmount` is what the customer was
  // billed for cancelling.
  refundAmount: {
    type: Number,
    min: [0, "Refund amount can't be negative."]
  },
  paidAt: {
    type: Date
  },
  refundedAt: {
    type: Date
  },
  // Raw Stripe status mirror (e.g. 'succeeded' / 'refunded') for support/debug.
  stripeStatus: {
    type: String,
    default: ''
  }
}, { timestamps: true, collection: 'bookings' });

// --- Indexes ----------------------------------------------------------------
// Admin booking list — the whole collection sorted newest-first (no filter),
// so a standalone createdAt index backs the sort instead of an in-memory sort.
bookingSchema.index({ createdAt: -1 });
// "My bookings" — list a user's bookings, newest first.
bookingSchema.index({ user: 1, createdAt: -1 });
// Admin filtering by status and/or date.
bookingSchema.index({ status: 1, bookingDate: 1 });
// The admin list filters on status but sorts on createdAt, which the index
// above can't serve (its second key is bookingDate) — that combination was
// falling back to an in-memory sort of every matching booking.
bookingSchema.index({ status: 1, createdAt: -1 });
// The same list filters on a bookingDate range with no status, which neither
// compound index can serve without a status prefix.
bookingSchema.index({ bookingDate: 1 });
// Referential guards (utils/referentialGuard.util.js) ask "is any booking still
// pointing at this catalogue record?" before an admin deletes one. Unindexed,
// every one of those probes scanned the largest collection in the database.
bookingSchema.index({ serviceId: 1 });
bookingSchema.index({ cityId: 1 });
bookingSchema.index({ specialRequests: 1 });
bookingSchema.index({ cleaningTools: 1 });
bookingSchema.index({ workers: 1 });
// Idempotency guard: a given payment can back at most one booking. `sparse` so
// the many bookings without a payment id (current state) don't collide on null.
bookingSchema.index({ paymentIntentId: 1 }, { unique: true, sparse: true });
// Subscription detail/history queries fetch each cycle newest first.
bookingSchema.index({ subscriptionId: 1, createdAt: -1 });

const Booking = mongoose.model('Booking', bookingSchema);
module.exports = Booking;
