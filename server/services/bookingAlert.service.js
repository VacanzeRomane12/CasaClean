// Admin booking alerts
// --------------------
// A confirmed booking is only worth anything to the business if somebody knows
// about it. Every booking that becomes confirmed-and-paid therefore raises ONE
// internal email, addressed to both halves of "the admin":
//
//   * the admin ACCOUNTS — read live from the User collection, so promoting a
//     new admin (the documented `role: "admin"` flip in Mongo) notifies them
//     without a second, easily-forgotten configuration step, and demoting them
//     stops it; and
//   * the BUSINESS mailbox — BOOKING_NOTIFY_EMAIL, falling back to the
//     contact-form address and then to the sending mailbox, so a shared inbox
//     keeps a copy of every booking even when no admin reads their own mail.
//
// Both lists are merged and de-duplicated into a single message: one admin who
// is also the business mailbox must not receive the same booking twice.
//
// This is a NOTIFICATION, not part of the transaction. By the time it runs the
// money has moved and the reservation exists, so every failure here — the admin
// lookup, the name resolution, SMTP — is swallowed and logged rather than
// propagated. Fire-and-forget for the same reason the confirmation email is:
// this runs inside a Stripe webhook and the charge worker, and a slow mail host
// must never stall either one.

const City = require('../models/city.model');
const Service = require('../models/service.model');
const User = require('../models/user.model');

const sendEmail = require('../utils/email.util');
const { newBookingAlertEmail } = require('../utils/emailTemplates.util');

// A pathological number of admin accounts must not turn one booking into a
// mail-server incident. Twenty is far above any plausible real team.
const MAX_ADMIN_RECIPIENTS = 20;

/**
 * Pull the bare address out of a configured value, which may be in nodemailer's
 * display form (`MAIL_FROM="CasaClean <hello@example.com>"`).
 */
const parseAddress = (value) => {
  const raw = String(value ?? '').trim();
  const angled = raw.match(/<([^>]+)>/);
  return (angled ? angled[1] : raw).trim();
};

// Deliberately stricter than "is it truthy": MAIL_USERNAME is the last fallback
// in the chain below and on several hosts (Mailtrap, SES) it is a login, not an
// address. Sending to it would be a hard SMTP rejection every single booking.
const isAddress = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/**
 * The business inbox (or inboxes — BOOKING_NOTIFY_EMAIL accepts a
 * comma-separated list, e.g. an ops address plus an owner's).
 */
const businessRecipients = () =>
  String(
    process.env.BOOKING_NOTIFY_EMAIL ||
      process.env.CONTACT_NOTIFY_EMAIL ||
      process.env.MAIL_FROM ||
      process.env.MAIL_USERNAME ||
      ''
  )
    .split(',')
    .map(parseAddress)
    .filter(isAddress);

/** Every current admin account's own email address. */
const adminRecipients = async () => {
  const admins = await User.find({ role: 'admin' })
    .select('email')
    .limit(MAX_ADMIN_RECIPIENTS)
    .lean();

  return admins.map((admin) => parseAddress(admin.email)).filter(isAddress);
};

/**
 * The merged, de-duplicated recipient list. A failed admin lookup degrades to
 * the configured mailbox rather than losing the notification entirely.
 *
 * @returns {Promise<string[]>}
 */
const resolveRecipients = async () => {
  let admins = [];
  try {
    admins = await adminRecipients();
  } catch (err) {
    console.error('Admin recipient lookup failed:', err.message);
  }

  const seen = new Set();
  const recipients = [];

  for (const address of [...admins, ...businessRecipients()]) {
    // Compared case-insensitively (nobody runs a mailbox that distinguishes
    // them) but sent as written, since the local part formally is case-sensitive.
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(address);
  }

  return recipients;
};

/**
 * Fill in the catalogue names the alert reads better with. The booking stores
 * ids; the caller usually has the service name already (it was cached on the
 * draft for the confirmation email), so only what is missing is fetched.
 */
const resolveNames = async (booking, serviceName = '') => {
  const names = {
    serviceName: serviceName || booking.serviceId?.name || '',
    cityName: booking.cityId?.name || ''
  };

  try {
    // Independent lookups, and each is skipped when the name is already on the
    // (populated) booking — so this is at most one round trip, not two.
    const [service, city] = await Promise.all([
      !names.serviceName && booking.serviceId
        ? Service.findById(booking.serviceId).select('name').lean()
        : null,
      !names.cityName && booking.cityId
        ? City.findById(booking.cityId).select('name').lean()
        : null
    ]);
    if (service) names.serviceName = service.name || '';
    if (city) names.cityName = city.name || '';
  } catch (err) {
    // A name is a nicety; the date, address and phone number are what the team
    // actually needs, so send the alert without it.
    console.error('Booking alert name resolution failed:', err.message);
  }

  return names;
};

/** Deep link to the panel, when the client origin is configured. */
const adminBookingsUrl = () => {
  const base = String(process.env.CLIENT_URL || '').trim().replace(/\/+$/, '');
  return base ? `${base}/admin/bookings` : '';
};

/**
 * Tell the team about a newly confirmed booking. Never throws and never
 * rejects — call it without awaiting.
 *
 * @param {Object}  opts
 * @param {Object}  opts.booking          the confirmed Booking (or an equivalent
 *                                        plain object for a subscription cycle)
 * @param {string}  [opts.serviceName]    resolved name, if the caller has it
 * @param {boolean} [opts.recurring]      true for a recurring-plan cycle
 * @returns {Promise<string[]|null>} the addresses written to, or null if the
 *                                   alert was skipped or failed
 */
const notifyAdminsOfNewBooking = async ({ booking, serviceName = '', recurring = false }) => {
  try {
    if (!booking) return null;

    const recipients = await resolveRecipients();
    // Nothing configured and no admin account yet: the booking is stored and
    // visible in the panel either way, so silence beats a crash.
    if (!recipients.length) return null;

    const names = await resolveNames(booking, serviceName);

    const { subject, html, text } = newBookingAlertEmail({
      bookingId: booking._id ? String(booking._id) : '',
      serviceName: names.serviceName,
      cityName: names.cityName,
      customerName: booking.customerName,
      customerEmail: booking.customerEmail,
      customerPhone: booking.customerPhone,
      customerPersonalId: booking.customerPersonalId,
      bookingDate: booking.bookingDate,
      bookingTime: booking.bookingTime,
      durationMinutes: booking.durationMinutes,
      // Passed through so a legacy booking (hours, no durationMinutes) still
      // states its length; the template resolves whichever one is present.
      hours: booking.hours,
      cleaners: booking.cleaners,
      streetName: booking.streetName,
      houseNumber: booking.houseNumber,
      propertySize: booking.propertySize,
      doorbellName: booking.doorbellName,
      notes: booking.notes,
      totalAmount: booking.totalAmount,
      paymentMethod: booking.paymentMethod,
      paymentStatus: booking.paymentStatus,
      recurring: recurring || Boolean(booking.subscriptionId),
      adminUrl: adminBookingsUrl()
    });

    await sendEmail({
      email: recipients.join(', '),
      subject,
      html,
      text,
      // Hitting Reply reaches the customer, not our own notification mailbox —
      // the same posture as the contact-form notification.
      ...(booking.customerEmail ? { replyTo: booking.customerEmail } : {})
    });

    return recipients;
  } catch (err) {
    console.error(
      `Admin booking notification failed for booking ${booking?._id}:`,
      err.message
    );
    return null;
  }
};

module.exports = {
  notifyAdminsOfNewBooking,
  resolveRecipients
};
