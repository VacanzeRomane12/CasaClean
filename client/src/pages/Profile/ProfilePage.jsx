import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  User,
  Mail,
  IdCard,
  ShieldCheck,
  CalendarDays,
  CalendarClock,
  CreditCard,
  LogOut,
  LayoutDashboard,
  CheckCircle2,
  AlertCircle,
  CalendarCheck,
  Clock,
  Lock,
  Sparkles,
  XCircle,
  Star,
} from "lucide-react";
import { Page } from "@/components/shared/Page";
import { Container } from "@/components/ui/Container";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { PhoneInput } from "@/components/ui/PhoneInput";
import { Textarea } from "@/components/ui/Textarea";
import { Badge } from "@/components/ui/Badge";
import { Pagination } from "@/components/ui/Pagination";
import { Spinner } from "@/components/ui/Spinner";
import { Modal } from "@/components/ui/Modal";
import { useAuth } from "@/features/admin/context/AuthContext";
import { BOOKING_STATUS_META } from "@/features/admin/constants";
import { updateProfile } from "@/features/auth/api/authApi";
import { AccountSecurity, BillingProfile } from "@/features/auth";
import {
  getMyBookings,
  cancelMyBooking,
  getMyReviews,
  createBookingReview,
  MySubscriptions,
} from "@/features/booking";
import { useCities } from "@/features/booking/hooks/useCities";
import { SavedCards } from "@/features/booking/components/SavedCards";
import { useServices } from "@/features/services";
import { Seo } from "@/seo";
import { useTranslation } from "@/i18n";
import { ROUTES } from "@/constants/routes";
import { cn } from "@/lib/cn";
import { localDateFromDateString } from "@/features/booking/utils/recurrence";

/*
 * ProfilePage
 * -----------
 * The signed-in user's account home. The route is wrapped in <RequireAuth>, so
 * this only ever renders for a real, registered user.
 *
 * The account grew far more than two columns can carry (details, bookings,
 * subscriptions, cards, billing, security), so the page is split into sections
 * driven by one nav: a sticky rail on desktop, a horizontally scrollable pill
 * row on small screens. Only the active section mounts — each one gets the full
 * content width instead of being squeezed into a sidebar, and the queries behind
 * the hidden sections don't run until they're opened.
 *
 * The active section is mirrored in the URL hash so sections are linkable, and
 * so the existing in-page anchors keep working: MySubscriptions links to
 * "#saved-cards", which now lives in another section — HASH_ALIASES maps such an
 * anchor onto the section that owns it before scrolling to it.
 */

const SECTIONS = [
  { id: "account", icon: User, labelKey: "profile.nav.account" },
  { id: "bookings", icon: CalendarCheck, labelKey: "profile.nav.bookings" },
  { id: "subscriptions", icon: CalendarClock, labelKey: "profile.nav.subscriptions" },
  { id: "billing", icon: CreditCard, labelKey: "profile.nav.billing" },
  { id: "security", icon: Lock, labelKey: "profile.nav.security" },
];

const SECTION_IDS = SECTIONS.map((s) => s.id);

// Anchors that live inside a section rather than being one.
const HASH_ALIASES = { "saved-cards": "billing" };

// Booking history pages rather than rendering a customer's whole record at once.
const HISTORY_PAGE_SIZE = 10;

