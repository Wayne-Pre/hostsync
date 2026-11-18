/**
 * T-28 .. T-35 — the booking ledger and its writes, over the API.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { closePool } from '../src/db.ts';
import { createCaptureTransport } from '../src/mail.ts';
import { addDays, todayUTC } from '../src/dates.ts';
import { CHANNELS, priceStay } from '../src/pricing.ts';
import type { Channel } from '../src/pricing.ts';
import { createBooking, createProperty, deleteUser, signUp } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';

const mailer = createCaptureTransport();
let app: FastifyInstance;
let user: ApiUser;
let propertyId: string;
const emails: string[] = [];

interface LedgerRow {
  id: string;
  reference: string;
  propertyName: string;
  guestName: string;
  channel: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  guests: number;
  grossCents: number;
  commissionBps: number;
  netCents: number;
  paymentStatus: string;
  status: string;
}

async function ledger(query = ''): Promise<LedgerRow[]> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/bookings${query}`,
    headers: { cookie: user.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { bookings: LedgerRow[] }).bookings;
}

before(async () => {
  app = buildApp({ mailer });
  await app.ready();
  user = await signUp(app, mailer);
  emails.push(user.email);
  const property = await createProperty(app, user, { name: 'Kilimani Apartment', guests: 6 });
  propertyId = property.id;
});

after(async () => {
  await app.close();
  for (const email of emails) await deleteUser(email);
  await closePool();
});

test('T-28 the ledger shows reference, nights, guests, channel, net, payment and status', async () => {
  const today = todayUTC();
  const rows: Array<[string, Channel, number, number, string]> = [
    ['Sofia Almeida', 'airbnb', 0, 3, 'paid'],
    ['Brian Kimani', 'booking_com', 5, 2, 'partial'],
    ['Elena Petrova', 'direct', 10, 4, 'unpaid'],
  ];

  for (const [guestName, channel, start, nights, paymentStatus] of rows) {
    await createBooking(app, user, {
      propertyId,
      guestName,
      channel,
      checkIn: addDays(today, start),
      checkOut: addDays(today, start + nights),
      guests: 2,
      guestEmail: `${guestName.split(' ')[0]?.toLowerCase()}@example.com`,
      guestPhone: '+254700000000',
      paymentStatus,
    });
  }

  const ledgerRows = await ledger();
  assert.equal(ledgerRows.length, 3);

  const sofia = ledgerRows.find((row) => row.guestName === 'Sofia Almeida');
  assert.ok(sofia);
  assert.match(sofia.reference, /^HS-\d+$/);
  assert.equal(sofia.propertyName, 'Kilimani Apartment');
  assert.equal(sofia.nights, 3);
  assert.equal(sofia.guests, 2);
  assert.equal(sofia.channel, 'airbnb');
  assert.equal(sofia.grossCents, 4_800_000);
  assert.equal(sofia.netCents, 4_080_000);
  assert.equal(sofia.paymentStatus, 'paid');
  assert.equal(sofia.status, 'confirmed');
  assert.equal(sofia.checkOut, addDays(today, 3));
});

test('T-29 in-house, arriving and net booked are computed, not guessed', async () => {
  const today = todayUTC();
  const kpiProperty = await createProperty(app, user, { name: 'KPI House', guests: 6 });

  // In-house today (check-in today, check-out in three days).
  await createBooking(app, user, {
    propertyId: kpiProperty.id,
    guestName: 'In House Guest',
    channel: 'direct',
    checkIn: today,
    checkOut: addDays(today, 3),
    guests: 2,
  });
  await createBooking(app, user, {
    propertyId: kpiProperty.id,
    guestName: 'Later Guest',
    channel: 'vrbo',
    checkIn: addDays(today, 20),
    checkOut: addDays(today, 22),
    guests: 2,
  });

  const response = await app.inject({
    method: 'GET',
    url: `/api/bookings/summary?propertyId=${kpiProperty.id}`,
    headers: { cookie: user.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  const summary = response.json() as {
    inHouseNow: number;
    arriving: number;
    netBookedCents: number;
  };

  const scoped = await ledger(`?propertyId=${kpiProperty.id}`);
  const confirmed = scoped.filter((row) => row.status === 'confirmed');
  assert.equal(summary.inHouseNow, 1);
  assert.equal(
    summary.arriving,
    confirmed.filter((row) => row.checkIn >= today).length
  );
  assert.equal(
    summary.netBookedCents,
    scoped
      .filter((row) => row.status === 'confirmed' || row.status === 'completed')
      .reduce((sum, row) => sum + row.netCents, 0)
  );
});

test('T-30 search matches guest, property and reference; nothing else leaks in', async () => {
  const unmatched = await createBooking(app, user, {
    propertyId,
    guestName: 'Zawadi Otieno',
    channel: 'vrbo',
    checkIn: addDays(todayUTC(), 40),
    checkOut: addDays(todayUTC(), 42),
    guests: 1,
  });

  const byProperty = await ledger('?q=Kilimani');
  assert.ok(byProperty.length >= 3);
  assert.equal(byProperty.every((row) => row.propertyName.includes('Kilimani')), true);

  const byReference = await ledger(`?q=${unmatched.reference}`);
  assert.equal(byReference.length, 1);
  assert.equal(byReference[0]?.id, unmatched.id);

  const byGuest = await ledger('?q=Sofia');
  assert.equal(byGuest.length, 1);
  assert.equal(byGuest[0]?.guestName, 'Sofia Almeida');

  const missing = await ledger('?q=NoSuchGuestAnywhere');
  assert.equal(missing.length, 0);
});

test('T-31 status and channel filters AND together', async () => {
  await createBooking(app, user, {
    propertyId,
    guestName: 'Pending Import',
    channel: 'airbnb',
    checkIn: addDays(todayUTC(), 60),
    checkOut: addDays(todayUTC(), 62),
    guests: 2,
    status: 'pending',
  });

  const airbnb = await ledger('?channel=airbnb');
  assert.ok(airbnb.length > 0);
  assert.equal(airbnb.every((row) => row.channel === 'airbnb'), true);

  const pending = await ledger('?status=pending');
  assert.equal(pending.every((row) => row.status === 'pending'), true);

  const combined = await ledger('?channel=airbnb&status=pending');
  assert.ok(combined.length >= 1);
  assert.equal(
    combined.every((row) => row.channel === 'airbnb' && row.status === 'pending'),
    true
  );

  const impossible = await ledger('?channel=vrbo&status=pending');
  assert.equal(impossible.length, 0);

  const badStatus = await app.inject({
    method: 'GET',
    url: '/api/bookings?status=maybe',
    headers: { cookie: user.cookie },
  });
  assert.equal(badStatus.statusCode, 422);
});

test('T-32 the detail sheet is arithmetically honest', async () => {
  const rows = await ledger();
  assert.ok(rows.length > 0);

  for (const row of rows) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/bookings/${row.id}`,
      headers: { cookie: user.cookie },
    });
    assert.equal(response.statusCode, 200, response.body);

    const detail = response.json() as {
      booking: { grossCents: number; commissionBps: number; netCents: number; guestEmail: string; checkinTime: string };
      overlaps: unknown[];
      overlapWarning: string | null;
    };

    assert.equal(
      detail.booking.grossCents - Math.round((detail.booking.grossCents * detail.booking.commissionBps) / 10_000),
      detail.booking.netCents,
      `gross − commission = net for ${row.reference}`
    );
    assert.equal(detail.booking.checkinTime, '15:00');
    const email = detail.booking.guestEmail;
    assert.equal(
      email === null || typeof email === 'string',
      true,
      'guest email is either absent or text'
    );
    assert.equal(Array.isArray(detail.overlaps), true);
  }
});

test('T-33 a pending stay that overlaps is refused at confirm, and stays pending', async () => {
  const today = todayUTC();
  await createBooking(app, user, {
    propertyId,
    guestName: 'Holder Guest',
    channel: 'direct',
    checkIn: addDays(today, 100),
    checkOut: addDays(today, 105),
    guests: 2,
  });

  const pending = await createBooking(app, user, {
    propertyId,
    guestName: 'Late Import',
    channel: 'airbnb',
    checkIn: addDays(today, 102),
    checkOut: addDays(today, 107),
    guests: 2,
    status: 'pending',
  });

  const attempt = await app.inject({
    method: 'POST',
    url: `/api/bookings/${pending.id}/confirm`,
    headers: { cookie: user.cookie },
  });
  assert.equal(attempt.statusCode, 409, attempt.body);
  assert.match((attempt.json() as { message: string }).message, /same nights/);
  assert.match((attempt.json() as { message: string }).message, /Holder Guest/);

  const after = await app.inject({
    method: 'GET',
    url: `/api/bookings/${pending.id}`,
    headers: { cookie: user.cookie },
  });
  assert.equal((after.json() as { booking: { status: string } }).booking.status, 'pending');

  // ...and a clean pending stay confirms normally.
  const clean = await createBooking(app, user, {
    propertyId,
    guestName: 'Clean Import',
    channel: 'airbnb',
    checkIn: addDays(today, 120),
    checkOut: addDays(today, 122),
    guests: 2,
    status: 'pending',
  });
  const confirmed = await app.inject({
    method: 'POST',
    url: `/api/bookings/${clean.id}/confirm`,
    headers: { cookie: user.cookie },
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal((confirmed.json() as { booking: { status: string } }).booking.status, 'confirmed');
});

test('T-34 cancelling releases the nights for a new guest', async () => {
  const today = todayUTC();
  const booking = await createBooking(app, user, {
    propertyId,
    guestName: 'Cancelled Guest',
    channel: 'direct',
    checkIn: addDays(today, 140),
    checkOut: addDays(today, 144),
    guests: 2,
  });

  const cancelled = await app.inject({
    method: 'POST',
    url: `/api/bookings/${booking.id}/cancel`,
    headers: { cookie: user.cookie },
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal((cancelled.json() as { booking: { status: string } }).booking.status, 'cancelled');

  const replacement = await createBooking(app, user, {
    propertyId,
    guestName: 'Replacement Guest',
    channel: 'direct',
    checkIn: addDays(today, 141),
    checkOut: addDays(today, 143),
    guests: 2,
  });
  assert.equal(typeof replacement.reference, 'string');
});

test('T-35 every channel prices identically in the quote, the write and the summary line', async () => {
  const today = todayUTC();
  const property = await createProperty(app, user, {
    name: 'Pricing House',
    nightlyRateCents: 1_250_000,
    cleaningFeeCents: 250_000,
  });

  let offset = 200;
  for (const channel of CHANNELS) {
    offset += 5;
    const checkIn = addDays(today, offset);
    const checkOut = addDays(today, offset + 4);

    const quoteResponse = await app.inject({
      method: 'GET',
      url: `/api/bookings/quote?propertyId=${property.id}&channel=${channel}&checkIn=${checkIn}&checkOut=${checkOut}&guests=2`,
      headers: { cookie: user.cookie },
    });
    assert.equal(quoteResponse.statusCode, 200, quoteResponse.body);
    const quote = quoteResponse.json() as {
      price: { grossCents: number; netCents: number; commissionBps: number };
      summary: string;
      channelLabel: string;
    };

    const expected = priceStay({
      nights: 4,
      nightlyRateCents: 1_250_000,
      cleaningFeeCents: 250_000,
      channel,
    });

    assert.equal(quote.price.grossCents, expected.grossCents, `${channel} gross`);
    assert.equal(quote.price.netCents, expected.netCents, `${channel} net`);
    assert.equal(quote.price.commissionBps, expected.commissionBps);
    assert.equal(quote.summary, `4 nights · base KES 12,500 + cleaning KES 2,500`);

    const booking = await createBooking(app, user, {
      propertyId: property.id,
      guestName: `Guest ${channel}`,
      channel,
      checkIn,
      checkOut,
      guests: 2,
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/bookings/${booking.id}`,
      headers: { cookie: user.cookie },
    });
    const stored = (detail.json() as {
      booking: { grossCents: number; netCents: number; commissionBps: number };
    }).booking;

    assert.equal(stored.grossCents, expected.grossCents, `${channel} stored gross`);
    assert.equal(stored.netCents, expected.netCents, `${channel} stored net`);
    assert.equal(stored.commissionBps, expected.commissionBps);
  }
});
