// End-to-end auth flows: signup + email verification, signin (incl. lockout and
// anti-enumeration), password reset, profile self-service, account deletion.
const crypto = require("crypto");

const { api, sendEmailMock } = require("../setup/testEnv");
const {
    createUser,
    createGoogleUser,
    cookieFor,
    createService,
    createCity,
    createPaidBooking
} = require("../setup/fixtures");

const User = require("../../models/user.model");
const Review = require("../../models/review.model");
const Booking = require("../../models/booking.model");

const SIGNUP_BODY = {
    fullname: "Mario Rossi",
    email: "mario.rossi@test.casaclean.local",
    phone: "+393312345678",
    password: "password123"
};

describe("POST /api/v1/auth/signup", () => {
    test("creates an unverified account and emails a verification link", async () => {
        const res = await api.post("/api/v1/auth/signup").send(SIGNUP_BODY);

        expect(res.status).toBe(201);
        expect(res.body.message).toMatch(/verify/i);

        const user = await User.findOne({ email: SIGNUP_BODY.email })
            .select("+password +verificationToken +verificationTokenExpires");
        expect(user).not.toBeNull();
        expect(user.isVerified).toBe(false);
        expect(user.role).toBe("user");
        // Password is hashed, never stored raw.
        expect(user.password).not.toBe(SIGNUP_BODY.password);
        // Only the token HASH is stored.
        expect(user.verificationToken).toMatch(/^[a-f0-9]{64}$/);
        expect(user.verificationTokenExpires.getTime()).toBeGreaterThan(Date.now());

        expect(sendEmailMock).toHaveBeenCalledTimes(1);
        expect(sendEmailMock.mock.calls[0][0].email).toBe(SIGNUP_BODY.email);
        // The emailed link carries the RAW token, not the stored hash.
        expect(sendEmailMock.mock.calls[0][0].html).not.toContain(user.verificationToken);
    });

    test("cannot mass-assign role or isVerified (strict schema)", async () => {
        const res = await api.post("/api/v1/auth/signup").send({
            ...SIGNUP_BODY,
            role: "admin",
            isVerified: true
        });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Validation failed/);
    });

    test("rejects a malformed phone number at validation", async () => {
        const malformed = await api.post("/api/v1/auth/signup").send({ ...SIGNUP_BODY, phone: "call-me" });
        expect(malformed.status).toBe(400);
    });

    // Registration asks for the two things signing in needs. The number is
    // collected at booking time, where not having one actually costs a visit.
    test("creates an account with no phone number", async () => {
        const { phone, ...withoutPhone } = SIGNUP_BODY;

        const res = await api.post("/api/v1/auth/signup").send(withoutPhone);
        expect(res.status).toBe(201);

        const user = await User.findOne({ email: SIGNUP_BODY.email });
        expect(user.phone).toBeUndefined();
    });

    // The trap the sparse unique index exists for: two phone-less accounts must
    // not collide on a stored "" (or on a null in the index).
    test("lets a SECOND account register without a phone number", async () => {
        const { phone, ...withoutPhone } = SIGNUP_BODY;

        const first = await api.post("/api/v1/auth/signup").send(withoutPhone);
        const second = await api.post("/api/v1/auth/signup")
            .send({ ...withoutPhone, email: "second@test.casaclean.local" });

        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
        expect(await User.countDocuments({ phone: { $exists: false } })).toBe(2);
    });

    // An empty string is the same as leaving the field out — and must not make
    // the duplicate lookup match an unrelated account.
    test("treats a blank phone as no phone, even alongside existing accounts", async () => {
        await createUser();
        const { phone, ...withoutPhone } = SIGNUP_BODY;

        const res = await api.post("/api/v1/auth/signup").send({ ...withoutPhone, phone: "" });

        expect(res.status).toBe(201);
        expect((await User.findOne({ email: SIGNUP_BODY.email })).phone).toBeUndefined();
    });

    test("stores one canonical form however the number was spaced", async () => {
        const res = await api.post("/api/v1/auth/signup")
            .send({ ...SIGNUP_BODY, phone: "0039 331 234-5678" });

        expect(res.status).toBe(201);
        expect((await User.findOne({ email: SIGNUP_BODY.email })).phone).toBe("+393312345678");
    });

    test("returns ONE generic message for duplicate email or phone (anti-enumeration)", async () => {
        await createUser({ email: SIGNUP_BODY.email });

        const dupEmail = await api.post("/api/v1/auth/signup")
            .send({ ...SIGNUP_BODY, phone: "+390000000001" });
        expect(dupEmail.status).toBe(400);
        expect(dupEmail.body.message).toMatch(/email or phone/i);

        const other = await createUser();
        const dupPhone = await api.post("/api/v1/auth/signup")
            .send({ ...SIGNUP_BODY, email: "fresh@test.casaclean.local", phone: other.phone });
        expect(dupPhone.status).toBe(400);
        expect(dupPhone.body.message).toBe(dupEmail.body.message);
    });

    test("rolls back the verification token when the email can't be sent", async () => {
        sendEmailMock.mockRejectedValueOnce(new Error("smtp down"));

        const res = await api.post("/api/v1/auth/signup").send(SIGNUP_BODY);
        expect(res.status).toBe(502);

        const user = await User.findOne({ email: SIGNUP_BODY.email })
            .select("+verificationToken");
        expect(user.verificationToken).toBeUndefined();
    });
});

