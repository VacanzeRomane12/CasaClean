// Helpers specific to recurring-payment integration tests.  These build a
// complete Subscription document directly so a test can focus on the worker or
// API transition it is exercising rather than repeating the booking template.
const Subscription = require("../../models/subscription.model");
const { dateStr } = require("./fixtures");
const { addDaysToDateString, localMidnight } = require("../../utils/date.util");

let sequence = 0;

const createSubscription = async (user, service, city, overrides = {}) => {
    const n = ++sequence;
    const nextServiceDate = overrides.nextServiceDate || dateStr(1);
    const intervalDays = overrides.intervalDays || 3;

    return Subscription.create({
        user: user._id,
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
        bookingTime: "10:00",
        durationMinutes: 120,
        cleaners: 1,
        notes: null,
        specialRequests: [],
        cleaningTools: [],
        supplies: [],
        intervalDays,
        nextServiceDate,
        nextChargeAt: localMidnight(addDaysToDateString(nextServiceDate, -1)),
        stripeCustomerId: `cus_subscription_${n}`,
        paymentMethodId: `pm_subscription_${n}`,
        firstPaymentIntentId: `pi_first_subscription_${n}`,
        ...overrides
    });
};

module.exports = { createSubscription };
