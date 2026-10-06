/*
 * Admin API
 * ---------
 * The single bridge between the admin panel and the real backend. Every admin
 * collection (cities, services, special requests, bookings) is read from and
 * written to MongoDB through these functions — there is no local/seed data.
 *
 * The backend models use camelCase (workingHourStarts, pricePerHour, …) while
 * the admin UI was built around snake_case fields. Rather than rewrite every
 * page, the mapping lives here: `fromApi` adapts a DB document to the shape the
 * pages render, and the `create`/`update` builders translate the form values
 * back into the exact payload each endpoint accepts (the server validates with
 * strict Zod schemas, so we must send only the allowed keys).
 *
 * Endpoints are the backend's singular routes:
 *   /city  /service  /special-request  /booking
 */

import { apiClient, request, MAIL_REQUEST_TIMEOUT } from "@/services/api";
import { durationInMinutes } from "@/features/booking/utils/duration";
import { occurrenceFromApi } from "../utils/calendarOccurrences";

// The server clamps every list endpoint to `limit=100`. The panel used to send
// exactly that and render whatever came back, so the 101st booking/user/
// subscription simply vanished — with no page controls and no warning. Walk the
// pages instead so the admin always sees the complete set.
const PAGE_SIZE = 100;

// Hard stop so a bad count or a server-side change can never spin forever.
// 100 pages x 100 records is far beyond this product's realistic dataset.
const MAX_PAGES = 100;

// The public catalogue lists (city/service/special-request) only return
// enabled records; the admin panel must also see soft-disabled ones to manage
// (and re-enable) them. The server honours this flag only for admins.
const CATALOGUE_QS = "?includeDisabled=true";

/**
 * Fetch every page of a list endpoint and return the concatenated records.
 *
 * Uses `apiClient` rather than the shared `request()` helper because the total
 * count lives on the response envelope alongside `data` (e.g. `bookingCount`),
 * and `request()` unwraps straight to `data` — discarding exactly the number
 * needed to know whether more pages exist.
 *
 * @param {string} url       endpoint path, may already carry a query string
 * @param {string} key       collection key inside `data` (e.g. "bookings")
 * @param {string} countKey  total-count key on the envelope (e.g. "bookingCount")
 */
async function fetchAll(url, key, countKey) {
  const separator = url.includes("?") ? "&" : "?";
  const items = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await apiClient.request({
      method: "GET",
      url: `${url}${separator}page=${page}&limit=${PAGE_SIZE}`,
    });
    const body = response.data ?? {};
    const batch = body.data?.[key] ?? [];
    items.push(...batch);

    // A short page is always the last one. The count check additionally stops us
    // re-requesting when the total lands exactly on a page boundary.
    if (batch.length < PAGE_SIZE) break;
    const total = Number(body[countKey]);
    if (Number.isFinite(total) && items.length >= total) break;
  }

  return items;
}

// Keep an object to only the keys whose value is defined — used so a partial
// edit (e.g. just toggling `enabled`) never sends `undefined` into a strict
// schema, which would be rejected as an unknown/invalid field.
const definedOnly = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

// Per-language copy, as the API returns it: an object keyed by locale code
// ({ ka: { name, … } }). The server stores a Map, which serialises to a plain
// object; anything else (a missing field on an older record) reads as "none".
const translationsFromApi = (value) =>
  value && typeof value === "object" ? value : {};

/*
 * Multipart encoding for endpoints that accept a file upload.
 *
 * multipart/form-data carries strings only, so the server re-types the
 * non-string fields (see middlewares/multipart.middleware.js). Arrays are
 * JSON-encoded rather than sent as repeated keys — that's the only encoding in
 * which an *empty* array survives the round trip, and "no cities selected" has
 * to reach the strict schema as `[]`, not as a missing field.
 *
 * The shared axios request interceptor strips the instance's default JSON
 * Content-Type for FormData payloads (see services/api/interceptors.js) so the
 * browser sets multipart/form-data with its own boundary. Without that, axios
 * would silently re-encode this FormData as JSON.
 */
