// Stripe webhook (/webhooks/stripe): signature verification runs the REAL
// Stripe HMAC check — payloads are signed with generateTestHeaderString and the
// same secret the app reads from STRIPE_WEBHOOK_SECRET.
const {
    app,
    request,
    stripeMock,
    sendEmailMock,
    waitForEmails,
    bookingAlerts,
    customerEmails
} = require("../setup/testEnv");
const {
    createUser,
    createCity,
    createService,
    createPaidBooking,
    dateStr
} = require("../setup/fixtures");

const { createSubscription } = require("../setup/subscriptionFixtures");

const Booking = require("../../models/booking.model");
const PendingBooking = require("../../models/pendingBooking.model");
const StripeEvent = require("../../models/stripeEvent.model");
const Subscription = require("../../models/subscription.model");

let eventSeq = 0;

/** POST a signed Stripe event to the webhook endpoint. */
const deliver = (type, object, { eventId, signature } = {}) => {
    const payload = JSON.stringify({
        id: eventId || `evt_test_${++eventSeq}`,
        type,
        data: { object }
    });
    const sig = signature || stripeMock.webhooks.generateTestHeaderString({
        payload,
        secret: process.env.STRIPE_WEBHOOK_SECRET
    });
    return request(app)
        .post("/webhooks/stripe")
        .set("stripe-signature", sig)
        .set("content-type", "application/json")
        .send(payload);
};

/** Seed a PendingBooking draft exactly as createBookingIntent would store it. */
const seedPendingBooking = async (paymentIntentId) => {
    const user = await createUser();
    const service = await createService({ pricePerHour: 20 });
    const city = await createCity();
    await PendingBooking.create({
        user: user._id,
        paymentIntentId,
        draft: {
            serviceId: service._id,
            cityId: city._id,
            serviceName: service.name,
            customerName: user.fullname,
            customerEmail: user.email,
            customerPhone: user.phone,
            customerPersonalId: user.personalId,
            streetName: "Via Roma",
            houseNumber: "12",
            propertySize: "80",
            doorbellName: "Rossi",
            bookingDate: dateStr(2),
            bookingTime: "10:00",
            durationMinutes: 120,
            cleaners: 1,
            totalAmount: 40
        }
    });
    return { user, service, city };
};

describe("signature verification", () => {
    test("rejects an unsigned payload", async () => {
        const res = await request(app)
            .post("/webhooks/stripe")
            .set("content-type", "application/json")
            .send(JSON.stringify({ id: "evt_x", type: "payment_intent.succeeded", data: { object: {} } }));
        expect(res.status).toBe(400);
        expect(res.text).toMatch(/Webhook Error/);
    });

    test("rejects a payload signed with the wrong secret", async () => {
        const payload = JSON.stringify({ id: "evt_x", type: "payment_intent.succeeded", data: { object: {} } });
        const badSig = stripeMock.webhooks.generateTestHeaderString({
            payload,
            secret: "whsec_wrong_secret"
        });
        const res = await deliver("payment_intent.succeeded", {}, { signature: badSig });
        expect(res.status).toBe(400);
    });

    test("rejects a tampered payload (signature no longer matches)", async () => {
        const payload = JSON.stringify({ id: "evt_x", type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } });
        const sig = stripeMock.webhooks.generateTestHeaderString({
            payload,
            secret: process.env.STRIPE_WEBHOOK_SECRET
        });
        const res = await request(app)
            .post("/webhooks/stripe")
            .set("stripe-signature", sig)
            .set("content-type", "application/json")
            .send(payload.replace("pi_1", "pi_2"));
        expect(res.status).toBe(400);
    });
});

