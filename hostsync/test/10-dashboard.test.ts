/**
 * T-14 / T-15 / T-16 / T-17 / T-18 / T-19 — dashboard essentials.
 *
 * Past-dated rows are seeded with SQL because the API (correctly) refuses to
 * back-date a manual booking; the aggregates are then computed independently
 * in this file from the seeded values.
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

interface Dashboard {
  currency: string;
  kpis: {
    netRevenueThisMonthCents: number;
    occupancyLast30Pct: number;
    turnoversDue48h: number;
    guestRating: number | null;
    reviewCount: number;
  };
  calendarClear: { clear: boolean; conflicts: number; label: string; detail: string };
  chart: Array<{ month: string; revenueCents: number; nights: number; occupancyPct: number }>;
  payouts: { amountCents: number; count: number };
  turnovers: Array<{
    id: string;
    propertyName: string;
    windowStart: string;
    windowEnd: string;
    assignee: string | null;
    status: string;
  }>;
  health: Array<{
    propertyId: string;
    name: string;
    status: string;
    occupancyPct: number;
    nextArrival: string | null;
    nextArrivalLabel: string;
    account: { label: string; verified: boolean; balanceCents: number } | null;
    nightlyRateCents: number;
  }>;
}

async function dashboard(forUser: ApiUser = user): Promise<Dashboard> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/dashboard',
    headers: { cookie: forUser.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as Dashboard;
}

/** The first day of the month `offset` months from this one, as YYYY-MM-DD. */
function monthStart(offset: number): string {
  const [year, month] = todayUTC().split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1 + offset, 1)).toISOString().slice(0, 10);
}

function daysInMonth(monthKey: string): number {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(year!, month!, 0)).getUTCDate();
}

async function seedPastBooking(input: {
  propertyId: string;
  checkIn: string;
  checkOut: string;
  netCents: number;
  status?: string;
}): Promise<void> {
  await pool.query(
    `insert into booking (
       property_id, reference, guest_name, channel, stay, guests,
       gross_cents, commission_bps, net_cents, rate_version,
       payment_status, status, source
     ) values (
       $1, 'SEED-' || nextval('booking_ref_seq'), 'Seeded Guest', 'direct',
       daterange($2::date, $3::date, '[)'), 2,
       $4, 0, $4, 1, 'paid', $5, 'import'
     )`,
    [input.propertyId, input.checkIn, input.checkOut, input.netCents, input.status ?? 'confirmed']
  );
}

before(async () => {
  app = buildApp({ mailer });
  await app.ready();
  user = await signUp(app, mailer);
  emails.push(user.email);
});

after(async () => {
  await app.close();
  for (const email of emails) await deleteUser(email);
  await closePool();
});

test('T-14 the four KPIs equal values computed from the seeded rows', async () => {
  const today = todayUTC();
  const monthStart = `${today.slice(0, 7)}-01`;

  const properties = [];
  for (const name of ['Villa One', 'Villa Two', 'Villa Three', 'Villa Four', 'Villa Five']) {
    properties.push(await createProperty(app, user, { name, guests: 4 }));
  }
  const property = properties[0]!;

  // Revenue inside the current month (check-in on/after the 1st).
  await seedPastBooking({
    propertyId: property.id,
    checkIn: today,
    checkOut: addDays(today, 3),
    netCents: 1_200_000,
  });

  // Occupancy inside the last 30 days.
  const occupancySeeds = [
    { checkIn: addDays(today, -12), checkOut: addDays(today, -10), netCents: 700_000 },
    { checkIn: addDays(today, -20), checkOut: addDays(today, -17), netCents: 900_000 },
    { checkIn: addDays(today, -5), checkOut: addDays(today, 1), netCents: 400_000 },
  ];
  for (const seed of occupancySeeds) {
    await seedPastBooking({ propertyId: properties[1]!.id, ...seed });
  }

  // Turnovers: +24 h and +47 h count, +49 h does not.
  const taskRows: Array<[string, number]> = [
    [properties[0]!.id, 24],
    [properties[1]!.id, 47],
    [properties[2]!.id, 49],
  ];
  for (const [propertyId, hours] of taskRows) {
    await pool.query(
      `insert into task (property_id, kind, window_start, window_end, status)
       values ($1, 'turnover', now() + ($2 || ' hours')::interval, now() + ($2 || ' hours')::interval + interval '2 hours', 'scheduled')`,
      [propertyId, String(hours)]
    );
  }

  // Reviews: six, averaging 4.5.
  for (const rating of [5, 5, 4, 4, 5, 4]) {
    await pool.query(
      `insert into review (property_id, rating, channel, guest_name, body)
       values ($1, $2, 'airbnb', 'Guest', 'Lovely stay')`,
      [properties[3]!.id, rating]
    );
  }

  const data = await dashboard();

  const revenueSeeds = [1_200_000, ...occupancySeeds.map((seed) => seed.netCents)].filter(
    (_value, index) => index === 0
  );
  // Only the first seed has a check-in inside the current month; the others are earlier.
  const expectedRevenue = occupancySeeds.some((seed) => seed.checkIn >= monthStart)
    ? revenueSeeds[0]! + occupancySeeds
        .filter((seed) => seed.checkIn >= monthStart)
        .reduce((sum, seed) => sum + seed.netCents, 0)
    : revenueSeeds[0]!;

  // Occupancy: 2 + 3 nights, plus the third seed clipped at today (5 of its 6).
  const expectedNights = 2 + 3 + 5;
  const expectedOccupancy = Math.round((expectedNights / (30 * properties.length)) * 100);

  assert.equal(data.kpis.netRevenueThisMonthCents, expectedRevenue);
  assert.equal(data.kpis.occupancyLast30Pct, expectedOccupancy);
  assert.equal(data.kpis.turnoversDue48h, 2, 'only the two inside 48 h');
  assert.equal(data.kpis.guestRating, 4.5);
  assert.equal(data.kpis.reviewCount, 6);
  assert.equal(data.currency, 'KES');
});

