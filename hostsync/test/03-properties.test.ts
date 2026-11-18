/**
 * T-21 / T-22 / T-23 / T-24 — properties.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../src/db.ts';
import {
  archiveProperty,
  createProperty,
  getProperty,
  listProperties,
  updateProperty,
} from '../src/properties.ts';
import { createBooking } from '../src/bookings.ts';
import { expectRejection, seedProperty, withFixture } from './helpers.ts';
import type { Fixture } from './helpers.ts';

let current: Fixture | null = null;

async function fixture(overrides = {}): Promise<Fixture> {
  current = await withFixture(overrides);
  return current;
}

afterEach(async () => {
  if (current) {
    await current.cleanup();
    current = null;
  }
});

test('creates a property with the fields the product shows on a card', async () => {
  const fx = await fixture();
  const property = fx.property;

  assert.equal(property.name, 'Karen Cottage');
  assert.equal(property.status, 'live');
  assert.equal(property.nightlyRateCents, 1_500_000);
  assert.equal(property.cleaningFeeCents, 300_000);
  assert.equal(property.managementFeeBps, 1500);
  assert.equal(property.guests, 4);
  assert.equal(property.checkinTime, '15:00');
  assert.equal(property.checkoutTime, '11:00');
  assert.equal(property.currency, 'KES');
  assert.match(property.id, /^[0-9a-f-]{36}$/);
});

test('rejects a management fee outside 0–100 %', async () => {
  const fx = await fixture();

  for (const bps of [10_001, -1]) {
    const error = await expectRejection(() =>
      createProperty({
        portfolioId: fx.portfolioId,
        name: 'Bad Fee',
        nightlyRateCents: 1_000_000,
        managementFeeBps: bps,
      })
    );
    assert.equal(error.name, 'ValidationError', `bps=${bps}`);
    assert.equal(error.status, 422);
    assert.equal(error.message.includes('managementFeeBps'), true);
  }
});

test('rejects a zero or negative nightly rate, an empty name, and a bad email', async () => {
  const fx = await fixture();
  const base = {
    portfolioId: fx.portfolioId,
    name: 'X',
    nightlyRateCents: 1_000_000,
  };

  const zeroRate = await expectRejection(() =>
    createProperty({ ...base, nightlyRateCents: 0 })
  );
  assert.equal(zeroRate.status, 422);

  const blankName = await expectRejection(() => createProperty({ ...base, name: '   ' }));
  assert.equal(blankName.status, 422);
  assert.match(blankName.message, /name is required/);

  const badEmail = await expectRejection(() =>
    createProperty({ ...base, ownerEmail: 'not-an-email' })
  );
  assert.equal(badEmail.status, 422);

  const badGuests = await expectRejection(() => createProperty({ ...base, guests: 0 }));
  assert.equal(badGuests.status, 422);
  assert.equal(badGuests.message.includes('guests'), true);
});

test('edits persist and are visible on re-read', async () => {
  const fx = await fixture();
  const updated = await updateProperty(fx.property.id, {
    nightlyRateCents: 1_800_000,
    name: 'Karen Cottage (Renovated)',
  });

  assert.equal(updated.nightlyRateCents, 1_800_000);
  assert.equal(updated.name, 'Karen Cottage (Renovated)');

  const reread = await getProperty(fx.property.id);
  assert.equal(reread.nightlyRateCents, 1_800_000);
});

test('a rate change never rewrites an existing booking (the price snapshot)', async () => {
  const fx = await fixture();

  const booking = await createBooking({
    propertyId: fx.property.id,
    guestName: 'Elena Petrova',
    channel: 'airbnb',
    checkIn: '2027-05-05',
    checkOut: '2027-05-08',
    guests: 2,
    status: 'confirmed',
    today: '2026-11-14',
  });

  // 3 nights × 15,000 + 3,000 = 48,000 gross; airbnb 15 % → 40,800 net
  assert.equal(booking.grossCents, 4_800_000);
  assert.equal(booking.netCents, 4_080_000);

  await updateProperty(fx.property.id, { nightlyRateCents: 2_000_000 });

  const { getBooking } = await import('../src/bookings.ts');
  const after = await getBooking(booking.id);

  assert.equal(after.grossCents, 4_800_000, 'history must not move with the rate');
  assert.equal(after.netCents, 4_080_000);
  assert.equal(after.rateVersion, booking.rateVersion);
});

test('status moves onboarding → live', async () => {
  const fx = await fixture({ status: 'onboarding' });
  assert.equal(fx.property.status, 'onboarding');

  const live = await updateProperty(fx.property.id, { status: 'live' });
  assert.equal(live.status, 'live');
});

test('archiving is refused while upcoming bookings exist', async () => {
  const fx = await fixture();

  await createBooking({
    propertyId: fx.property.id,
    guestName: 'Future Guest',
    channel: 'direct',
    checkIn: '2027-06-01',
    checkOut: '2027-06-04',
    guests: 2,
    status: 'confirmed',
    today: '2026-11-14',
  });

  const error = await expectRejection(() => archiveProperty(fx.property.id));
  assert.equal(error.name, 'ConflictError');
  assert.match(error.message, /upcoming booking/);
});

test('archiving succeeds on a clean property and hides it from the list', async () => {
  const fx = await fixture();
  const archived = await archiveProperty(fx.property.id);
  assert.equal(archived.status, 'archived');

  const listed = await listProperties(fx.portfolioId);
  assert.equal(listed.some((property) => property.id === fx.property.id), false);

  // ...but the archive view still holds it, so nothing is lost.
  const archivedList = await listProperties(fx.portfolioId, { includeArchived: true });
  const found = archivedList.find((property) => property.id === fx.property.id);
  assert.equal(found?.status, 'archived');
});

test('the list is ordered by name', async () => {
  const fx = await fixture();
  await seedProperty(fx.portfolioId, { name: 'Aardvark Villa' });
  await seedProperty(fx.portfolioId, { name: 'Zebra Studio' });

  const listed = await listProperties(fx.portfolioId);
  const names = listed.map((property) => property.name);
  assert.deepEqual(names, [...names].sort());
});

test.after(async () => {
  await closePool();
});