const toFormData = (fields) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value instanceof File || value instanceof Blob) form.append(key, value);
    // Arrays and nested objects (the per-language `translations` map) are both
    // JSON-encoded — the only encoding in which an empty one survives.
    else if (value !== null && typeof value === "object")
      form.append(key, JSON.stringify(value));
    else form.append(key, String(value));
  }
  return form;
};

/* ------------------------------------------------------------------ Cities */

const cityFromApi = (c) => ({
  _id: c._id,
  name: c.name,
  translations: translationsFromApi(c.translations),
  working_hours_start: c.workingHourStarts,
  working_hours_end: c.workingHourEnds,
  enabled: c.enabled,
  createdAt: c.createdAt,
});

export const cityApi = {
  async list() {
    const cities = await fetchAll(`/city${CATALOGUE_QS}`, "cities", "cityCount");
    return cities.map(cityFromApi);
  },
  async create(v) {
    // addCitySchema is strict: ONLY these keys are allowed on create.
    const data = await request({
      method: "POST",
      url: "/city",
      data: {
        name: v.name,
        translations: v.translations ?? {},
        workingHourStarts: v.working_hours_start,
        workingHourEnds: v.working_hours_end,
      },
    });
    return cityFromApi(data.city);
  },
  async update(id, patch) {
    // editCitySchema allows name / translations / workingHourStarts /
    // workingHourEnds / enabled.
    const data = await request({
      method: "PATCH",
      url: `/city/${id}`,
      data: definedOnly({
        name: patch.name,
        // Sent whole (the dialog edits every language at once), so an omitted
        // locale removes that translation server-side. Undefined when the
        // caller didn't touch translations — e.g. the table's enable toggle.
        translations: patch.translations,
        workingHourStarts: patch.working_hours_start,
        workingHourEnds: patch.working_hours_end,
        enabled: patch.enabled,
      }),
    });
    return cityFromApi(data.city);
  },
  remove: (id) => request({ method: "DELETE", url: `/city/${id}` }),
};

/* ---------------------------------------------------------------- Services */

const serviceFromApi = (s) => ({
  _id: s._id,
  name: s.name,
  subtitle: s.subtitle ?? "",
  description: s.description,
  image: s.image ?? "",
  includes: Array.isArray(s.includes) ? s.includes : [],
  translations: translationsFromApi(s.translations),
  price_per_hour: s.pricePerHour,
  all_cities: Boolean(s.allCities),
  // `cities` may arrive populated (objects) or as raw ids depending on the
  // endpoint — normalise to an array of id strings for the multiselect.
  cities: (s.cities ?? []).map((c) => (c && c._id ? c._id : c)),
  // Special-request add-ons enabled for this service (same normalisation).
  all_special_requests: Boolean(s.allSpecialRequests),
  special_requests: (s.specialRequests ?? []).map((r) =>
    r && r._id ? r._id : r
  ),
  // Recurring bookings: opt-in per service, with an optional cadence whitelist.
  // An empty list means "the customer picks any cadence the platform allows".
  recurring_enabled: Boolean(s.recurringEnabled),
  recurring_interval_days: (s.recurringIntervalDays ?? []).map(Number),
  // Same-day booking: skips the 48-hour advance notice for this service.
  allow_instant_booking: Boolean(s.allowInstantBooking),
  enabled: s.enabled,
  createdAt: s.createdAt,
});

// The cover image is either a freshly picked File (upload it as multipart) or a
// plain string: the path already stored on the record, a hosted URL, or "" to
// clear it. Only the File case needs multipart, so ordinary edits keep sending
// the same compact JSON body they always did.
const isUpload = (image) => image instanceof File;

