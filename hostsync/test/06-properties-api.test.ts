/**
 * T-21 .. T-25, T-27 — properties over the real API.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { closePool } from '../src/db.ts';
import { createCaptureTransport } from '../src/mail.ts';
import { addDays, todayUTC } from '../src/dates.ts';
import { createProperty, deleteUser, signUp } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';

const mailer = createCaptureTransport();
let app: FastifyInstance;
let user: ApiUser;
const emails: string[] = [];

interface Card {
  id: string;
  name: string;
  status: string;
  occupancyPct: number;
  nightsBooked: number;
  channels: string[];
  nextArrival: string | null;
  account: { label: string; verified: boolean; balanceCents: number } | null;
  nightlyRateCents: number;
  bedrooms: number | null;
  baths: number | null;
  guests: number | null;
  ownerName: string | null;
}

async function properties(): Promise<Card[]> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/properties',
    headers: { cookie: user.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { properties: Card[] }).properties;
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

test('T-21 cards carry rate, layout, occupancy, channels, account, arrival, owner, status', async () => {
  const today = todayUTC();

  const cottage = await createProperty(app, user, { name: 'Karen Cottage' });
  await createProperty(app, user, {
    name: 'Riverside Studio',
    status: 'onboarding',
    type: 'studio',
    bedrooms: 1,
    baths: 1,
    guests: 2,
    nightlyRateCents: 750_000,
    cleaningFeeCents: 150_000,
    channels: ['direct'],
  });

  // 10 nights inside the 30-day window → 33 % occupancy.
  await app.inject({
    method: 'POST',
    url: '/api/bookings',
    headers: { cookie: user.cookie },
    payload: {
      propertyId: cottage.id,
      guestName: 'Amina Yusuf',
      channel: 'airbnb',
      checkIn: addDays(today, 2),
      checkOut: addDays(today, 12),
      guests: 2,
    },
  });

  const account = await app.inject({
    method: 'PUT',
    url: `/api/properties/${cottage.id}/account`,
    headers: { cookie: user.cookie },
    payload: { label: 'KCB 3310', verified: true, balanceCents: 1_234_500 },
  });
  assert.equal(account.statusCode, 200, account.body);

  const cards = await properties();
  assert.equal(cards.length, 2);

  const card = cards.find((entry) => entry.name === 'Karen Cottage');
  assert.ok(card);

  assert.equal(card.nightlyRateCents, 1_500_000);
  assert.equal(card.bedrooms, 2);
  assert.equal(card.baths, 2);
  assert.equal(card.guests, 4, 'sleeps');
  assert.equal(card.nightsBooked, 10);
  assert.equal(card.occupancyPct, 33);
  assert.deepEqual(card.channels, ['airbnb']);
  assert.equal(card.account?.label, 'KCB 3310');
  assert.equal(card.account?.verified, true);
  assert.equal(card.account?.balanceCents, 1_234_500);
  assert.equal(card.nextArrival, addDays(today, 2));
  assert.equal(card.ownerName, 'David Mwangi');
  assert.equal(card.status, 'live');

  const studio = cards.find((entry) => entry.name === 'Riverside Studio');
  assert.equal(studio?.status, 'onboarding');
  assert.equal(studio?.occupancyPct, 0);
  assert.equal(studio?.account, null);
});

test('T-22 a full property payload is accepted; an impossible fee is a field error', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/properties',
    headers: { cookie: user.cookie },
    payload: {
      name: 'Nyali Beach House',
      status: 'live',
      type: 'house',
      neighbourhood: 'Nyali',
      city: 'Mombasa',
      address: '12 Beach Road',
      bedrooms: 4,
      baths: 3,
      guests: 8,
      nightlyRateCents: 2_600_000,
      cleaningFeeCents: 500_000,
      managementFeePercent: 20,
      ownerName: 'Grace Achieng',
      ownerEmail: 'grace@example.com',
      photoKey: 'properties/nyali/cover.jpg',
      channels: ['airbnb', 'booking_com', 'vrbo'],
    },
  });

  assert.equal(response.statusCode, 201, response.body);
  const property = (response.json() as { property: { id: string; managementFeeBps: number } })
    .property;
  assert.equal(property.managementFeeBps, 2000, '20 % is stored as 2000 bps');

  const badFee = await app.inject({
    method: 'POST',
    url: '/api/properties',
    headers: { cookie: user.cookie },
    payload: { name: 'Bad Fee', nightlyRateCents: 1_000_000, managementFeePercent: 150 },
  });
  assert.equal(badFee.statusCode, 422);
  const error = badFee.json() as { field?: string; message: string };
  assert.ok(error.field, 'the form needs a field to highlight');
  assert.match(error.message, /managementFeeBps/);
});

test('T-23 editing the rate changes the card and all future pricing', async () => {
  const property = await createProperty(app, user, { name: 'Westlands Loft' });

  const patch = await app.inject({
    method: 'PATCH',
    url: `/api/properties/${property.id}`,
    headers: { cookie: user.cookie },
    payload: { nightlyRateCents: 1_850_000 },
  });
  assert.equal(patch.statusCode, 200, patch.body);
  assert.equal((patch.json() as { property: { nightlyRateCents: number } }).property.nightlyRateCents, 1_850_000);

  const card = (await properties()).find((entry) => entry.id === property.id);
  assert.equal(card?.nightlyRateCents, 1_850_000);

  const quote = await app.inject({
    method: 'GET',
    url: `/api/bookings/quote?propertyId=${property.id}&channel=airbnb&checkIn=${addDays(todayUTC(), 5)}&checkOut=${addDays(todayUTC(), 7)}&guests=2`,
    headers: { cookie: user.cookie },
  });
  assert.equal(quote.statusCode, 200, quote.body);
  const price = (quote.json() as { price: { grossCents: number; netCents: number } }).price;
  // 2 × 18,500 + 3,000 cleaning = 40,000 gross; 15 % commission → 34,000 net.
  assert.equal(price.grossCents, 4_000_000);
  assert.equal(price.netCents, 3_400_000);
});

test('T-24 onboarding flips to live and that is what the card and health table read', async () => {
  const property = await createProperty(app, user, { name: 'Kilimani Apartment', status: 'onboarding' });

  const toggled = await app.inject({
    method: 'PATCH',
    url: `/api/properties/${property.id}`,
    headers: { cookie: user.cookie },
    payload: { status: 'live' },
  });
  assert.equal(toggled.statusCode, 200);
  assert.equal((toggled.json() as { property: { status: string } }).property.status, 'live');
  assert.equal((await properties()).find((entry) => entry.id === property.id)?.status, 'live');

  const archive = await app.inject({
    method: 'POST',
    url: `/api/properties/${property.id}/archive`,
    headers: { cookie: user.cookie },
  });
  assert.equal(archive.statusCode, 200);
  assert.equal((archive.json() as { property: { status: string } }).property.status, 'archived');
  assert.equal(
    (await properties()).some((entry) => entry.id === property.id),
    false,
    'archived properties leave the active list'
  );
});

test('T-25 a calendar link is stored on the property; junk is refused', async () => {
  const property = await createProperty(app, user, { name: 'Link House' });
  const url = 'https://www.airbnb.com/calendar/ical/123456.ics?s=abc';

  const saved = await app.inject({
    method: 'PUT',
    url: `/api/properties/${property.id}/calendar-feed`,
    headers: { cookie: user.cookie },
    payload: { url, source: 'airbnb' },
  });
  assert.equal(saved.statusCode, 200, saved.body);

  const feeds = await app.inject({
    method: 'GET',
    url: `/api/properties/${property.id}/calendar-feeds`,
    headers: { cookie: user.cookie },
  });
  const list = (feeds.json() as { feeds: Array<{ url: string; source: string }> }).feeds;
  assert.equal(list.length, 1);
  assert.equal(list[0]?.url, url);
  assert.equal(list[0]?.source, 'airbnb');

  const junk = await app.inject({
    method: 'PUT',
    url: `/api/properties/${property.id}/calendar-feed`,
    headers: { cookie: user.cookie },
    payload: { url: 'not a link', source: 'airbnb' },
  });
  assert.equal(junk.statusCode, 422);
  assert.match((junk.json() as { message: string }).message, /web link/);

  const insecure = await app.inject({
    method: 'PUT',
    url: `/api/properties/${property.id}/calendar-feed`,
    headers: { cookie: user.cookie },
    payload: { url: 'http://example.com/feed.ics', source: 'airbnb' },
  });
  assert.equal(insecure.statusCode, 422);
});

test('T-27 an unverified account reads as pending, a verified one as itself', async () => {
  const property = await createProperty(app, user, { name: 'Account House' });

  const pending = await app.inject({
    method: 'PUT',
    url: `/api/properties/${property.id}/account`,
    headers: { cookie: user.cookie },
    payload: { label: 'KCB 3310', verified: false, balanceCents: 0 },
  });
  assert.equal(pending.statusCode, 200);
  assert.equal((pending.json() as { account: { display: string } }).account.display, 'KCB 3310 · pending');

  const verified = await app.inject({
    method: 'PUT',
    url: `/api/properties/${property.id}/account`,
    headers: { cookie: user.cookie },
    payload: { label: 'KCB 3310', verified: true, balanceCents: -250_000 },
  });
  assert.equal(verified.statusCode, 200);
  const account = (verified.json() as {
    account: { display: string; balanceCents: number };
  }).account;
  assert.equal(account.display, 'KCB 3310');
  assert.equal(account.balanceCents, -250_000, 'a negative balance is a real state, not an error');
});

test('the API refuses anonymous callers and other portfolios', async () => {
  const anonymous = await app.inject({ method: 'GET', url: '/api/properties' });
  assert.equal(anonymous.statusCode, 401);

  const other = await signUp(app, mailer, 'OTHER');
  emails.push(other.email);
  const foreign = await createProperty(app, other, { name: 'Not Yours' });

  const peek = await app.inject({
    method: 'GET',
    url: `/api/properties/${foreign.id}`,
    headers: { cookie: user.cookie },
  });
  assert.equal(peek.statusCode, 404, 'another portfolio is a 404, not a 403');
});
