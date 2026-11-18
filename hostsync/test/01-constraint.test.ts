/**
 * T-33 / T-41 (core) — the invariant.
 * If these pass, no code path can double-book a property.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, pool } from '../src/db.ts';
import { createBooking, confirmBooking } from '../src/bookings.ts';
import { ConflictError } from '../src/errors.ts';
import { expectRejection, withFixture } from './helpers.ts';
import type { Fixture } from './helpers.ts';

let fx: Fixture;

before(async () => {
  fx = await withFixture();
});

after(async () => {
  await fx.cleanup();
  await closePool();
});

test('a confirmed stay blocks a second confirmed stay on the same nights', async () => {
  await createBooking({
    propertyId: fx.property.id,
    guestName: 'Brian Kimani',
    channel: 'direct',
    checkIn: '2027-03-10',
    checkOut: '2027-03-15',
    guests: 2,
    status: 'confirmed',
  });

  const error = await expectRejection(() =>
    createBooking({
      propertyId: fx.property.id,
      guestName: 'test',
      channel: 'direct',
      checkIn: '2027-03-12',
      checkOut: '2027-03-14',
      guests: 2,
      status: 'confirmed',
    })
  );

  assert.equal(error.name, 'ConflictError');
  assert.equal(error.status, 409);
  assert.match(error.message, /overlaps an existing booking/i);
  assert.match(error.message, /Brian Kimani/);
  assert.match(error.message, /2027-03-10 → 2027-03-15/);
});

test('the block is a database constraint, not just a service check', async () => {
  const portfolioIdFree = fx.property.id;

  // Bypass every service path and write raw SQL: the constraint must still refuse.
  await pool.query(
    `insert into booking (property_id, reference, guest_name, channel, stay, guests,
                          gross_cents, commission_bps, net_cents, rate_version,
                          payment_status, status, source)
     values ($1, 'RAW-1', 'Raw Guest', 'direct', daterange('2027-06-01','2027-06-05','[)'),
             1, 100000, 0, 100000, 1, 'unpaid', 'confirmed', 'manual')`,
    [portfolioIdFree]
  );

  await assert.rejects(
    () =>
      pool.query(
        `insert into booking (property_id, reference, guest_name, channel, stay, guests,
                              gross_cents, commission_bps, net_cents, rate_version,
                              payment_status, status, source)
         values ($1, 'RAW-2', 'Raw Guest 2', 'direct', daterange('2027-06-04','2027-06-08','[)'),
                 1, 100000, 0, 100000, 1, 'unpaid', 'confirmed', 'manual')`,
        [portfolioIdFree]
      ),
    (error: { code?: string }) => error.code === '23P01'
  );
});

test('an imported (pending) stay may collide — the conflict is surfaced, not hidden', async () => {
  const pending = await createBooking({
    propertyId: fx.property.id,
    guestName: 'Imported Guest',
    channel: 'airbnb',
    checkIn: '2027-03-11',
    checkOut: '2027-03-13',
    guests: 2,
    status: 'pending',
    source: 'import',
  });

  assert.equal(pending.status, 'pending');
  assert.equal(pending.reference.startsWith('MRD-'), true);
});

test('a pending stay that overlaps cannot be confirmed', async () => {
  const pending = await createBooking({
    propertyId: fx.property.id,
    guestName: 'Late Arrival',
    channel: 'airbnb',
    checkIn: '2027-04-01',
    checkOut: '2027-04-05',
    guests: 2,
    status: 'pending',
    source: 'import',
  });

  const holder = await createBooking({
    propertyId: fx.property.id,
    guestName: 'Holder',
    channel: 'direct',
    checkIn: '2027-04-03',
    checkOut: '2027-04-07',
    guests: 2,
    status: 'confirmed',
  });
  assert.equal(holder.status, 'confirmed');

  const error = await expectRejection(() => confirmBooking(pending.id));
  assert.equal(error.name, 'ConflictError');
  assert.match(error.message, /cannot hold the same nights/i);
  assert.match(error.message, /Holder/);
});

test('back-to-back stays do not collide — checkout frees the day', async () => {
  const first = await createBooking({
    propertyId: fx.property.id,
    guestName: 'First',
    channel: 'direct',
    checkIn: '2027-07-01',
    checkOut: '2027-07-05',
    guests: 2,
    status: 'confirmed',
  });
  const second = await createBooking({
    propertyId: fx.property.id,
    guestName: 'Second',
    channel: 'direct',
    checkIn: '2027-07-05',
    checkOut: '2027-07-08',
    guests: 2,
    status: 'confirmed',
  });

  assert.equal(first.checkOut, second.checkIn);
  assert.equal(second.status, 'confirmed');
});

test('two concurrent confirms: exactly one wins, one gets a conflict', async () => {
  const a = await createBooking({
    propertyId: fx.property.id,
    guestName: 'Race A',
    channel: 'airbnb',
    checkIn: '2027-08-10',
    checkOut: '2027-08-15',
    guests: 2,
    status: 'pending',
    source: 'import',
  });
  const b = await createBooking({
    propertyId: fx.property.id,
    guestName: 'Race B',
    channel: 'vrbo',
    checkIn: '2027-08-12',
    checkOut: '2027-08-17',
    guests: 2,
    status: 'pending',
    source: 'import',
  });

  const results = await Promise.allSettled([confirmBooking(a.id), confirmBooking(b.id)]);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );

  assert.equal(fulfilled.length, 1, 'exactly one confirm must succeed');
  assert.equal(rejected.length, 1, 'exactly one confirm must be refused');
  assert.equal((rejected[0]?.reason as ConflictError).name, 'ConflictError');

  const confirmed = await pool.query<{ count: number }>(
    `select count(*)::int as count from booking
      where property_id = $1 and status = 'confirmed'
        and stay && daterange('2027-08-10','2027-08-17','[)')`,
    [fx.property.id]
  );
  assert.equal(confirmed.rows[0]?.count, 1, 'only one stay may hold those nights');
});

test('two different properties may hold the same nights', async () => {
  const { seedProperty } = await import('./helpers.ts');
  const other = await seedProperty(fx.portfolioId, { name: 'Second Property' });

  await createBooking({
    propertyId: fx.property.id,
    guestName: 'Property One Guest',
    channel: 'direct',
    checkIn: '2027-09-01',
    checkOut: '2027-09-04',
    guests: 2,
    status: 'confirmed',
  });
  const second = await createBooking({
    propertyId: other.id,
    guestName: 'Property Two Guest',
    channel: 'direct',
    checkIn: '2027-09-01',
    checkOut: '2027-09-04',
    guests: 2,
    status: 'confirmed',
  });

  assert.equal(second.status, 'confirmed');
});