export const serviceApi = {
  async list() {
    const services = await fetchAll(`/service${CATALOGUE_QS}`, "services", "serviceCount");
    return services.map(serviceFromApi);
  },
  async create(v) {
    const allCities = Boolean(v.all_cities);
    const allSpecialRequests = Boolean(v.all_special_requests);
    const recurringEnabled = Boolean(v.recurring_enabled);
    // createServiceSchema is strict. `enabled` is NOT accepted here (defaults to
    // true server-side); the special-request keys are optional.
    const body = {
      name: v.name,
      subtitle: v.subtitle || "",
      description: v.description,
      image: v.image || "",
      includes: Array.isArray(v.includes) ? v.includes.filter(Boolean) : [],
      translations: v.translations ?? {},
      pricePerHour: Number(v.price_per_hour),
      allCities,
      cities: allCities ? [] : (v.cities ?? []),
      allSpecialRequests,
      specialRequests: allSpecialRequests ? [] : (v.special_requests ?? []),
      recurringEnabled,
      // Cadences are only meaningful for a recurring service; the server clears
      // them anyway, but don't send a list the form left behind.
      recurringIntervalDays: recurringEnabled
        ? (v.recurring_interval_days ?? []).map(Number)
        : [],
      allowInstantBooking: Boolean(v.allow_instant_booking),
    };
    const data = await request({
      method: "POST",
      url: "/service",
      data: isUpload(v.image) ? toFormData(body) : body,
    });
    return serviceFromApi(data.service);
  },
  async update(id, patch) {
    // editServiceSchema is strict: name / subtitle / description / image /
    // includes / pricePerHour / allCities / cities / allSpecialRequests /
    // specialRequests / recurringEnabled / recurringIntervalDays / enabled.
    const body = definedOnly({
      name: patch.name,
      subtitle: patch.subtitle,
      description: patch.description,
      image: patch.image,
      includes: Array.isArray(patch.includes)
        ? patch.includes.filter(Boolean)
        : undefined,
      // Sent whole (the dialog edits every language at once), so an omitted
      // locale removes that translation server-side. Undefined when the caller
      // didn't touch translations at all — e.g. the table's enable toggle.
      translations: patch.translations,
      pricePerHour:
        patch.price_per_hour !== undefined
          ? Number(patch.price_per_hour)
          : undefined,
      allCities: patch.all_cities,
      cities: patch.cities,
      allSpecialRequests: patch.all_special_requests,
      specialRequests: patch.special_requests,
      recurringEnabled: patch.recurring_enabled,
      recurringIntervalDays:
        patch.recurring_interval_days === undefined
          ? undefined
          : patch.recurring_interval_days.map(Number),
      allowInstantBooking: patch.allow_instant_booking,
      // Soft on/off switch — a disabled service is hidden from the public site.
      enabled: patch.enabled,
    });
    const data = await request({
      method: "PATCH",
      url: `/service/${id}`,
      data: isUpload(patch.image) ? toFormData(body) : body,
    });
    return serviceFromApi(data.service);
  },
  remove: (id) => request({ method: "DELETE", url: `/service/${id}` }),
};

/* -------------------------------------------------------- Special requests */

const specialRequestFromApi = (s) => ({
  _id: s._id,
  name: s.name,
  description: s.description ?? "",
  translations: translationsFromApi(s.translations),
  price: s.price,
  enabled: s.enabled,
  createdAt: s.createdAt,
});

export const specialRequestApi = {
  async list() {
    const specialRequests = await fetchAll(
      `/special-request${CATALOGUE_QS}`,
      "specialRequests",
      "specialRequestCount"
    );
    return specialRequests.map(specialRequestFromApi);
  },
  async create(v) {
    const data = await request({
      method: "POST",
      url: "/special-request",
      data: {
        name: v.name,
        description: v.description,
        translations: v.translations ?? {},
        price: Number(v.price),
      },
    });
    return specialRequestFromApi(data.specialRequest);
  },
  async update(id, patch) {
    const data = await request({
      method: "PATCH",
      url: `/special-request/${id}`,
      data: definedOnly({
        name: patch.name,
        description: patch.description,
        // Sent whole (the dialog edits every language at once), so an omitted
        // locale removes that translation server-side. Undefined when the
        // caller didn't touch translations — e.g. the table's enable toggle.
        translations: patch.translations,
        price: patch.price !== undefined ? Number(patch.price) : undefined,
        enabled: patch.enabled,
      }),
    });
    return specialRequestFromApi(data.specialRequest);
  },
  remove: (id) => request({ method: "DELETE", url: `/special-request/${id}` }),
};

