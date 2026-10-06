import { describe, test, expect, vi } from "vitest";

vi.mock("@/services/api", () => ({ request: vi.fn() }));

import { request } from "@/services/api";
import * as bookingApi from "./bookingApi";
import { toBookingPayload, cancelMyBooking, getMyBookings } from "./bookingApi";

const wizardValues = {
  serviceId: "svc1",
  cityId: "city1",
  street: "Via Roma",
  houseNumber: "12",
  propertySize: 80,
  doorbellName: "Rossi",
  date: "2026-08-01",
  time: "10:00",
  durationHours: "1",
  durationMins: "25",
  cleaners: "2",
  name: "Mario Rossi",
  email: "mario@example.com",
  phone: "+393312345678",
  personalId: "01001012345",
  notes: "",
  additionalServices: ["sr1"],
  cleaningTools: ["ct1"],
};

describe("toBookingPayload", () => {
  test("maps wizard fields onto the camelCase API contract", () => {
    const payload = toBookingPayload(wizardValues);
    expect(payload).toEqual({
      serviceId: "svc1",
      cityId: "city1",
      customerPhone: "+393312345678",
      customerPersonalId: "01001012345",
      streetName: "Via Roma",
      houseNumber: "12",
      propertySize: "80", // stringified for the API
      doorbellName: "Rossi",
      bookingDate: "2026-08-01",
      bookingTime: "10:00",
      // The two duration inputs, combined into the one total the API takes.
      durationMinutes: 85,
      cleaners: 2,
      notes: null, // empty string -> null
      specialRequests: ["sr1"],
      cleaningTools: ["ct1"],
    });
  });

  test("never sends the duration as hours, or as anything but whole minutes", () => {
    const payload = toBookingPayload({ ...wizardValues, durationHours: 2, durationMins: 10 });
    expect(payload.durationMinutes).toBe(130);
    expect(payload).not.toHaveProperty("hours");
    expect(payload).not.toHaveProperty("durationHours");
    expect(payload).not.toHaveProperty("durationMins");
    expect(Number.isInteger(payload.durationMinutes)).toBe(true);
  });

  test("never sends identity or price fields (server derives them)", () => {
    const payload = toBookingPayload(wizardValues);
    // The API's .strict() schema rejects unknown fields — sending any of these
    // would fail the whole request.
    expect(payload).not.toHaveProperty("name");
    expect(payload).not.toHaveProperty("customerName");
    expect(payload).not.toHaveProperty("email");
    expect(payload).not.toHaveProperty("customerEmail");
    expect(payload).not.toHaveProperty("totalAmount");
  });

  test("defaults optional arrays to empty", () => {
    const payload = toBookingPayload({ ...wizardValues, additionalServices: undefined, cleaningTools: undefined });
    expect(payload.specialRequests).toEqual([]);
    expect(payload.cleaningTools).toEqual([]);
  });

  test("sends intervalDays only for a recurring booking", () => {
    expect(toBookingPayload({ ...wizardValues, intervalDays: 3 })).toMatchObject({
      intervalDays: 3,
    });
    expect(toBookingPayload({ ...wizardValues, intervalDays: 0 })).not.toHaveProperty(
      "intervalDays"
    );
  });
});

describe("customer booking creation", () => {
  test("exposes no createBooking helper", () => {
    // Customers must go through the pay-first flow in paymentApi.js. A helper
    // posting to the admin-only POST /booking could only 403 — and the old one
    // faked a "confirmed" result on a network error, showing a confirmation for
    // a booking that was never created or paid for.
    expect(bookingApi.createBooking).toBeUndefined();
  });
});

describe("cancelMyBooking", () => {
  test("PATCHes the cancel endpoint and returns the new status", async () => {
    request.mockResolvedValue({ booking: { _id: "b1", status: "cancelled" } });
    const result = await cancelMyBooking("b1");
    expect(request).toHaveBeenCalledWith({ method: "PATCH", url: "/booking/b1/cancel" });
    expect(result).toEqual({ _id: "b1", status: "cancelled" });
  });
});

describe("getMyBookings", () => {
  test("normalises populated and raw service/city references", async () => {
    request.mockResolvedValue({
      bookings: [
        {
          _id: "abcdefabcdef",
          serviceId: { _id: "svc1", name: "Home Cleaning" }, // populated
          cityId: "city1", // raw id
          bookingDate: "2026-08-01",
          bookingTime: "10:00",
          totalAmount: 100,
          status: "confirmed",
        },
      ],
    });

    const [booking] = await getMyBookings();
    expect(booking.service_id).toBe("svc1");
    expect(booking.city_id).toBe("city1");
    expect(booking.reference).toBe("CC-ABCDEF"); // last 6 chars, uppercased
  });
});
