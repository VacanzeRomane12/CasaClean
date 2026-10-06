// HTML email templates for CasaClean.
//
// Emails are NOT regular web pages: many clients (Outlook, Gmail) strip <style>
// blocks, ignore flexbox/grid and external CSS. The reliable approach is
// table-based layout with inline styles and a 600px max width — that's why this
// markup looks old-fashioned on purpose.
//
// Colours mirror the website design system (client/src/styles/globals.css):
//   brand teal  -> #1dae9f / #0e8b81 / #0f6f68
//   accent gold -> #f59e0b
//   ink (text)  -> #0e1424 / #636c88

const { formatEuro, formatDateLong } = require("./vat.util");
// Durations are total minutes; formatDuration keeps raw minute counts out of
// the text ("1 h 25 min", never "85").
const { formatDuration, durationInMinutes } = require("./duration.util");

// Shared palette so every template stays on-brand from one place.
const COLORS = {
    brand: "#0e8b81",
    brandDark: "#0f6f68",
    accent: "#f59e0b",
    ink: "#0e1424",
    muted: "#636c88",
    canvas: "#f6f7f9",
    surface: "#ffffff",
    border: "#eceef2"
};

// Default footer line. Correct for the account emails this shell was written
// for; templates addressed to somebody else (e.g. the team's contact-form
// notification) pass their own `footerNote`.
const DEFAULT_FOOTER_NOTE =
    "You received this email because an account was created with this address on CasaClean.";

/**
 * Generic branded shell shared by all emails: coloured header, white card body
 * and a muted footer. `bodyContent` is injected as the card's inner HTML.
 */
const baseLayout = ({ title, bodyContent, footerNote = DEFAULT_FOOTER_NOTE }) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light only" />
    <title>${title}</title>
</head>
<body style="margin:0; padding:0; background-color:${COLORS.canvas}; font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <!-- Full-width background wrapper -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${COLORS.canvas}; padding:32px 12px;">
        <tr>
            <td align="center">
                <!-- 600px centred container -->
                <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background-color:${COLORS.surface}; border-radius:16px; overflow:hidden; border:1px solid ${COLORS.border};">

                    <!-- Header / brand bar -->
                    <tr>
                        <td style="background:linear-gradient(135deg, ${COLORS.brand}, ${COLORS.brandDark}); padding:32px 40px; text-align:center;">
                            <span style="font-size:26px; font-weight:700; color:#ffffff; letter-spacing:0.5px;">
                                Casa<span style="color:${COLORS.accent};">Clean</span>
                            </span>
                            <div style="margin-top:6px; font-size:13px; color:#d4f8f2; letter-spacing:1px; text-transform:uppercase;">
                                Professional Cleaning Services
                            </div>
                        </td>
                    </tr>

                    <!-- Body -->
                    <tr>
                        <td style="padding:40px;">
                            ${bodyContent}
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="padding:24px 40px 32px; border-top:1px solid ${COLORS.border}; text-align:center;">
                            <p style="margin:0 0 4px; font-size:12px; color:${COLORS.muted};">
                                ${footerNote}
                            </p>
                            <p style="margin:0; font-size:12px; color:${COLORS.muted};">
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

/**
 * Bulletproof CTA button (works in Outlook too). Plain anchor styled as a
 * pill — kept simple so it degrades gracefully.
 */
const button = (url, label) => `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px auto;">
        <tr>
            <td align="center" style="border-radius:10px; background-color:${COLORS.brand};">
                <a href="${url}"
                   style="display:inline-block; padding:14px 36px; font-size:16px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:10px;">
                    ${label}
                </a>
            </td>
        </tr>
    </table>`;

// Escape user-provided values before interpolating them into the HTML body so
// a crafted fullname can never inject markup into the email.
const escapeHtml = (value) =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

/**
 * Email-verification template.
 *
 * @param {Object} opts
 * @param {string} opts.fullname  - recipient's name (personalisation)
 * @param {string} opts.url       - one-time verification link
 * @param {number} opts.expiresInHours - link validity window, shown to the user
 * @returns {{ subject: string, html: string, text: string }}
 */