describe("GET /api/v1/auth/verify-email/:token", () => {
    test("verifies the account, signs the user in and redirects to the client", async () => {
        const user = await createUser({ isVerified: false });
        const rawToken = user.createVerificationToken();
        await user.save({ validateBeforeSave: false });

        const res = await api.get(`/api/v1/auth/verify-email/${rawToken}`);
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe(`${process.env.CLIENT_URL}/`);
        expect(res.headers["set-cookie"].join(";")).toMatch(/lt=/);

        const fresh = await User.findById(user._id).select("+verificationToken");
        expect(fresh.isVerified).toBe(true);
        expect(fresh.verificationToken).toBeUndefined();
    });

    test("redirects to a failure page for an unknown/expired token", async () => {
        const res = await api.get(`/api/v1/auth/verify-email/${crypto.randomBytes(32).toString("hex")}`);
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe(`${process.env.CLIENT_URL}/signin?verified=failed`);
    });
});

describe("POST /api/v1/auth/signin", () => {
    test("signs in a verified user and sets the auth cookie", async () => {
        const user = await createUser();
        const res = await api.post("/api/v1/auth/signin")
            .send({ email: user.email, password: "password123", remember: true });

        expect(res.status).toBe(200);
        const cookie = res.headers["set-cookie"].find((c) => c.startsWith("lt="));
        expect(cookie).toMatch(/HttpOnly/i);
        expect(cookie).toMatch(/Max-Age/i); // remember=true -> persistent cookie
        expect(res.body.data.user.password).toBeUndefined();
        expect(res.body.data.user.tokenVersion).toBeUndefined();
    });

    test("issues a session cookie (no Max-Age) when remember is false", async () => {
        const user = await createUser();
        const res = await api.post("/api/v1/auth/signin")
            .send({ email: user.email, password: "password123", remember: false });
        const cookie = res.headers["set-cookie"].find((c) => c.startsWith("lt="));
        expect(cookie).not.toMatch(/Max-Age/i);
    });

    test("uses ONE generic 401 for unknown email and wrong password", async () => {
        const user = await createUser();

        const wrongPassword = await api.post("/api/v1/auth/signin")
            .send({ email: user.email, password: "wrong-password" });
        const unknownEmail = await api.post("/api/v1/auth/signin")
            .send({ email: "ghost@test.casaclean.local", password: "whatever123" });

        expect(wrongPassword.status).toBe(401);
        expect(unknownEmail.status).toBe(401);
        expect(wrongPassword.body.message).toBe(unknownEmail.body.message);
    });

    test("blocks unverified accounts with a 403", async () => {
        const user = await createUser({ isVerified: false });
        const res = await api.post("/api/v1/auth/signin")
            .send({ email: user.email, password: "password123" });
        expect(res.status).toBe(403);
        expect(res.body.message).toMatch(/verify/i);
    });

    test("locks the account after too many failed attempts (even with the right password)", async () => {
        const user = await createUser();
        // Fast-forward to one attempt before the limit instead of burning 10 bcrypt rounds.
        await User.updateOne({ _id: user._id }, { failedLoginAttempts: 9 });

        const lastFail = await api.post("/api/v1/auth/signin")
            .send({ email: user.email, password: "wrong-password" });
        expect(lastFail.status).toBe(401);

        // The account is now locked: the CORRECT password is rejected with 429.
        const locked = await api.post("/api/v1/auth/signin")
            .send({ email: user.email, password: "password123" });
        expect(locked.status).toBe(401);
        expect(locked.body.message).toBe(lastFail.body.message);
    });

    test("a successful signin clears accumulated failure state", async () => {
        const user = await createUser();
        await User.updateOne({ _id: user._id }, { failedLoginAttempts: 5 });

        const res = await api.post("/api/v1/auth/signin")
            .send({ email: user.email, password: "password123" });
        expect(res.status).toBe(200);

        const fresh = await User.findById(user._id).select("+failedLoginAttempts");
        expect(fresh.failedLoginAttempts).toBe(0);
    });
});

