import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CalendarDays, ChevronLeft, ChevronRight, Repeat } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Select } from "@/components/ui/Select";
import { Modal } from "@/components/ui/Modal";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  PageHeader,
  BOOKING_STATUS_META,
  PAYMENT_STATUS_META,
  PROJECTED_STATUS,
  PROJECTED_STATUS_META,
  STATUS_COLORS,
  mergeBookingsWithOccurrences,
  useCollection,
} from "@/features/admin";
import { subscriptionApi } from "@/features/admin/api/adminApi";
import { useTranslation } from "@/i18n";
import { formatDuration } from "@/features/booking";
import { intervalLabel } from "@/features/booking/utils/recurrence";
import { ROUTES } from "@/constants/routes";
import { cn } from "@/lib/cn";

/*
 * Bookings calendar
 * -----------------
 * A month-grid view of every booking, placed on its bookingDate. Each entry is
 * a colour-coded chip (same STATUS_COLORS as the bookings map); clicking a chip
 * opens the booking detail, and crowded days expose a "+N" day list. The grid
 * is Monday-first (European market) and all labels come from Intl so every
 * supported locale renders its own month/weekday names.
 *
 * Two sources feed the grid. Real bookings come from the shared bookings
 * collection (one-off visits and the charged cycles of recurring plans). The
 * FUTURE visits of a recurring plan exist nowhere as documents — a cycle's
 * booking is created only when it is charged, the day before — so for the
 * visible range the page also asks GET /subscription/occurrences, which
 * projects them from each active plan's rule. Those render as dashed
 * "scheduled" chips and are merged with a per-plan-per-day guard so a visit is
 * never shown twice (features/admin/utils/calendarOccurrences.js).
 */

const eur = (n) =>
  new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(
    n || 0
  );

// Local (not UTC) YYYY-MM-DD key, matching the string the API stores in
// bookingDate — grouping and lookup both go through this.
const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;

/** Build the visible cells for a month: full Monday-first weeks, padded with
 * leading/trailing days from the adjacent months. */
function buildMonthCells(year, month) {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // days shown before the 1st
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const total = Math.ceil((lead + daysInMonth) / 7) * 7;
  return Array.from({ length: total }, (_, i) => {
    const date = new Date(year, month, i - lead + 1);
    return { date, key: dayKey(date), inMonth: date.getMonth() === month };
  });
}

/* Stacks below `xs` so a long value gets the whole dialog width instead of
   overflowing it — see BookingsPage's twin. */
function DetailRow({ label, value }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-ink-100 py-2.5 last:border-0 xs:flex-row xs:justify-between xs:gap-4">
      <span className="shrink-0 text-body-sm text-ink-400">{label}</span>
      <span className="min-w-0 wrap-break-word text-body-sm font-medium text-ink-800 xs:text-right">
        {value || "—"}
      </span>
    </div>
  );
}

/** One booking entry inside a day cell or the day modal. A projected visit of
 * a recurring plan is drawn dashed, with a repeat mark, so it reads as "coming"
 * rather than "booked". */
function BookingChip({ booking, onClick, detailed, projectedLabel }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={booking.projected ? projectedLabel : undefined}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-caption font-medium text-ink-700 transition-colors hover:bg-ink-100",
        detailed && "gap-2.5 rounded-xl px-3 py-2.5 text-body-sm",
        booking.projected && "border border-dashed border-ink-300 text-ink-600"
      )}
    >
      <span
        className={cn("size-2 shrink-0 rounded-full", detailed && "size-2.5")}
        style={{ backgroundColor: STATUS_COLORS[booking.status] || STATUS_COLORS.pending }}
        aria-hidden="true"
      />
      <span className="shrink-0 tabular-nums text-ink-500">{booking.booking_time}</span>
      <span className="truncate">{booking.customer_name}</span>
      {booking.projected && (
        <Repeat className="size-3 shrink-0 text-ink-400" aria-label={projectedLabel} />
      )}
      {detailed && (
        <span className="ml-auto shrink-0 text-body-sm text-ink-400">{booking.service_name}</span>
      )}
    </button>
  );
}

const MAX_CHIPS = 3;

/*
 * How many placeholder chips a day cell shows while the bookings load. The grid
 * itself is real (the dates are known offline) — only its contents are pending —
 * so an uneven, date-derived pattern reads as "a month with bookings in it"
 * rather than a uniform stripe across every cell.
 */
const skeletonChips = (date) => [0, 1, 2, 1, 0, 2, 1][date.getDate() % 7];

