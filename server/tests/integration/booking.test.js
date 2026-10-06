// Booking flows: admin manual creation (fail-closed resolution + server-side
// pricing), listing/scoping, admin edits with re-pricing, customer
// self-cancellation with the refund policy, and deletion.
const { api, stripeMock, sendEmailMock } = require("../setup/testEnv");
const {
    createUser,
    createAdmin,
    cookieFor,
    createCity,
    createService,
    createInstantService,
    createSpecialRequest,
    createCleaningTool,
    createWorker,
    createPaidBooking,
    validBookingBody,
    dateStr,
    dateTimeIn
} = require("../setup/fixtures");

const Booking = require("../../models/booking.model");

describe("POST /api/v1/booking (admin manual bookings)", () => {
    test("customers cannot use the direct-create endpoint (they must pay online)", async () => {
        const user = await createUser();
        const service = await createService();
        const city = await createCity();

        const res = await api.post("/api/v1/booking")
            .set("Cookie", cookieFor(user))
            .send(validBookingBody(service, city));
        expect(res.status).toBe(403);
    });

    test("admin self-booking is confirmed, manual and priced server-side", async () => {
        const admin = await createAdmin();
        const service = await createService({ pricePerHour: 20 });
        const city = await createCity();
        const addon = await createSpecialRequest({ price: 15 });
        const tool = await createCleaningTool({ price: 5 });

        const res = await api.post("/api/v1/booking")
            .set("Cookie", cookieFor(admin))
            .send(validBookingBody(service, city, {
                durationMinutes: 180,
                cleaners: 2,
                specialRequests: [String(addon._id)],
                cleaningTools: [String(tool._id)]
            }));

        expect(res.status).toBe(201);
        const booking = res.body.data.booking;
        // 20 €/h * 3h + 15 + 5 — computed by the server, never from the client.
        expect(booking.totalAmount).toBe(140);
        expect(booking.status).toBe("confirmed");
        expect(booking.paymentMethod).toBe("manual");
        expect(booking.paymentStatus).toBe("manual");
        expect(booking.customerEmail).toBe(admin.email);
        expect(sendEmailMock).toHaveBeenCalledTimes(1); // confirmation email
    });

    test("an admin booking on a customer's behalf starts as pending", async () => {
        const admin = await createAdmin();
        const customer = await createUser();
        const service = await createService();
        const city = await createCity();

        const res = await api.post("/api/v1/booking")
            .set("Cookie", cookieFor(admin))
            .send(validBookingBody(service, city, { userId: String(customer._id) }));

        expect(res.status).toBe(201);
        expect(res.body.data.booking.status).toBe("pending");
        expect(res.body.data.booking.user).toBe(String(customer._id));
        expect(res.body.data.booking.customerEmail).toBe(customer.email);
    });

    // A phone is optional on the ACCOUNT and required for the BOOKING: someone
    // has to be reachable at the door. The booking carries it when the profile
    // doesn't, and is refused when neither does.
    test("refuses a booking when neither the request nor the account has a phone", async () => {
        const admin = await createAdmin({ phone: undefined });
        const service = await createService();
        const city = await createCity();

        const res = await api.post("/api/v1/booking")
            .set("Cookie", cookieFor(admin))
            .send(validBookingBody(service, city));

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/phone number/i);
    });

    test("takes the phone from the request when the account has none", async () => {
        const admin = await createAdmin({ phone: undefined });
        const service = await createService();
        const city = await createCity();

        const res = await api.post("/api/v1/booking")
            .set("Cookie", cookieFor(admin))
            .send(validBookingBody(service, city, { customerPhone: "+995 555 12 34 56" }));

        expect(res.status).toBe(201);
        expect(res.body.data.booking.customerPhone).toBe("+995555123456");
    });

    test("rejects a booking phone that has no country prefix", async () => {
        const admin = await createAdmin();
        const service = await createService();
        const city = await createCity();

        const res = await api.post("/api/v1/booking")
            .set("Cookie", cookieFor(admin))
            .send(validBookingBody(service, city, { customerPhone: "3312345678" }));

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Validation failed/);
    });

    test("client-supplied totalAmount is rejected by the strict schema", async () => {
        const admin = await createAdmin();
        const service = await createService();
        const city = await createCity();

        const res = await api.post("/api/v1/booking")
            .set("Cookie", cookieFor(admin))
            .send(validBookingBody(service, city, { totalAmount: 0.01 }));
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Validation failed/);
    });

    test("rejects more than 10 cleaners", async () => {
        const admin = await createAdmin();
        const service = await createService();
        const city = await createCity();
        const res = await api.post("/api/v1/booking")
            .set("Cookie", cookieFor(admin))
            .send(validBookingBody(service, city, { cleaners: 11 }));
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Validation failed/);
    });

    describe("fail-closed reference resolution", () => {
        test("rejects a disabled service", async () => {
            const admin = await createAdmin();
            const service = await createService({ enabled: false });
            const city = await createCity();
            const res = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(validBookingBody(service, city));
            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(/service does not exist or is unavailable/i);
        });

        test("rejects a disabled city", async () => {
            const admin = await createAdmin();
            const service = await createService();
            const city = await createCity({ enabled: false });
            const res = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(validBookingBody(service, city));
            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(/city does not exist or is unavailable/i);
        });

        test("rejects a city outside a restricted service's coverage", async () => {
            const admin = await createAdmin();
            const covered = await createCity();
            const uncovered = await createCity();
            const service = await createService({ allCities: false, cities: [covered._id] });

            const res = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(validBookingBody(service, uncovered));
            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(/not available in the chosen city/i);
        });

        test("rejects a disabled add-on", async () => {
            const admin = await createAdmin();
            const service = await createService();
            const city = await createCity();
            const addon = await createSpecialRequest({ enabled: false });

            const res = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(validBookingBody(service, city, { specialRequests: [String(addon._id)] }));
            expect(res.status).toBe(400);
        });

        test("rejects an add-on the service doesn't offer", async () => {
            const admin = await createAdmin();
            const offered = await createSpecialRequest();
            const notOffered = await createSpecialRequest();
            const service = await createService({
                allSpecialRequests: false,
                specialRequests: [offered._id]
            });
            const city = await createCity();

            const res = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(validBookingBody(service, city, { specialRequests: [String(notOffered._id)] }));
            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(/not available for this service/i);
        });

        test("rejects a tool restricted to a different service", async () => {
            const admin = await createAdmin();
            const service = await createService();
            const otherService = await createService();
            const city = await createCity();
            const tool = await createCleaningTool({ services: [otherService._id] });

            const res = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(validBookingBody(service, city, { cleaningTools: [String(tool._id)] }));
            expect(res.status).toBe(400);
        });
    });

    describe("working-hours window", () => {
        test("rejects a start outside the city's working hours", async () => {
            const admin = await createAdmin();
            const service = await createService();
            const city = await createCity({ workingHourStarts: "09:00", workingHourEnds: "17:00" });

            const res = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(validBookingBody(service, city, { bookingTime: "07:00" }));
            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(/outside city working hours/i);
        });

        test("rejects a booking that would run past closing time", async () => {
            const admin = await createAdmin();
            const service = await createService();
            const city = await createCity({ workingHourStarts: "09:00", workingHourEnds: "17:00" });

            const res = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(validBookingBody(service, city, { bookingTime: "16:00", durationMinutes: 240 }));
            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(/run past the city's closing time/i);
        });

        test("prices and stores an exact-minute duration", async () => {
            const admin = await createAdmin();
            const service = await createService({ pricePerHour: 20 });
            const city = await createCity({ workingHourStarts: "09:00", workingHourEnds: "17:30" });

            // 16:05 + 1 h 25 min ends exactly at closing, and 85/60 × 20 = 28.33.
            const res = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(validBookingBody(service, city, { bookingTime: "16:05", durationMinutes: 85 }));

            expect(res.status).toBe(201);
            expect(res.body.data.booking.durationMinutes).toBe(85);
            expect(res.body.data.booking.totalAmount).toBe(28.33);
        });

        test("rejects a duration that overruns closing by a single minute", async () => {
            const admin = await createAdmin();
            const service = await createService();
            const city = await createCity({ workingHourStarts: "09:00", workingHourEnds: "17:00" });

            const fits = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(validBookingBody(service, city, { bookingTime: "15:00", durationMinutes: 120 }));
            expect(fits.status).toBe(201);

            const overruns = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(validBookingBody(service, city, { bookingTime: "15:00", durationMinutes: 121 }));
            expect(overruns.status).toBe(400);
            expect(overruns.body.message).toMatch(/run past the city's closing time/i);
        });

        test("accepts an arbitrary start minute, not just whole hours", async () => {
            const admin = await createAdmin();
            const service = await createService();
            const city = await createCity({ workingHourStarts: "09:00", workingHourEnds: "17:30" });

            const res = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(validBookingBody(service, city, { bookingTime: "12:20", durationMinutes: 120 }));

            expect(res.status).toBe(201);
            expect(res.body.data.booking.bookingTime).toBe("12:20");
        });

        test.each([
            ["a fraction of a minute", 85.5],
            ["a zero duration", 0],
            ["a negative duration", -60],
            ["less than the platform minimum", 30],
            ["more than the platform maximum", 721],
            ["a non-numeric value", "1h 25m"]
        ])("rejects %s at the validation layer", async (_label, durationMinutes) => {
            const admin = await createAdmin();
            const service = await createService();
            const city = await createCity();

            const res = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(validBookingBody(service, city, { durationMinutes }));

            expect(res.status).toBe(400);
            expect(res.body.fields).toHaveProperty("durationMinutes");
        });

        test("rejects a past date at the validation layer", async () => {
            const admin = await createAdmin();
            const service = await createService();
            const city = await createCity();

            const res = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(validBookingBody(service, city, { bookingDate: "2020-01-01" }));
            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(/Validation failed/);
        });
    });

    describe("48-hour advance notice", () => {
        // Built from the real clock so the assertions describe the rule the way a
        // customer meets it, rather than a frozen fixture the code could drift from.
        const stamp = (msFromNow) => {
            const d = new Date(Date.now() + msFromNow);
            return {
                bookingDate: [
                    d.getFullYear(),
                    String(d.getMonth() + 1).padStart(2, "0"),
                    String(d.getDate()).padStart(2, "0")
                ].join("-"),
                bookingTime: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
            };
        };
        const HOURS = 60 * 60 * 1000;
        // Open around the clock, so only the notice rule can reject these.
        const allDay = { workingHourStarts: "00:00", workingHourEnds: "23:59" };

        test("accepts a booking placed a minute over 48 hours ahead", async () => {
            const admin = await createAdmin();
            const service = await createService();
            const city = await createCity(allDay);

            const res = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(validBookingBody(service, city, { ...stamp(48 * HOURS + 60 * 1000), durationMinutes: 60 }));

            expect(res.status).toBe(201);
        });

        test("rejects a booking 47 h 59 m ahead", async () => {
            const admin = await createAdmin();
            const service = await createService();
            const city = await createCity(allDay);

            const res = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(validBookingBody(service, city, { ...stamp(47 * HOURS + 59 * 60 * 1000), durationMinutes: 60 }));

            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(/at least 48 hours in advance/i);
        });

        test("a service with allowInstantBooking can be booked later today", async () => {
            const admin = await createAdmin();
            const service = await createInstantService();
            const city = await createCity(allDay);

            const res = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(validBookingBody(service, city, { ...stamp(2 * HOURS), durationMinutes: 60 }));

            expect(res.status).toBe(201);
        });

        test("an instant booking still cannot start in the past", async () => {
            const admin = await createAdmin();
            const service = await createInstantService();
            const city = await createCity(allDay);

            const res = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(validBookingBody(service, city, {
                    ...stamp(0),
                    bookingDate: stamp(0).bookingDate,
                    durationMinutes: 60
                }));

            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(/must be in the future/i);
        });

        test("an instant booking still has to finish before the city closes", async () => {
            const admin = await createAdmin();
            const service = await createInstantService();
            // A window that certainly contains "an hour from now" and closes two
            // hours later, so 60 minutes fits and 180 cannot.
            const now = new Date();
            const opens = new Date(now.getTime() + 30 * 60 * 1000);
            const closes = new Date(now.getTime() + 3 * HOURS);
            const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
            // Skip when "now + 3 h" would cross midnight — the window would wrap.
            if (closes.getDate() !== now.getDate()) return;

            const city = await createCity({
                workingHourStarts: hhmm(opens),
                workingHourEnds: hhmm(closes)
            });
            const slot = stamp(60 * 60 * 1000);

            const fits = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(validBookingBody(service, city, { ...slot, durationMinutes: 60 }));
            expect(fits.status).toBe(201);

            const overruns = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(validBookingBody(service, city, { ...slot, durationMinutes: 180 }));
            expect(overruns.status).toBe(400);
            expect(overruns.body.message).toMatch(/run past the city's closing time/i);
        });
    });

    describe("concurrent bookings of the same slot", () => {
        // There is deliberately NO service-level conflict rule: two customers
        // wanting the same service at the same hour is ordinary demand, not a
        // collision. Staffing is handled by worker assignment, which is separate.
        test("two customers may book the same service at the same start time", async () => {
            const admin = await createAdmin();
            const service = await createService({ pricePerHour: 20 });
            const city = await createCity({ workingHourStarts: "09:00", workingHourEnds: "20:00" });

            const body = validBookingBody(service, city, {
                bookingTime: "14:00",
                durationMinutes: 120,
                customerName: "Customer A",
                customerEmail: "a@test.casaclean.local",
                customerPhone: "+393310000001"
            });

            const first = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send(body);
            expect(first.status).toBe(201);

            // Overlapping, different length, same service, same start.
            const second = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send({
                    ...body,
                    durationMinutes: 85,
                    customerName: "Customer B",
                    customerEmail: "b@test.casaclean.local",
                    customerPhone: "+393310000002"
                });
            expect(second.status).toBe(201);

            // And a third that merely overlaps rather than matching exactly.
            const third = await api.post("/api/v1/booking")
                .set("Cookie", cookieFor(admin))
                .send({
                    ...body,
                    bookingTime: "15:00",
                    durationMinutes: 90,
                    customerName: "Customer C",
                    customerEmail: "c@test.casaclean.local",
                    customerPhone: "+393310000003"
                });
            expect(third.status).toBe(201);
        });
    });

    test("admin can assign workers; ids are validated fail-closed", async () => {
        const admin = await createAdmin();
        const service = await createService();
        const city = await createCity();
        const worker = await createWorker();

        const ok = await api.post("/api/v1/booking")
            .set("Cookie", cookieFor(admin))
            .send(validBookingBody(service, city, { workers: [String(worker._id)] }));
        expect(ok.status).toBe(201);
        expect(ok.body.data.booking.workers).toEqual([String(worker._id)]);

        const bad = await api.post("/api/v1/booking")
            .set("Cookie", cookieFor(admin))
            .send(validBookingBody(service, city, { workers: ["64b000000000000000000000"] }));
        expect(bad.status).toBe(400);
    });
});

describe("listing and scoping", () => {
    test("GET /booking/my only returns the caller's bookings", async () => {
        const service = await createService();
        const city = await createCity();
        const alice = await createUser();
        const bob = await createUser();
        await createPaidBooking(alice, service, city);
        await createPaidBooking(bob, service, city);

        const res = await api.get("/api/v1/booking/my").set("Cookie", cookieFor(alice));
        expect(res.status).toBe(200);
        expect(res.body.bookingCount).toBe(1);
        expect(res.body.data.bookings).toHaveLength(1);
    });

    test("GET /booking (admin) supports status and date filters", async () => {
        const admin = await createAdmin();
        const service = await createService();
        const city = await createCity();
        const user = await createUser();
        await createPaidBooking(user, service, city, { status: "confirmed", bookingDate: dateStr(3) });
        await createPaidBooking(user, service, city, { status: "cancelled", bookingDate: dateStr(30) });

        const byStatus = await api.get("/api/v1/booking?status=cancelled")
            .set("Cookie", cookieFor(admin));
        expect(byStatus.body.bookingCount).toBe(1);
        expect(byStatus.body.data.bookings[0].status).toBe("cancelled");

        const byDate = await api.get(`/api/v1/booking?from=${dateStr(2)}&to=${dateStr(5)}`)
            .set("Cookie", cookieFor(admin));
        expect(byDate.body.bookingCount).toBe(1);
        expect(byDate.body.data.bookings[0].bookingDate).toBe(dateStr(3));
    });

    test("GET /booking/:id is admin-only and 404s when missing", async () => {
        const admin = await createAdmin();
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city);

        const asUser = await api.get(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(user));
        expect(asUser.status).toBe(403);

        const found = await api.get(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin));
        expect(found.status).toBe(200);

        const missing = await api.get("/api/v1/booking/64b000000000000000000000")
            .set("Cookie", cookieFor(admin));
        expect(missing.status).toBe(404);
    });
});