describe("POST /api/v1/auth/logout", () => {
    test("expires the auth cookie", async () => {
        const user = await createUser();
        const res = await api.post("/api/v1/auth/logout").set("Cookie", cookieFor(user));
        expect(res.status).toBe(200);
        const cookie = res.headers["set-cookie"].find((c) => c.startsWith("lt="));
        expect(cookie).toMatch(/lt=;/);
    });
});

describe("POST /api/v1/auth/resend-verification", () => {
    const GENERIC = /if an unverified account exists/i;

    test("responds identically for unknown emails (no email sent)", async () => {
        const res = await api.post("/api/v1/auth/resend-verification")
            .send({ email: "ghost@test.casaclean.local" });
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(GENERIC);
        expect(sendEmailMock).not.toHaveBeenCalled();
    });

    test("responds identically for already-verified users (no email sent)", async () => {
        const user = await createUser();
        const res = await api.post("/api/v1/auth/resend-verification")
            .send({ email: user.email });
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(GENERIC);
        expect(sendEmailMock).not.toHaveBeenCalled();
    });

    test("sends a fresh link for an unverified local account", async () => {
        const user = await createUser({ isVerified: false });
        const res = await api.post("/api/v1/auth/resend-verification")
            .send({ email: user.email });
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(GENERIC);
        expect(sendEmailMock).toHaveBeenCalledTimes(1);
    });
});

describe("password reset flow", () => {
    test("forgot-password responds identically for unknown emails (no email sent)", async () => {
        const res = await api.post("/api/v1/auth/forgot-password")
            .send({ email: "ghost@test.casaclean.local" });
        expect(res.status).toBe(200);
        expect(sendEmailMock).not.toHaveBeenCalled();
    });

    test("forgot-password stores a hashed token and emails the raw one", async () => {
        const user = await createUser();
        const res = await api.post("/api/v1/auth/forgot-password").send({ email: user.email });
        expect(res.status).toBe(200);
        expect(sendEmailMock).toHaveBeenCalledTimes(1);

        const fresh = await User.findById(user._id).select("+passwordResetToken +passwordResetExpires");
        expect(fresh.passwordResetToken).toMatch(/^[a-f0-9]{64}$/);
        expect(fresh.passwordResetExpires.getTime()).toBeGreaterThan(Date.now());
    });

    test("reset-password consumes the token, revokes old sessions and signs in", async () => {
        const user = await createUser();
        const staleCookie = cookieFor(user); // minted before the reset
        const rawToken = user.createPasswordResetToken();
        await user.save({ validateBeforeSave: false });

        const res = await api.post(`/api/v1/auth/reset-password/${rawToken}`)
            .send({ password: "new-password-456" });
        expect(res.status).toBe(200);
        expect(res.headers["set-cookie"].join(";")).toMatch(/lt=/);

        // New password works…
        const signin = await api.post("/api/v1/auth/signin")
            .send({ email: user.email, password: "new-password-456" });
        expect(signin.status).toBe(200);

        // …the old one doesn't…
        const oldSignin = await api.post("/api/v1/auth/signin")
            .send({ email: user.email, password: "password123" });
        expect(oldSignin.status).toBe(401);

        // …and every session minted before the reset is dead (tokenVersion bump).
        const staleMe = await api.get("/api/v1/auth/me").set("Cookie", staleCookie);
        expect(staleMe.status).toBe(401);

        // The token is single-use.
        const reuse = await api.post(`/api/v1/auth/reset-password/${rawToken}`)
            .send({ password: "another-pass-789" });
        expect(reuse.status).toBe(400);
    });

    test("rejects an unknown reset token", async () => {
        const res = await api.post(`/api/v1/auth/reset-password/${crypto.randomBytes(32).toString("hex")}`)
            .send({ password: "new-password-456" });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/invalid or has expired/i);
    });
});

