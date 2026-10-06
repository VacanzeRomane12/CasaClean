# Booking Endpoints — Test Plan

These endpoints manage cleaning **bookings** (a customer's reservation).
You must be **logged in** to make a booking. A logged-in user can create a
booking and see **their own** bookings. Listing **all** bookings, viewing any
single booking, editing, and deleting are **admin only**.

Base address: `http://localhost:3000/api/v1/booking`

| Method | Endpoint   | Who can use it     | What it does                          |
|--------|------------|--------------------|---------------------------------------|
| POST   | `/`        | Any logged-in user | Create a new booking                  |
| GET    | `/my`      | Any logged-in user | List **your own** bookings            |
| GET    | `/`        | Admin only         | List **all** bookings                 |
| GET    | `/:id`     | Admin only         | Get one booking by its id             |
| PATCH  | `/:id`     | Admin only         | Edit a booking                        |
| DELETE | `/:id`     | Admin only         | Delete a booking                      |

> **Reminder:** Every booking endpoint needs a login cookie. The admin ones also
> need the admin role. See [00-setup.md](../00-setup.md).

A booking request body looks like this:
```json
{
  "serviceId": 1,
  "cityId": 1,
  "streetName": "Rustaveli Ave",
  "houseNumber": "12",
  "propertySize": "80m2",
  "doorbellName": "Smith",
  "bookingDate": "2026-07-01",
  "bookingTime": "14:00",
  "durationMinutes": 85,
  "cleaners": 2,
  "customerPersonalId": "01001012345",
  "notes": "Please bring eco products",
  "specialRequests": ["PASTE_SPECIAL_REQUEST_ID"],
  "supplies": ["vacuum", "mop"]
}
```

Important things to know:
- **Contact details come from your account.** You do **not** send `customerName`
  or `customerEmail` — the server fills those from your logged-in profile.
- **Phone:** if your account has a phone number, it is used automatically. If it
  does not (a Google account, or anyone who skipped the optional field at signup),
  you must send `customerPhone` in the body. It must carry the country prefix
  (`+39 331 234 5678`, `+995 555 12 34 56`); spacing and dashes are normalised
  away, a bare `3312345678` is rejected as ambiguous.
- **Personal ID:** same posture as the phone. If your account has `personalId`
  saved (profile → *Personal ID number*, `PATCH /auth/me`), it is used
  automatically; otherwise send `customerPersonalId`. It is 5–20 letters or
  digits after normalisation (uppercase, spaces/dots/dashes removed — e.g. a
  Georgian `01001012345` or an Italian `RSSMRA85M01H501U`). The customer
  checkout (`POST /payment/booking/intent`) refuses a booking without one; the
  admin manual path accepts a walk-in without it. It is returned on every
  booking as `customerPersonalId` and shown in the admin panel.
- **Required fields:** `serviceId`, `cityId`, `streetName`, `houseNumber`,
  `propertySize`, `doorbellName`, `bookingDate`, `bookingTime`,
  `durationMinutes`, `cleaners`. Missing any of these gives a 400.
- **Duration is TOTAL MINUTES**, a whole number between 60 and 720. `85` is a
  1 h 25 min visit. There is no `hours` field any more, and no decimal spelling
  of a duration — the wizard collects an Hours box and a Minutes box and sends
  the sum. The price is the service's hourly rate pro-rated over those minutes
  (85 / 60 x EUR 20 = EUR 28.33), computed in integer cents server-side.
- **Bookings need 48 hours' notice**, measured to the minute against the chosen
  start — not by calendar day. A service with `allowInstantBooking: true` skips
  the wait and can be booked for today; every other rule (working hours, the
  duration fitting inside them, "not already past") still applies to it.
- **`serviceId` / `cityId` are numbers** (the current client contract), not ids
  of real City/Service documents. Sending `0` is allowed (it is a real value).
- **`specialRequests`** must be a list of ids of **existing, enabled** add-ons.
  See [special-request tests](../special-request/special-request-tests.md).
- **`supplies`** is a free list of text tags. Anything that is not a list is
  ignored (stored as an empty list).
- A new booking's `status` defaults to **`confirmed`**.
- A confirmation **email** is sent after creating, but if the email fails the
  booking is **still saved** (email is best-effort).

> **Tip:** Create one or more enabled special requests first, so you have a real
> id to put in `specialRequests`.

---

## 1. POST `/` — Create a booking (any logged-in user)

**curl:**
```bash
curl -X POST http://localhost:3000/api/v1/booking ^
  -H "Content-Type: application/json" ^
  -b cookie.txt ^
  -d "{\"serviceId\":1,\"cityId\":1,\"streetName\":\"Rustaveli Ave\",\"houseNumber\":\"12\",\"propertySize\":\"80m2\",\"doorbellName\":\"Smith\",\"bookingDate\":\"2026-07-01\",\"bookingTime\":\"14:00\",\"durationMinutes\":85,\"cleaners\":2}"
```

### Tests

| #  | What you do                                                        | Expected status | Expected answer                                                     |
|----|-------------------------------------------------------------------|-----------------|---------------------------------------------------------------------|
| 1  | Logged-in user sends all required fields                          | **201**         | message: "Booking created successfully!" + `data.booking`           |
| 2  | Check the contact details on the result                          | **201**         | `customerName` / `customerEmail` match your account (not the body)  |
| 3  | New booking status                                               | **201**         | `data.booking.status` is `"confirmed"`                              |
| 4  | Send valid `specialRequests` (enabled add-on ids)               | **201**         | Created; `data.booking.specialRequests` holds those ids             |
| 5  | Send the same special request id twice                          | **201**         | Created; the duplicate is removed (stored once)                     |
| 6  | Send `specialRequests: []` or leave it out                      | **201**         | Created; `specialRequests` is an empty list                         |
| 7  | Send `supplies` as a list                                       | **201**         | Created; `supplies` saved as given                                  |
| 8  | Send `supplies` as something that is not a list (e.g. a string) | **201**         | Created; `supplies` becomes an empty list                           |
| 9  | Send `serviceId: 0` and `cityId: 0`                             | **201**         | Created — `0` is a valid value (not treated as missing)             |
| 10 | Leave out a required field (e.g. `streetName`)                  | **400**         | message: "Please provide all required fields for booking!"          |
| 11 | Leave out `durationMinutes` / `cleaners`                        | **400**         | message: "Please provide all required fields for booking!"          |
| 12 | Account has **no** phone and you do **not** send `customerPhone` | **400**         | message: "Please add a phone number to your profile or provide one for this booking!" |
| 13 | Account has no phone but you **do** send `customerPhone`        | **201**         | Created; `customerPhone` uses the value you sent                    |
| 14 | `specialRequests` is not a list (e.g. a string)                 | **400**         | message: "specialRequests must be an array of ids!"                 |
| 15 | `specialRequests` has a broken id (like `"123"`)               | **400**         | message: "One or more special request ids are invalid!"             |
| 16 | `specialRequests` has an id that does not exist                 | **400**         | message: "One or more selected special requests do not exist or are unavailable!" |
| 17 | `specialRequests` points to a **disabled** add-on              | **400**         | message: "One or more selected special requests do not exist or are unavailable!" |
| 18 | Not logged in                                                   | **401**         | "Authorization is required!"                                        |
| 19 | Send `durationMinutes: 85` inside the city's hours              | **201**         | Created; `data.booking.durationMinutes` is `85`, total = rate x 85/60 |
| 20 | Send `durationMinutes: 85.5`, `0`, `-60`, `30` or `721`         | **400**         | Validation failed; `fields` names `durationMinutes`                  |
| 21 | Send `bookingTime: "12:20"` inside the city's hours             | **201**         | Created; any minute is a valid start, not just whole hours          |
| 22 | Start 15:00 with `durationMinutes: 120` in a 09:00-17:00 city   | **201**         | Ends exactly at closing, which is allowed                            |
| 23 | Same start with `durationMinutes: 121`                          | **400**         | message: "...would run past the city's closing time"                 |
| 24 | Book a date/time **exactly 48 h** away                          | **201**         | Created — the notice rule is "at least"                              |
| 25 | Book a date/time **47 h 59 m** away                             | **400**         | message: "Bookings must be made at least 48 hours in advance..."     |
| 26 | Book **today** on a service with `allowInstantBooking: true`    | **201**         | Created, provided the visit still finishes before the city closes    |
| 27 | Book a start **earlier today** on an instant service            | **400**         | message: "Booking time for today must be in the future!"             |
| 28 | Two different customers book the same service, date and start   | **201** both    | Deliberately allowed — there is no service-level conflict rule       |

> **Check #2 carefully:** Even if you send `customerName` or `customerEmail` in
> the body, the server **ignores** them and uses your account details. This is on
> purpose — you cannot book under someone else's name.

---

## 2. GET `/my` — List your own bookings (any logged-in user)

You can add `?page=` and `?limit=`. Newest first.

**curl:**
```bash
curl http://localhost:3000/api/v1/booking/my -b cookie.txt
curl "http://localhost:3000/api/v1/booking/my?page=1&limit=5" -b cookie.txt
```

### Tests

| # | What you do                                          | Expected status | Expected answer                                                 |
|---|------------------------------------------------------|-----------------|-----------------------------------------------------------------|
| 1 | Logged-in user with some bookings                    | **200**         | `data.bookings` is a list, plus `bookingCount`                  |
| 2 | The list only shows **your** bookings                | **200**         | No booking from another user appears                            |
| 3 | Special requests are filled in                       | **200**         | Each booking's `specialRequests` shows full add-on info, not just ids |
| 4 | A user with no bookings                              | **200**         | `data.bookings` is an empty list, `bookingCount` is `0`         |
| 5 | Call with `?limit=2`                                 | **200**         | List has at most 2 bookings                                     |
| 6 | Not logged in                                        | **401**         | "Authorization is required!"                                    |

---

## 3. GET `/` — List all bookings (admin only)

You can add `?page=` and `?limit=`. Newest first.

**curl:**
```bash
curl http://localhost:3000/api/v1/booking -b cookie.txt
curl "http://localhost:3000/api/v1/booking?page=1&limit=5" -b cookie.txt
```

### Tests

| # | What you do                          | Expected status | Expected answer                                              |
|---|--------------------------------------|-----------------|--------------------------------------------------------------|
| 1 | Admin lists bookings                  | **200**         | `data.bookings` is a list, plus `bookingCount` (total)       |
| 2 | List includes bookings from everyone | **200**         | Not limited to the admin's own bookings                      |
| 3 | Call with `?limit=2`                 | **200**         | List has at most 2 bookings                                  |
| 4 | Call with junk like `?limit=abc`     | **200**         | Still works — falls back to default (10)                     |
| 5 | A normal user tries this             | **403**         | "You do not have permission to perform this action!"         |
| 6 | Not logged in                        | **401**         | "Authorization is required!"                                 |

---

## 4. GET `/:id` — Get one booking (admin only)

**curl:**
```bash
curl http://localhost:3000/api/v1/booking/PASTE_BOOKING_ID -b cookie.txt
```

### Tests

| # | What you do                          | Expected status | Expected answer                                       |
|---|--------------------------------------|-----------------|-------------------------------------------------------|
| 1 | Admin uses a real booking id         | **200**         | `data.booking` with the booking, special requests filled in |
| 2 | Use an id that does not exist        | **404**         | message: "Booking not found!"                         |
| 3 | Use a broken id (like `123`)         | **400**         | message about invalid id                              |
| 4 | A normal user tries this             | **403**         | "You do not have permission..."                       |
| 5 | Not logged in                        | **401**         | "Authorization is required!"                          |

---

## 5. PATCH `/:id` — Edit a booking (admin only)

Only send the fields you want to change. The admin can edit these fields:
`status`, `bookingDate`, `bookingTime`, `durationMinutes`, `cleaners`,
`streetName`, `houseNumber`, `propertySize`, `doorbellName`, `customerPhone`,
`notes`, `supplies`, and `specialRequests`.

Anything else (like `user`, `customerEmail`, or payment fields) is **ignored**.

`status` must be one of: `pending`, `confirmed`, `cancelled`, `completed`.

**Example — confirm a date change and mark completed:**
```json
{
  "status": "completed",
  "bookingDate": "2026-07-02",
  "totalAmount": 130
}
```

**curl:**
```bash
curl -X PATCH http://localhost:3000/api/v1/booking/PASTE_BOOKING_ID ^
  -H "Content-Type: application/json" ^
  -b cookie.txt ^
  -d "{\"status\":\"completed\",\"totalAmount\":130}"
```

### Tests

| #  | What you do                                                  | Expected status | Expected answer                                          |
|----|-------------------------------------------------------------|-----------------|----------------------------------------------------------|
| 1  | Admin changes the `status` to `completed`                   | **200**         | message: "Booking updated successfully!" + new status    |
| 2  | Change `bookingDate` / `bookingTime`                        | **200**         | New values saved                                         |
| 3  | Change `totalAmount`                                        | **200**         | `data.booking.totalAmount` updated                       |
| 4  | Replace `specialRequests` with other valid enabled ids     | **200**         | `specialRequests` updated to the new list                |
| 5  | Send `specialRequests` with a disabled / missing id        | **400**         | message about special requests not existing / unavailable |
| 6  | Try to change `customerEmail` or `user` in the body        | **200**         | Those are ignored — the booking keeps the original values |
| 7  | Send an invalid `status` (e.g. `"done"`)                   | **400**         | validation error (status must be one of the allowed values) |
| 8  | Send a negative `totalAmount` (e.g. `-5`)                  | **400**         | validation error (amount can't be negative)              |
| 9  | Edit an id that does not exist                             | **404**         | message: "Booking not found!"                            |
| 10 | Use a broken id                                           | **400**         | message about invalid id                                 |
| 11 | A normal user tries this                                  | **403**         | "You do not have permission..."                          |
| 12 | Not logged in                                             | **401**         | "Authorization is required!"                             |

> **Check #6 carefully:** The edit only touches a fixed list of allowed fields.
> Sending `user`, `customerEmail`, `paymentIntentId`, etc. should have **no effect** —
> this protects ownership and payment data from being changed by accident.

### The customer is emailed when the status changes

Moving a booking to a new state sends the customer a message saying so — it is
the only thing that tells them. Watch the mail catcher (or the server log) while
you run these:

| What you do | Email |
| --- | --- |
| `pending` → `confirmed` | "Your booking is confirmed", with the slot and address |
| `confirmed` → `completed` | "Your cleaning is complete" |
| anything → `cancelled` on an **unpaid / manual** booking | "Your booking was cancelled" |
| anything → `cancelled` on a **paid card** booking | the refund email only — **not both** |
| re-send the same `status` with other edits | **nothing** — that isn't a transition |
| edit that omits `status` entirely | **nothing** |

Two rules worth checking deliberately, because both are easy to regress:

- **One email per event.** A cancellation that refunds money already sends the
  refund email, which says the booking is off *and* accounts for the money. A
  status email on top of it reads to the customer like two cancellations.
- **A no-op save is silent.** The admin form seeds itself from the booking and
  re-sends every field, so `status` is present on every edit. Only a value that
  actually *differs* from the stored one notifies.

The send is best-effort and happens after the write: if mail is down, the edit
still succeeds with a `200` and the failure is logged.

---

## 6. PATCH `/:id/cancel` — Cancel your own booking (any logged-in user)

Scoped to the caller: a booking that isn't yours is a **404**, with no hint that
it exists. Only a `pending` or `confirmed` booking can be cancelled.

**How much money comes back** depends on how close the appointment is:

| When you cancel | What happens to the charge |
|---|---|
| **At least 24h** before the start | Full refund (`paymentStatus: "refunded"`) |
| **Inside 24h** | Refund of everything **except one hour of the booked crew** (`paymentStatus: "partially-refunded"`, `refundAmount` = what went back) |
| Inside 24h, booking is **1 hour or shorter** | The retained hour is the whole charge, so nothing is refunded and the payment is left untouched |
| Manual / offline / unpaid booking | Cancelled, Stripe never called |

The kept hour is `pricePerHour × cleaners`. Add-ons and cleaning tools are always
refunded in full — only the blocked hour is charged for. The window is
configurable via `CANCELLATION_WINDOW_HOURS` (default 24; `0` always refunds in
full).

**curl:**
```bash
curl -X PATCH http://localhost:3000/api/v1/booking/PASTE_BOOKING_ID/cancel ^
  -H "X-Requested-With: XMLHttpRequest" ^
  -b cookie.txt
```

### Tests

| # | What you do | Expected status | Expected answer |
|---|---|---|---|
| 1 | Cancel your own paid booking **3 days out** | **200** | "Booking cancelled and refunded successfully!", `paymentStatus: "refunded"` |
| 2 | Cancel your own paid **2-hour** booking starting **in 2 hours** (€40) | **200** | message names a €20.00 late-cancellation fee; `paymentStatus: "partially-refunded"`, `refundAmount: 20` |
| 3 | Same, but the booking is **1 hour** long | **200** | message names the fee; no Stripe refund, `paymentStatus` stays `"paid"` |
| 4 | Cancel a booking that has add-ons, inside the window | **200** | The add-on prices are fully refunded — only `pricePerHour × cleaners` is kept |
| 5 | Cancel someone else's booking | **404** | "Booking not found!" |
| 6 | Cancel the same booking twice | **400** | "This booking is already cancelled." |
| 7 | Cancel a `completed` booking | **400** | "A completed booking can't be cancelled." |
| 8 | Use a broken id | **400** | message about invalid id |
| 9 | Not logged in | **401** | "Authorization is required!" |

> **Check #2 carefully:** the customer's email must state both figures — what was
> refunded and the fee that was kept. An **admin** cancelling the
> same booking (`PATCH /:id` with `{"status":"cancelled"}`) always refunds in
> full — that is the case-by-case override.

---

## 7. DELETE `/:id` — Delete a booking (admin only)

**curl:**
```bash
curl -X DELETE http://localhost:3000/api/v1/booking/PASTE_BOOKING_ID -b cookie.txt
```

### Tests

| # | What you do                          | Expected status | Expected answer                              |
|---|--------------------------------------|-----------------|----------------------------------------------|
| 1 | Admin deletes a real booking         | **200**         | message: "Booking deleted successfully!"     |
| 2 | Delete the same booking again        | **404**         | message: "Booking not found!"                |
| 3 | Delete an id that does not exist     | **404**         | message: "Booking not found!"                |
| 4 | Delete with a broken id              | **400**         | message about invalid id                     |
| 5 | A normal user tries this             | **403**         | "You do not have permission..."              |
| 6 | Not logged in                        | **401**         | "Authorization is required!"                 |