const verificationEmail = ({ fullname, url, expiresInHours }) => {
    const subject = "Verify your CasaClean email address";

    const bodyContent = `
        <h1 style="margin:0 0 12px; font-size:22px; color:${COLORS.ink};">
            Welcome, ${escapeHtml(fullname)}! 👋
        </h1>
        <p style="margin:0 0 20px; font-size:15px; line-height:1.6; color:${COLORS.muted};">
            Thanks for signing up with <strong style="color:${COLORS.ink};">CasaClean</strong>.
            Please confirm your email address to activate your account and start booking
            sparkling-clean homes.
        </p>

        ${button(url, "Verify Email Address")}

        <p style="margin:24px 0 8px; font-size:13px; color:${COLORS.muted};">
            This link is valid for <strong>${expiresInHours} hours</strong>. If the button
            above doesn't work, copy and paste this URL into your browser:
        </p>
        <p style="margin:0 0 20px; font-size:13px; word-break:break-all;">
            <a href="${url}" style="color:${COLORS.brand};">${url}</a>
        </p>

        <hr style="border:none; border-top:1px solid ${COLORS.border}; margin:24px 0;" />

        <p style="margin:0; font-size:13px; line-height:1.6; color:${COLORS.muted};">
            If you didn't create a CasaClean account, you can safely ignore this email —
            no account will be activated.
        </p>`;

    // Plain-text fallback for clients that don't render HTML.
    const text =
        `Welcome to CasaClean, ${fullname}!\n\n` +
        `Please verify your email address by opening the link below:\n${url}\n\n` +
        `This link is valid for ${expiresInHours} hours.\n\n` +
        `If you didn't create an account, you can ignore this email.`;

    return { subject, html: baseLayout({ title: subject, bodyContent }), text };
};

/**
 * Password-reset template.
 *
 * @param {Object} opts
 * @param {string} opts.fullname  - recipient's name (personalisation)
 * @param {string} opts.url       - one-time reset link (client reset page)
 * @param {number} opts.expiresInMinutes - link validity window, shown to the user
 * @returns {{ subject: string, html: string, text: string }}
 */
const passwordResetEmail = ({ fullname, url, expiresInMinutes }) => {
    const subject = "Reset your CasaClean password";

    const bodyContent = `
        <h1 style="margin:0 0 12px; font-size:22px; color:${COLORS.ink};">
            Hello, ${escapeHtml(fullname)}
        </h1>
        <p style="margin:0 0 20px; font-size:15px; line-height:1.6; color:${COLORS.muted};">
            We received a request to reset the password for your
            <strong style="color:${COLORS.ink};">CasaClean</strong> account.
            Click the button below to choose a new password.
        </p>

        ${button(url, "Reset Password")}

        <p style="margin:24px 0 8px; font-size:13px; color:${COLORS.muted};">
            This link is valid for <strong>${expiresInMinutes} minutes</strong>. If the button
            above doesn't work, copy and paste this URL into your browser:
        </p>
        <p style="margin:0 0 20px; font-size:13px; word-break:break-all;">
            <a href="${url}" style="color:${COLORS.brand};">${url}</a>
        </p>

        <hr style="border:none; border-top:1px solid ${COLORS.border}; margin:24px 0;" />

        <p style="margin:0; font-size:13px; line-height:1.6; color:${COLORS.muted};">
            If you didn't request a password reset, you can safely ignore this email —
            your password will stay unchanged.
        </p>`;

    const text =
        `Hello ${fullname},\n\n` +
        `We received a request to reset your CasaClean password.\n` +
        `Open the link below to choose a new one:\n${url}\n\n` +
        `This link is valid for ${expiresInMinutes} minutes.\n\n` +
        `If you didn't request a reset, you can ignore this email.`;

    return { subject, html: baseLayout({ title: subject, bodyContent }), text };
};

// Human-readable topic labels for the notification subject/body. Keys mirror
// CONTACT_TOPICS (utils/contact.util.js); an unknown value falls back to itself.
const TOPIC_LABELS = {
    general: "General enquiry",
    booking: "Booking a turnover",
    pricing: "Pricing & plans",
    partnership: "Property manager / partnership",
    support: "Existing customer support"
};