describe("PATCH /api/v1/booking/:id (admin edit)", () => {
    test("re-pointing a booking at another service is rejected, not silently ignored", async () => {
        const admin = await createAdmin();
        const user = await createUser();
        const service = await createService();
        const otherService = await createService({ pricePerHour: 99 });
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city, { totalAmount: 40 });

        const res = await api.patch(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin))
            .send({ serviceId: String(otherService._id) });

        expect(res.status).toBe(400);
        const fresh = await Booking.findById(booking._id);
        expect(String(fresh.serviceId)).toBe(String(service._id));
        expect(fresh.totalAmount).toBe(40);
    });

    test("recomputes the total when the duration changes", async () => {
        const admin = await createAdmin();
        const user = await createUser();
        const service = await createService({ pricePerHour: 20 });
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city, { durationMinutes: 120, totalAmount: 40 });

        const res = await api.patch(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin))
            .send({ durationMinutes: 300 });

        expect(res.status).toBe(200);
        expect(res.body.data.booking.totalAmount).toBe(100);
    });

    test("recomputes the total when cleaners change", async () => {
        const admin = await createAdmin();
        const user = await createUser();
        const service = await createService({ pricePerHour: 20 });
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city, { totalAmount: 40 });
        const res = await api.patch(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin))
            .send({ cleaners: 3 });
        expect(res.status).toBe(200);
        expect(res.body.data.booking.totalAmount).toBe(120);
    });

    test("cannot overwrite server-managed payment fields (strict schema)", async () => {
        const admin = await createAdmin();
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city);

        const res = await api.patch(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin))
            .send({ paymentStatus: "refunded" });
        expect(res.status).toBe(400);
    });

    test("admin cancellation of a paid card booking refunds the charge", async () => {
        const admin = await createAdmin();
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city);

        stripeMock.refunds.create.mockResolvedValue({ id: "re_admin_1" });

        const res = await api.patch(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin))
            .send({ status: "cancelled" });

        expect(res.status).toBe(200);
        // The idempotency key is what stops two concurrent cancels producing
        // two refunds, so assert it explicitly rather than ignoring the option.
        expect(stripeMock.refunds.create).toHaveBeenCalledWith(
            { payment_intent: booking.paymentIntentId },
            { idempotencyKey: `refund:booking:${booking._id}` }
        );
        const fresh = await Booking.findById(booking._id);
        expect(fresh.status).toBe("cancelled");
        expect(fresh.paymentStatus).toBe("refunded");
        expect(fresh.refundId).toBe("re_admin_1");
        expect(sendEmailMock).toHaveBeenCalledTimes(1); // refund email
    });

    // The admin edit form seeds every field from the booking and re-sends them,
    // so an edit to a PAST booking (marking it completed, adding notes,
    // assigning staff after the fact) always carries its own past bookingDate.
    // A blanket "no past dates" rule used to live in editBookingSchema and made
    // every one of those edits fail with "Validation failed!".
    test("editing a past booking with its own unchanged date is allowed", async () => {
        const admin = await createAdmin();
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city, {
            bookingDate: dateStr(-30),
            status: "confirmed"
        });

        const res = await api.patch(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin))
            .send({
                status: "completed",
                bookingDate: dateStr(-30),
                bookingTime: "10:00",
                notes: "Keys returned to the concierge."
            });

        expect(res.status).toBe(200);
        expect(res.body.data.booking.status).toBe("completed");
        expect(res.body.data.booking.bookingDate).toBe(dateStr(-30));
    });

    test("a status-only edit of a past booking succeeds", async () => {
        const admin = await createAdmin();
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city, {
            bookingDate: dateStr(-3)
        });

        const res = await api.patch(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin))
            .send({ status: "completed" });

        expect(res.status).toBe(200);
    });

    test("actually RESCHEDULING a booking into the past is still rejected", async () => {
        const admin = await createAdmin();
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city);

        const res = await api.patch(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin))
            .send({ bookingDate: dateStr(-1) });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/past/i);
        const fresh = await Booking.findById(booking._id);
        expect(fresh.bookingDate).toBe(booking.bookingDate);
    });

    test("a malformed date is still rejected by the schema", async () => {
        const admin = await createAdmin();
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city);

        const res = await api.patch(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin))
            .send({ bookingDate: "04/02/2026" });

        expect(res.status).toBe(400);
    });

    test("a validation failure names the offending field", async () => {
        const admin = await createAdmin();
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city);

        const res = await api.patch(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin))
            .send({ durationMinutes: 9999 });

        expect(res.status).toBe(400);
        expect(res.body.fields).toHaveProperty("durationMinutes");
    });

    test("re-cancelling an already-cancelled booking never double-refunds", async () => {
        const admin = await createAdmin();
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city, { status: "cancelled" });

        const res = await api.patch(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin))
            .send({ status: "cancelled" });

        expect(res.status).toBe(200);
        expect(stripeMock.refunds.create).not.toHaveBeenCalled();
    });
});