/* ----------------------------------------------------------- Cleaning tools */

// Physical tools/supplies (mop, vacuum, …) an admin manages centrally. Each
// tool carries a flat surcharge and the services it can be used on — an empty
// `services` array means the tool is available for every service.
const cleaningToolFromApi = (t) => ({
  _id: t._id,
  name: t.name,
  description: t.description ?? "",
  translations: translationsFromApi(t.translations),
  price: t.price,
  // May arrive populated (objects) or as raw ids — normalise to id strings
  // for the services multiselect.
  services: (t.services ?? []).map((s) => (s && s._id ? s._id : s)),
  enabled: t.enabled,
  createdAt: t.createdAt,
});

export const cleaningToolApi = {
  async list() {
    const cleaningTools = await fetchAll(
      `/cleaning-tool${CATALOGUE_QS}`,
      "cleaningTools",
      "cleaningToolCount"
    );
    return cleaningTools.map(cleaningToolFromApi);
  },
  async create(v) {
    const data = await request({
      method: "POST",
      url: "/cleaning-tool",
      data: {
        name: v.name,
        description: v.description,
        translations: v.translations ?? {},
        price: Number(v.price),
        services: v.services ?? [],
      },
    });
    return cleaningToolFromApi(data.cleaningTool);
  },
  async update(id, patch) {
    const data = await request({
      method: "PATCH",
      url: `/cleaning-tool/${id}`,
      data: definedOnly({
        name: patch.name,
        description: patch.description,
        // Sent whole (the dialog edits every language at once), so an omitted
        // locale removes that translation server-side. Undefined when the
        // caller didn't touch translations — e.g. the table's enable toggle.
        translations: patch.translations,
        price: patch.price !== undefined ? Number(patch.price) : undefined,
        services: patch.services,
        enabled: patch.enabled,
      }),
    });
    return cleaningToolFromApi(data.cleaningTool);
  },
  remove: (id) => request({ method: "DELETE", url: `/cleaning-tool/${id}` }),
};

/* ------------------------------------------------------------------ Workers */

const workerFromApi = (w) => ({
  _id: w._id,
  fullname: w.fullname,
  email: w.email ?? "",
  phone: w.phone ?? "",
  enabled: w.enabled,
  createdAt: w.createdAt,
});

export const workerApi = {
  async list() {
    const workers = await fetchAll("/worker", "workers", "workerCount");
    return workers.map(workerFromApi);
  },
  async create(v) {
    // addWorkerSchema is strict: fullname required, email/phone optional. Blank
    // contact fields are omitted so the strict schema doesn't see empty noise.
    const data = await request({
      method: "POST",
      url: "/worker",
      data: definedOnly({
        fullname: v.fullname,
        email: v.email ? v.email : undefined,
        phone: v.phone ? v.phone : undefined,
      }),
    });
    return workerFromApi(data.worker);
  },
  async update(id, patch) {
    // editWorkerSchema allows fullname / email / phone / enabled. Email and phone
    // are sent even when blanked (empty string) so the admin can clear them.
    const data = await request({
      method: "PATCH",
      url: `/worker/${id}`,
      data: definedOnly({
        fullname: patch.fullname,
        email: patch.email,
        phone: patch.phone,
        enabled: patch.enabled,
      }),
    });
    return workerFromApi(data.worker);
  },
  remove: (id) => request({ method: "DELETE", url: `/worker/${id}` }),
};

/* ---------------------------------------------------------------- Bookings */