/**
 * Contact-form notification, sent to the team (CONTACT_NOTIFY_EMAIL) — NOT to
 * the person who wrote it.
 *
 * Every value here is unauthenticated, customer-typed text, so all of it goes
 * through escapeHtml before it touches the markup. The message body is rendered
 * in a <pre>-like block so the sender's line breaks survive.
 *
 * @param {Object} opts
 * @param {string} opts.name    - sender's name
 * @param {string} opts.email   - sender's reply address
 * @param {string} [opts.phone] - optional phone number
 * @param {string} opts.topic   - one of CONTACT_TOPICS
 * @param {string} opts.message - the message body
 * @param {Date}   [opts.submittedAt] - arrival time (defaults to now)
 * @returns {{ subject: string, html: string, text: string }}
 */
const contactMessageEmail = ({ name, email, phone, topic, message, submittedAt }) => {
    const topicLabel = TOPIC_LABELS[topic] || topic;
    const subject = `New contact message — ${topicLabel}`;
    const received = (submittedAt instanceof Date ? submittedAt : new Date()).toISOString();

    // Small label/value row, repeated for each detail.
    const row = (label, value) => `
        <tr>
            <td style="padding:6px 12px 6px 0; font-size:13px; color:${COLORS.muted}; white-space:nowrap; vertical-align:top;">${label}</td>
            <td style="padding:6px 0; font-size:14px; color:${COLORS.ink};">${value}</td>
        </tr>`;

    const safeEmail = escapeHtml(email);

    const bodyContent = `
        <h1 style="margin:0 0 12px; font-size:22px; color:${COLORS.ink};">
            New contact message
        </h1>
        <p style="margin:0 0 20px; font-size:15px; line-height:1.6; color:${COLORS.muted};">
            Someone just wrote to you through the website contact form.
            Replying to this email goes straight back to them.
        </p>

        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; margin-bottom:20px;">
            ${row("From", escapeHtml(name))}
            ${row("Email", `<a href="mailto:${safeEmail}" style="color:${COLORS.brand};">${safeEmail}</a>`)}
            ${phone ? row("Phone", escapeHtml(phone)) : ""}
            ${row("Topic", escapeHtml(topicLabel))}
            ${row("Received", escapeHtml(received))}
        </table>

        <div style="padding:16px 18px; background-color:${COLORS.canvas}; border:1px solid ${COLORS.border}; border-radius:10px;">
            <p style="margin:0; font-size:14px; line-height:1.7; color:${COLORS.ink}; white-space:pre-wrap;">${escapeHtml(message)}</p>
        </div>`;

    const text =
        `New contact message — ${topicLabel}\n\n` +
        `From: ${name} <${email}>\n` +
        (phone ? `Phone: ${phone}\n` : "") +
        `Received: ${received}\n\n` +
        `${message}\n`;

    return {
        subject,
        html: baseLayout({
            title: subject,
            bodyContent,
            footerNote: "You received this email because it is the CasaClean contact-form notification address."
        }),
        text
    };
};

/**
 * The team's answer to a contact-form message, sent to the customer from the
 * admin panel.
 *
 * The original message is quoted underneath so the customer has the context —
 * they wrote days ago and won't remember the wording. Both the answer and the
 * quote are escaped: the answer is admin-typed but still ends up in HTML, and
 * the quote is the customer's own unauthenticated text.
 *
 * @param {Object} opts
 * @param {string} opts.customerName    - who we're writing to
 * @param {string} opts.replyBody       - the answer the admin typed
 * @param {string} opts.originalMessage - the message being answered
 * @param {Date}   [opts.originalSentAt] - when they wrote to us
 * @returns {{ subject: string, html: string, text: string }}
 */