describe("PATCH /api/v1/booking/:id/cancel (customer self-cancel)", () => {
    test("a user cannot cancel someone else's booking (404, no leak)", async () => {
        const owner = await createUser();
        const attacker = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(owner, service, city);

        const res = await api.patch(`/api/v1/booking/${booking._id}/cancel`)
            .set("Cookie", cookieFor(attacker));
        expect(res.status).toBe(404);
        expect((await Booking.findById(booking._id)).status).toBe("confirmed");
    });

    test("cancelling early enough refunds a paid card booking", async () => {
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        // 72h ahead — outside the 24h no-refund window.
        const booking = await createPaidBooking(user, service, city, dateTimeIn(72));

        stripeMock.refunds.create.mockResolvedValue({ id: "re_user_1" });

        const res = await api.patch(`/api/v1/booking/${booking._id}/cancel`)
            .set("Cookie", cookieFor(user));

        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/refunded/i);
        expect(stripeMock.refunds.create).toHaveBeenCalledTimes(1);
        const fresh = await Booking.findById(booking._id);
        expect(fresh.status).toBe("cancelled");
        expect(fresh.paymentStatus).toBe("refunded");
    });

    test("two concurrent cancels issue exactly one refund", async () => {
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city, dateTimeIn(72));

        stripeMock.refunds.create.mockResolvedValue({ id: "re_race_1" });
        const cookie = cookieFor(user);

        // Both requests race the same booking. Only the one that wins the atomic
        // status claim may talk to Stripe; the loser must be rejected outright.
        const [a, b] = await Promise.all([
            api.patch(`/api/v1/booking/${booking._id}/cancel`).set("Cookie", cookie),
            api.patch(`/api/v1/booking/${booking._id}/cancel`).set("Cookie", cookie)
        ]);

        const statuses = [a.status, b.status].sort();
        expect(statuses).toEqual([200, 400]);
        expect(stripeMock.refunds.create).toHaveBeenCalledTimes(1);

        const fresh = await Booking.findById(booking._id);
        expect(fresh.status).toBe("cancelled");
        expect(fresh.paymentStatus).toBe("refunded");
    });

    test("a failed refund leaves the booking uncancelled", async () => {
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city, dateTimeIn(72));

        stripeMock.refunds.create.mockRejectedValue(
            Object.assign(new Error("Stripe is down"), { type: "StripeAPIError" })
        );

        const res = await api.patch(`/api/v1/booking/${booking._id}/cancel`)
            .set("Cookie", cookieFor(user));

        expect(res.status).toBe(502);
        // The atomic claim must be rolled back — a booking cancelled while the
        // customer is still charged is the exact state this guards against.
        const fresh = await Booking.findById(booking._id);
        expect(fresh.status).toBe("confirmed");
        expect(fresh.paymentStatus).toBe("paid");
    });

    test("cancelling inside the 24h window keeps one hour and refunds the rest", async () => {
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        // 2h ahead — inside the window. €20/h × 2h × 1 cleaner = €40 charged, so
        // the retained hour is €20 and €20 goes back.
        const booking = await createPaidBooking(user, service, city, dateTimeIn(2));

        stripeMock.refunds.create.mockResolvedValue({ id: "re_partial_1" });

        const res = await api.patch(`/api/v1/booking/${booking._id}/cancel`)
            .set("Cookie", cookieFor(user));

        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/late-cancellation fee/i);

        // Stripe must be asked for a PARTIAL refund, in integer cents.
        expect(stripeMock.refunds.create).toHaveBeenCalledTimes(1);
        const [params] = stripeMock.refunds.create.mock.calls[0];
        expect(params).toMatchObject({ payment_intent: booking.paymentIntentId, amount: 2000 });

        const fresh = await Booking.findById(booking._id);
        expect(fresh.status).toBe("cancelled");
        expect(fresh.paymentStatus).toBe("partially-refunded");
        expect(fresh.refundAmount).toBe(20);
        expect(fresh.refundId).toBe("re_partial_1");
        // A partial refund leaves the charge's raw Stripe state alone — only a
        // full reversal makes it 'refunded'.
        expect(fresh.stripeStatus).toBe("succeeded");
    });

    test("the kept hour covers the whole crew, and add-ons come back in full", async () => {
        const user = await createUser();
        const service = await createService({ pricePerHour: 20 });
        const city = await createCity();
        const addon = await createSpecialRequest({ price: 15 });
        const tool = await createCleaningTool({ price: 5 });
        // €20/h × 3h × 2 cleaners = €120 of labour, + €15 + €5 = €140 charged.
        // The fee is one hour of BOTH cleaners (€40) — the add-ons are not
        // delivered, so none of their price is kept.
        const booking = await createPaidBooking(user, service, city, {
            ...dateTimeIn(2),
            durationMinutes: 180,
            cleaners: 2,
            totalAmount: 140,
            amountPaid: 140,
            specialRequests: [addon._id],
            cleaningTools: [tool._id]
        });

        stripeMock.refunds.create.mockResolvedValue({ id: "re_partial_2" });

        const res = await api.patch(`/api/v1/booking/${booking._id}/cancel`)
            .set("Cookie", cookieFor(user));

        expect(res.status).toBe(200);
        expect(stripeMock.refunds.create.mock.calls[0][0].amount).toBe(10000);
        const fresh = await Booking.findById(booking._id);
        expect(fresh.refundAmount).toBe(100);
    });

    test("a late cancellation of a one-hour booking keeps the whole charge", async () => {
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        // €20/h × 1h — the retained hour is the entire charge, so there is
        // nothing left to refund and Stripe is never called.
        const booking = await createPaidBooking(user, service, city, {
            ...dateTimeIn(2),
            durationMinutes: 60,
            totalAmount: 20,
            amountPaid: 20
        });

        const res = await api.patch(`/api/v1/booking/${booking._id}/cancel`)
            .set("Cookie", cookieFor(user));

        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/late-cancellation fee/i);
        expect(stripeMock.refunds.create).not.toHaveBeenCalled();
        const fresh = await Booking.findById(booking._id);
        expect(fresh.status).toBe("cancelled");
        expect(fresh.paymentStatus).toBe("paid");
    });

    test("a failed partial refund leaves the booking uncancelled and fully charged", async () => {
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city, dateTimeIn(2));

        stripeMock.refunds.create.mockRejectedValue(
            Object.assign(new Error("Stripe is down"), { type: "StripeAPIError" })
        );

        const res = await api.patch(`/api/v1/booking/${booking._id}/cancel`)
            .set("Cookie", cookieFor(user));

        expect(res.status).toBe(502);
        // Same invariant as the full-refund path: never leave a booking cancelled
        // while the customer is still charged for it.
        const fresh = await Booking.findById(booking._id);
        expect(fresh.status).toBe("confirmed");
        expect(fresh.paymentStatus).toBe("paid");
    });

    test("the customer is emailed what was kept and why", async () => {
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city, dateTimeIn(2));

        stripeMock.refunds.create.mockResolvedValue({ id: "re_partial_mail" });

        await api.patch(`/api/v1/booking/${booking._id}/cancel`)
            .set("Cookie", cookieFor(user));

        const mail = sendEmailMock.mock.calls
            .map(([args]) => args)
            .find((args) => args.email === user.email);
        expect(mail).toBeDefined();
        expect(mail.subject).toMatch(/partially refunded/i);
        // Both figures have to appear: what came back, and what did not.
        expect(mail.text).toContain("€20.00");
        expect(mail.text).toMatch(/late-cancellation fee/i);
        expect(mail.text).toMatch(/one hour of the booked cleaning/i);
    });

    test("an admin cancelling still refunds in full, whatever the window", async () => {
        const admin = await createAdmin();
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        // 2h ahead — the customer would only get half of this back. The admin
        // override is the escape hatch and is deliberately not fee'd.
        const booking = await createPaidBooking(user, service, city, dateTimeIn(2));

        stripeMock.refunds.create.mockResolvedValue({ id: "re_admin_full" });

        const res = await api.patch(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin))
            .send({ status: "cancelled" });

        expect(res.status).toBe(200);
        expect(stripeMock.refunds.create.mock.calls[0][0].amount).toBeUndefined();
        const fresh = await Booking.findById(booking._id);
        expect(fresh.paymentStatus).toBe("refunded");
    });

    test("a Stripe refund failure aborts the cancellation", async () => {
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city, dateTimeIn(72));

        stripeMock.refunds.create.mockRejectedValue(
            Object.assign(new Error("stripe down"), { type: "StripeAPIError" })
        );

        const res = await api.patch(`/api/v1/booking/${booking._id}/cancel`)
            .set("Cookie", cookieFor(user));

        expect(res.status).toBeGreaterThanOrEqual(500);
        // Never mark a booking cancelled while the customer is still charged.
        const fresh = await Booking.findById(booking._id);
        expect(fresh.status).toBe("confirmed");
        expect(fresh.paymentStatus).toBe("paid");
    });

    test("completed and already-cancelled bookings can't be cancelled", async () => {
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const completed = await createPaidBooking(user, service, city, { status: "completed" });
        const cancelled = await createPaidBooking(user, service, city, { status: "cancelled" });

        const r1 = await api.patch(`/api/v1/booking/${completed._id}/cancel`)
            .set("Cookie", cookieFor(user));
        expect(r1.status).toBe(400);

        const r2 = await api.patch(`/api/v1/booking/${cancelled._id}/cancel`)
            .set("Cookie", cookieFor(user));
        expect(r2.status).toBe(400);
    });

    test("manual (offline) bookings cancel without touching Stripe", async () => {
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city, {
            ...dateTimeIn(72),
            paymentMethod: "manual",
            paymentStatus: "manual",
            paymentIntentId: undefined
        });

        const res = await api.patch(`/api/v1/booking/${booking._id}/cancel`)
            .set("Cookie", cookieFor(user));
        expect(res.status).toBe(200);
        expect(stripeMock.refunds.create).not.toHaveBeenCalled();
        expect((await Booking.findById(booking._id)).status).toBe("cancelled");
    });
});

