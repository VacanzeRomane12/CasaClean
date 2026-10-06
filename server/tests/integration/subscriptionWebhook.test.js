// Subscription-cycle webhook coverage uses the real Stripe signature verifier
// exposed by the shared Stripe mock, just like the existing one-off webhook
// suite.
const {
    app,
    request,
    stripeMock,
    sendEmailMock,
    waitForCustomerEmails,
    waitForBookingAlerts
} = require("../setup/testEnv");
const { createUser, createCity, createService, dateStr } = require("../setup/fixtures");
const { createSubscription } = require("../setup/subscriptionFixtures");

const Booking = require("../../models/booking.model");
const PendingBooking = require("../../models/pendingBooking.model");
const Subscription = require("../../models/subscription.model");
const { addDaysToDateString } = require("../../utils/date.util");

let eventSequence = 0;

const deliver = (type, object, eventId = `evt_subscription_${++eventSequence}`) => {
    const payload = JSON.stringify({
        id: eventId,
        type,
        data: { object }
    });
    const signature = stripeMock.webhooks.generateTestHeaderString({
        payload,
        secret: process.env.STRIPE_WEBHOOK_SECRET
    });
    return request(app)
        .post("/webhooks/stripe")
        .set("stripe-signature", signature)
        .set("content-type", "application/json")
        .send(payload);
};