test('T-16 calendar-clear reads clear with no overlap, and flips when an imported stay collides', async () => {
  const today = todayUTC();
  const property = await createProperty(app, user, { name: 'Clear House' });

  const clear = await dashboard();
  assert.equal(clear.calendarClear.clear, true);
  assert.equal(clear.calendarClear.label, 'CALENDAR CLEAR');
  assert.equal(clear.calendarClear.detail, 'No overlapping nights');

  await createBooking(app, user, {
    propertyId: property.id,
    guestName: 'Brian Kimani',
    channel: 'direct',
    checkIn: addDays(today, 200),
    checkOut: addDays(today, 204),
    guests: 2,
  });
  await createBooking(app, user, {
    propertyId: property.id,
    guestName: 'test',
    channel: 'airbnb',
    checkIn: addDays(today, 202),
    checkOut: addDays(today, 206),
    guests: 2,
    status: 'pending',
  });

  const overlapping = await dashboard();
  assert.equal(overlapping.calendarClear.clear, false);
  assert.equal(overlapping.calendarClear.label, 'OVERLAP FOUND');
  assert.equal(overlapping.calendarClear.conflicts, 1);
  assert.match(overlapping.calendarClear.detail, /1 overlapping night/);
});

test('T-19 the health table reports occupancy, next arrival, account and status per property', async () => {
  const today = todayUTC();
  const property = await createProperty(app, user, { name: 'Health House', status: 'live' });

  await createBooking(app, user, {
    propertyId: property.id,
    guestName: 'Tomorrow Guest',
    channel: 'direct',
    checkIn: addDays(today, 1),
    checkOut: addDays(today, 4),
    guests: 2,
  });

  await app.inject({
    method: 'PUT',
    url: `/api/properties/${property.id}/account`,
    headers: { cookie: user.cookie },
    payload: { label: 'KCB 3310', verified: true, balanceCents: 2_500_000 },
  });

  const data = await dashboard();
  const row = data.health.find((entry) => entry.propertyId === property.id);
  assert.ok(row);

  // Three nights booked over the 30-day window → 10 %.
  assert.equal(row.occupancyPct, 10);
  assert.equal(row.nextArrival, addDays(today, 1));
  assert.equal(row.nextArrivalLabel, 'Tomorrow');
  assert.equal(row.account?.label, 'KCB 3310');
  assert.equal(row.account?.balanceCents, 2_500_000);
  assert.equal(row.status, 'live');
  assert.equal(row.nightlyRateCents, 1_500_000);
});

