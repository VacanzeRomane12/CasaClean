import { describe, test, expect } from "vitest";
import { mergeBookingsWithOccurrences, occurrenceFromApi } from "./calendarOccurrences";

const apiOccurrence = (overrides = {}) => ({
  subscriptionId: "sub1",
  bookingDate: "2026-11-02",
  bookingTime: "10:00",
  durationMinutes: 120,
  cleaners: 1,
  customerName: "Giorgi K.",
  customerEmail: "giorgi@example.com",
  customerPhone: "+995555123456",
  customerPersonalId: "01001012345",
  streetName: "Rustaveli",
  houseNumber: "7",
  serviceId: { _id: "svc1", name: "Home Cleaning" },
  cityId: { _id: "city1", name: "Tbilisi" },
  intervalDays: 7,
  notes: null,
  projected: true,
  ...overrides,
});

describe("occurrenceFromApi", () => {
  test("maps a projection onto the calendar's booking shape with a per-plan-day key", () => {
    const o = occurrenceFromApi(apiOccurrence());
    expect(o).toMatchObject({
      _id: "sub1:2026-11-02",
      projected: true,
      status: "scheduled",
      subscription_id: "sub1",
      interval_days: 7,
      customer_name: "Giorgi K.",
      customer_personal_id: "01001012345",
      service_id: "svc1",
      service_name: "Home Cleaning",
      city_name: "Tbilisi",
      booking_date: "2026-11-02",
      booking_time: "10:00",
      duration_minutes: 120,
    });
    expect(o.total_amount).toBeUndefined();
  });

  test("tolerates raw ids and missing optional fields", () => {
    const o = occurrenceFromApi(apiOccurrence({ serviceId: "svc1", cityId: "city1", customerPersonalId: undefined }));
    expect(o.service_id).toBe("svc1");
    expect(o.service_name).toBe("—");
    expect(o.customer_personal_id).toBe("");
  });
});

describe("mergeBookingsWithOccurrences", () => {
  const real = (overrides = {}) => ({
    _id: "b1",
    subscription_id: "sub1",
    booking_date: "2026-11-02",
    status: "confirmed",
    ...overrides,
  });

  test("keeps every real booking and appends projections that do not duplicate one", () => {
    const merged = mergeBookingsWithOccurrences(
      [real()],
      [occurrenceFromApi(apiOccurrence({ bookingDate: "2026-11-09" }))]
    );
    expect(merged.map((e) => e._id)).toEqual(["b1", "sub1:2026-11-09"]);
  });

  test("drops a projection when a real booking of the same plan exists on that day", () => {
    const merged = mergeBookingsWithOccurrences(
      [real()],
      [occurrenceFromApi(apiOccurrence())]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]._id).toBe("b1");
  });

  test("does not confuse one plan's day with another plan's, nor with a one-off booking", () => {
    const merged = mergeBookingsWithOccurrences(
      [real({ _id: "oneoff", subscription_id: null }), real({ _id: "b2", subscription_id: "sub2" })],
      [occurrenceFromApi(apiOccurrence())]
    );
    expect(merged.map((e) => e._id)).toEqual(["oneoff", "b2", "sub1:2026-11-02"]);
  });

  test("handles a missing occurrences list", () => {
    expect(mergeBookingsWithOccurrences([real()], undefined)).toHaveLength(1);
  });
});