const contactReplyEmail = ({ customerName, replyBody, originalMessage, originalSentAt }) => {
    const subject = "Re: your message to CasaClean";
    const sentOn = originalSentAt instanceof Date ? originalSentAt.toISOString().slice(0, 10) : null;

    const bodyContent = `
        <h1 style="margin:0 0 12px; font-size:22px; color:${COLORS.ink};">
            Hello, ${escapeHtml(customerName)}
        </h1>
        <p style="margin:0 0 20px; font-size:15px; line-height:1.6; color:${COLORS.muted};">
            Thanks for writing to <strong style="color:${COLORS.ink};">CasaClean</strong>.
            Here's our answer — just reply to this email if anything is still unclear.
        </p>

        <div style="padding:16px 18px; background-color:${COLORS.canvas}; border:1px solid ${COLORS.border}; border-radius:10px;">
            <p style="margin:0; font-size:15px; line-height:1.7; color:${COLORS.ink}; white-space:pre-wrap;">${escapeHtml(replyBody)}</p>
        </div>

        <hr style="border:none; border-top:1px solid ${COLORS.border}; margin:24px 0;" />

        <p style="margin:0 0 8px; font-size:13px; color:${COLORS.muted};">
            ${sentOn ? `Your message from ${escapeHtml(sentOn)}:` : "Your message:"}
        </p>
        <p style="margin:0; padding-left:14px; border-left:3px solid ${COLORS.border}; font-size:13px; line-height:1.6; color:${COLORS.muted}; white-space:pre-wrap;">${escapeHtml(originalMessage)}</p>`;

    const text =
        `Hello ${customerName},\n\n` +
        `Thanks for writing to CasaClean. Here's our answer:\n\n` +
        `${replyBody}\n\n` +
        `---\n` +
        `${sentOn ? `Your message from ${sentOn}:` : "Your message:"}\n` +
        `${originalMessage}\n`;

    return {
        subject,
        html: baseLayout({
            title: subject,
            bodyContent,
            footerNote: "You received this email because you contacted CasaClean through our website."
        }),
        text
    };
};

/**
 * Internal "a booking just came in" alert, sent to the team — the admin accounts
 * and the business mailbox — NOT to the customer, who gets their own
 * confirmation email.
 *
 * It is written to be actionable from the notification alone: everything needed
 * to staff the job (when, where, how long, how many cleaners) and to reach the
 * customer (email and phone as tap-able links) is in the body, so an admin on a
 * phone doesn't have to open the panel just to find out what arrived.
 *
 * Customer-typed values (name, address, doorbell, notes) are escaped like every
 * other template here — this email is read by staff, which is precisely why it
 * must not be a place where crafted booking text can inject markup.
 *
 * @param {Object} opts
 * @param {string} opts.bookingId     - the Booking's _id, for panel lookup
 * @param {string} [opts.serviceName] - resolved catalogue name
 * @param {string} [opts.cityName]    - resolved city name
 * @param {boolean} [opts.recurring]  - true for a recurring-plan cycle booking
 * @param {string} [opts.adminUrl]    - deep link to the admin bookings page
 * @returns {{ subject: string, html: string, text: string }}
 */
