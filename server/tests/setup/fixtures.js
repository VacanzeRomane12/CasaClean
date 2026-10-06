// Factories for the domain documents the integration suites need. Each factory
// writes straight through the Mongoose model (bypassing the HTTP layer) so a
// suite can assemble its preconditions without depending on other endpoints.
const jwt = require("jsonwebtoken");

const User = require("../../models/user.model");
const City = require("../../models/city.model");
const Service = require("../../models/service.model");
const SpecialRequest = require("../../models/specialRequest.model");
const CleaningTool = require("../../models/cleaningTool.model");
const Worker = require("../../models/worker.model");
const Booking = require("../../models/booking.model");

let seq = 0;
const next = () => ++seq;

/** A verified local user (password: "password123"). */
const createUser = (overrides = {}) => {
    const n = next();
    return User.create({
        fullname: `Test User ${n}`,
        email: `user${n}@test.casaclean.local`,
        phone: `+3933100${String(n).padStart(5, "0")}`,
        // A booking requires a personal ID number (falling back to the profile),
        // so every fixture user carries one and the existing booking/intent
        // suites keep passing. Suites exercising the rule override it with "".
        personalId: `010010${String(n).padStart(5, "0")}`,
        password: "password123",
        isVerified: true,
        ...overrides
    });
};

const createAdmin = (overrides = {}) => createUser({ role: "admin", ...overrides });

/**
 * A Google (OAuth) account: verified by Google, with NO local password and no
 * phone — exactly what config/passport.config.js creates on first sign-in.
 */
const createGoogleUser = (overrides = {}) => {
    const n = next();
    return User.create({
        fullname: `Google User ${n}`,
        email: `google${n}@test.casaclean.local`,
        googleId: `google-oauth-id-${n}`,
        provider: "google",
        isVerified: true,
        ...overrides
    });
};

/** The auth cookie the protect middleware expects, signed like signToken(). */
const cookieFor = (user) => {
    const token = jwt.sign(
        { id: user._id, v: user.tokenVersion ?? 0 },
        process.env.JWT_SECRET,
        { expiresIn: "1h" }
    );
    return [`lt=${token}`];
};

const createCity = (overrides = {}) =>
    City.create({
        name: `Test City ${next()}`,
        workingHourStarts: "08:00",
        workingHourEnds: "20:00",
        ...overrides
    });

const createService = (overrides = {}) =>
    Service.create({
        name: `Test Service ${next()}`,
        description: "A perfectly ordinary cleaning service used in tests.",
        pricePerHour: 20,
        allCities: true,
        allSpecialRequests: true,
        // NOT permissive, unlike the coverage/add-on flags above: recurrence is
        // exclusive, so a service that repeats can ONLY be booked on a plan.
        // Almost every suite books a one-off, so the default has to be off and a
        // suite exercising recurrence passes recurringEnabled: true.
        recurringEnabled: false,
        ...overrides
    });

/** A service that skips the 48-hour notice — bookable today. */
const createInstantService = (overrides = {}) =>
    createService({ allowInstantBooking: true, ...overrides });

const createSpecialRequest = (overrides = {}) =>
    SpecialRequest.create({
        name: `Test Add-on ${next()}`,
        price: 15,
        ...overrides
    });

const createCleaningTool = (overrides = {}) =>
    CleaningTool.create({
        name: `Test Tool ${next()}`,
        price: 5,
        ...overrides
    });

const createWorker = (overrides = {}) =>
    Worker.create({
        fullname: `Test Worker ${next()}`,
        ...overrides
    });

/** Local "YYYY-MM-DD" for N days from now (defaults to tomorrow). */
const dateStr = (daysAhead = 1) => {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    return [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, "0"),
        String(d.getDate()).padStart(2, "0")
    ].join("-");
};

/**
 * Local date/time strings for a moment `hoursAhead` from now — used to place a
 * booking inside/outside the cancellation-refund window (which is computed from
 * the stored strings, not from city working hours).
 */
const dateTimeIn = (hoursAhead) => {
    const d = new Date(Date.now() + hoursAhead * 60 * 60 * 1000);
    return {
        bookingDate: [
            d.getFullYear(),
            String(d.getMonth() + 1).padStart(2, "0"),
            String(d.getDate()).padStart(2, "0")
        ].join("-"),
        bookingTime: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    };
};

/**
 * A valid createBooking/bookingIntent body for the given service+city.
 *
 * The date is three days out because every booking must clear the 48-hour
 * advance notice (utils/leadTime.util.js) unless its service opts into instant
 * booking. Suites exercising the notice rule override `bookingDate` explicitly.
 */
const validBookingBody = (service, city, overrides = {}) => ({
    serviceId: String(service._id),
    cityId: String(city._id),
    streetName: "Via Roma",
    houseNumber: "12",
    propertySize: "80",
    doorbellName: "Rossi",
    bookingDate: dateStr(3),
    bookingTime: "10:00",
    durationMinutes: 120,
    cleaners: 1,
    ...overrides
});

/** A paid online (card) booking, as promotePendingBooking would persist it. */
const createPaidBooking = (user, service, city, overrides = {}) => {
    const n = next();
    return Booking.create({
        user: user._id,
        serviceId: service._id,
        cityId: city._id,
        customerName: user.fullname,
        customerEmail: user.email,
        customerPhone: user.phone,
        streetName: "Via Roma",
        houseNumber: "12",
        propertySize: "80",
        doorbellName: "Rossi",
        bookingDate: dateStr(7),
        bookingTime: "10:00",
        durationMinutes: 120,
        cleaners: 1,
        totalAmount: 40,
        status: "confirmed",
        paymentIntentId: `pi_test_${n}`,
        paymentMethod: "card",
        paymentStatus: "paid",
        amountPaid: 40,
        currency: "eur",
        paidAt: new Date(),
        stripeStatus: "succeeded",
        ...overrides
    });
};

module.exports = {
    createUser,
    createAdmin,
    createGoogleUser,
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
};
