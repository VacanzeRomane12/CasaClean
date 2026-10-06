import { useEffect } from "react";
import { Controller, useFormContext } from "react-hook-form";
import { Input } from "@/components/ui/Input";
import { PhoneInput } from "@/components/ui/PhoneInput";
import { Textarea } from "@/components/ui/Textarea";
import { useTranslation } from "@/i18n";
import { useAuth } from "@/features/admin/context/AuthContext";

/*
 * ContactStep
 * -----------
 * Step 4 — how to reach the customer. Maps to customer_name / email / phone and
 * optional notes on the booking model. The contact fields are pre-filled from
 * the signed-in user's account (booking is auth-only), and only when still
 * empty — so any edits the customer makes are preserved across step navigation.
 *
 * The phone is REQUIRED here even though an account can exist without one: this
 * is the number the crew rings at the door, and it is the one moment where not
 * having it costs a visit. An account that skipped it at registration simply
 * fills it in here. The personal ID number has the same posture — optional on
 * the profile, required for the reservation — and is pre-filled the same way.
 */

export function ContactStep() {
  const { t } = useTranslation();
  const {
    register,
    control,
    setValue,
    getValues,
    formState: { errors },
  } = useFormContext();
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;
    const current = getValues();
    if (!current.name && user.fullname) setValue("name", user.fullname);
    if (!current.email && user.email) setValue("email", user.email);
    if (!current.phone && user.phone) setValue("phone", user.phone);
    if (!current.personalId && user.personalId) setValue("personalId", user.personalId);
  }, [user, setValue, getValues]);

  return (
    <div className="space-y-5">
      <Input
        label={t("booking.contact.name")}
        placeholder={t("booking.contact.namePlaceholder")}
        required
        error={errors.name?.message}
        {...register("name")}
      />

      <div className="grid gap-5 sm:grid-cols-2">
        <Input
          label={t("booking.fields.email")}
          type="email"
          placeholder={t("booking.contact.emailPlaceholder")}
          required
          error={errors.email?.message}
          {...register("email")}
        />
        <Controller
          name="phone"
          control={control}
          render={({ field }) => (
            <PhoneInput
              label={t("booking.fields.phone")}
              countryLabel={t("common.countryCode")}
              placeholder={t("booking.contact.phonePlaceholder")}
              required
              error={errors.phone?.message}
              name={field.name}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              ref={field.ref}
            />
          )}
        />
      </div>

      <Input
        label={t("booking.contact.personalId")}
        placeholder={t("booking.contact.personalIdPlaceholder")}
        hint={t("booking.contact.personalIdHint")}
        autoComplete="off"
        autoCapitalize="characters"
        required
        error={errors.personalId?.message}
        {...register("personalId")}
      />

      <Textarea
        label={t("booking.contact.notes")}
        hint={t("booking.contact.notesHint")}
        rows={4}
        placeholder={t("booking.contact.notesPlaceholder")}
        error={errors.notes?.message}
        {...register("notes")}
      />
    </div>
  );
}

export default ContactStep;
