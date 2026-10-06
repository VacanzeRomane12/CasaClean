// New-booking alerts to the team — end to end.
//
// Covers the promise the feature makes: a booking that becomes confirmed-and-
// paid reaches BOTH halves of "the admin" — every admin account's own address
// and the configured business mailbox — in a single de-duplicated email, with
// enough in it to staff the job. Also pins the two ways this could quietly go
// wrong: alerting twice for one booking (the finalize/webhook race), and letting
// a notification failure damage a paid booking.

const {
  api,
  stripeMock,
  sendEmailMock,
  BOOKING_ALERT_EMAIL,
  bookingAlerts,
  customerEmails,
  waitForBookingAlerts,
  waitForCustomerEmails
} = require('../setup/testEnv');
const {
  createUser,
  createAdmin,
  cookieFor,
  createCity,
  createService,
  validBookingBody
} = require('../setup/fixtures');

const Booking = require('../../models/booking.model');

/** A PaymentIntent that both creates and retrieves as already succeeded. */
const mockPaidIntent = (id = 'pi_test_alert_1') => {
  stripeMock.customers.create.mockResolvedValue({ id: 'cus_test_alert' });
  const intent = (params = {}) => ({
    id,
    client_secret: `${id}_secret`,
    status: 'succeeded',
    amount: params.amount ?? 4000,
    customer: params.customer ?? 'cus_test_alert',
    payment_method: 'pm_test_alert'
  });
  stripeMock.paymentIntents.create.mockImplementation(async (params) => intent(params));
  stripeMock.paymentIntents.retrieve.mockImplementation(async () => intent());
};

/** Pay for a booking as `user`, returning the finalize response. */
const payForBooking = async (user, service, city, overrides = {}) => {
  const cookie = cookieFor(user);
  const intent = await api
    .post('/api/v1/payment/booking/intent')
    .set('Cookie', cookie)
    .send(validBookingBody(service, city, overrides));
  expect(intent.status).toBe(201);

  return api
    .post('/api/v1/payment/booking/finalize')
    .set('Cookie', cookie)
    .send({ paymentIntentId: intent.body.data.paymentIntentId });
};

describe('new-booking alerts', () => {
  it('emails the admin accounts and the business mailbox in one message', async () => {
    const [user, admin, city, service] = await Promise.all([
      createUser(),
      createAdmin(),
      createCity(),
      createService()
    ]);
    mockPaidIntent();

    const finalize = await payForBooking(user, service, city, {
      notes: 'Cat in the flat, please keep the door shut.'
    });
    expect(finalize.status).toBe(201);

    const [alert] = await waitForBookingAlerts(1);

    // Both audiences, one email — an admin who is also the shared mailbox must
    // not get the same booking twice.
    expect(alert.email).toContain(admin.email);
    expect(alert.email).toContain(BOOKING_ALERT_EMAIL);
    expect(alert.email.split(',')).toHaveLength(2);

    // Actionable on its own: when, where, who and how to reach them.
    expect(alert.subject).toContain('New booking');
    expect(alert.subject).toContain(service.name);
    expect(alert.text).toContain(user.fullname);
    expect(alert.text).toContain(user.email);
    expect(alert.text).toContain(user.phone);
    expect(alert.text).toContain(user.personalId);
    expect(alert.html).toContain(user.personalId);
    expect(alert.text).toContain(city.name);
    expect(alert.text).toContain('Via Roma');
    expect(alert.text).toContain('Cat in the flat');
    expect(alert.text).toContain(finalize.body.data.booking._id);
    // Replying reaches the customer, not our own notification mailbox.
    expect(alert.replyTo).toBe(user.email);

    // And the customer still gets exactly their own one email.
    expect(await waitForCustomerEmails(1)).toHaveLength(1);
    expect(customerEmails()[0].email).toBe(user.email);
  });

  it('alerts once per booking, not once per promotion attempt', async () => {
    const [user, city, service] = await Promise.all([
      createUser(),
      createCity(),
      createService()
    ]);
    mockPaidIntent('pi_test_alert_race');

    const cookie = cookieFor(user);
    const intent = await api
      .post('/api/v1/payment/booking/intent')
      .set('Cookie', cookie)
      .send(validBookingBody(service, city));

    // Finalize twice: the second call is the idempotent return, exactly like the
    // Stripe webhook arriving after the client's own finalize.
    const first = await api
      .post('/api/v1/payment/booking/finalize')
      .set('Cookie', cookie)
      .send({ paymentIntentId: intent.body.data.paymentIntentId });
    const second = await api
      .post('/api/v1/payment/booking/finalize')
      .set('Cookie', cookie)
      .send({ paymentIntentId: intent.body.data.paymentIntentId });

    // Both calls succeed (finalize is idempotent), but only one booking exists.
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await Booking.countDocuments({})).toBe(1);

    await waitForBookingAlerts(1);
    // Give a second (wrong) alert time to appear before declaring there isn't one.
    await waitForBookingAlerts(2, 300);
    expect(bookingAlerts()).toHaveLength(1);
  });

  it('does not alert for a payment that never became a booking', async () => {
    const [user, city, service] = await Promise.all([
      createUser(),
      createCity(),
      createService()
    ]);
    stripeMock.customers.create.mockResolvedValue({ id: 'cus_test_alert' });
    stripeMock.paymentIntents.create.mockResolvedValue({
      id: 'pi_test_alert_unpaid',
      client_secret: 'pi_test_alert_unpaid_secret',
      status: 'requires_payment_method'
    });
    stripeMock.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_test_alert_unpaid',
      status: 'requires_payment_method'
    });

    const cookie = cookieFor(user);
    const intent = await api
      .post('/api/v1/payment/booking/intent')
      .set('Cookie', cookie)
      .send(validBookingBody(service, city));

    const finalize = await api
      .post('/api/v1/payment/booking/finalize')
      .set('Cookie', cookie)
      .send({ paymentIntentId: intent.body.data.paymentIntentId });

    // "Payment has not been completed yet." — no charge, so no booking.
    expect(finalize.status).toBe(400);
    expect(await Booking.countDocuments({})).toBe(0);
    await waitForBookingAlerts(1, 300);
    expect(bookingAlerts()).toHaveLength(0);
  });

  it('keeps the paid booking intact when the alert cannot be sent', async () => {
    const [user, city, service] = await Promise.all([
      createUser(),
      createCity(),
      createService()
    ]);
    mockPaidIntent('pi_test_alert_smtp');
    // Every send fails — the customer's confirmation email and the team's alert alike.
    sendEmailMock.mockRejectedValue(new Error('SMTP is down'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const finalize = await payForBooking(user, service, city);

      // The money moved and the reservation exists; mail is downstream of both.
      expect(finalize.status).toBe(201);
      expect(finalize.body.data.booking.paymentStatus).toBe('paid');
      expect(await Booking.countDocuments({ paymentStatus: 'paid' })).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