describe("subscription-cycle webhooks", () => {
    test("creates a paid cycle booking as a succeeded-event backstop and advances only once", async () => {
        const user = await createUser();
        const service = await createService({ recurringEnabled: true });
        const city = await createCity();
        const subscription = await createSubscription(user, service, city, {
            nextServiceDate: dateStr(2),
            intervalDays: 3
        });
        const paymentIntent = {
            id: "pi_subscription_hook_success",
            status: "succeeded",
            amount: 4000,
            customer: subscription.stripeCustomerId,
            metadata: {
                type: "subscription-cycle",
                subscriptionId: String(subscription._id),
                serviceDate: subscription.nextServiceDate,
                userId: String(user._id)
            }
        };

        const first = await deliver("payment_intent.succeeded", paymentIntent, "evt_subscription_success_1");
        // Different Stripe event id: the event ledger cannot hide a bad
        // schedule/idempotency implementation here.
        const second = await deliver("payment_intent.succeeded", paymentIntent, "evt_subscription_success_2");

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(await Booking.countDocuments({ paymentIntentId: paymentIntent.id })).toBe(1);

        const booking = await Booking.findOne({ paymentIntentId: paymentIntent.id });
        expect(booking).toMatchObject({
            status: "confirmed",
            paymentStatus: "paid",
            totalAmount: 40,
            bookingDate: subscription.nextServiceDate
        });
        expect(String(booking.subscriptionId)).toBe(String(subscription._id));

        const fresh = await Subscription.findById(subscription._id);
        expect(fresh.nextServiceDate).toBe(addDaysToDateString(subscription.nextServiceDate, 3));
        expect(fresh.chargeAttempts).toHaveLength(1);
        expect(fresh.chargeAttempts[0]).toMatchObject({
            status: "succeeded",
            paymentIntentId: paymentIntent.id,
            amount: 40
        });
        // One cycle, so exactly one receipt to the customer and one alert to the
        // team — the redelivered event must not double either.
        expect(await waitForCustomerEmails(1)).toHaveLength(1);
        expect(await waitForBookingAlerts(1)).toHaveLength(1);
    });

    test("does not create a cycle booking for a cancelled subscription", async () => {
        const user = await createUser();
        const service = await createService({ recurringEnabled: true });
        const city = await createCity();
        const subscription = await createSubscription(user, service, city, {
            nextServiceDate: dateStr(2),
            intervalDays: 3,
            status: "cancelled",
            cancelledAt: new Date()
        });
        const paymentIntent = {
            id: "pi_subscription_hook_cancelled",
            status: "succeeded",
            amount: 4000,
            customer: subscription.stripeCustomerId,
            metadata: {
                type: "subscription-cycle",
                subscriptionId: String(subscription._id),
                serviceDate: subscription.nextServiceDate,
                userId: String(user._id)
            }
        };

        // Acknowledged (so Stripe stops retrying) but NOT turned into a booking:
        // the schedule advance would refuse anyway, and a confirmed booking on a
        // cancelled plan is exactly the divergence this guards against.
        const res = await deliver("payment_intent.succeeded", paymentIntent);

        expect(res.status).toBe(200);
        expect(await Booking.countDocuments({ paymentIntentId: paymentIntent.id })).toBe(0);
        expect((await Subscription.findById(subscription._id)).status).toBe("cancelled");
    });

    test("does not create a cycle booking once the schedule has moved past that date", async () => {
        const user = await createUser();
        const service = await createService({ recurringEnabled: true });
        const city = await createCity();
        const subscription = await createSubscription(user, service, city, {
            nextServiceDate: dateStr(9),
            intervalDays: 3
        });
        const staleServiceDate = dateStr(2); // an earlier, already-completed cycle
        const paymentIntent = {
            id: "pi_subscription_hook_stale",
            status: "succeeded",
            amount: 4000,
            customer: subscription.stripeCustomerId,
            metadata: {
                type: "subscription-cycle",
                subscriptionId: String(subscription._id),
                serviceDate: staleServiceDate,
                userId: String(user._id)
            }
        };

        const res = await deliver("payment_intent.succeeded", paymentIntent);

        expect(res.status).toBe(200);
        expect(await Booking.countDocuments({ paymentIntentId: paymentIntent.id })).toBe(0);
        // The schedule must be left exactly where it was.
        expect((await Subscription.findById(subscription._id)).nextServiceDate).toBe(dateStr(9));
    });

    test("a fully refunded cycle charge pauses the plan instead of re-charging next sweep", async () => {
        const user = await createUser();
        const service = await createService({ recurringEnabled: true });
        const city = await createCity();
        const subscription = await createSubscription(user, service, city);
        await Booking.create({
            user: user._id,
            serviceId: service._id,
            cityId: city._id,
            subscriptionId: subscription._id,
            customerName: user.fullname,
            customerEmail: user.email,
            customerPhone: user.phone,
            streetName: "Via Roma",
            houseNumber: "12",
            propertySize: "80",
            doorbellName: "Rossi",
            bookingDate: dateStr(3),
            bookingTime: "10:00",
            durationMinutes: 120,
            cleaners: 1,
            totalAmount: 40,
            status: "confirmed",
            paymentIntentId: "pi_cycle_refunded",
            paymentMethod: "card",
            paymentStatus: "paid",
            amountPaid: 40
        });

        const res = await deliver("charge.refunded", {
            id: "ch_cycle_refunded",
            payment_intent: "pi_cycle_refunded",
            amount: 4000,
            amount_refunded: 4000
        });

        expect(res.status).toBe(200);
        expect((await Booking.findOne({ paymentIntentId: "pi_cycle_refunded" })).paymentStatus)
            .toBe("refunded");

        // Refunding from the Stripe dashboard is a deliberate "undo"; leaving the
        // plan active would just charge the same card again on the next sweep.
        const fresh = await Subscription.findById(subscription._id);
        expect(fresh.status).toBe("paused");
        expect(fresh.pausedReason).toBe("payment-failed");
    });

    test("a partial refund leaves the plan running", async () => {
        const user = await createUser();
        const service = await createService({ recurringEnabled: true });
        const city = await createCity();
        const subscription = await createSubscription(user, service, city);
        await Booking.create({
            user: user._id,
            serviceId: service._id,
            cityId: city._id,
            subscriptionId: subscription._id,
            customerName: user.fullname,
            customerEmail: user.email,
            customerPhone: user.phone,
            streetName: "Via Roma",
            houseNumber: "12",
            propertySize: "80",
            doorbellName: "Rossi",
            bookingDate: dateStr(3),
            bookingTime: "10:00",
            durationMinutes: 120,
            cleaners: 1,
            totalAmount: 40,
            status: "confirmed",
            paymentIntentId: "pi_cycle_partial",
            paymentMethod: "card",
            paymentStatus: "paid",
            amountPaid: 40
        });

        // A goodwill refund of €10 must not stop the whole plan.
        const res = await deliver("charge.refunded", {
            id: "ch_cycle_partial",
            payment_intent: "pi_cycle_partial",
            amount: 4000,
            amount_refunded: 1000
        });

        expect(res.status).toBe(200);
        expect((await Booking.findOne({ paymentIntentId: "pi_cycle_partial" })).paymentStatus)
            .toBe("paid");
        expect((await Subscription.findById(subscription._id)).status).toBe("active");
    });

    test("does not send the one-off failure email for a subscription-cycle decline", async () => {
        const user = await createUser();
        const service = await createService({ recurringEnabled: true });
        const city = await createCity();

        // Deliberately leave a matching pending draft behind. The legacy
        // one-off branch would email it, so silence proves the early return.
        await PendingBooking.create({
            user: user._id,
            paymentIntentId: "pi_subscription_hook_failed",
            draft: {
                serviceId: service._id,
                cityId: city._id,
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

        const res = await deliver("payment_intent.payment_failed", {
            id: "pi_subscription_hook_failed",
            metadata: { type: "subscription-cycle" },
            last_payment_error: { message: "Your card was declined." }
        });

        expect(res.status).toBe(200);
        expect(await Booking.countDocuments()).toBe(0);
        expect(sendEmailMock).not.toHaveBeenCalled();
    });
});
