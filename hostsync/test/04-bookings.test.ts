/**
 * T-28 / T-30 / T-31 / T-34 / T-35(integration) / T-36 — bookings.
 * The date and capacity rules here are the ones the original app is missing
 * (spec §7.4 #1 and #6).
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../src/db.ts';
import {
  cancelBooking,
  createBooking,
  findOverlaps,
  getBooking,
  listBookings,
} from '../src/bookings.ts';
import { expectRejection, withFixture } from './helpers.ts';
import type { Fixture } from './helpers.ts';

let current: Fixture | null = null;

async function fixture(): Promise<Fixture> {
  current = await withFixture();
  return current;
}

afterEach(async () => {
  if (current) {
    await current.cleanup();
    current = null;
  }
});

const base = {
  guestName: 'Sofia Almeida',
  channel: 'direct',
  guests: 2,
  today: '2026-11-14',
} as const;

test('zero-night and inverted stays are refused — the defect the original ships with', async () => {
  const fx = await fixture();

  const zero = await expectRejection(() =>
    createBooking({
      ...base,
      propertyId: fx.property.id,
      checkIn: '2027-02-10',
      checkOut: '2027-02-10',
    })
  );
  assert.equal(zero.status, 422);
  assert.match(zero.message, /check-out must be after check-in/);

  const inverted = await expectRejection(() =>
    createBooking({
      ...base,
      propertyId: fx.property.id,
      checkIn: '2027-02-10',
      checkOut: '2027-02-08',
    })
  );
  assert.equal(inverted.status, 422);
  assert.match(inverted.message, /check-out must be after check-in/);
});

test('a manual booking cannot be back-dated, but an imported one can', async () => {
  const fx = await fixture();

  const past = await expectRejection(() =>
    createBooking({
      ...base,
      propertyId: fx.property.id,
      checkIn: '2020-01-01',
      checkOut: '2020-01-04',
    })
  );
  assert.equal(past.status, 422);
  assert.match(past.message, /in the past/);

  const imported = await createBooking({
    ...base,
    propertyId: fx.property.id,
    channel: 'airbnb',
    checkIn: '2020-01-01',
    checkOut: '2020-01-04',
    source: 'import',
    status: 'pending',
    today: '2026-11-14',
  });
  assert.equal(imported.status, 'pending');
});

test('capacity is enforced against the property, not the form', async () => {
  const fx = await fixture(); // sleeps 4

  const tooMany = await expectRejection(() =>
    createBooking({
      ...base,
      propertyId: fx.property.id,
      guests: 5,
      checkIn: '2027-02-10',
      checkOut: '2027-02-12',
    })
  );
  assert.equal(tooMany.status, 422);
  assert.match(tooMany.message, /sleeps 4/);

  const zero = await expectRejection(() =>
    createBooking({
      ...base,
      propertyId: fx.property.id,
      guests: 0,
      checkIn: '2027-02-10',
      checkOut: '2027-02-12',
    })
  );
  assert.equal(zero.status, 422);
});

test('stays longer than 90 nights are refused', async () => {
  const fx = await fixture();

  const error = await expectRejection(() =>
    createBooking({
      ...base,
      propertyId: fx.property.id,
      checkIn: '2027-02-01',
      checkOut: '2027-06-01',
    })
  );
  assert.equal(error.status, 422);
  assert.match(error.message, /cannot exceed 90 nights/);
});

test('the reference is human-facing and prefixed by source', async () => {
  const fx = await fixture();

  const manual = await createBooking({
    ...base,
    propertyId: fx.property.id,
    channel: 'direct',
    checkIn: '2027-02-10',
    checkOut: '2027-02-12',
  });
  assert.match(manual.reference, /^HS-\d+$/);

  const imported = await createBooking({
    ...base,
    propertyId: fx.property.id,
    channel: 'airbnb',
    checkIn: '2027-02-20',
    checkOut: '2027-02-22',
    source: 'import',
    status: 'pending',
  });
  assert.match(imported.reference, /^MRD-\d+$/);
});

test('price is computed server-side from the property, per channel', async () => {
  const fx = await fixture();

  const direct = await createBooking({
    ...base,
    propertyId: fx.property.id,
    channel: 'direct',
    checkIn: '2027-02-10',
    checkOut: '2027-02-13',
  });
  // 3 × 15,000 + 3,000 = 48,000
  assert.equal(direct.grossCents, 4_800_000);
  assert.equal(direct.commissionBps, 0);
  assert.equal(direct.netCents, 4_800_000);

  const airbnb = await createBooking({
    ...base,
    propertyId: fx.property.id,
    channel: 'airbnb',
    checkIn: '2027-03-10',
    checkOut: '2027-03-13',
    status: 'confirmed',
  });
  assert.equal(airbnb.grossCents, 4_800_000);
  assert.equal(airbnb.commissionBps, 1500);
  assert.equal(airbnb.netCents, 4_080_000);
});

test('overlap preview distinguishes held nights from pending ones', async () => {
  const fx = await fixture();

  await createBooking({
    ...base,
    propertyId: fx.property.id,
    channel: 'direct',
    checkIn: '2027-04-01',
    checkOut: '2027-04-05',
    status: 'confirmed',
  });
  await createBooking({
    ...base,
    propertyId: fx.property.id,
    channel: 'airbnb',
    checkIn: '2027-04-10',
    checkOut: '2027-04-12',
    status: 'pending',
    source: 'import',
  });

  const held = await findOverlaps({
    propertyId: fx.property.id,
    checkIn: '2027-04-03',
    checkOut: '2027-04-04',
  });
  assert.equal(held.length, 1);
  assert.equal(held[0]?.status, 'confirmed');

  const pendingOnly = await findOverlaps({
    propertyId: fx.property.id,
    checkIn: '2027-04-10',
    checkOut: '2027-04-11',
  });
  assert.equal(pendingOnly.length, 1);
  assert.equal(pendingOnly[0]?.status, 'pending');

  const confirmedOnly = await findOverlaps({
    propertyId: fx.property.id,
    checkIn: '2027-04-10',
    checkOut: '2027-04-11',
    includePending: false,
  });
  assert.equal(confirmedOnly.length, 0);

  const adjacent = await findOverlaps({
    propertyId: fx.property.id,
    checkIn: '2027-04-05',
    checkOut: '2027-04-06',
  });
  assert.equal(adjacent.length, 0, 'checkout day is free for the next arrival');
});

test('cancelling frees the nights for a new booking', async () => {
  const fx = await fixture();

  const first = await createBooking({
    ...base,
    propertyId: fx.property.id,
    channel: 'direct',
    checkIn: '2027-05-01',
    checkOut: '2027-05-05',
    status: 'confirmed',
  });

  const blocked = await expectRejection(() =>
    createBooking({
      ...base,
      propertyId: fx.property.id,
      channel: 'direct',
      checkIn: '2027-05-02',
      checkOut: '2027-05-04',
      status: 'confirmed',
    })
  );
  assert.equal(blocked.name, 'ConflictError');

  const cancelled = await cancelBooking(first.id);
  assert.equal(cancelled.status, 'cancelled');

  const replacement = await createBooking({
    ...base,
    propertyId: fx.property.id,
    channel: 'direct',
    checkIn: '2027-05-02',
    checkOut: '2027-05-04',
    status: 'confirmed',
  });
  assert.equal(replacement.status, 'confirmed');
});

test('cancelling is idempotent and refuses completed stays', async () => {
  const fx = await fixture();

  const booking = await createBooking({
    ...base,
    propertyId: fx.property.id,
    channel: 'direct',
    checkIn: '2027-06-01',
    checkOut: '2027-06-03',
    status: 'confirmed',
  });

  const once = await cancelBooking(booking.id);
  const twice = await cancelBooking(booking.id);
  assert.equal(once.status, 'cancelled');
  assert.equal(twice.status, 'cancelled');
  assert.equal(twice.version, once.version, 'a repeat cancel must not bump the version again');
});

test('the ledger filters by channel and status', async () => {
  const fx = await fixture();

  await createBooking({ ...base, propertyId: fx.property.id, channel: 'airbnb', checkIn: '2027-07-01', checkOut: '2027-07-03', status: 'confirmed' });
  await createBooking({ ...base, propertyId: fx.property.id, channel: 'airbnb', checkIn: '2027-07-10', checkOut: '2027-07-12', status: 'pending', source: 'import' });
  await createBooking({ ...base, propertyId: fx.property.id, channel: 'direct', checkIn: '2027-07-20', checkOut: '2027-07-22', status: 'confirmed' });

  const airbnb = await listBookings({ propertyId: fx.property.id, channel: 'airbnb' });
  assert.equal(airbnb.length, 2);
  assert.equal(airbnb.every((booking) => booking.channel === 'airbnb'), true);

  const pending = await listBookings({ propertyId: fx.property.id, status: 'pending' });
  assert.equal(pending.length, 1);

  const confirmed = await listBookings({ propertyId: fx.property.id, status: 'confirmed' });
  assert.equal(confirmed.length, 2);
});

test('a missing property is a 404, not a crash', async () => {
  const error = await expectRejection(() =>
    createBooking({
      ...base,
      propertyId: '00000000-0000-0000-0000-000000000000',
      checkIn: '2027-08-01',
      checkOut: '2027-08-03',
    })
  );
  assert.equal(error.name, 'NotFoundError');
  assert.equal(error.status, 404);
});

test.after(async () => {
  await closePool();
});