// serviceId/cityId arrive either as a raw id string OR as a populated
// `{ _id, name }` object (the booking read endpoints populate them). Normalise
// to a plain id string + an optional name so the page can resolve/display both.
const refId = (v) => (v && typeof v === "object" ? v._id : v);
const refName = (v) => (v && typeof v === "object" ? v.name : null);

const bookingFromApi = (b) => ({
  _id: b._id,
  // Short human-readable reference derived from the id (bookings have no
  // dedicated reference field server-side).
  reference: `CC-${String(b._id).slice(-6).toUpperCase()}`,
  customer_name: b.customerName,
  customer_email: b.customerEmail,
  customer_phone: b.customerPhone,
  // Snapshotted at booking time; absent on bookings made before it existed.
  customer_personal_id: b.customerPersonalId ?? "",
  // Present on bookings created from a recurring plan (the first visit and
  // every charged cycle). The calendar uses it to recognise a charged cycle
  // among the plan's projected occurrences.
  subscription_id: b.subscriptionId ? String(refId(b.subscriptionId)) : null,
  // The page resolves names from the loaded catalogues by id; the populated name
  // (when present) is the fallback, then the id form.
  service_id: refId(b.serviceId),
  city_id: refId(b.cityId),
  service_name:
    refName(b.serviceId) || (b.serviceId != null ? `Service #${refId(b.serviceId)}` : "—"),
  city_name:
    refName(b.cityId) || (b.cityId != null ? `City #${refId(b.cityId)}` : "—"),
  street_name: b.streetName,
  house_number: b.houseNumber,
  property_size: b.propertySize,
  doorbell_name: b.doorbellName,
  booking_date: b.bookingDate,
  booking_time: b.bookingTime,
  // Total minutes. `hours` is what bookings written before minute-level
  // durations carry, so read it through durationInMinutes rather than either
  // field — see features/booking/utils/duration.js.
  duration_minutes: durationInMinutes(b),
  cleaners: b.cleaners,
  total_amount: b.totalAmount,
  // VAT treatment snapshot: how this booking was actually taxed. 'reverse-charge'
  // means a verified business was charged the net instead of the catalogue price.
  tax_treatment: b.tax?.treatment ?? "standard",
  customer_type: b.tax?.customerType ?? "individual",
  vat_rate: b.tax?.vatRate ?? 0,
  vat_amount: b.tax?.vatAmount ?? 0,
  net_amount: b.tax?.netAmount ?? null,
  vat_number: b.tax?.vatNumber ?? "",
  company_name: b.tax?.companyName ?? "",
  status: b.status,
  // Payment posture (read-only in the admin UI): how it was paid and where the
  // money currently sits. 'manual' = offline/cash booking (no Stripe).
  payment_method: b.paymentMethod ?? "card",
  payment_status: b.paymentStatus ?? "unpaid",
  refund_id: b.refundId ?? null,
  notes: b.notes ?? "",
  supplies: b.supplies ?? [],
  special_requests: b.specialRequests ?? [],
  // Requested cleaning tools arrive populated ({ _id, name, price }) from the
  // admin booking feed.
  cleaning_tools: b.cleaningTools ?? [],
  // Assigned staff arrive populated as { _id, fullname } objects (or raw ids).
  // Keep the ids for the assignment multiselect and the names for display.
  workers: (b.workers ?? []).map((w) => (w && w._id ? w._id : w)),
  worker_names: (b.workers ?? []).map((w) =>
    w && w.fullname ? w.fullname : `#${w}`
  ),
  createdAt: b.createdAt,
});

