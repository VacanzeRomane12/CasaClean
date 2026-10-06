// DB-free units of the recurring-plan service: projecting the upcoming visits
// of a plan from its rule, which the admin calendar reads instead of waiting for
// each cycle to be charged into a Booking.
const { projectOccurrences, MAX_OCCURRENCE_SPAN_DAYS } = require("../../services/subscription.service");
const { addDaysToDateString, todayString } = require("../../utils/date.util");

const today = todayString();
const inDays = (n) => addDaysToDateString(today, n);

describe("projectOccurrences", () => {
    test("starts at the first uncharged date and steps by the cadence, inclusive of both bounds", () => {
        const plan = { nextServiceDate: inDays(2), intervalDays: 7 };
        expect(projectOccurrences(plan, inDays(2), inDays(16))).toEqual([
            inDays(2), inDays(9), inDays(16)
        ]);
    });

    test("skips dates before the range without shifting the cadence", () => {
        const plan = { nextServiceDate: inDays(1), intervalDays: 3 };
        // The walk still runs 1, 4, 7, 10 — only the dates inside the window are returned.
        expect(projectOccurrences(plan, inDays(5), inDays(10))).toEqual([inDays(7), inDays(10)]);
    });

    test("never paints the past: an overdue plan contributes only today onwards", () => {
        const plan = { nextServiceDate: inDays(-5), intervalDays: 2 };
        // -5, -3, -1, 1, 3 — the past three are dropped.
        expect(projectOccurrences(plan, inDays(-10), inDays(3))).toEqual([inDays(1), inDays(3)]);
    });

    test("returns nothing when the plan's next visit is after the range", () => {
        const plan = { nextServiceDate: inDays(20), intervalDays: 7 };
        expect(projectOccurrences(plan, inDays(1), inDays(19))).toEqual([]);
    });

    test("uses local calendar arithmetic across month ends and the DST change", () => {
        // 2026-10-24 → +7 crosses the EU autumn clock change on 25 October.
        const plan = { nextServiceDate: "2026-10-24", intervalDays: 7 };
        const from = "2026-10-01" > today ? "2026-10-01" : today;
        const dates = projectOccurrences(plan, from, "2026-11-30");
        const expected = ["2026-10-24", "2026-10-31", "2026-11-07", "2026-11-14", "2026-11-21", "2026-11-28"]
            .filter((d) => d >= today);
        expect(dates).toEqual(expected);
    });

    test("is bounded: a daily plan over the widest span yields at most span + 1 dates", () => {
        const plan = { nextServiceDate: today, intervalDays: 1 };
        const dates = projectOccurrences(plan, today, inDays(MAX_OCCURRENCE_SPAN_DAYS));
        expect(dates).toHaveLength(MAX_OCCURRENCE_SPAN_DAYS + 1);
        expect(dates[0]).toBe(today);
        expect(dates[dates.length - 1]).toBe(inDays(MAX_OCCURRENCE_SPAN_DAYS));
    });

    test("rejects an invalid cadence, a missing date or an inverted range", () => {
        expect(projectOccurrences({ nextServiceDate: today, intervalDays: 0 }, today, inDays(10))).toEqual([]);
        expect(projectOccurrences({ nextServiceDate: today, intervalDays: 15 }, today, inDays(10))).toEqual([]);
        expect(projectOccurrences({ intervalDays: 7 }, today, inDays(10))).toEqual([]);
        expect(projectOccurrences({ nextServiceDate: today, intervalDays: 7 }, inDays(10), today)).toEqual([]);
    });
});