// Moving a booking between states is something the CUSTOMER needs to hear about
// — the admin panel is the only place it happens, and nothing else tells them.
// What these tests pin is the restraint around it: one email per real
// transition, none for a no-op save, and never a second one alongside a refund.
describe("booking status-change emails", () => {
    const setup = async (overrides = {}) => {
        const [admin, user, service, city] = await Promise.all([
            createAdmin(),
            createUser(),
            createService(),
            createCity()
        ]);
        const booking = await createPaidBooking(user, service, city, overrides);
        return { admin, user, service, city, booking };
    };

    /** The mail addressed to the booking's customer, if any went out. */
    const mailTo = (email) =>
        sendEmailMock.mock.calls.map(([mail]) => mail).find((mail) => mail.email === email);

    test("emails the customer when a pending booking is confirmed", async () => {
        const { admin, booking } = await setup({ status: "pending" });

        const res = await api.patch(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin))
            .send({ status: "confirmed" });

        expect(res.status).toBe(200);
        expect(sendEmailMock).toHaveBeenCalledTimes(1);

        const mail = mailTo(booking.customerEmail);
        expect(mail.subject).toContain("confirmed");
        // The message carries the slot, not just the word "confirmed" — a status
        // email a customer has to open the site to act on isn't worth sending.
        expect(mail.text).toContain(booking.bookingDate);
        expect(mail.text).toContain(booking.bookingTime);
        expect(mail.html).toContain("Booking confirmed");
    });

    test("emails the customer when a booking is marked completed", async () => {
        const { admin, booking } = await setup({
            status: "confirmed",
            bookingDate: dateStr(-2)
        });

        const res = await api.patch(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin))
            .send({ status: "completed" });

        expect(res.status).toBe(200);
        const mail = mailTo(booking.customerEmail);
        expect(mail.subject).toContain("complete");
        // Where it came from is stated, so a customer can spot a wrong move.
        expect(mail.text).toContain("Cleaning completed");
    });

    test("sends nothing when the admin re-saves the same status", async () => {
        const { admin, booking } = await setup({ status: "confirmed" });

        // The panel seeds its form from the booking and re-sends every field, so
        // an unrelated edit always carries the status it already had.
        const res = await api.patch(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin))
            .send({ status: "confirmed", notes: "Gate code 1234" });

        expect(res.status).toBe(200);
        expect(res.body.data.booking.notes).toBe("Gate code 1234");
        expect(sendEmailMock).not.toHaveBeenCalled();
    });

    test("sends nothing when the edit doesn't touch the status at all", async () => {
        const { admin, booking } = await setup({ status: "confirmed" });

        const res = await api.patch(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin))
            .send({ doorbellName: "Bianchi" });

        expect(res.status).toBe(200);
        expect(sendEmailMock).not.toHaveBeenCalled();
    });

    test("a refunded cancellation sends the refund email only, not both", async () => {
        const { admin, booking } = await setup({ status: "confirmed" });
        stripeMock.refunds.create.mockResolvedValue({ id: "re_status_1" });

        const res = await api.patch(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin))
            .send({ status: "cancelled" });

        expect(res.status).toBe(200);
        // One cancellation, one email — and it's the one that accounts for the
        // money, which is the more informative of the two.
        expect(sendEmailMock).toHaveBeenCalledTimes(1);
        expect(mailTo(booking.customerEmail).subject).toContain("refunded");
    });

    test("cancelling an unpaid/offline booking still tells the customer", async () => {
        // No refund is due here, so the refund email never fires — without the
        // status email this cancellation would reach the customer silently.
        const { admin, booking } = await setup({
            status: "confirmed",
            paymentMethod: "manual",
            paymentStatus: "manual",
            paymentIntentId: undefined
        });

        const res = await api.patch(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin))
            .send({ status: "cancelled" });

        expect(res.status).toBe(200);
        expect(stripeMock.refunds.create).not.toHaveBeenCalled();
        expect(sendEmailMock).toHaveBeenCalledTimes(1);
        expect(mailTo(booking.customerEmail).subject).toContain("cancelled");
    });

    test("a failed send never fails the edit the admin just made", async () => {
        const { admin, booking } = await setup({ status: "pending" });
        sendEmailMock.mockRejectedValueOnce(new Error("SMTP is down"));

        const res = await api.patch(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin))
            .send({ status: "confirmed" });

        expect(res.status).toBe(200);
        const fresh = await Booking.findById(booking._id);
        expect(fresh.status).toBe("confirmed");
    });

    test("a double-clicked cancel emails the customer once", async () => {
        const { admin, booking } = await setup({
            status: "confirmed",
            paymentMethod: "manual",
            paymentStatus: "manual",
            paymentIntentId: undefined
        });
        const cookie = cookieFor(admin);

        // Only one request wins the atomic claim; the loser must not narrate a
        // transition it didn't perform.
        await Promise.all([
            api.patch(`/api/v1/booking/${booking._id}`).set("Cookie", cookie).send({ status: "cancelled" }),
            api.patch(`/api/v1/booking/${booking._id}`).set("Cookie", cookie).send({ status: "cancelled" })
        ]);

        expect(sendEmailMock).toHaveBeenCalledTimes(1);
    });
});