describe("profile self-service", () => {
    test("PATCH /me updates name and phone", async () => {
        const user = await createUser();
        const res = await api.patch("/api/v1/auth/me")
            .set("Cookie", cookieFor(user))
            .send({ fullname: "Renamed Person", phone: "+393399999999" });
        expect(res.status).toBe(200);
        expect(res.body.data.user.fullname).toBe("Renamed Person");
        expect(res.body.data.user.phone).toBe("+393399999999");
    });

    test("PATCH /me rejects a phone already used by another account", async () => {
        const other = await createUser();
        const user = await createUser();
        const res = await api.patch("/api/v1/auth/me")
            .set("Cookie", cookieFor(user))
            .send({ phone: other.phone });
        expect(res.status).toBe(409);
    });

    // Optional means removable: "" unsets the field rather than storing a blank
    // (which the sparse unique index would then treat as a real value).
    test("PATCH /me clears the phone when sent an empty string", async () => {
        const user = await createUser();

        const res = await api.patch("/api/v1/auth/me")
            .set("Cookie", cookieFor(user))
            .send({ phone: "" });

        expect(res.status).toBe(200);
        expect(res.body.data.user.phone).toBeUndefined();

        const stored = await User.findById(user._id).lean();
        expect("phone" in stored).toBe(false);

        // And a second account can clear its number too.
        const another = await createUser();
        const second = await api.patch("/api/v1/auth/me")
            .set("Cookie", cookieFor(another))
            .send({ phone: "" });
        expect(second.status).toBe(200);
    });

    test("PATCH /me adds a phone to an account that registered without one", async () => {
        const user = await createUser({ phone: undefined });

        const res = await api.patch("/api/v1/auth/me")
            .set("Cookie", cookieFor(user))
            .send({ phone: "+995 555 12 34 56" });

        expect(res.status).toBe(200);
        expect(res.body.data.user.phone).toBe("+995555123456");
    });

    test("PATCH /me cannot change role or email (strict schema)", async () => {
        const user = await createUser();
        const res = await api.patch("/api/v1/auth/me")
            .set("Cookie", cookieFor(user))
            .send({ role: "admin" });
        expect(res.status).toBe(400);
    });

    test("PATCH /me/password requires the correct current password", async () => {
        const user = await createUser();
        const res = await api.patch("/api/v1/auth/me/password")
            .set("Cookie", cookieFor(user))
            .send({ currentPassword: "wrong-password", newPassword: "new-password-456" });
        expect(res.status).toBe(401);
    });

    test("PATCH /me/password changes the password and kills other sessions", async () => {
        const user = await createUser();
        const otherSession = cookieFor(user);

        const res = await api.patch("/api/v1/auth/me/password")
            .set("Cookie", cookieFor(user))
            .send({ currentPassword: "password123", newPassword: "new-password-456" });
        expect(res.status).toBe(200);

        const staleMe = await api.get("/api/v1/auth/me").set("Cookie", otherSession);
        expect(staleMe.status).toBe(401);

        const signin = await api.post("/api/v1/auth/signin")
            .send({ email: user.email, password: "new-password-456" });
        expect(signin.status).toBe(200);
    });
});

