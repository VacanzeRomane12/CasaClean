const mongoose = require('mongoose');

// PendingBooking
// --------------
// A transient, SERVER-VALIDATED booking draft created the moment a customer
// begins paying. It holds the fully resolved & priced booking fields (computed
// server-side via buildValidatedBookingDraft — never trusted from the client),
// keyed to a Stripe PaymentIntent.
//
// It only becomes a real Booking once that PaymentIntent succeeds (see
// promotePendingBooking in payment.controller). This is what makes the product
// rule "no charge -> no booking" true: an abandoned or failed payment leaves
// only a draft, which the TTL index below reaps automatically.
const pendingBookingSchema = new mongoose.Schema({
  // The signed-in customer this draft belongs to.
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  // The Stripe PaymentIntent this draft is waiting on. Unique so a single intent
  // maps to exactly one draft (and the webhook/finalize can look the draft up by
  // intent id).
  paymentIntentId: {
    type: String,
    required: true,
    unique: true
  },

  // Whether the customer asked to save this card for future bookings.
  savePaymentMethod: {
    type: Boolean,
    default: false
  },

  // Present only when this first paid booking starts a recurring subscription.
  // It sits outside the draft because recurrence is payment/schedule state, not
  // a field copied into an individual Booking.
  recurrence: {
    type: new mongoose.Schema({
      intervalDays: { type: Number }
    }, { _id: false }),
    default: null
  },

  // The fully validated & priced booking payload, ready to hand to
  // Booking.create() on promotion. An explicit sub-schema (rather than a free
  // Mixed blob) keeps the shape honest.
  draft: {
    serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
    cityId: { type: mongoose.Schema.Types.ObjectId, ref: 'City', required: true },
    // Cached for the confirmation email so promotion needs no extra Service read.
    serviceName: { type: String },
    customerName: { type: String, required: true },
    customerEmail: { type: String, required: true },
    customerPhone: { type: String, required: true },
    // Required outright: drafts are written only by buildValidatedBookingDraft,
    // which already refuses a booking without one, and they live an hour at
    // most, so there is no legacy shape to tolerate here.
    customerPersonalId: { type: String, required: true },
    streetName: { type: String, required: true },
    houseNumber: { type: String, required: true },
    propertySize: { type: String, required: true },
    doorbellName: { type: String, required: true },
    bookingDate: { type: String, required: true },
    bookingTime: { type: String, required: true },
    // Total minutes (see utils/duration.util.js). Drafts live an hour at most
    // (TTL), so there is no legacy `hours` shape to tolerate here.
    durationMinutes: { type: Number, required: true },
    cleaners: { type: Number, required: true },
    totalAmount: { type: Number, required: true },
    // The VAT treatment resolved when the draft was priced (see
    // utils/tax.util.js). Carried through promotion so the Booking records what
    // the customer was actually charged, even if their VAT status changes
    // between paying and the webhook landing.
    tax: {
      treatment: { type: String, enum: ['standard', 'reverse-charge'], default: 'standard' },
      customerType: { type: String, enum: ['individual', 'business'], default: 'individual' },
      vatNumber: { type: String, default: '' },
      companyName: { type: String, default: '' },
      catalogueVatRate: { type: Number, default: 0 },
      vatRate: { type: Number, default: 0 },
      netAmount: { type: Number },
      vatAmount: { type: Number, default: 0 }
    },
    notes: { type: String, default: null },
    specialRequests: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SpecialRequest' }],
      default: []
    },
    cleaningTools: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'CleaningTool' }],
      default: []
    },
    supplies: { type: [String], default: [] }
  }
}, { timestamps: true, collection: 'pendingBookings' });

// TTL: auto-delete abandoned drafts one hour after creation. A successful
// payment promotes (and deletes) the draft well before then.
//
// Exported because the webhook needs it to tell an ORPHANED payment (draft
// reaped before the money landed — refundable) apart from one whose draft simply
// hasn't been written yet (a create-intent request still in flight — emphatically
// not refundable). See handleStripeWebhook.
const DRAFT_TTL_SECONDS = 3600;

pendingBookingSchema.index({ createdAt: 1 }, { expireAfterSeconds: DRAFT_TTL_SECONDS });

const PendingBooking = mongoose.model('PendingBooking', pendingBookingSchema);
module.exports = PendingBooking;
module.exports.DRAFT_TTL_SECONDS = DRAFT_TTL_SECONDS;