describe("DELETE /api/v1/booking/:id", () => {
    test("is admin-only", async () => {
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city);

        const asUser = await api.delete(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(user));
        expect(asUser.status).toBe(403);

        const admin = await createAdmin();
        const asAdmin = await api.delete(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin));
        expect(asAdmin.status).toBe(200);
        expect(await Booking.findById(booking._id)).toBeNull();
    });
});

// The admin manual path is the escape hatch for walk-ins: the ID is honoured
// from the body, falls back to the linked account, and is never required.
describe("POST/PATCH /api/v1/booking - personal ID", () => {
    test("an admin booking falls back to the linked customer's ID", async () => {
        const admin = await createAdmin();
        const customer = await createUser({ personalId: "01001012345" });
        const service = await createService();
        const city = await createCity();

        const res = await api.post("/api/v1/booking")
            .set("Cookie", cookieFor(admin))
            .send(validBookingBody(service, city, { userId: String(customer._id) }));

        expect(res.status).toBe(201);
        expect(res.body.data.booking.customerPersonalId).toBe("01001012345");
    });

    test("a walk-in booking without an ID is still accepted", async () => {
        const admin = await createAdmin();
        const service = await createService();
        const city = await createCity();

        const res = await api.post("/api/v1/booking")
            .set("Cookie", cookieFor(admin))
            .send(validBookingBody(service, city, {
                customerName: "Walk In",
                customerEmail: "walkin@test.casaclean.local",
                customerPhone: "+393312345678"
            }));

        expect(res.status).toBe(201);
        expect(res.body.data.booking.customerPersonalId).toBeUndefined();
    });

    test("an admin can correct the ID on an existing booking", async () => {
        const admin = await createAdmin();
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const booking = await createPaidBooking(user, service, city, { customerPersonalId: "WRONG123" });

        const res = await api.patch(`/api/v1/booking/${booking._id}`)
            .set("Cookie", cookieFor(admin))
            .send({ customerPersonalId: "ak 123456" });

        expect(res.status).toBe(200);
        expect(res.body.data.booking.customerPersonalId).toBe("AK123456");
    });
});
