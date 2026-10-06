import { useFormContext, useWatch } from "react-hook-form";
import { AlertCircle } from "lucide-react";
import { formatCurrency } from "@/utils/formatCurrency";
import { useTranslation } from "@/i18n";
import { useServices } from "@/features/services";
import { useAuth } from "@/features/admin/context/AuthContext";
import { useBookingNav } from "../../store/BookingContext";
import { useCities } from "../../hooks/useCities";
import { useSpecialRequests } from "../../hooks/useSpecialRequests";
import { useCleaningTools } from "../../hooks/useCleaningTools";
import { computeQuote } from "../../utils/pricing";
import { formatDuration } from "../../utils/duration";
import { formatLocalDateString, intervalLabel } from "../../utils/recurrence";
import { useTimeIssue } from "../../hooks/useTimeIssue";
import { durationMinutesOf } from "../../validation/bookingSchema";

/*
 * ReviewStep
 * ----------
 * Step 5 — a final, readable summary before submission. Each group links back
 * to its step (edit affordance), and the live quote is restated. A submission
 * error from the mutation surfaces here.
 */

function Row({ label, value }) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-body-sm">
      <span className="text-ink-500">{label}</span>
      <span className="text-right font-medium text-ink-900">{value}</span>
    </div>
  );
}

function Group({ title, stepIndex, children }) {
  const { t } = useTranslation();
  const { goTo } = useBookingNav();
  return (
    <div className="rounded-2xl border border-ink-100 bg-surface p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-body-md font-semibold text-ink-900">{title}</h3>
        <button
          type="button"
          onClick={() => goTo(stepIndex)}
          className="text-body-sm font-semibold text-brand-600 hover:text-brand-700"
        >
          {t("booking.edit")}
        </button>
      </div>
      <div className="mt-2 divide-y divide-ink-50">{children}</div>
    </div>
  );
}

export function ReviewStep({ submitError }) {
  const { t, locale } = useTranslation();
  const { control } = useFormContext();
  const v = useWatch({ control });
  const { data: cities = [] } = useCities();
  const { data: addons = [] } = useSpecialRequests();
  const { data: tools = [] } = useCleaningTools();
  const { services } = useServices();
  const durationMinutes = durationMinutesOf(v);
  const formatServiceLabel = ({ name, durationMinutes: minutes, cleaners }) =>
    t("booking.units.serviceLine", {
      name,
      duration: formatDuration(t, minutes),
      cleaners,
      unit: t(cleaners > 1 ? "booking.units.cleaners" : "booking.units.cleaner"),
    });
  // The quote must be priced under the customer's VAT treatment, or the review
  // step would restate the catalogue price while the API charges the net.
  const { tax } = useAuth();
  const quote = computeQuote(
    { ...v, durationMinutes },
    { addons, tools, services, formatServiceLabel, tax }
  );

  const cityRecord = cities.find((c) => String(c.id) === String(v.cityId));
  const city = cityRecord?.name;
  const addonLabels = (v.additionalServices || [])
    .map((id) => addons.find((a) => a.value === id)?.label)
    .filter(Boolean)
    .join(", ");
  const toolLabels = (v.cleaningTools || [])
    .map((id) => tools.find((t) => t.value === id)?.label)
    .filter(Boolean)
    .join(", ");
  const intervalDays = Number(v.intervalDays) || 0;
  const dateLocale = locale === "ka" ? "ka-GE" : locale;
  const cleanersUnit = t(
    v.cleaners > 1 ? "booking.units.cleaners" : "booking.units.cleaner"
  );

  // The schedule step's guard can be walked around: change the duration on an
  // earlier step, then jump forward through the progress bar. This is the last
  // screen before the card is charged, so restate the problem here rather than
  // letting the API be the one to explain it.
  const { message: timeIssueMessage } = useTimeIssue({
    city: cityRecord,
    service: quote.service,
    durationMinutes,
    date: v.date,
    time: v.time,
  });

  return (
    <div className="space-y-4">
      {/* Service now lives in step 1 alongside the city that constrains it, so
          its edit link must point there too. */}
      <Group title={t("booking.review.property")} stepIndex={0}>
        <Row label={t("booking.review.service")} value={quote.service?.name} />
        <Row
          label={t("booking.review.address")}
          value={`${v.street} ${v.houseNumber}, ${city || ""}`}
        />
        <Row
          label={t("booking.review.size")}
          value={
            v.propertySize
              ? t("booking.units.squareMeters", { size: v.propertySize })
              : null
          }
        />
        <Row label={t("booking.review.doorbell")} value={v.doorbellName} />
      </Group>

      <Group title={t("booking.review.cleaning")} stepIndex={1}>
        <Row
          label={t("booking.review.duration")}
          value={t("booking.units.durationLine", {
            duration: formatDuration(t, durationMinutes),
            cleaners: v.cleaners,
            unit: cleanersUnit,
          })}
        />
        <Row
          label={t("booking.fields.addons")}
          value={addonLabels || t("booking.none")}
        />
        <Row
          label={t("booking.fields.tools")}
          value={toolLabels || t("booking.none")}
        />
      </Group>

      <Group title={t("booking.review.schedule")} stepIndex={2}>
        <Row
          label={t("booking.review.date")}
          value={
            v.date
              ? formatLocalDateString(v.date, dateLocale, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })
              : null
          }
        />
        <Row label={t("booking.review.time")} value={v.time} />
        {timeIssueMessage && (
          <p className="flex items-start gap-2 pt-2 text-body-sm text-red-700">
            <AlertCircle className="mt-0.5 size-4.5 shrink-0" />
            {timeIssueMessage}
          </p>
        )}
        {intervalDays > 0 && (
          <Row
            label={t("booking.schedule.repeat.label")}
            value={intervalLabel(t, intervalDays)}
          />
        )}
      </Group>

      <Group title={t("booking.review.contact")} stepIndex={3}>
        <Row label={t("booking.review.name")} value={v.name} />
        <Row label={t("booking.fields.email")} value={v.email} />
        <Row label={t("booking.fields.phone")} value={v.phone} />
        <Row label={t("booking.fields.personalId")} value={v.personalId} />
        <Row label={t("booking.review.notes")} value={v.notes} />
      </Group>

      {/* Total */}
      <div className="rounded-2xl border border-ink-200 bg-white p-5">
        <div className="space-y-2">
          {quote.lineItems.map((item, i) => (
            <div key={i} className="flex justify-between text-body-sm text-black">
              <span>{item.label}</span>
              <span className="font-medium">{formatCurrency(item.amount)}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-ink-200 pt-3">
          <span className="text-body-md font-semibold text-black">
            {t("booking.review.totalDue")}
          </span>
          <span className="text-heading-sm font-bold text-black">
            {formatCurrency(quote.total)}
          </span>
        </div>
      </div>

      {submitError && (
        <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-4 text-body-sm text-red-700">
          <AlertCircle className="mt-0.5 size-4.5 shrink-0" />
          {submitError.message || t("booking.review.submitError")}
        </div>
      )}
    </div>
  );
}

export default ReviewStep;
