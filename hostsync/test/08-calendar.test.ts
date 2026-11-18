/**
 * T-37 / T-40 / T-41 — the calendar grid, sync health and overlap flagging.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { closePool, pool } from '../src/db.ts';
import { createCaptureTransport } from '../src/mail.ts';
import { addDays, todayUTC } from '../src/dates.ts';
import { createBooking, createProperty, deleteUser, signUp } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';

const mailer = createCaptureTransport();
let app: FastifyInstance;
let user: ApiUser;
const emails: string[] = [];
const propertyIds: string[] = [];

interface CalendarBar {
  id: string;
  reference: string;
  guestName: string;
  status: string;
  checkIn: string;
  checkOut: string;
  startIndex: number;
  endIndex: number;
  overlaps: string[];
}

interface CalendarRow {
  propertyId: string;
  name: string;
  bars: CalendarBar[];
  cells: Array<{ date: string; state: string; bookingId: string | null }>;
}

interface CalendarResponse {
  range: { from: string; to: string; days: number; label: string };
  dates: string[];
  rows: CalendarRow[];
  conflicts: number;
  legend: Array<{ key: string; label: string }>;
}

async function calendar(query = ''): Promise<CalendarResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/calendar${query}`,
    headers: { cookie: user.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as CalendarResponse;
}

before(async () => {
  app = buildApp({ mailer });
  await app.ready();
  user = await signUp(app, mailer);
  emails.push(user.email);

  for (const name of ['Alpha Villa', 'Bravo Studio', 'Charlie House', 'Delta Loft', 'Echo Cottage']) {
    const property = await createProperty(app, user, { name });
    propertyIds.push(property.id);
  }
});

after(async () => {
  await app.close();
  for (const email of emails) await deleteUser(email);
  await closePool();
});

test('T-37 five properties by twenty-one days, and every bar spans exactly its nights', async () => {
  const today = todayUTC();
  const grid = await calendar();

  assert.equal(grid.rows.length, 5, 'one row per property');
  assert.equal(grid.dates.length, 21, 'twenty-one day columns');
  assert.equal(grid.range.days, 21);
  assert.equal(grid.range.from, today);

  // A stay starting three days in and running four nights.
  const property = propertyIds[0]!;
  const booking = await createBooking(app, user, {
    propertyId: property,
    guestName: 'Grid Guest',
    channel: 'airbnb',
    checkIn: addDays(today, 3),
    checkOut: addDays(today, 7),
    guests: 2,
  });

  const after = await calendar();
  const row = after.rows.find((entry) => entry.propertyId === property);
  assert.ok(row);

  const bar = row.bars.find((entry) => entry.id === booking.id);
  assert.ok(bar, 'the booking appears as a bar');
  assert.equal(bar.startIndex, 3, 'bar starts on the arrival column');
  assert.equal(bar.endIndex, 7, 'bar ends on the checkout column (exclusive)');
  assert.equal(bar.endIndex - bar.startIndex, 4, 'four nights = four columns');

  assert.equal(row.cells.length, 21);
  assert.equal(row.cells[2]?.state, 'free', 'night before arrival is free');
  assert.equal(row.cells[3]?.state, 'held');
  assert.equal(row.cells[6]?.state, 'held');
  assert.equal(row.cells[7]?.state, 'free', 'checkout day is free for the next arrival');
  assert.equal(row.cells[3]?.bookingId, booking.id);

  // A stay clipped at the start of the window never produces a negative index.
  const clippedGuest = await createBooking(app, user, {
    propertyId: propertyIds[1]!,
    guestName: 'Window Edge Guest',
    channel: 'direct',
    checkIn: today,
    checkOut: addDays(today, 2),
    guests: 1,
  });
  const clipped = (await calendar()).rows.find((entry) => entry.propertyId === propertyIds[1]);
  const clippedBar = clipped?.bars.find((entry) => entry.id === clippedGuest.id);
  assert.equal(clippedBar?.startIndex, 0);
  assert.equal(clippedBar?.endIndex, 2);
});

test('T-37 the legend carries all five channels plus conflict and turnover markers', async () => {
  const grid = await calendar();
  const keys = grid.legend.map((entry) => entry.key);
  assert.deepEqual(keys, ['airbnb', 'booking_com', 'vrbo', 'direct', 'whatsapp', 'conflict', 'turnover']);
  const turnover = grid.legend.find((entry) => entry.key === 'turnover');
  assert.equal(turnover?.label, 'Turnover scheduled');
});

test('T-41 two stays on the same night are both flagged with the other guest named', async () => {
  const today = todayUTC();
  const property = propertyIds[2]!;

  const holder = await createBooking(app, user, {
    propertyId: property,
    guestName: 'Brian Kimani',
    channel: 'direct',
    checkIn: addDays(today, 10),
    checkOut: addDays(today, 14),
    guests: 2,
  });
  const collision = await createBooking(app, user, {
    propertyId: property,
    guestName: 'test',
    channel: 'airbnb',
    checkIn: addDays(today, 12),
    checkOut: addDays(today, 16),
    guests: 2,
    status: 'pending',
  });

  const grid = await calendar();
  const row = grid.rows.find((entry) => entry.propertyId === property);
  const holderBar = row?.bars.find((entry) => entry.id === holder.id);
  const collisionBar = row?.bars.find((entry) => entry.id === collision.id);

  assert.deepEqual(holderBar?.overlaps, [collision.id]);
  assert.deepEqual(collisionBar?.overlaps, [holder.id]);
  assert.ok(grid.conflicts >= 1, 'the grid reports the conflict');

  const detail = await app.inject({
    method: 'GET',
    url: `/api/bookings/${holder.id}`,
    headers: { cookie: user.cookie },
  });
  const body = detail.json() as {
    overlaps: Array<{ guestName: string; checkIn: string; checkOut: string }>;
    overlapWarning: string;
  };
  assert.equal(body.overlapWarning, 'Overlaps 1 other booking');
  assert.equal(body.overlaps[0]?.guestName, 'test');
  assert.equal(body.overlaps[0]?.checkIn, addDays(today, 12));
  assert.equal(body.overlaps[0]?.checkOut, addDays(today, 16));
});

test('T-40 sync health counts the portfolio and reports a non-live stamp when a sync failed', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/sync/health',
    headers: { cookie: user.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);

  const health = response.json() as {
    properties: number;
    confirmedStays: number;
    conflicts: number;
    state: string;
    headline: string;
  };

  assert.equal(health.properties, 5);
  assert.equal(health.state, 'never', 'no feed has been synced yet');
  assert.equal(health.headline, 'Waiting for the first sync');

  // A failed sync must never read as "Live".
  await pool.query(
    `update calendar_feed
        set last_status = 'failed', last_error = '404', last_attempt_at = now()
      where property_id = $1`,
    [propertyIds[3]]
  );
  // (No feed row yet, so create one to represent the failed channel.)
  await pool.query(
    `insert into calendar_feed (property_id, url, source, last_status, last_error, last_attempt_at)
     values ($1, 'https://www.airbnb.com/calendar/ical/9.ics?s=1', 'airbnb', 'failed', '404 not found', now())
     on conflict do nothing`,
    [propertyIds[3]]
  );

  const failed = await app.inject({
    method: 'GET',
    url: '/api/sync/health',
    headers: { cookie: user.cookie },
  });
  const after = failed.json() as { state: string; fresh: boolean; headline: string };
  assert.equal(after.state, 'failed');
  assert.equal(after.fresh, false);
  assert.notEqual(after.headline, 'No double bookings');
});