export const bookingApi = {
  async list() {
    const bookings = await fetchAll("/booking", "bookings", "bookingCount");
    return bookings.map(bookingFromApi);
  },
  async create(v) {
    // Admin-entered booking, on a customer's behalf. The admin may either link a
    // registered account (userId) and/or type the contact details directly; the
    // server fills any omitted contact field from the linked account. serviceId/
    // cityId must be real, enabled Service/City ObjectIds (server-validated).
    // totalAmount is NOT sent — the server computes it from the service price,
    // the booked minutes and the add-ons.
    const data = await request({
      method: "POST",
      url: "/booking",
      data: definedOnly({
        // Empty string from the optional account picker → omit so the strict
        // schema doesn't reject it (objectId validation would fail on "").
        userId: v.customer_user_id ? String(v.customer_user_id).trim() : undefined,
        customerName: v.customer_name || undefined,
        customerEmail: v.customer_email || undefined,
        customerPhone: v.customer_phone || undefined,
        customerPersonalId: v.customer_personal_id || undefined,
        serviceId: String(v.service_id).trim(),
        cityId: String(v.city_id).trim(),
        streetName: v.street_name,
        houseNumber: v.house_number,
        propertySize: v.property_size,
        doorbellName: v.doorbell_name,
        bookingDate: v.booking_date,
        bookingTime: v.booking_time,
        durationMinutes: Number(v.duration_minutes),
        cleaners: Number(v.cleaners),
        notes: v.notes || null,
        supplies: v.supplies || [],
        workers: v.workers || [],
      }),
    });
    return bookingFromApi(data.booking);
  },
  async update(id, patch) {
    // editBooking whitelists these fields server-side. totalAmount is omitted —
    // the server recomputes it whenever the duration or add-ons change.
    const data = await request({
      method: "PATCH",
      url: `/booking/${id}`,
      data: definedOnly({
        status: patch.status,
        bookingDate: patch.booking_date,
        bookingTime: patch.booking_time,
        durationMinutes:
          patch.duration_minutes !== undefined
            ? Number(patch.duration_minutes)
            : undefined,
        cleaners:
          patch.cleaners !== undefined ? Number(patch.cleaners) : undefined,
        streetName: patch.street_name,
        houseNumber: patch.house_number,
        propertySize: patch.property_size,
        doorbellName: patch.doorbell_name,
        customerPhone: patch.customer_phone,
        // The edit schema accepts a correction but not a blank: an empty value
        // from the form is simply left out.
        customerPersonalId: patch.customer_personal_id || undefined,
        notes: patch.notes,
        supplies: patch.supplies,
        workers: patch.workers,
      }),
    });
    return bookingFromApi(data.booking);
  },
  remove: (id) => request({ method: "DELETE", url: `/booking/${id}` }),
};

/* ------------------------------------------------------------------- Users */

const userFromApi = (u) => ({
  _id: u._id,
  fullname: u.fullname,
  email: u.email,
  phone: u.phone ?? "",
  personalId: u.personalId ?? "",
  role: u.role,
  isVerified: Boolean(u.isVerified),
  provider: u.provider,
  avatar: u.avatar,
  createdAt: u.createdAt,
});

export const userApi = {
  async list() {
    const users = await fetchAll("/auth/users", "users", "userCount");
    return users.map(userFromApi);
  },
  async create(v) {
    const data = await request({
      method: "POST",
      url: "/auth/users",
      data: {
        fullname: v.fullname,
        email: v.email,
        phone: v.phone,
        personalId: v.personalId,
        password: v.password,
        role: v.role || "user",
        isVerified: Boolean(v.isVerified),
      },
    });
    return userFromApi(data.user);
  },
  async update(id, patch) {
    // A blank password is omitted so editing other fields never wipes it.
    const data = await request({
      method: "PATCH",
      url: `/auth/users/${id}`,
      data: definedOnly({
        fullname: patch.fullname,
        email: patch.email,
        phone: patch.phone,
        personalId: patch.personalId,
        password: patch.password ? patch.password : undefined,
        role: patch.role,
        isVerified: patch.isVerified,
      }),
    });
    return userFromApi(data.user);
  },
  remove: (id) => request({ method: "DELETE", url: `/auth/users/${id}` }),
};

/* ----------------------------------------------------------------- Reviews */

