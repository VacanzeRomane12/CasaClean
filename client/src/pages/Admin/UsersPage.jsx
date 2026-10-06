import { useMemo, useState } from "react";
import { Users, Plus, Pencil, Trash2, BadgeCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import {
  PageHeader,
  DataTable,
  ResourceModal,
  ConfirmDialog,
  useCollection,
} from "@/features/admin";
import { useTranslation } from "@/i18n";

/*
 * Users management
 * ----------------
 * Manage customer and admin accounts: edit details, change roles, toggle
 * verification and remove accounts.
 */

export default function UsersPage() {
  const { items, create, update, remove, loading } = useCollection("users");
  const { t, locale } = useTranslation();
  const [editing, setEditing] = useState(undefined);
  const [deleting, setDeleting] = useState(null);

  const roleOptions = useMemo(
    () => [
      { value: "user", label: t("admin.users.role.user") },
      { value: "admin", label: t("admin.users.role.admin") },
    ],
    [t]
  );

  // `editing` is null when creating, the record when editing. A password is
  // required to create an account, but optional on edit (blank keeps the
  // current one).
  const isCreate = editing === null;
  const fields = useMemo(
    () => [
      { name: "fullname", label: t("admin.users.field.fullname"), required: true },
      { name: "email", label: t("admin.users.field.email"), type: "email", required: true },
      // Optional on the account (the booking is what requires a number), but the
      // API only stores it in international form — hence the hint.
      {
        name: "phone",
        label: t("admin.users.field.phone"),
        hint: t("admin.users.field.phoneHint"),
      },
      // Same posture as the phone: offered on the account, required by the
      // booking (which falls back to it).
      {
        name: "personalId",
        label: t("admin.users.field.personalId"),
        hint: t("admin.users.field.personalIdHint"),
      },
      {
        name: "password",
        label: t("admin.users.field.password"),
        type: "password",
        required: isCreate,
        hint: isCreate ? undefined : t("admin.users.field.passwordEditHint"),
      },
      { name: "role", label: t("admin.users.field.role"), type: "select", options: roleOptions, required: true },
      { name: "isVerified", label: t("admin.users.field.verified"), type: "switch" },
    ],
    [t, roleOptions, isCreate]
  );

  const fmtDate = (iso) =>
    iso
      ? new Date(iso).toLocaleDateString(locale === "ka" ? "ka-GE" : locale, {
          day: "2-digit",
          month: "short",
          year: "numeric",
        })
      : "—";

  const handleSubmit = (values) => {
    if (editing) update(editing._id, values);
    else create(values);
    setEditing(undefined);
  };

  const columns = [
    {
      key: "fullname",
      header: t("admin.users.col.user"),
      render: (u) => (
        <div className="flex items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ink-100 text-caption font-bold text-ink-600">
            {(u.fullname || "?").slice(0, 2).toUpperCase()}
          </span>
          <div>
            <p className="font-semibold text-ink-900">{u.fullname}</p>
            <p className="text-caption text-ink-400">{u.email}</p>
          </div>
        </div>
      ),
    },
    { key: "phone", header: t("admin.users.col.phone"), render: (u) => u.phone || "—" },
    {
      key: "role",
      header: t("admin.users.col.role"),
      render: (u) => (
        <Badge variant={u.role === "admin" ? "dark" : "neutral"} size="sm">
          {t(`admin.users.role.${u.role}`)}
        </Badge>
      ),
    },
    {
      key: "isVerified",
      header: t("admin.users.col.verified"),
      align: "center",
      render: (u) =>
        u.isVerified ? (
          <BadgeCheck className="mx-auto size-5 text-brand-600" />
        ) : (
          <span className="text-ink-300">—</span>
        ),
    },
    { key: "createdAt", header: t("admin.users.col.joined"), render: (u) => fmtDate(u.createdAt) },
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        icon={Users}
        title={t("admin.users.title")}
        description={t("admin.users.description")}
        actions={
          <Button size="sm" leftIcon={Plus} onClick={() => setEditing(null)}>
            {t("admin.users.add")}
          </Button>
        }
      />

      <DataTable
        columns={columns}
        data={items}
        loading={loading}
        searchKeys={["fullname", "email", "phone"]}
        searchPlaceholder={t("admin.users.search")}
        emptyTitle={t("admin.users.emptyTitle")}
        emptyDescription={t("admin.users.emptyDescription")}
        actions={(u) => (
          <>
            <Button variant="ghost" size="icon" aria-label={t("admin.action.edit")} onClick={() => setEditing(u)}>
              <Pencil className="size-4.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("admin.action.delete")}
              className="text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-500/15 dark:hover:text-red-300"
              onClick={() => setDeleting(u)}
            >
              <Trash2 className="size-4.5" />
            </Button>
          </>
        )}
      />

      <ResourceModal
        open={editing !== undefined}
        onClose={() => setEditing(undefined)}
        onSubmit={handleSubmit}
        title={editing ? t("admin.users.editTitle") : t("admin.users.addTitle")}
        fields={fields}
        initialValues={editing || { role: "user", isVerified: false }}
        submitLabel={editing ? t("admin.form.saveChanges") : t("admin.form.create")}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          remove(deleting._id);
          setDeleting(null);
        }}
        title={t("admin.users.deleteTitle")}
        description={t("admin.form.deleteConfirm", { name: deleting?.fullname })}
        confirmLabel={t("admin.action.delete")}
        danger
      />
    </div>
  );
}