// A Google account starts with no local password. It must be able to add one
// (and only then does the current-password rule apply to it).
describe("adding a password to a Google account", () => {
    test("GET /me reports whether the account has a local password", async () => {
        const google = await createGoogleUser();
        const local = await createUser();

        const asGoogle = await api.get("/api/v1/auth/me").set("Cookie", cookieFor(google));
        expect(asGoogle.status).toBe(200);
        expect(asGoogle.body.data.user.hasPassword).toBe(false);
        // The answer travels, never the hash.
        expect(asGoogle.body.data.user.password).toBeUndefined();

        const asLocal = await api.get("/api/v1/auth/me").set("Cookie", cookieFor(local));
        expect(asLocal.body.data.user.hasPassword).toBe(true);
    });

    test("PATCH /me/password sets a first password and enables email sign-in", async () => {
        const google = await createGoogleUser();
        const otherSession = cookieFor(google);

        const res = await api.patch("/api/v1/auth/me/password")
            .set("Cookie", cookieFor(google))
            .send({ newPassword: "brand-new-password-1" });
        expect(res.status).toBe(200);

        // Same posture as a change: every other session dies.
        const stale = await api.get("/api/v1/auth/me").set("Cookie", otherSession);
        expect(stale.status).toBe(401);

        const signin = await api.post("/api/v1/auth/signin")
            .send({ email: google.email, password: "brand-new-password-1" });
        expect(signin.status).toBe(200);

        // The Google link survives — the account now has both ways in.
        const stored = await User.findById(google._id).select("+password");
        expect(stored.provider).toBe("google");
        expect(stored.googleId).toBe(google.googleId);
        expect(stored.password).not.toBe("brand-new-password-1"); // hashed
    });

    test("rejects a current password on an account that has none", async () => {
        const google = await createGoogleUser();
        const res = await api.patch("/api/v1/auth/me/password")
            .set("Cookie", cookieFor(google))
            .send({ currentPassword: "anything", newPassword: "brand-new-password-1" });
        expect(res.status).toBe(400);

        const stored = await User.findById(google._id).select("+password");
        expect(stored.password).toBeUndefined();
    });

    test("once set, the password can only be changed with the current one", async () => {
        const google = await createGoogleUser();
        const first = await api.patch("/api/v1/auth/me/password")
            .set("Cookie", cookieFor(google))
            .send({ newPassword: "brand-new-password-1" });
        expect(first.status).toBe(200);

        // The session cookie was re-issued by the change; re-read the bumped
        // tokenVersion so the follow-up requests carry a live token.
        const live = await User.findById(google._id).select("+tokenVersion");

        const omitted = await api.patch("/api/v1/auth/me/password")
            .set("Cookie", cookieFor(live))
            .send({ newPassword: "second-password-22" });
        expect(omitted.status).toBe(400);

        const wrong = await api.patch("/api/v1/auth/me/password")
            .set("Cookie", cookieFor(live))
            .send({ currentPassword: "not-it", newPassword: "second-password-22" });
        expect(wrong.status).toBe(401);

        const ok = await api.patch("/api/v1/auth/me/password")
            .set("Cookie", cookieFor(live))
            .send({ currentPassword: "brand-new-password-1", newPassword: "second-password-22" });
        expect(ok.status).toBe(200);
    });

    test("DELETE /me starts requiring the password once one is set", async () => {
        const google = await createGoogleUser();
        await api.patch("/api/v1/auth/me/password")
            .set("Cookie", cookieFor(google))
            .send({ newPassword: "brand-new-password-1" });

        const live = await User.findById(google._id).select("+tokenVersion");

        const unconfirmed = await api.delete("/api/v1/auth/me")
            .set("Cookie", cookieFor(live))
            .send({});
        expect(unconfirmed.status).toBe(401);
        expect(await User.findById(google._id)).not.toBeNull();

        const confirmed = await api.delete("/api/v1/auth/me")
            .set("Cookie", cookieFor(live))
            .send({ password: "brand-new-password-1" });
        expect(confirmed.status).toBe(200);
    });

    test("forgot-password follows the password, not the provider", async () => {
        const google = await createGoogleUser();

        // No local password yet -> nothing to reset, and no email sent.
        sendEmailMock.mockClear();
        const before = await api.post("/api/v1/auth/forgot-password")
            .send({ email: google.email });
        expect(before.status).toBe(200);
        expect(sendEmailMock).not.toHaveBeenCalled();

        await api.patch("/api/v1/auth/me/password")
            .set("Cookie", cookieFor(google))
            .send({ newPassword: "brand-new-password-1" });

        // With a password, the account can reset it like any other.
        sendEmailMock.mockClear();
        const after = await api.post("/api/v1/auth/forgot-password")
            .send({ email: google.email });
        expect(after.status).toBe(200);
        expect(sendEmailMock).toHaveBeenCalledTimes(1);
        // Identical response either way (anti-enumeration).
        expect(after.body.message).toBe(before.body.message);
    });
});

