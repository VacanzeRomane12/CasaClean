import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Eye,
  PauseCircle,
  PlayCircle,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import {
  DataTable,
  PageHeader,
  SUBSCRIPTION_STATUS_META,
} from "@/features/admin";
import { subscriptionApi } from "@/features/admin/api/adminApi";
import {
  formatLocalDateString,
  formatTimestampDate,
  intervalLabel,
} from "@/features/booking/utils/recurrence";
import { useTranslation } from "@/i18n";

const DATE_OPTIONS = { day: "numeric", month: "short", year: "numeric" };

const eur = (value) =>
  new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(
    Number(value) || 0
  );

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

function StatusBadge({ status, t }) {
  const meta = SUBSCRIPTION_STATUS_META[status] || SUBSCRIPTION_STATUS_META.cancelled;
  return <Badge variant={meta.variant} size="sm">{t(meta.labelKey)}</Badge>;
}

function ChargeHistory({ detail, locale, t }) {
  const failedAttempts = (detail.subscription.charge_attempts ?? []).filter(
    (attempt) => attempt.status === "failed"
  );
  const bookings = detail.bookings ?? [];

  return (
    <div className="mt-6 space-y-5 border-t border-ink-100 pt-5">
      <div>
        <h3 className="text-body-md font-semibold text-ink-900">
          {t("admin.subscriptions.cycleBookings")}
        </h3>
        {bookings.length ? (
          <ul className="mt-3 space-y-2">
            {bookings.map((booking) => (
              <li
                key={booking._id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-ink-50 px-3 py-2.5 text-body-sm"
              >
                <span className="font-medium text-ink-800">
                  {formatLocalDateString(booking.booking_date, locale, DATE_OPTIONS)}
                  {booking.booking_time ? ` · ${booking.booking_time}` : ""}
                </span>
                <span className="text-ink-500">{eur(booking.total_amount)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-body-sm text-ink-500">{t("admin.subscriptions.noCycleBookings")}</p>
        )}
      </div>

      <div>
        <h3 className="text-body-md font-semibold text-ink-900">
          {t("admin.subscriptions.failedAttempts")}
        </h3>
        {failedAttempts.length ? (
          <ul className="mt-3 space-y-2">
            {failedAttempts.map((attempt, index) => (
              <li
                key={`${attempt.at || attempt.serviceDate}-${index}`}
                className="rounded-xl border border-red-100 bg-red-50 px-3 py-2.5 text-body-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-red-800">
                    {formatLocalDateString(attempt.serviceDate, locale, DATE_OPTIONS)}
                  </span>
                  <span className="text-caption text-red-600">
                    {formatTimestampDate(attempt.at, locale, DATE_OPTIONS)}
                  </span>
                </div>
                {attempt.errorMessage && (
                  <p className="mt-1 text-caption text-red-700">{attempt.errorMessage}</p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-body-sm text-ink-500">{t("admin.subscriptions.noFailedAttempts")}</p>
        )}
      </div>
    </div>
  );
}

export default function SubscriptionsPage() {
  const { t, locale } = useTranslation();
  const dateLocale = locale === "ka" ? "ka-GE" : locale;
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("");
  const [viewing, setViewing] = useState(null);
  const [cancelTarget, setCancelTarget] = useState(null);

  // The status filter is part of the query key so it round-trips to the server
  // (subscriptionApi.list applies it as ?status=). Filtering client-side only
  // ever searched the first page of results.
  const subscriptionsQuery = useQuery({
    queryKey: ["admin-subscriptions", statusFilter],
    queryFn: () => subscriptionApi.list({ status: statusFilter || undefined }),
    placeholderData: (previous) => previous,
  });
  const detailQuery = useQuery({
    queryKey: ["admin-subscription", viewing?._id],
    queryFn: () => subscriptionApi.get(viewing._id),
    enabled: Boolean(viewing),
  });

  const actionMutation = useMutation({
    mutationFn: ({ action, id }) => subscriptionApi[action](id),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["admin-subscriptions"] });
      queryClient.invalidateQueries({ queryKey: ["admin-subscription", variables.id] });
      if (variables.action === "cancel") setCancelTarget(null);
    },
  });

  // Already filtered server-side — no second pass here.
  const subscriptions = subscriptionsQuery.data ?? [];
  const statusOptions = useMemo(
    () =>
      Object.entries(SUBSCRIPTION_STATUS_META).map(([value, meta]) => ({
        value,
        label: t(meta.labelKey),
      })),
    [t]
  );
  const isPendingFor = (id) =>
    actionMutation.isPending && actionMutation.variables?.id === id;
  const detailSubscription = detailQuery.data?.subscription ?? viewing;

  const columns = [
    {
      key: "customer_name",
      header: t("admin.subscriptions.col.customer"),
      render: (subscription) => (
        <div>
          <p className="font-semibold text-ink-900">{subscription.customer_name}</p>
          <p className="text-caption text-ink-400">{subscription.customer_email}</p>
        </div>
      ),
    },
    {
      key: "service_name",
      header: t("admin.subscriptions.col.service"),
      render: (subscription) => (
        <div>
          <p className="text-ink-800">{subscription.service_name}</p>
          <p className="text-caption text-ink-400">{subscription.city_name}</p>
        </div>
      ),
    },
    {
      key: "interval_days",
      header: t("admin.subscriptions.col.interval"),
      render: (subscription) => intervalLabel(t, subscription.interval_days),
    },
    {
      key: "next_charge_at",
      header: t("admin.subscriptions.col.nextCharge"),
      render: (subscription) => (
        <div className="whitespace-nowrap">
          <p className="text-ink-700">
            {formatTimestampDate(subscription.next_charge_at, dateLocale, DATE_OPTIONS)}
          </p>
          <p className="text-caption text-ink-400">
            {formatLocalDateString(subscription.next_service_date, dateLocale, DATE_OPTIONS)}
          </p>
        </div>
      ),
    },
    {
      key: "last_charge_status",
      header: t("admin.subscriptions.col.lastCharge"),
      render: (subscription) =>
        subscription.last_charge_status ? (
          <div className="flex flex-col items-start gap-1">
            <Badge
              variant={subscription.last_charge_status === "succeeded" ? "success" : "accent"}
              size="sm"
            >
              {subscription.last_charge_status === "succeeded"
                ? t("admin.subscriptions.chargeSucceeded")
                : t("admin.subscriptions.chargeFailed")}
            </Badge>
            {subscription.last_charge_at && (
              <span className="text-caption text-ink-400">
                {formatTimestampDate(subscription.last_charge_at, dateLocale, DATE_OPTIONS)}
              </span>
            )}
          </div>
        ) : (
          "—"
        ),
    },
    {
      key: "status",
      header: t("admin.subscriptions.col.status"),
      render: (subscription) => (
        <div className="flex flex-col items-start gap-1.5">
          <StatusBadge status={subscription.status} t={t} />
          {subscription.paused_reason && (
            <span className="text-caption text-amber-700">
              {t(`admin.subscriptions.reason.${subscription.paused_reason}`)}
            </span>
          )}
          {subscription.failed_attempts > 0 && (
            <span className="text-caption text-red-600">
              {t("admin.subscriptions.retryCount", { count: subscription.failed_attempts })}
            </span>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        icon={CalendarClock}
        title={t("admin.subscriptions.title")}
        description={t("admin.subscriptions.description")}
      />

      {/* A failed fetch replaces the table; a pending one skeletons it, the same
          way every collection-backed admin table loads. */}
      {subscriptionsQuery.isError ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-4 text-body-sm text-red-700">
          <AlertCircle className="mt-0.5 size-4.5 shrink-0" />
          {subscriptionsQuery.error?.message || t("admin.subscriptions.error")}
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={subscriptions}
          loading={subscriptionsQuery.isLoading}
          searchKeys={["customer_name", "customer_email", "service_name", "city_name"]}
          searchPlaceholder={t("admin.subscriptions.search")}
          emptyTitle={t("admin.subscriptions.emptyTitle")}
          emptyDescription={t("admin.subscriptions.emptyDescription")}
          filters={
            <Select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              options={[
                { value: "", label: t("admin.subscriptions.allStatuses") },
                ...statusOptions,
              ]}
              className="h-11 xs:min-w-40"
            />
          }
          onRowClick={setViewing}
          actions={(subscription) => (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("admin.action.view")}
                onClick={() => setViewing(subscription)}
              >
                <Eye className="size-4.5" />
              </Button>
              {subscription.status === "active" ? (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("admin.subscriptions.pause")}
                  loading={isPendingFor(subscription._id)}
                  onClick={() => actionMutation.mutate({ action: "pause", id: subscription._id })}
                >
                  <PauseCircle className="size-4.5" />
                </Button>
              ) : subscription.status === "paused" ? (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("admin.subscriptions.resume")}
                  loading={isPendingFor(subscription._id)}
                  onClick={() => actionMutation.mutate({ action: "resume", id: subscription._id })}
                >
                  <PlayCircle className="size-4.5" />
                </Button>
              ) : null}
              {subscription.status !== "cancelled" && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("admin.subscriptions.cancel")}
                  disabled={isPendingFor(subscription._id)}
                  className="text-red-600 hover:bg-red-500/10 hover:text-red-700"
                  onClick={() => setCancelTarget(subscription)}
                >
                  <XCircle className="size-4.5" />
                </Button>
              )}
            </>
          )}
        />
      )}

      <Modal
        open={Boolean(viewing)}
        onClose={() => setViewing(null)}
        title={t("admin.subscriptions.detailTitle")}
        description={viewing?.customer_name}
        size="xl"
        footer={
          detailSubscription && detailSubscription.status !== "cancelled" ? (
            <>
              {detailSubscription.status === "active" ? (
                <Button
                  variant="outline"
                  size="sm"
                  leftIcon={PauseCircle}
                  loading={isPendingFor(detailSubscription._id)}
                  onClick={() =>
                    actionMutation.mutate({ action: "pause", id: detailSubscription._id })
                  }
                >
                  {t("admin.subscriptions.pause")}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  leftIcon={PlayCircle}
                  loading={isPendingFor(detailSubscription._id)}
                  onClick={() =>
                    actionMutation.mutate({ action: "resume", id: detailSubscription._id })
                  }
                >
                  {t("admin.subscriptions.resume")}
                </Button>
              )}
              <Button
                size="sm"
                leftIcon={XCircle}
                disabled={isPendingFor(detailSubscription._id)}
                onClick={() => setCancelTarget(detailSubscription)}
                className="bg-red-600 hover:bg-red-700"
              >
                {t("admin.subscriptions.cancel")}
              </Button>
            </>
          ) : null
        }
      >
        {detailQuery.isLoading ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : detailQuery.isError ? (
          <p className="text-body-sm text-red-600">
            {detailQuery.error?.message || t("admin.subscriptions.error")}
          </p>
        ) : detailQuery.data ? (
          <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <StatusBadge status={detailQuery.data.subscription.status} t={t} />
                {detailQuery.data.subscription.last_charge_status === "succeeded" && (
                  <Badge variant="success" size="sm" icon={CheckCircle2}>
                    {t("admin.subscriptions.chargeSucceeded")}
                  </Badge>
                )}
              </div>
              {detailQuery.data.subscription.last_cycle_amount != null && (
                <span className="text-heading-sm font-bold text-ink-900">
                  {eur(detailQuery.data.subscription.last_cycle_amount)}
                </span>
              )}
            </div>
            <DetailRow label={t("admin.subscriptions.detail.customer")} value={detailQuery.data.subscription.customer_name} />
            <DetailRow label={t("admin.subscriptions.detail.email")} value={detailQuery.data.subscription.customer_email} />
            <DetailRow label={t("admin.subscriptions.detail.personalId")} value={detailQuery.data.subscription.customer_personal_id} />
            <DetailRow label={t("admin.subscriptions.detail.service")} value={detailQuery.data.subscription.service_name} />
            <DetailRow label={t("admin.subscriptions.detail.city")} value={detailQuery.data.subscription.city_name} />
            <DetailRow label={t("admin.subscriptions.detail.interval")} value={intervalLabel(t, detailQuery.data.subscription.interval_days)} />
            <DetailRow label={t("admin.subscriptions.detail.nextService")} value={formatLocalDateString(detailQuery.data.subscription.next_service_date, dateLocale, DATE_OPTIONS)} />
            <DetailRow label={t("admin.subscriptions.detail.nextCharge")} value={formatTimestampDate(detailQuery.data.subscription.next_charge_at, dateLocale, DATE_OPTIONS)} />
            {detailQuery.data.subscription.last_error && (
              <DetailRow label={t("admin.subscriptions.detail.lastError")} value={detailQuery.data.subscription.last_error} />
            )}
            <ChargeHistory detail={detailQuery.data} locale={dateLocale} t={t} />
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(cancelTarget)}
        onClose={() => !actionMutation.isPending && setCancelTarget(null)}
        title={t("admin.subscriptions.cancelTitle")}
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setCancelTarget(null)}
              disabled={actionMutation.isPending}
            >
              {t("admin.form.cancel")}
            </Button>
            <Button
              loading={actionMutation.isPending}
              onClick={() =>
                actionMutation.mutate({ action: "cancel", id: cancelTarget._id })
              }
              className="bg-red-600 hover:bg-red-700"
            >
              {t("admin.subscriptions.cancelConfirm")}
            </Button>
          </>
        }
      >
        {cancelTarget && (
          <p className="text-body-sm text-ink-600">
            {t("admin.subscriptions.cancelBody", { service: cancelTarget.service_name })}
          </p>
        )}
        {actionMutation.isError && (
          <p className="mt-3 text-body-sm text-red-600">
            {actionMutation.error?.message || t("admin.subscriptions.error")}
          </p>
        )}
      </Modal>
    </div>
  );
}
