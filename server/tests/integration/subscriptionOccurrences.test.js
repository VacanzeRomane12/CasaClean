// GET /subscription/occurrences — the admin calendar's view of upcoming
// recurring visits, projected from each active plan's rule.
const { api, stripeMock } = require("../setup/testEnv");
const {
    createUser,
    createAdmin,
    cookieFor,
    createCity,
    createService,
    dateStr
} = require("../setup/fixtures");
const { createSubscription } = require("../setup/subscriptionFixtures");
const { runSubscriptionCharges } = require("../../jobs/subscriptionCharge.job");

const occurrences = (admin, from, to) =>
    api.get(`/api/v1/subscription/occurrences?from=${from}&to=${to}`)
        .set("Cookie", cookieFor(admin));

describe("GET /api/v1/subscription/occurrences", () => {
    test("is admin-only", async () => {
        const user = await createUser();
        const anon = await api.get(`/api/v1/subscription/occurrences?from=${dateStr(1)}&to=${dateStr(10)}`);
        expect(anon.status).toBe(401);

        const customer = await api.get(`/api/v1/subscription/occurrences?from=${dateStr(1)}&to=${dateStr(10)}`)
            .set("Cookie", cookieFor(user));
        expect(customer.status).toBe(403);
    });

    test("validates the range: both bounds, ordered, and capped", async () => {
        const admin = await createAdmin();
        expect((await occurrences(admin, dateStr(1), "")).status).toBe(400);
        expect((await occurrences(admin, "next-week", dateStr(10))).status).toBe(400);
        expect((await occurrences(admin, dateStr(10), dateStr(1))).status).toBe(400);
        expect((await occurrences(admin, dateStr(1), dateStr(90))).status).toBe(400);
        expect((await occurrences(admin, dateStr(1), dateStr(60))).status).toBe(200);
    });

    test("projects every upcoming visit of an active plan inside the range, and only active plans", async () => {
        const admin = await createAdmin();
        const user = await createUser();
        const service = await createService({ recurringEnabled: true });
        const city = await createCity();
        const weekly = await createSubscription(user, service, city, {
            nextServiceDate: dateStr(2),
            intervalDays: 7
        });
        await createSubscription(user, service, city, {
            nextServiceDate: dateStr(3),
            intervalDays: 7,
            status: "paused",
            pausedReason: "user-request"
        });
        await createSubscription(user, service, city, {
            nextServiceDate: dateStr(4),
            intervalDays: 7,
            status: "cancelled"
        });

        const res = await occurrences(admin, dateStr(0), dateStr(30));
        expect(res.status).toBe(200);
        const dates = res.body.data.occurrences.map((o) => o.bookingDate);
        expect(dates).toEqual([dateStr(2), dateStr(9), dateStr(16), dateStr(23), dateStr(30)]);
        expect(res.body.occurrenceCount).toBe(5);

        const [first] = res.body.data.occurrences;
        expect(first).toMatchObject({
            subscriptionId: String(weekly._id),
            bookingTime: "10:00",
            durationMinutes: 120,
            cleaners: 1,
            customerName: user.fullname,
            customerPhone: user.phone,
            customerPersonalId: user.personalId,
            intervalDays: 7,
            projected: true
        });
        expect(first.serviceId.name).toBe(service.name);
        expect(first.cityId.name).toBe(city.name);
        expect(first.totalAmount).toBeUndefined();
    });

    test("a charged cycle leaves the projection and appears as a real booking — never both", async () => {
        const admin = await createAdmin();
        const user = await createUser();
        const service = await createService({ recurringEnabled: true });
        const city = await createCity();
        const subscription = await createSubscription(user, service, city, {
            nextServiceDate: dateStr(1),
            intervalDays: 3,
            nextChargeAt: new Date(Date.now() - 60_000)
        });

        const before = await occurrences(admin, dateStr(0), dateStr(10));
        expect(before.body.data.occurrences.map((o) => o.bookingDate))
            .toEqual([dateStr(1), dateStr(4), dateStr(7), dateStr(10)]);

        stripeMock.paymentMethods.retrieve.mockResolvedValue({
            id: subscription.paymentMethodId,
            customer: subscription.stripeCustomerId
        });
        stripeMock.paymentIntents.create.mockResolvedValue({ id: "pi_cycle_occ", status: "succeeded" });
        await runSubscriptionCharges();

        const after = await occurrences(admin, dateStr(0), dateStr(10));
        expect(after.body.data.occurrences.map((o) => o.bookingDate))
            .toEqual([dateStr(4), dateStr(7), dateStr(10)]);

        const bookings = await api.get(`/api/v1/booking?from=${dateStr(0)}&to=${dateStr(10)}`)
            .set("Cookie", cookieFor(admin));
        const charged = bookings.body.data.bookings.filter((b) => b.subscriptionId === String(subscription._id));
        expect(charged.map((b) => b.bookingDate)).toEqual([dateStr(1)]);
        expect(charged[0].customerPersonalId).toBe(user.personalId);
    });
});