describe("payment_intent.succeeded (booking-creation backstop)", () => {
    test("promotes the pending draft into a paid booking without any client call", async () => {
        const { user } = await seedPendingBooking("pi_hook_1");

        const res = await deliver("payment_intent.succeeded", { id: "pi_hook_1", status: "succeeded" });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ received: true });

        const booking = await Booking.findOne({ paymentIntentId: "pi_hook_1" });
        expect(booking).not.toBeNull();
        expect(booking.status).toBe("confirmed");
        expect(booking.paymentStatus).toBe("paid");
        expect(String(booking.user)).toBe(String(user._id));
        expect(booking.totalAmount).toBe(40);

        // Draft consumed; the confirmation email is dispatched fire-and-forget
        // after the webhook has already ACKed, so wait for it rather than race it.
        expect(await PendingBooking.countDocuments({ paymentIntentId: "pi_hook_1" })).toBe(0);
        // Two audiences, both dispatched after the ACK: the customer's
        // confirmation email and the team's new-booking alert.
        await waitForEmails(2);
        expect(customerEmails()).toHaveLength(1);
        const alerts = bookingAlerts();
        expect(alerts).toHaveLength(1);
        expect(alerts[0].subject).toContain("New booking");
        expect(alerts[0].replyTo).toBe(user.email);
    });

    test("does nothing (but ACKs) for an intent that isn't ours", async () => {
        // No metadata.type: not a payment this application created, so it is not
        // ours to promote OR to refund.
        const res = await deliver("payment_intent.succeeded", { id: "pi_ghost", status: "succeeded" });
        expect(res.status).toBe(200);
        expect(await Booking.countDocuments()).toBe(0);
        expect(stripeMock.refunds.create).not.toHaveBeenCalled();
    });

    test("never creates a second booking for an already-promoted intent", async () => {
        await seedPendingBooking("pi_hook_2");
        await deliver("payment_intent.succeeded", { id: "pi_hook_2", status: "succeeded" });

        // A second delivery with a DIFFERENT event id (so it isn't deduped) still
        // finds the existing booking instead of creating a duplicate.
        const res = await deliver("payment_intent.succeeded", { id: "pi_hook_2", status: "succeeded" });
        expect(res.status).toBe(200);
        expect(await Booking.countDocuments({ paymentIntentId: "pi_hook_2" })).toBe(1);
    });

    test("skips duplicate event ids entirely (processed-event ledger)", async () => {
        await seedPendingBooking("pi_hook_3");
        await deliver("payment_intent.succeeded", { id: "pi_hook_3", status: "succeeded" }, { eventId: "evt_dup" });
        // Delete the booking so a re-processed event WOULD recreate it.
        await Booking.deleteMany({ paymentIntentId: "pi_hook_3" });

        const res = await deliver("payment_intent.succeeded", { id: "pi_hook_3", status: "succeeded" }, { eventId: "evt_dup" });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ received: true, duplicate: true });
        expect(await Booking.countDocuments({ paymentIntentId: "pi_hook_3" })).toBe(0);

        expect(await StripeEvent.countDocuments({ eventId: "evt_dup" })).toBe(1);
    });
});

// A charge that can never become a booking must not be quietly kept. The
// finalize endpoint already refunds this when the customer is still on the page;
// these cover the case where they closed the tab and only the webhook is left.
describe("payment_intent.succeeded — orphaned payments", () => {
    const HOUR = 60 * 60;
    const secondsAgo = (s) => Math.floor(Date.now() / 1000) - s;

    test("refunds a charge whose draft expired before it landed", async () => {
        stripeMock.refunds.create.mockResolvedValue({ id: "re_orphan_hook" });

        const res = await deliver("payment_intent.succeeded", {
            id: "pi_orphan",
            status: "succeeded",
            // Older than the draft TTL, so the missing draft was definitively
            // reaped — nothing can still be in flight writing it.
            created: secondsAgo(2 * HOUR),
            metadata: { type: "booking", userId: "u1" }
        });

        expect(res.status).toBe(200);
        expect(stripeMock.refunds.create).toHaveBeenCalledWith(
            { payment_intent: "pi_orphan" },
            { idempotencyKey: "refund:intent:pi_orphan" }
        );
        expect(await Booking.countDocuments()).toBe(0);
    });

    test("does NOT refund a young intent whose draft may still be in flight", async () => {
        // A saved-card charge captures inside paymentIntents.create, so Stripe can
        // deliver this before createBookingIntent has written its draft. Refunding
        // here would cancel a good payment seconds before its booking appears.
        const res = await deliver("payment_intent.succeeded", {
            id: "pi_young",
            status: "succeeded",
            created: secondsAgo(5),
            metadata: { type: "booking", userId: "u1" }
        });

        expect(res.status).toBe(200);
        expect(stripeMock.refunds.create).not.toHaveBeenCalled();
    });

    test("a redelivered orphan reuses the same refund key (never two refunds)", async () => {
        stripeMock.refunds.create.mockResolvedValue({ id: "re_orphan_hook" });
        const object = {
            id: "pi_orphan_2",
            status: "succeeded",
            created: secondsAgo(2 * HOUR),
            metadata: { type: "booking", userId: "u1" }
        };

        await deliver("payment_intent.succeeded", object);
        await deliver("payment_intent.succeeded", object); // new event id, same intent

        // Called twice, but under one key — Stripe replays the original refund
        // rather than issuing a second.
        expect(stripeMock.refunds.create).toHaveBeenCalledTimes(2);
        for (const call of stripeMock.refunds.create.mock.calls) {
            expect(call[1]).toEqual({ idempotencyKey: "refund:intent:pi_orphan_2" });
        }
    });

    test("promotes normally when the draft is present, however old the intent", async () => {
        await seedPendingBooking("pi_old_but_valid");

        const res = await deliver("payment_intent.succeeded", {
            id: "pi_old_but_valid",
            status: "succeeded",
            created: secondsAgo(3 * HOUR),
            metadata: { type: "booking", userId: "u1" }
        });

        expect(res.status).toBe(200);
        expect(await Booking.countDocuments({ paymentIntentId: "pi_old_but_valid" })).toBe(1);
        expect(stripeMock.refunds.create).not.toHaveBeenCalled();
    });
});