const sectionForHash = (hash) => {
  const raw = hash.replace(/^#/, "");
  if (!raw) return null;
  return SECTION_IDS.includes(raw) ? raw : HASH_ALIASES[raw] || null;
};

/* One nav, two shapes: a scroll-snapping pill row until `lg`, a sticky vertical
   rail from `lg` up. Same markup, so the active section survives a resize. */
const SectionNav = ({ sections, active, onSelect, t }) => (
  /* `min-w-0` is load-bearing, not defensive. The pill row below is a row of
     `shrink-0`, `whitespace-nowrap` items, so its min-content width is the sum
     of all five pills (~780px) — and `overflow-x-auto` does NOT reduce that for
     a block box, it only allows scrolling once the box is narrower. Without
     `min-w-0` that min-content becomes the grid TRACK's floor, and because the
     layout is a single-column grid below `lg`, the content column shares the
     same track: every section card gets stretched to ~740px inside a phone
     viewport and the whole page scrolls sideways. */
  <nav aria-label={t("profile.title")} className="min-w-0 lg:sticky lg:top-28">
    {/* The negative margin must match the Container's gutter at every width it
        applies to, or the row either clips its first pill or overflows the page. */}
    <ul
      className="scrollbar-none -mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-2
                 xs:-mx-5 xs:px-5
                 sm:-mx-6 sm:px-6
                 lg:mx-0 lg:flex-col lg:gap-1 lg:overflow-visible lg:px-0 lg:pb-0"
    >
      {sections.map(({ id, icon: Icon, labelKey, badge }) => {
        const isActive = id === active;
        return (
          <li key={id} className="shrink-0 snap-start lg:shrink lg:snap-align-none">
            <button
              type="button"
              onClick={() => onSelect(id)}
              aria-current={isActive ? "true" : undefined}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-full border px-4 py-2.5 text-body-sm font-semibold transition-colors lg:rounded-2xl",
                isActive
                  ? "border-brand-200 bg-brand-50 text-brand-700"
                  : "border-transparent text-ink-500 hover:bg-ink-100 hover:text-ink-900"
              )}
            >
              <Icon className="size-4.5 shrink-0" aria-hidden="true" />
              <span className="whitespace-nowrap">{t(labelKey)}</span>
              {badge ? (
                <span
                  className={cn(
                    "ml-auto hidden rounded-full px-2 py-0.5 text-caption font-semibold lg:inline-block",
                    isActive ? "bg-brand-100 text-brand-700" : "bg-ink-100 text-ink-500"
                  )}
                >
                  {badge}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  </nav>
);

const initials = (name = "") =>
  name
    .split(" ")
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase() || "U";

const fmtDate = (value, locale) => {
  const calendarDate = localDateFromDateString(value);
  const isCalendarDate = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const timestamp = !calendarDate && !isCalendarDate && value ? Date.parse(value) : Number.NaN;
  const date = calendarDate || (!Number.isNaN(timestamp) ? new Date(timestamp) : null);

  return date
    ? date.toLocaleDateString(locale === "ka" ? "ka-GE" : locale, {
        day: "2-digit",
        month: "long",
        year: "numeric",
      })
    : "—";
};

const eur = (n) =>
  new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(
    Number(n) || 0
  );

// Cancelling this close to the appointment keeps a fee worth one hour of the
// booked cleaning (server: utils/cancellation.util.js, CANCELLATION_WINDOW_HOURS
// — the deployable default, which is also what the FAQ quotes). Used only to
// warn BEFORE the customer confirms; the server decides the money either way and
// its response reports exactly what happened.
const CANCELLATION_WINDOW_HOURS = 24;

const isLateCancellation = ({ booking_date: date, booking_time: time }) => {
  const startsAt = localDateFromDateString(date);
  if (!startsAt) return false;

  const [hour, minute] = String(time || "00:00").split(":").map(Number);
  startsAt.setHours(Number.isFinite(hour) ? hour : 0, Number.isFinite(minute) ? minute : 0, 0, 0);
  return startsAt.getTime() - Date.now() < CANCELLATION_WINDOW_HOURS * 60 * 60 * 1000;
};

// A booking can only be cancelled by the customer while it's still upcoming.
// Completed/cancelled bookings are terminal (matches the server-side guard).
const isCancellable = (status) => status === "pending" || status === "confirmed";

// Read-only five-star score (filled up to `value`).
const Stars = ({ value, className }) => (
  <span className={cn("inline-flex items-center gap-0.5", className)}>
    {[1, 2, 3, 4, 5].map((n) => (
      <Star
        key={n}
        aria-hidden="true"
        className={cn(
          "size-4",
          n <= value ? "fill-amber-400 text-amber-400" : "fill-none text-ink-300"
        )}
      />
    ))}
  </span>
);

const ProfilePage = () => {
  const { t, locale } = useTranslation();
  const { user, isAdmin, updateUser, logout } = useAuth();

  const [form, setForm] = useState({
    fullname: user?.fullname || "",
    phone: user?.phone || "",
    personalId: user?.personalId || "",
  });
  const [status, setStatus] = useState("idle"); // idle | saving | saved | error
  const [errorMsg, setErrorMsg] = useState("");

  // Which section is open. Seeded from the hash so a link like /profile#billing
  // (or an in-page "#saved-cards" anchor) opens the right one on first paint.
  const [section, setSection] = useState(
    () => sectionForHash(window.location.hash) || "account"
  );

  useEffect(() => {
    // Fragment links are handled by the browser, not the router, so listen to
    // the DOM event. The target only exists once its section has rendered —
    // hence the deferred scroll rather than relying on the native jump.
    const syncFromHash = () => {
      const raw = window.location.hash.replace(/^#/, "");
      const next = sectionForHash(raw);
      if (!next) return;
      setSection(next);
      requestAnimationFrame(() => {
        document.getElementById(raw)?.scrollIntoView({ block: "start", behavior: "smooth" });
      });
    };
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  // Nav clicks keep the hash in step (replaceState, so no history spam and no
  // hashchange echo back into the listener above).
  const openSection = (id) => {
    setSection(id);
    window.history.replaceState(null, "", `#${id}`);
  };

  // Booking history for the signed-in user — straight from the database.
  const { data: bookings = [], isLoading: bookingsLoading } = useQuery({
    queryKey: ["my-bookings", user?.email],
    queryFn: getMyBookings,
    enabled: Boolean(user),
  });

  // Self-cancel flow: confirm in a modal, then PATCH /booking/:id/cancel and
  // refresh the history so the status flips to "cancelled" in place.
  const queryClient = useQueryClient();
  const [cancelTarget, setCancelTarget] = useState(null);
  const cancelMutation = useMutation({
    mutationFn: (id) => cancelMyBooking(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["my-bookings"] });
      setCancelTarget(null);
    },
  });

  // The user's own reviews → a bookingId → review map, so each completed
  // booking shows either its rating or a "Rate" action (one review per booking).
  const { data: myReviews = [] } = useQuery({
    queryKey: ["my-reviews", user?.email],
    queryFn: getMyReviews,
    enabled: Boolean(user),
  });
  const reviewByBooking = useMemo(
    () => Object.fromEntries(myReviews.map((r) => [String(r.booking_id), r])),
    [myReviews]
  );

  // Rate flow: open a modal for a completed booking, pick stars + comment, then
  // POST /review/booking/:id and refresh so the row shows the new rating.
  const [rateTarget, setRateTarget] = useState(null);
  const [rateValue, setRateValue] = useState(0);
  const [rateHover, setRateHover] = useState(0);
  const [rateComment, setRateComment] = useState("");

  const resetRate = () => {
    setRateTarget(null);
    setRateValue(0);
    setRateHover(0);
    setRateComment("");
  };

  const reviewMutation = useMutation({
    mutationFn: ({ id, rating, comment }) =>
      createBookingReview(id, { rating, comment }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["my-reviews"] });
      resetRate();
    },
  });

  const openRate = (booking) => {
    setRateTarget(booking);
    setRateValue(0);
    setRateHover(0);
    setRateComment("");
  };

  // Bookings store the service/city id only, so resolve display names from the
  // live catalogues (same source the booking wizard offers).
  const { services } = useServices();
  const { data: cities = [] } = useCities();
  const serviceNameById = useMemo(
    () => Object.fromEntries(services.map((s) => [String(s.id), s.name])),
    [services]
  );
  const cityNameById = useMemo(
    () => Object.fromEntries(cities.map((c) => [String(c.id), c.name])),
    [cities]
  );
  const history = useMemo(
    () =>
      bookings.map((b) => ({
        ...b,
        service_name: serviceNameById[String(b.service_id)] || "Service",
        city_name: cityNameById[String(b.city_id)] || "",
      })),
    [bookings, serviceNameById, cityNameById]
  );

  /*
   * A long-standing customer's history runs to hundreds of bookings, and every
   * row carries a badge, a date and two buttons. Rendering all of it built a
   * very large subtree for a section most visits scroll past, so it pages —
   * `historyPage` resets whenever the underlying list changes so a cancellation
   * can't strand the reader on a page that no longer exists.
   */
  const [historyPage, setHistoryPage] = useState(1);
  const historyPages = Math.max(1, Math.ceil(history.length / HISTORY_PAGE_SIZE));
  const safeHistoryPage = Math.min(historyPage, historyPages);
  const historyRows = useMemo(
    () =>
      history.slice(
        (safeHistoryPage - 1) * HISTORY_PAGE_SIZE,
        safeHistoryPage * HISTORY_PAGE_SIZE
      ),
    [history, safeHistoryPage]
  );

  // The booking count rides on the nav so the section is worth opening — the
  // history query runs page-wide, the rest only mount with their section.
  const navSections = useMemo(
    () =>
      SECTIONS.map((s) =>
        s.id === "bookings" && history.length ? { ...s, badge: history.length } : s
      ),
    [history.length]
  );

  if (!user) return null;

  const dirty =
    form.fullname !== (user.fullname || "") ||
    form.phone !== (user.phone || "") ||
    form.personalId !== (user.personalId || "");

  // PhoneInput hands back a value, not an event (it drives two controls), so the
  // setter is split from the event adapter the plain inputs use.
  const onChangeValue = (key, value) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (status !== "idle") setStatus("idle");
  };

  const onChange = (key) => (e) => onChangeValue(key, e.target.value);

  const onSubmit = async (e) => {
    e.preventDefault();
    setStatus("saving");
    setErrorMsg("");
    try {
      const res = await updateProfile({
        fullname: form.fullname.trim(),
        // "" is sent deliberately: it clears the stored number.
        phone: form.phone.trim(),
        // Same semantics as the phone.
        personalId: form.personalId.trim(),
      });
      const updated = res?.user ?? res ?? form;
      // A cleared number comes back absent, so fall back to "" rather than
      // leaving the previous value in the auth context.
      updateUser({
        fullname: updated.fullname,
        phone: updated.phone ?? "",
        personalId: updated.personalId ?? "",
      });
      // The server normalises the ID (uppercase, no separators); show what it
      // stored rather than what was typed.
      setForm((f) => ({ ...f, personalId: updated.personalId ?? "" }));
      setStatus("saved");
    } catch (err) {
      setErrorMsg(err?.message || t("auth.errors.generic"));
      setStatus("error");
    }
  };

  return (
    <Page>
      <Seo title={`${t("profile.title")} · CasaClean`} path={ROUTES.profile} noIndex />

      <section className="bg-sand-50 pb-16 pt-28 lg:pt-32">
        <Container size="lg">
          {/* Identity header — the one thing every section shares, so the
              account-wide actions (admin console, sign out) live here rather
              than at the bottom of a column the user has to scroll to. */}
          <Card className="p-4 xs:p-5 sm:p-6">
            {/* Identity and actions only share a row from `md`: at 640px the two
                buttons squeeze the name into a two-line wrap. */}
            <div className="flex flex-col gap-5 md:flex-row md:items-center">
              {/*
               * The avatar comes straight off the name's column, and it is the
               * name and the email that have to stay readable — an address
               * broken into four fragments reads as the wrong account being
               * signed in. Beside the name wherever the card can carry both
               * (from 320px, which covers every mainstream phone); on anything
               * narrower it moves above and the block centres, giving the text
               * the card's full width instead of 60% of it.
               */}
              <div className="flex min-w-0 flex-1 flex-col items-center gap-3 text-center 2xs:flex-row 2xs:gap-4 2xs:text-left sm:gap-5">
                {user.avatar ? (
                  <img
                    src={user.avatar}
                    alt={user.fullname}
                    referrerPolicy="no-referrer"
                    className="size-14 shrink-0 rounded-3xl object-cover shadow-soft sm:size-20"
                  />
                ) : (
                  <span className="grid size-14 shrink-0 place-items-center rounded-3xl bg-brand-600 text-heading-sm font-bold text-white shadow-soft sm:size-20 sm:text-heading-md">
                    {initials(user.fullname)}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <h1 className="wrap-break-word text-heading-md text-ink-900 sm:text-heading-lg">
                    {user.fullname}
                  </h1>
                  {/* Wrapped, not truncated: a hidden half of your own address
                      reads as the wrong account being signed in. */}
                  <p className="mt-1 wrap-break-word text-body-md text-ink-500">
                    {user.email}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-2 2xs:justify-start">
                    <Badge variant={isAdmin ? "dark" : "neutral"} size="sm">
                      {user.role}
                    </Badge>
                    {user.isVerified ? (
                      <Badge variant="success" size="sm" icon={ShieldCheck}>
                        {t("profile.verified")}
                      </Badge>
                    ) : (
                      <Badge variant="outline" size="sm">
                        {t("profile.unverified")}
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
              {/* Full width and stacked on a phone — side by side they either
                  wrap their labels or leave a ragged half-row, and a full-width
                  target is the better tap anyway. Natural widths from `xs`. */}
              <div className="flex flex-col gap-2 xs:flex-row xs:flex-wrap xs:items-center md:shrink-0">
                {isAdmin && (
                  <Button
                    to={ROUTES.admin.dashboard}
                    variant="outline"
                    size="sm"
                    leftIcon={LayoutDashboard}
                    className="w-full xs:w-auto"
                  >
                    {t("profile.adminConsole")}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={LogOut}
                  onClick={logout}
                  className="w-full text-red-600 hover:bg-red-500/10 hover:text-red-700 xs:w-auto dark:text-red-400 dark:hover:bg-red-500/15 dark:hover:text-red-300"
                >
                  {t("common.signOut")}
                </Button>
              </div>
            </div>
          </Card>

          {/* Nav + the active section. `minmax(0,1fr)` keeps the content column
              from being widened past the grid by long, unbreakable strings. */}
          <div className="mt-8 grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start lg:gap-8">
            <SectionNav
              sections={navSections}
              active={section}
              onSelect={openSection}
              t={t}
            />

            <div className="min-w-0">
              {section === "account" && (
                <div id="account" className="grid gap-6 xl:grid-cols-2 xl:items-start">
                  {/* Personal information (editable) */}
                  <Card className="p-4 xs:p-5 sm:p-6">
                    <h2 className="text-heading-sm text-ink-900">
                      {t("profile.personalInfo")}
                    </h2>

                    <form onSubmit={onSubmit} className="mt-6 space-y-5">
                      <Input
                        label={t("common.fullName")}
                        leftIcon={User}
                        value={form.fullname}
                        onChange={onChange("fullname")}
                        required
                      />
                      <Input
                        label={t("common.email")}
                        type="email"
                        leftIcon={Mail}
                        value={user.email}
                        disabled
                        hint={t("profile.emailHint")}
                      />
                      {/* Optional on the account: an empty value clears the
                          stored number, and the booking wizard asks for one
                          when a crew actually has to ring a doorbell. */}
                      <PhoneInput
                        label={`${t("common.phone")} (${t("common.optional")})`}
                        countryLabel={t("common.countryCode")}
                        value={form.phone}
                        onChange={(next) => onChangeValue("phone", next)}
                        placeholder={t("profile.phonePlaceholder")}
                        hint={t("profile.phoneHint")}
                      />
                      {/* Same posture as the phone: optional here, required by
                          the booking wizard, which pre-fills it from the profile. */}
                      <Input
                        label={`${t("profile.personalId")} (${t("common.optional")})`}
                        leftIcon={IdCard}
                        value={form.personalId}
                        onChange={onChange("personalId")}
                        placeholder={t("profile.personalIdPlaceholder")}
                        hint={t("profile.personalIdHint")}
                        autoComplete="off"
                        autoCapitalize="characters"
                      />

                      {status === "saved" && (
                        <div className="flex items-center gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-body-sm text-emerald-700">
                          <CheckCircle2 className="size-4.5 shrink-0" />
                          {t("profile.saved")}
                        </div>
                      )}
                      {status === "error" && (
                        <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3.5 text-body-sm text-red-700">
                          <AlertCircle className="mt-0.5 size-4.5 shrink-0" />
                          {errorMsg}
                        </div>
                      )}

                      <Button
                        type="submit"
                        size="md"
                        loading={status === "saving"}
                        disabled={!dirty}
                      >
                        {t("profile.save")}
                      </Button>
                    </form>
                  </Card>

                  {/* Account metadata (read-only) */}
                  <Card className="p-4 xs:p-5 sm:p-6">
                    <h2 className="text-heading-sm text-ink-900">
                      {t("profile.account")}
                    </h2>
                    <dl className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
                      <div className="flex items-center gap-3">
                        <CalendarDays className="size-5 shrink-0 text-ink-400" />
                        <div className="min-w-0">
                          <dt className="text-caption text-ink-400">
                            {t("profile.memberSince")}
                          </dt>
                          <dd className="text-body-sm font-medium text-ink-800">
                            {fmtDate(user.createdAt, locale)}
                          </dd>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <ShieldCheck className="size-5 shrink-0 text-ink-400" />
                        <div className="min-w-0">
                          <dt className="text-caption text-ink-400">
                            {t("profile.role")}
                          </dt>
                          <dd className="text-body-sm font-medium capitalize text-ink-800">
                            {user.role}
                          </dd>
                        </div>
                      </div>
                    </dl>
                  </Card>
                </div>
              )}

              {/* Booking history */}
              {section === "bookings" && (
                <Card id="bookings" className="p-4 xs:p-5 sm:p-6">
                  <div className="flex items-center gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
                      <CalendarCheck className="size-5" />
                    </span>
                    <div className="min-w-0">
                      <h2 className="text-heading-sm text-ink-900">
                        {t("profile.bookingHistory")}
                      </h2>
                      <p className="text-body-sm text-ink-500">
                        {t("profile.bookingHistorySubtitle")}
                      </p>
                    </div>
                  </div>

                  <div className="mt-6">
                    {bookingsLoading ? (
                      <div className="flex items-center justify-center py-10">
                        <Spinner size="lg" />
                      </div>
                    ) : history.length === 0 ? (
                      <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-ink-200 px-4 py-12 text-center">
                        <span className="grid size-12 place-items-center rounded-2xl bg-ink-50 text-ink-400">
                          <Sparkles className="size-6" />
                        </span>
                        <div>
                          <p className="text-body-md font-semibold text-ink-900">
                            {t("profile.noBookings")}
                          </p>
                          <p className="mt-1 text-body-sm text-ink-500">
                            {t("profile.noBookingsHint")}
                          </p>
                        </div>
                        <Button to={ROUTES.booking} size="sm" className="mt-1">
                          {t("profile.bookNow")}
                        </Button>
                      </div>
                    ) : (
                      <>
                      <ul className="divide-y divide-ink-100">
                        {historyRows.map((b) => {
                          const meta = BOOKING_STATUS_META[b.status];
                          return (
                            <li
                              key={b._id || b.reference}
                              className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 md:flex-row md:items-center md:gap-4"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="min-w-0 truncate font-semibold text-ink-900">
                                    {b.service_name}
                                  </p>
                                  {meta && (
                                    <Badge variant={meta.variant} size="sm">
                                      {t(meta.labelKey)}
                                    </Badge>
                                  )}
                                </div>
                                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-400">
                                  <span className="inline-flex items-center gap-1">
                                    <CalendarDays className="size-3.5" />
                                    {fmtDate(b.booking_date, locale)}
                                  </span>
                                  {b.booking_time && (
                                    <span className="inline-flex items-center gap-1">
                                      <Clock className="size-3.5" />
                                      {b.booking_time}
                                    </span>
                                  )}
                                  <span>{b.city_name}</span>
                                  {b.reference && (
                                    <span className="font-medium text-ink-500">
                                      {b.reference}
                                    </span>
                                  )}
                                </p>
                              </div>
                              {/* Price and actions share a row of their own on
                                  phones and tablets (spread apart), and rejoin the
                                  entry once the row is wide enough to hold the
                                  service name, the meta line and both actions. */}
                              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 md:shrink-0 md:justify-end">
                                <span className="text-body-md font-bold text-ink-900">
                                  {eur(b.total_amount)}
                                </span>
                                <span className="flex flex-wrap items-center gap-2">
                                  {isCancellable(b.status) && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      leftIcon={XCircle}
                                      onClick={() => setCancelTarget(b)}
                                      className="text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-500/15 dark:hover:text-red-300"
                                    >
                                      {t("profile.cancelBooking")}
                                    </Button>
                                  )}
                                  {b.status === "completed" &&
                                    (reviewByBooking[b._id] ? (
                                      <span
                                        className="inline-flex items-center gap-1.5"
                                        title={reviewByBooking[b._id].comment}
                                      >
                                        <Stars value={reviewByBooking[b._id].rating} />
                                        <span className="text-caption font-medium text-ink-400">
                                          {t("profile.yourRating")}
                                        </span>
                                      </span>
                                    ) : (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        leftIcon={Star}
                                        onClick={() => openRate(b)}
                                      >
                                        {t("profile.rate")}
                                      </Button>
                                    ))}
                                </span>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                      <Pagination
                        page={safeHistoryPage}
                        total={historyPages}
                        onChange={setHistoryPage}
                        className="mt-5"
                      />
                      </>
                    )}
                  </div>
                </Card>
              )}

              {/* Recurring services */}
              {section === "subscriptions" && (
                <div id="subscriptions">
                  <MySubscriptions />
                </div>
              )}

              {/* Money settings: the cards that get charged, then how the
                  charge is billed. A paused subscription links straight to
                  "#saved-cards" above, which opens this section. */}
              {section === "billing" && (
                <div id="billing" className="space-y-6">
                  {/* Hidden when Stripe isn't configured */}
                  <SavedCards />
                  {/* Bill as a company: a verified VAT number removes VAT from
                      the charge. Keyed on the account so its form seeds itself
                      once the session resolves. */}
                  <BillingProfile key={user?._id ?? "anon"} />
                </div>
              )}

              {/* Change password / delete account */}
              {section === "security" && (
                <div id="security">
                  <AccountSecurity />
                </div>
              )}
            </div>
          </div>
        </Container>
      </section>

      {/* Cancel confirmation */}
      <Modal
        open={Boolean(cancelTarget)}
        onClose={() => !cancelMutation.isPending && setCancelTarget(null)}
        title={t("profile.cancelTitle")}
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setCancelTarget(null)}
              disabled={cancelMutation.isPending}
            >
              {t("profile.keepBooking")}
            </Button>
            <Button
              onClick={() => cancelMutation.mutate(cancelTarget._id)}
              loading={cancelMutation.isPending}
              className="bg-red-600 hover:bg-red-700"
            >
              {t("profile.cancelConfirm")}
            </Button>
          </>
        }
      >
        {cancelTarget && (
          <p className="text-body-sm text-ink-600">
            {t("profile.cancelBody", {
              service: cancelTarget.service_name,
              date: fmtDate(cancelTarget.booking_date, locale),
            })}
          </p>
        )}
        {/* Money is about to be kept — say so before they confirm, not after. */}
        {cancelTarget && isLateCancellation(cancelTarget) && (
          <p className="mt-3 text-body-sm text-amber-700">
            {t("profile.cancelFeeWarning", { hours: CANCELLATION_WINDOW_HOURS })}
          </p>
        )}
        {cancelMutation.isError && (
          <p className="mt-3 text-body-sm text-red-600">
            {t("profile.cancelError")}
          </p>
        )}
      </Modal>

      {/* Rate a completed booking */}
      <Modal
        open={Boolean(rateTarget)}
        onClose={() => !reviewMutation.isPending && resetRate()}
        title={t("profile.rateTitle")}
        size="md"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={resetRate}
              disabled={reviewMutation.isPending}
            >
              {t("admin.form.cancel")}
            </Button>
            <Button
              onClick={() =>
                reviewMutation.mutate({
                  id: rateTarget._id,
                  rating: rateValue,
                  comment: rateComment.trim(),
                })
              }
              loading={reviewMutation.isPending}
              disabled={rateValue < 1 || !rateComment.trim()}
            >
              {t("profile.submitReview")}
            </Button>
          </>
        }
      >
        {rateTarget && (
          <div className="space-y-5">
            <p className="text-body-sm text-ink-600">
              {t("profile.rateSubtitle", {
                service: rateTarget.service_name,
                date: fmtDate(rateTarget.booking_date, locale),
              })}
            </p>

            <div>
              <label className="mb-1.5 block text-body-sm font-semibold text-ink-800">
                {t("profile.ratingLabel")}
              </label>
              {/* Five 32px stars plus their padding come to 216px — wider than
                  this dialog on a 200px screen, and a rating control that has to
                  be scrolled to reach the fifth star is not a rating control. A
                  size down below `xs` keeps all five reachable and each of them
                  still a 40px tap target. */}
              <div className="flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    type="button"
                    key={n}
                    onMouseEnter={() => setRateHover(n)}
                    onMouseLeave={() => setRateHover(0)}
                    onClick={() => setRateValue(n)}
                    aria-label={t("profile.rateStars", { count: n })}
                    aria-pressed={rateValue === n}
                    className="rounded-md p-1 transition-transform hover:scale-110"
                  >
                    <Star
                      className={cn(
                        "size-6 transition-colors xs:size-8",
                        (rateHover || rateValue) >= n
                          ? "fill-amber-400 text-amber-400"
                          : "fill-none text-ink-300"
                      )}
                    />
                  </button>
                ))}
              </div>
            </div>

            <Textarea
              label={t("profile.commentLabel")}
              rows={4}
              maxLength={500}
              value={rateComment}
              onChange={(e) => setRateComment(e.target.value)}
              placeholder={t("profile.commentPlaceholder")}
              required
            />

            {reviewMutation.isError && (
              <p className="text-body-sm text-red-600">
                {reviewMutation.error?.message || t("profile.reviewError")}
              </p>
            )}
          </div>
        )}
      </Modal>
    </Page>
  );
};

export default ProfilePage;