const newBookingAlertEmail = ({
    bookingId,
    serviceName,
    cityName,
    customerName,
    customerEmail,
    customerPhone,
    // Shown to the team only — the customer's confirmation email never repeats
    // it (they know their own number, and receipts get forwarded).
    customerPersonalId,
    bookingDate,
    bookingTime,
    durationMinutes,
    // Legacy bookings store whole/half hours instead; durationInMinutes below
    // reads whichever one this booking actually carries.
    hours,
    cleaners,
    streetName,
    houseNumber,
    propertySize,
    doorbellName,
    notes,
    totalAmount,
    paymentMethod,
    paymentStatus,
    recurring = false,
    adminUrl
}) => {
    const service = serviceName || "Cleaning service";
    const minutes = durationInMinutes({ durationMinutes, hours });
    // The date and time lead the subject: an inbox full of these is triaged by
    // "when is it", not by "which of our services was it".
    const subject = `${recurring ? "New recurring booking" : "New booking"} — ${service} · ${bookingDate || "date TBC"} ${bookingTime || ""}`.trim();

    const address = [
        [streetName, houseNumber ? `No. ${houseNumber}` : ""].filter(Boolean).join(", "),
        cityName
    ].filter(Boolean).join(", ");

    const paid = paymentStatus === "paid" || paymentStatus === "manual";
    const payment = `${formatEuro(totalAmount)} — ${paid ? "paid" : paymentStatus || "unpaid"}${
        paymentMethod ? ` (${paymentMethod})` : ""
    }`;

    const row = (label, value) => `
        <tr>
            <td style="padding:6px 12px 6px 0; font-size:13px; color:${COLORS.muted}; white-space:nowrap; vertical-align:top;">${label}</td>
            <td style="padding:6px 0; font-size:14px; color:${COLORS.ink};">${value}</td>
        </tr>`;

    const safeEmail = escapeHtml(customerEmail);
    const safePhone = escapeHtml(customerPhone);

    const bodyContent = `
        <h1 style="margin:0 0 12px; font-size:22px; color:${COLORS.ink};">
            ${recurring ? "A recurring cleaning was just charged" : "A new booking was just confirmed"}
        </h1>
        <p style="margin:0 0 20px; font-size:15px; line-height:1.6; color:${COLORS.muted};">
            Payment has been received and the slot is reserved. Replying to this email
            goes straight to the customer.
        </p>

        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; margin-bottom:20px;">
            ${row("Service", escapeHtml(service))}
            ${row("Date", escapeHtml(bookingDate ? formatDateLong(bookingDate) : "—"))}
            ${row("Time", escapeHtml(bookingTime || "—"))}
            ${row("Duration", escapeHtml(`${formatDuration(minutes)} · ${cleaners} cleaner(s)`))}
            ${row("Address", escapeHtml(address || "—"))}
            ${propertySize ? row("Property size", `${escapeHtml(propertySize)} m&sup2;`) : ""}
            ${doorbellName ? row("Doorbell", escapeHtml(doorbellName)) : ""}
            ${recurring ? row("Plan", "Recurring service") : ""}
            ${row("Payment", escapeHtml(payment))}
            ${bookingId ? row("Booking ID", `<span style="font-family:monospace; font-size:13px;">${escapeHtml(bookingId)}</span>`) : ""}
        </table>

        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; margin-bottom:20px;">
            ${row("Customer", escapeHtml(customerName))}
            ${customerEmail ? row("Email", `<a href="mailto:${safeEmail}" style="color:${COLORS.brand};">${safeEmail}</a>`) : ""}
            ${customerPhone ? row("Phone", `<a href="tel:${safePhone}" style="color:${COLORS.brand};">${safePhone}</a>`) : ""}
            ${customerPersonalId ? row("Personal ID", `<span style="font-family:monospace; font-size:13px;">${escapeHtml(customerPersonalId)}</span>`) : ""}
        </table>

        ${notes ? `
        <p style="margin:0 0 6px; font-size:13px; color:${COLORS.muted};">Customer notes</p>
        <div style="padding:16px 18px; background-color:${COLORS.canvas}; border:1px solid ${COLORS.border}; border-radius:10px;">
            <p style="margin:0; font-size:14px; line-height:1.7; color:${COLORS.ink}; white-space:pre-wrap;">${escapeHtml(notes)}</p>
        </div>` : ""}

        ${adminUrl ? button(adminUrl, "Open in admin panel") : ""}`;

    const text =
        `${subject}\n\n` +
        `Service:   ${service}\n` +
        `Date:      ${bookingDate || "—"} ${bookingTime || ""}\n` +
        `Duration:  ${formatDuration(minutes)} (${cleaners} cleaner(s))\n` +
        `Address:   ${address || "—"}\n` +
        (propertySize ? `Size:      ${propertySize} m2\n` : "") +
        (doorbellName ? `Doorbell:  ${doorbellName}\n` : "") +
        (recurring ? `Plan:      Recurring service\n` : "") +
        `Payment:   ${payment}\n` +
        (bookingId ? `Booking:   ${bookingId}\n` : "") +
        `\nCustomer:  ${customerName}\n` +
        (customerEmail ? `Email:     ${customerEmail}\n` : "") +
        (customerPhone ? `Phone:     ${customerPhone}\n` : "") +
        (customerPersonalId ? `ID:        ${customerPersonalId}\n` : "") +
        (notes ? `\nNotes:\n${notes}\n` : "") +
        (adminUrl ? `\nAdmin panel: ${adminUrl}\n` : "");

    return {
        subject,
        html: baseLayout({
            title: subject,
            bodyContent,
            footerNote: "You received this email because you are notified of new CasaClean bookings."
        }),
        text
    };
};

module.exports = {
    verificationEmail,
    passwordResetEmail,
    contactMessageEmail,
    contactReplyEmail,
    newBookingAlertEmail
};