export default function CalendarPage() {
  const { items, loading: bookingsLoading } = useCollection("bookings");
  // The chips print service and city names, so the grid waits on the catalogues
  // as well — same reasoning as the Bookings table.
  const { items: cities, loading: citiesLoading } = useCollection("cities");
  const { items: services, loading: servicesLoading } = useCollection("services");
  const loading = bookingsLoading || citiesLoading || servicesLoading;
  const { t, locale } = useTranslation();

  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [statusFilter, setStatusFilter] = useState("");
  const [dayOpen, setDayOpen] = useState(null); // day key whose full list is open
  const [viewing, setViewing] = useState(null);

  const cells = useMemo(
    () => buildMonthCells(cursor.year, cursor.month),
    [cursor]
  );

  // Projected recurring visits for exactly the visible grid (padding days
  // included). Re-fetched per month and kept briefly fresh so a plan paused or
  // cancelled elsewhere disappears on the next navigation. A failure here
  // leaves the real bookings untouched — the grid never goes blank because the
  // projection could not be loaded.
  const range = { from: cells[0].key, to: cells[cells.length - 1].key };
  const occurrencesQuery = useQuery({
    queryKey: ["admin", "occurrences", range.from, range.to],
    queryFn: () => subscriptionApi.occurrences(range),
    staleTime: 30_000,
    retry: 1,
  });
  const occurrences = useMemo(() => occurrencesQuery.data ?? [], [occurrencesQuery.data]);

  // Resolve service/city ids to names, same as the Bookings page.
  const cityNameById = useMemo(
    () => Object.fromEntries(cities.map((c) => [String(c._id), c.name])),
    [cities]
  );
  const serviceNameById = useMemo(
    () => Object.fromEntries(services.map((s) => [String(s._id), s.name])),
    [services]
  );

  const statusOptions = useMemo(
    () => [
      ...Object.keys(BOOKING_STATUS_META).map((value) => ({
        value,
        label: t(BOOKING_STATUS_META[value].labelKey),
      })),
      { value: PROJECTED_STATUS, label: t(PROJECTED_STATUS_META.labelKey) },
    ],
    [t]
  );

  // bookingDate is stored as a "YYYY-MM-DD" string, so bookings group straight
  // onto the cell keys with no timezone maths. Real bookings and projected
  // visits are merged first so a charged cycle is never doubled by its own
  // projection.
  const bookingsByDay = useMemo(() => {
    const map = {};
    for (const b of mergeBookingsWithOccurrences(items, occurrences)) {
      if (statusFilter && b.status !== statusFilter) continue;
      if (!b.booking_date) continue;
      (map[b.booking_date] ??= []).push({
        ...b,
        service_name: serviceNameById[String(b.service_id)] || b.service_name,
        city_name: cityNameById[String(b.city_id)] || b.city_name,
      });
    }
    for (const list of Object.values(map)) {
      list.sort((a, b) => String(a.booking_time).localeCompare(String(b.booking_time)));
    }
    return map;
  }, [items, occurrences, statusFilter, serviceNameById, cityNameById]);

  const { monthCount, projectedCount } = useMemo(() => {
    let real = 0;
    let projected = 0;
    for (const c of cells) {
      if (!c.inMonth) continue;
      for (const b of bookingsByDay[c.key] || []) {
        if (b.projected) projected += 1;
        else real += 1;
      }
    }
    return { monthCount: real, projectedCount: projected };
  }, [cells, bookingsByDay]);

  // Locale-aware labels straight from Intl (codes in config.js are valid BCP47).
  const monthLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(
        new Date(cursor.year, cursor.month, 1)
      ),
    [locale, cursor]
  );
  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
    // 2024-01-01 was a Monday — walk one Monday-first week.
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
  }, [locale]);
  const longDate = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
    [locale]
  );

  const todayKey = dayKey(new Date());
  const goMonth = (delta) =>
    setCursor(({ year, month }) => {
      const d = new Date(year, month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  const goToday = () => {
    const now = new Date();
    setCursor({ year: now.getFullYear(), month: now.getMonth() });
  };

  const dayBookings = dayOpen ? bookingsByDay[dayOpen] || [] : [];
  const projectedLabel = t("admin.calendar.projected");

  return (
    <div className="space-y-8">
      <PageHeader
        icon={CalendarDays}
        title={t("admin.calendar.title")}
        description={t("admin.calendar.description")}
      />

      {/* Toolbar: month switcher + status filter */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {/* Two arrows plus a month name ("September 2026") is already wider than
            a 200px screen's content column, so the label may drop under them. */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("admin.calendar.prevMonth")}
            onClick={() => goMonth(-1)}
          >
            <ChevronLeft className="size-4.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("admin.calendar.nextMonth")}
            onClick={() => goMonth(1)}
          >
            <ChevronRight className="size-4.5" />
          </Button>
          <div className="min-w-0 xs:ml-1">
            <h2 className="wrap-break-word text-heading-sm font-bold capitalize text-ink-900">
              {monthLabel}
            </h2>
            {/* Live only while loading — otherwise it would re-announce the
                count on every month step. */}
            <p className="text-caption text-ink-400" role={loading ? "status" : undefined}>
              {loading
                ? t("admin.table.loading")
                : t("admin.calendar.monthCount", { count: monthCount })}
              {!loading && projectedCount > 0 && (
                <> · {t("admin.calendar.projectedCount", { count: projectedCount })}</>
              )}
            </p>
          </div>
        </div>
        {/* The filter is 160px from `xs` up; below that it shares whatever the
            row has left with "Today", or wraps onto its own line. */}
        <div className="flex flex-wrap items-center gap-2 *:flex-1 xs:*:flex-none">
          <Button variant="outline" size="sm" onClick={goToday}>
            {t("admin.calendar.today")}
          </Button>
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={[{ value: "", label: t("admin.bookings.allStatuses") }, ...statusOptions]}
            className="h-9 xs:min-w-40"
          />
        </div>
      </div>

      {occurrencesQuery.isError && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3.5 text-body-sm text-red-700"
        >
          <AlertCircle className="mt-0.5 size-4.5 shrink-0" />
          {t("admin.calendar.projectedError")}
        </div>
      )}

      {/* Month grid — scrolls horizontally on narrow screens instead of crushing */}
      <div className="overflow-x-auto rounded-2xl border border-ink-100 bg-surface">
        <div className="min-w-[52rem]">
          <div className="grid grid-cols-7 border-b border-ink-100">
            {weekdayLabels.map((label) => (
              <div
                key={label}
                className="px-2 py-2.5 text-center text-caption font-semibold uppercase tracking-wider text-ink-400"
              >
                {label}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map(({ date, key, inMonth }) => {
              const dayList = bookingsByDay[key] || [];
              const overflow = dayList.length - MAX_CHIPS;
              const isToday = key === todayKey;
              return (
                <div
                  key={key}
                  className={cn(
                    "min-h-28 border-b border-r border-ink-100 p-1.5 [&:nth-child(7n)]:border-r-0",
                    !inMonth && "bg-ink-100/40"
                  )}
                >
                  <span
                    className={cn(
                      "mb-1 grid size-6 place-items-center rounded-full text-caption font-semibold",
                      isToday
                        ? "bg-brand-600 text-white"
                        : inMonth
                          ? "text-ink-700"
                          : "text-ink-400"
                    )}
                  >
                    {date.getDate()}
                  </span>
                  <div className="space-y-0.5">
                    {loading &&
                      inMonth &&
                      Array.from({ length: skeletonChips(date) }).map((_, i) => (
                        // The wrapper reproduces a chip's own box (px-1.5 py-1
                        // around a caption line) so the cell heights match.
                        <div key={`skeleton-${i}`} className="px-1.5 py-1">
                          <Skeleton className="h-3 w-full" />
                        </div>
                      ))}
                    {!loading &&
                      dayList.slice(0, MAX_CHIPS).map((b) => (
                        <BookingChip
                          key={b._id}
                          booking={b}
                          projectedLabel={projectedLabel}
                          onClick={() => setViewing(b)}
                        />
                      ))}
                    {!loading && overflow > 0 && (
                      <button
                        type="button"
                        onClick={() => setDayOpen(key)}
                        className="w-full rounded-lg px-1.5 py-1 text-left text-caption font-semibold text-brand-600 transition-colors hover:bg-brand-50"
                      >
                        {t("admin.calendar.more", { count: overflow })}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Status legend (same colours as the bookings map, plus projected visits) */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {Object.entries(BOOKING_STATUS_META).map(([status, meta]) => (
          <span key={status} className="flex items-center gap-2 text-body-sm text-ink-600">
            <span
              className="size-2.5 rounded-full"
              style={{ backgroundColor: STATUS_COLORS[status] }}
              aria-hidden="true"
            />
            {t(meta.labelKey)}
          </span>
        ))}
        <span className="flex items-center gap-2 text-body-sm text-ink-600">
          <span
            className="size-2.5 rounded-full"
            style={{ backgroundColor: STATUS_COLORS[PROJECTED_STATUS] }}
            aria-hidden="true"
          />
          {t(PROJECTED_STATUS_META.labelKey)}
        </span>
      </div>

      {/* Full list for a crowded day */}
      <Modal
        open={Boolean(dayOpen)}
        onClose={() => setDayOpen(null)}
        title={dayOpen ? longDate.format(new Date(`${dayOpen}T00:00:00`)) : ""}
        description={dayOpen ? t("admin.calendar.dayCount", { count: dayBookings.length }) : ""}
      >
        <div className="space-y-1">
          {dayBookings.map((b) => (
            <BookingChip
              key={b._id}
              booking={b}
              detailed
              projectedLabel={projectedLabel}
              onClick={() => {
                setDayOpen(null);
                setViewing(b);
              }}
            />
          ))}
        </div>
      </Modal>

      {/* Booking detail — same layout as the Bookings page view dialog. A
          projected visit has no document, price or payment yet, so it shows the
          plan's cadence instead of the money badges. */}
      <Modal
        open={Boolean(viewing)}
        onClose={() => setViewing(null)}
        title={viewing?.projected ? projectedLabel : t("admin.bookings.detailsTitle")}
        description={viewing?.projected ? undefined : viewing?.reference}
        size="lg"
      >
        {viewing && (
          <div className="space-y-1">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <div className="flex flex-wrap items-center gap-2">
                {viewing.projected ? (
                  <Badge variant={PROJECTED_STATUS_META.variant}>
                    {t(PROJECTED_STATUS_META.labelKey)}
                  </Badge>
                ) : (
                  <>
                    <Badge variant={BOOKING_STATUS_META[viewing.status]?.variant}>
                      {BOOKING_STATUS_META[viewing.status] &&
                        t(BOOKING_STATUS_META[viewing.status].labelKey)}
                    </Badge>
                    {(() => {
                      const pm = PAYMENT_STATUS_META[viewing.payment_status] || PAYMENT_STATUS_META.unpaid;
                      return (
                        <Badge variant={pm.variant} size="sm">
                          {t(pm.labelKey)}
                        </Badge>
                      );
                    })()}
                  </>
                )}
              </div>
              {!viewing.projected && (
                <span className="text-heading-sm font-bold text-ink-900">
                  {eur(viewing.total_amount)}
                </span>
              )}
            </div>
            {viewing.projected && (
              <div className="mb-3 flex flex-col gap-2 rounded-xl bg-ink-50 p-3.5 text-body-sm text-ink-600 xs:flex-row xs:items-start xs:justify-between">
                <span className="flex items-start gap-2">
                  <Repeat className="mt-0.5 size-4 shrink-0 text-ink-400" aria-hidden="true" />
                  {t("admin.calendar.projectedHint", {
                    interval: intervalLabel(t, viewing.interval_days),
                  })}
                </span>
                <Link
                  to={ROUTES.admin.subscriptions}
                  className="shrink-0 font-semibold text-brand-600 hover:underline"
                >
                  {t("admin.calendar.openPlan")}
                </Link>
              </div>
            )}
            <DetailRow label={t("admin.bookings.detail.customer")} value={viewing.customer_name} />
            <DetailRow label={t("admin.bookings.detail.email")} value={viewing.customer_email} />
            <DetailRow label={t("admin.bookings.detail.phone")} value={viewing.customer_phone} />
            <DetailRow label={t("admin.bookings.detail.personalId")} value={viewing.customer_personal_id} />
            <DetailRow label={t("admin.bookings.detail.service")} value={viewing.service_name} />
            <DetailRow label={t("admin.bookings.detail.city")} value={viewing.city_name} />
            <DetailRow
              label={t("admin.bookings.detail.address")}
              value={[viewing.street_name, viewing.house_number].filter(Boolean).join(" ")}
            />
            <DetailRow
              label={t("admin.bookings.detail.dateTime")}
              value={`${viewing.booking_date} · ${viewing.booking_time}`}
            />
            <DetailRow
              label={t("admin.bookings.detail.hoursCleaners")}
              value={`${formatDuration(t, viewing.duration_minutes) || "—"} · ${viewing.cleaners || "—"}`}
            />
            {!viewing.projected && (
              <DetailRow
                label={t("admin.bookings.detail.workers")}
                value={viewing.worker_names?.length ? viewing.worker_names.join(", ") : "—"}
              />
            )}
            <DetailRow label={t("admin.bookings.detail.notes")} value={viewing.notes} />
          </div>
        )}
      </Modal>
    </div>
  );
}