describe("payment_intent.payment_failed", () => {
    test("emails the customer a heads-up and creates no booking", async () => {
        const { user } = await seedPendingBooking("pi_fail_1");

        const res = await deliver("payment_intent.payment_failed", {
            id: "pi_fail_1",
            last_payment_error: { message: "Your card was declined." }
        });

        expect(res.status).toBe(200);
        expect(await Booking.countDocuments()).toBe(0);
        expect(sendEmailMock).toHaveBeenCalledTimes(1);
        const mail = sendEmailMock.mock.calls[0][0];
        expect(mail.email).toBe(user.email);
        expect(mail.text).toMatch(/didn't go through/i);
        expect(mail.text).toMatch(/declined/i);
    });

    test("stays silent when there is no matching draft", async () => {
        const res = await deliver("payment_intent.payment_failed", { id: "pi_unknown" });
        expect(res.status).toBe(200);
        expect(sendEmailMock).not.toHaveBeenCalled();
    });
});

describe("charge.refunded", () => {
    test("a FULL refund flips the booking's money state", async () => {
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city, {
            paymentIntentId: "pi_refund_1"
        });

        const res = await deliver("charge.refunded", {
            payment_intent: "pi_refund_1",
            amount: 4000,
            amount_refunded: 4000
        });

        expect(res.status).toBe(200);
        const fresh = await Booking.findById(booking._id);
        expect(fresh.paymentStatus).toBe("refunded");
        expect(fresh.stripeStatus).toBe("refunded");
        expect(fresh.refundedAt).toBeInstanceOf(Date);
    });

    test("a PARTIAL refund does NOT mark the booking refunded", async () => {
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city, {
            paymentIntentId: "pi_refund_2"
        });

        const res = await deliver("charge.refunded", {
            payment_intent: "pi_refund_2",
            amount: 4000,
            amount_refunded: 1000 // €10 goodwill refund from the dashboard
        });

        expect(res.status).toBe(200);
        const fresh = await Booking.findById(booking._id);
        expect(fresh.paymentStatus).toBe("paid");
    });
});

describe("charge.dispute.created", () => {
    test("flags the booking as disputed without claiming it was refunded", async () => {
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city, {
            paymentIntentId: "pi_disputed"
        });

        const res = await deliver("charge.dispute.created", {
            id: "dp_1",
            charge: "ch_1",
            payment_intent: "pi_disputed",
            amount: 4000,
            reason: "fraudulent"
        });

        expect(res.status).toBe(200);
        const fresh = await Booking.findById(booking._id);
        expect(fresh.stripeStatus).toBe("disputed");
        // A dispute can still be WON — the money has not been returned, so the
        // booking must not be relabelled as refunded.
        expect(fresh.paymentStatus).toBe("paid");
    });

    test("pauses the recurring plan the disputed charge belonged to", async () => {
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const subscription = await createSubscription(user, service, city);
        await createPaidBooking(user, service, city, {
            paymentIntentId: "pi_disputed_sub",
            subscriptionId: subscription._id
        });

        const res = await deliver("charge.dispute.created", {
            id: "dp_2",
            charge: "ch_2",
            payment_intent: "pi_disputed_sub",
            amount: 4000,
            reason: "product_not_received"
        });

        expect(res.status).toBe(200);
        const fresh = await Subscription.findById(subscription._id);
        expect(fresh.status).toBe("paused");
        expect(fresh.lastError).toMatch(/disputed/i);
        // Charging the same card again would earn a second chargeback.
        expect(fresh.processingAt).toBeNull();
    });

    test("ACKs a dispute for a charge we have no booking for", async () => {
        const res = await deliver("charge.dispute.created", {
            id: "dp_3",
            charge: "ch_3",
            payment_intent: "pi_unknown",
            amount: 1000,
            reason: "general"
        });
        expect(res.status).toBe(200);
    });
});

describe("unhandled event types", () => {
    test("are acknowledged so Stripe stops retrying", async () => {
        const res = await deliver("customer.created", { id: "cus_whatever" });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ received: true });
    });
});