// Reviews are written by customers (and only after a completed booking — that
// gate is enforced server-side). The admin panel is read-only here apart from
// moderation: it lists scores + comments and can delete an inappropriate
// review. `user`, `service_id` and the rated `booking` arrive populated from the
// admin feed (GET /review), so reuse the booking ref helpers to normalise them.
const reviewFromApi = (r) => {
  // The rated booking is populated so the admin can see exactly which booking a
  // review is for; it may be null if the booking was later deleted.
  const b = r.booking && typeof r.booking === "object" ? r.booking : null;
  return {
    _id: r._id,
    rating: Number(r.rating) || 0,
    comment: r.review_text ?? "",
    service_id: refId(r.service_id),
    service_name: refName(r.service_id) || "—",
    // The author is populated; fall back to the booking's contact, then a dash.
    customer_name: (r.user && r.user.fullname) || b?.customerName || "—",
    customer_email: (r.user && r.user.email) || b?.customerEmail || "",
    // Rated booking — a short reference (same scheme as the Bookings page) plus
    // the details the admin needs to identify it.
    booking_id: refId(r.booking),
    booking_reference: r.booking
      ? `CC-${String(refId(r.booking)).slice(-6).toUpperCase()}`
      : "—",
    booking_date: b?.bookingDate || "",
    booking_time: b?.bookingTime || "",
    booking_status: b?.status || "",
    booking_total: b?.totalAmount,
    booking_duration_minutes: durationInMinutes(b),
    booking_cleaners: b?.cleaners,
    booking_property_size: b?.propertySize || "",
    booking_doorbell: b?.doorbellName || "",
    booking_city: refName(b?.cityId) || "",
    booking_address: b
      ? [b.streetName, b.houseNumber].filter(Boolean).join(" ")
      : "",
    // Moderation: reviews are created hidden and only appear on the public site
    // once an admin publishes them.
    is_published: Boolean(r.isPublished),
    published_at: r.publishedAt ?? null,
    createdAt: r.createdAt,
  };
};

export const reviewApi = {
  async list() {
    const reviews = await fetchAll("/review", "reviews", "reviewCount");
    return reviews.map(reviewFromApi);
  },
  // The only field an admin can write is the public-visibility flag — the
  // content belongs to the customer. Anything else in the patch is ignored.
  async update(id, patch) {
    const data = await request({
      method: "PATCH",
      url: `/review/${id}/publish`,
      data: { isPublished: Boolean(patch.is_published) },
    });
    return reviewFromApi(data.review);
  },
  remove: (id) => request({ method: "DELETE", url: `/review/${id}` }),
};

/* ------------------------------------------------------- Contact messages */

// Submitted through the public contact form. Nothing here is editable — the
// text belongs to whoever wrote it — so the panel only reads, triages and
// deletes. `handledBy` is populated by the server when present.
const contactMessageFromApi = (m) => ({
  _id: m._id,
  name: m.name,
  email: m.email,
  phone: m.phone || "",
  topic: m.topic,
  message: m.message,
  status: m.status || "new",
  handled_at: m.handledAt ?? null,
  handled_by_name: (m.handledBy && m.handledBy.fullname) || "",
  // Answers already emailed to this customer, oldest first.
  replies: Array.isArray(m.replies) ? m.replies : [],
  createdAt: m.createdAt,
});

export const contactMessageApi = {
  async list() {
    const contactMessages = await fetchAll("/contact", "contactMessages", "contactMessageCount");
    return contactMessages.map(contactMessageFromApi);
  },
  // Triage state is the only writable field.
  async update(id, patch) {
    const data = await request({
      method: "PATCH",
      url: `/contact/${id}`,
      data: { status: patch.status === "handled" ? "handled" : "new" },
    });
    return contactMessageFromApi(data.contactMessage);
  },
  /**
   * Email an answer to the customer.
   *
   * The server awaits the actual send, so a rejection here means the mail did
   * NOT go out and nothing was recorded — surface it, never swallow it. On
   * success the message comes back already marked handled.
   *
   * Which is exactly why this one call needs MAIL_REQUEST_TIMEOUT: the default
   * budget expires mid-handshake, and an aborted request tells us nothing about
   * whether the mail left. Waiting for the server's own verdict is the point.
   */
  async reply(id, body) {
    const data = await request({
      method: "POST",
      url: `/contact/${id}/reply`,
      data: { body },
      timeout: MAIL_REQUEST_TIMEOUT,
    });
    return contactMessageFromApi(data.contactMessage);
  },
  remove: (id) => request({ method: "DELETE", url: `/contact/${id}` }),
};