test('T-15 six seeded months become six ordered buckets with the right revenue and occupancy', async () => {
  const owner = await signUp(app, mailer, 'CHART');
  emails.push(owner.email);
  const property = await createProperty(app, owner, { name: 'Chart House' });

  // One stay per month, always fully inside its month, with a different
  // length so occupancy cannot be a constant dressed up as data.
  const nightsPerMonth = [4, 6, 3, 5, 7, 2];
  const offsets = [-5, -4, -3, -2, -1, 0];
  const expected = offsets.map((offset, index) => {
    const start = monthStart(offset);
    const nights = nightsPerMonth[index]!;
    const netCents = 250_000 + index * 150_000;
    return { start, month: start.slice(0, 7), nights, netCents };
  });

  for (const seed of expected) {
    await seedPastBooking({
      propertyId: property.id,
      checkIn: seed.start,
      checkOut: addDays(seed.start, seed.nights),
      netCents: seed.netCents,
    });
  }

  const data = await dashboard(owner);

  assert.equal(data.chart.length, 6, 'exactly six buckets');
  assert.deepEqual(
    data.chart.map((bucket) => bucket.month),
    expected.map((seed) => seed.month),
    'oldest first, one per month, no gaps'
  );

  for (const [index, bucket] of data.chart.entries()) {
    const seed = expected[index]!;
    assert.equal(bucket.revenueCents, seed.netCents, `revenue for ${seed.month}`);
    assert.equal(bucket.nights, seed.nights, `nights for ${seed.month}`);
    assert.equal(
      bucket.occupancyPct,
      Math.round((seed.nights / daysInMonth(seed.month)) * 100),
      `occupancy for ${seed.month} is nights / days in that month`
    );
  }

  assert.equal(data.chart.at(-1)?.month, todayUTC().slice(0, 7), 'the last bucket is this month');
});

test('T-17 the payout widget sums draft and approved statements, and excludes paid ones', async () => {
  const owner = await signUp(app, mailer, 'PAYOUTS');
  emails.push(owner.email);
  const property = await createProperty(app, owner, { name: 'Payout House' });

  async function seedStatement(input: {
    monthOffset: number;
    netCents: number;
    status: 'draft' | 'approved' | 'paid';
  }): Promise<void> {
    const start = monthStart(input.monthOffset);
    const feeCents = Math.round(input.netCents / 9);
    await pool.query(
      `insert into statement (
         portfolio_id, property_id, owner_name, period_start, period_end,
         gross_cents, expenses_cents, fee_bps, fee_cents, net_cents, status
       ) values (
         $1, $2, 'Payout Owner', $3::date, ($3::date + interval '1 month')::date,
         $4, 0, 1000, $5, $6, $7
       )`,
      [
        owner.portfolioId,
        property.id,
        start,
        input.netCents + feeCents,
        feeCents,
        input.netCents,
        input.status,
      ]
    );
  }

  await seedStatement({ monthOffset: -3, netCents: 90_000, status: 'draft' });
  await seedStatement({ monthOffset: -2, netCents: 110_000, status: 'approved' });
  await seedStatement({ monthOffset: -1, netCents: 500_000, status: 'paid' });

  const data = await dashboard(owner);
  assert.equal(data.payouts.count, 2, 'draft and approved only');
  assert.equal(data.payouts.amountCents, 200_000, 'paid money is not still payable');
});

test('T-18 only turnovers inside the next 48 hours are listed', async () => {
  const owner = await signUp(app, mailer, 'TURNOVERS');
  emails.push(owner.email);
  const property = await createProperty(app, owner, { name: 'Turnover House' });

  const rows: Array<{ hours: number; assignee: string | null; status: string }> = [
    { hours: 24, assignee: 'Mary Wanjiku', status: 'scheduled' },
    { hours: 47, assignee: 'Peter Otieno', status: 'in_progress' },
    { hours: 49, assignee: null, status: 'scheduled' },
  ];
  for (const row of rows) {
    await pool.query(
      `insert into task (property_id, kind, window_start, window_end, status, assignee)
       values ($1, 'turnover',
               now() + ($2 || ' hours')::interval,
               now() + ($2 || ' hours')::interval + interval '4 hours',
               $3, $4)`,
      [property.id, String(row.hours), row.status, row.assignee]
    );
  }

  const data = await dashboard(owner);

  assert.equal(data.turnovers.length, 2, 'the +49 h task is not due yet');
  assert.equal(data.kpis.turnoversDue48h, 2, 'the KPI counts the same list');
  assert.deepEqual(
    data.turnovers.map((row) => row.propertyName),
    ['Turnover House', 'Turnover House']
  );
  assert.equal(data.turnovers[0]?.assignee, 'Mary Wanjiku');
  assert.equal(data.turnovers[0]?.status, 'scheduled');
  assert.equal(data.turnovers[1]?.assignee, 'Peter Otieno');
  assert.equal(data.turnovers[1]?.status, 'in_progress');
  assert.ok(
    Date.parse(data.turnovers[0]!.windowStart) < Date.parse(data.turnovers[1]!.windowStart),
    'the list is ordered by window start'
  );
});