describe("DELETE /api/v1/auth/me", () => {
    test("requires the correct password for local accounts", async () => {
        const user = await createUser();
        const res = await api.delete("/api/v1/auth/me")
            .set("Cookie", cookieFor(user))
            .send({ password: "wrong-password" });
        expect(res.status).toBe(401);
        expect(await User.findById(user._id)).not.toBeNull();
    });

    test("is blocked while upcoming bookings exist", async () => {
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        await createPaidBooking(user, service, city, { status: "confirmed" });

        const res = await api.delete("/api/v1/auth/me")
            .set("Cookie", cookieFor(user))
            .send({ password: "password123" });
        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(/cancel your upcoming bookings/i);
    });

    test("deletes the account, removes reviews and detaches past bookings", async () => {
        const user = await createUser();
        const service = await createService();
        const city = await createCity();
        const pastBooking = await createPaidBooking(user, service, city, { status: "completed" });
        await Review.create({
            booking: pastBooking._id,
            service_id: service._id,
            user: user._id,
            rating: 5,
            review_text: "Great!"
        });

        const res = await api.delete("/api/v1/auth/me")
            .set("Cookie", cookieFor(user))
            .send({ password: "password123" });
        expect(res.status).toBe(200);

        expect(await User.findById(user._id)).toBeNull();
        expect(await Review.countDocuments({ user: user._id })).toBe(0);
        // The financial record survives, detached from the deleted account.
        const kept = await Booking.findById(pastBooking._id);
        expect(kept).not.toBeNull();
        expect(kept.user).toBeUndefined();
    });
});

describe("profile self-service - personal ID", () => {
    test("PATCH /me stores a normalised personal ID and GET /me returns it", async () => {
        const user = await createUser({ personalId: "" });
        const res = await api.patch("/api/v1/auth/me")
            .set("Cookie", cookieFor(user))
            .send({ personalId: "rss mra-85m01 h501u" });
        expect(res.status).toBe(200);
        expect(res.body.data.user.personalId).toBe("RSSMRA85M01H501U");

        const me = await api.get("/api/v1/auth/me").set("Cookie", cookieFor(user));
        expect(me.body.data.user.personalId).toBe("RSSMRA85M01H501U");
    });

    test("PATCH /me clears the personal ID when sent an empty string", async () => {
        const user = await createUser({ personalId: "01001012345" });
        const res = await api.patch("/api/v1/auth/me")
            .set("Cookie", cookieFor(user))
            .send({ personalId: "" });
        expect(res.status).toBe(200);
        expect(res.body.data.user.personalId).toBeUndefined();

        const stored = await User.findById(user._id).lean();
        expect("personalId" in stored).toBe(false);
    });

    test("PATCH /me rejects a malformed personal ID", async () => {
        const user = await createUser();
        const res = await api.patch("/api/v1/auth/me")
            .set("Cookie", cookieFor(user))
            .send({ personalId: "id#1" });
        expect(res.status).toBe(400);
    });
});