/* ---------------------------------------------------------- Subscriptions */

// Subscription endpoints are already camelCase on the wire, but admin pages
// use the same snake_case display shape as the rest of this module. Keep the
// boundary here so the UI never mixes API field conventions.
export const subscriptionFromApi = (s) => ({
  _id: s._id,
  customer_name: s.customerName || s.user?.fullname || "—",
  customer_email: s.customerEmail || s.user?.email || "",
  customer_phone: s.customerPhone || "",
  customer_personal_id: s.customerPersonalId || "",
  user_id: refId(s.user),
  service_id: refId(s.serviceId),
  service_name: refName(s.serviceId) || "—",
  city_id: refId(s.cityId),
  city_name: refName(s.cityId) || "—",
  interval_days: Number(s.intervalDays) || 0,
  status: s.status,
  paused_reason: s.pausedReason ?? null,
  next_service_date: s.nextServiceDate,
  next_charge_at: s.nextChargeAt ?? null,
  failed_attempts: Number(s.failedAttempts) || 0,
  last_charge_status: s.lastChargeStatus ?? null,
  last_charge_at: s.lastChargeAt ?? null,
  last_error: s.lastError ?? null,
  last_cycle_amount: s.lastCycleAmount ?? null,
  charge_attempts: s.chargeAttempts ?? [],
  createdAt: s.createdAt,
  pausedAt: s.pausedAt ?? null,
  cancelledAt: s.cancelledAt ?? null,
});

const subscriptionAction = async (id, action) => {
  const data = await request({
    method: "PATCH",
    url: `/subscription/${id}/${action}`,
  });
  return subscriptionFromApi(data.subscription ?? data);
};

export const subscriptionApi = {
  // `status` is applied SERVER-side. The page used to call list() with no
  // argument and filter the (truncated) result client-side, so filtering by
  // "paused" only ever searched the newest 100 subscriptions.
  async list({ status } = {}) {
    const statusQuery = status ? `?status=${encodeURIComponent(status)}` : "";
    const subscriptions = await fetchAll(
      `/subscription${statusQuery}`,
      "subscriptions",
      "subscriptionCount"
    );
    return subscriptions.map(subscriptionFromApi);
  },
  async get(id) {
    const data = await request({ method: "GET", url: `/subscription/${id}` });
    return {
      subscription: subscriptionFromApi(data.subscription),
      bookings: (data.bookings ?? []).map(bookingFromApi),
    };
  },
  pause: (id) => subscriptionAction(id, "admin-pause"),
  resume: (id) => subscriptionAction(id, "admin-resume"),
  cancel: (id) => subscriptionAction(id, "admin-cancel"),
  /**
   * The upcoming visits of every active plan inside a date range, projected
   * server-side from each plan's rule (a cycle's booking only exists once it
   * has been charged). Both bounds are "YYYY-MM-DD" and the server caps the
   * span, so the calendar asks for exactly its visible grid.
   */
  async occurrences({ from, to }) {
    const data = await request({
      method: "GET",
      url: `/subscription/occurrences?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    });
    return (data.occurrences ?? []).map(occurrenceFromApi);
  },
};

/* ----------------------------------------------------------------- Registry */

// Collection name (as used by the admin pages) → its API module. The data
// context dispatches generic create/update/remove calls through this map.
export const RESOURCES = {
  cities: cityApi,
  services: serviceApi,
  specialRequests: specialRequestApi,
  cleaningTools: cleaningToolApi,
  bookings: bookingApi,
  users: userApi,
  workers: workerApi,
  reviews: reviewApi,
  contactMessages: contactMessageApi,
};
