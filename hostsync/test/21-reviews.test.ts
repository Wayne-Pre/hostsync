/**
 * T-56 reputation KPIs · T-57 review feed · T-58 write a reply
 * T-59 requests due · T-60 already requested · T-61 auto-request schedule
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { closePool, pool } from '../src/db.ts';
import { createCaptureTransport } from '../src/mail.ts';
import { addDays, todayUTC } from '../src/dates.ts';
import { createProperty, deleteUser, signUp } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';

const mailer = createCaptureTransport();
let app: FastifyInstance;
let user: ApiUser;
let propertyId: string;
const emails: string[] = [];

interface Review {
  id: string;
  rating: number;
  channel: string | null;
  guestName: string | null;
  body: string | null;
  receivedAt: string;
  repliedAt: string | null;
  replyBody: string | null;
  propertyName: string | null;
}

interface ReviewsPayload {
  kpis: {
    averageRating: number | null;
    reviewCount: number;
    repliedCount: number;
    responseRatePct: number;
    awaitingReply: number;
    requestsDue: number;
  };
  reviews: Review[];
  settings: { autoRequest: boolean; daysAfterCheckout: number };
}

async function load(): Promise<ReviewsPayload> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/reviews',
    headers: { cookie: user.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as ReviewsPayload;
}

async function seedReview(rating: number, daysAgo: number, replied: boolean): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into review (property_id, rating, channel, guest_name, body, received_at, replied_at, reply_body)
     values ($1, $2, 'airbnb', 'Seeded Guest', 'Lovely stay', now() - ($3 || ' days')::interval,
             case when $4 then now() else null end,
             case when $4 then 'Thank you for staying.' else null end)
     returning id`,
    [propertyId, rating, String(daysAgo), replied]
  );
  return result.rows[0]!.id;
}

before(async () => {
  app = buildApp({ mailer });
  await app.ready();
  user = await signUp(app, mailer, 'REVIEWS');
  emails.push(user.email);
  propertyId = (await createProperty(app, user, { name: 'Review House' })).id;
});

after(async () => {
  await app.close();
  for (const email of emails) await deleteUser(email);
  await closePool();
});

test('T-56 the four numbers are computed from the reviews themselves', async () => {
  // Six reviews averaging 4.50, three of them answered.
  for (const rating of [5, 5, 4]) await seedReview(rating, 1, true);
  for (const rating of [4, 5, 4]) await seedReview(rating, 2, false);

  const data = await load();
  assert.equal(data.kpis.reviewCount, 6);
  assert.equal(data.kpis.averageRating, 4.5);
  assert.equal(data.kpis.repliedCount, 3);
  assert.equal(data.kpis.responseRatePct, 50);
  assert.equal(data.kpis.awaitingReply, 3);
});

test('T-57 the feed is newest first and shows the reply that exists', async () => {
  const data = await load();
  assert.equal(data.reviews.length, 6);

  const times = data.reviews.map((review) => Date.parse(review.receivedAt));
  const sorted = [...times].sort((a, b) => b - a);
  assert.deepEqual(times, sorted, 'newest first');

  const answered = data.reviews.find((review) => review.repliedAt !== null);
  assert.ok(answered);
  assert.equal(answered.replyBody, 'Thank you for staying.');
  assert.equal(answered.propertyName, 'Review House');
});

test('T-58 a reply is stored, the response rate moves, and an empty reply is refused', async () => {
  const data = await load();
  const unanswered = data.reviews.find((review) => review.repliedAt === null);
  assert.ok(unanswered);

  const empty = await app.inject({
    method: 'POST',
    url: `/api/reviews/${unanswered.id}/reply`,
    headers: { cookie: user.cookie },
    payload: { body: '   ' },
  });
  assert.equal(empty.statusCode, 422, empty.body);

  const replied = await app.inject({
    method: 'POST',
    url: `/api/reviews/${unanswered.id}/reply`,
    headers: { cookie: user.cookie },
    payload: { body: 'Thank you — we would love to host you again.' },
  });
  assert.equal(replied.statusCode, 200, replied.body);

  const after = await load();
  assert.equal(after.kpis.repliedCount, 4);
  assert.equal(after.kpis.responseRatePct, 67, '4 of 6 answered');
  assert.equal(after.kpis.awaitingReply, 2);

  const updated = after.reviews.find((review) => review.id === unanswered.id);
  assert.ok(updated?.repliedAt);
  assert.match(updated?.replyBody ?? '', /host you again/);
});

test('T-59 a stay that finished two days ago is due; one that finished today is not', async () => {
  const today = todayUTC();

  await pool.query(
    `insert into booking (
       property_id, reference, guest_name, channel, stay, guests,
       gross_cents, commission_bps, net_cents, rate_version, payment_status, status, source
     ) values
       ($1, 'REV-OLD', 'Old Guest', 'airbnb', daterange($2::date, $3::date, '[)'), 2, 100, 0, 100, 1, 'paid', 'confirmed', 'import'),
       ($1, 'REV-TODAY', 'Today Guest', 'airbnb', daterange($4::date, $5::date, '[)'), 2, 100, 0, 100, 1, 'paid', 'confirmed', 'import')`,
    [propertyId, addDays(today, -10), addDays(today, -2), addDays(today, -2), addDays(today, 0)]
  );

  const response = await app.inject({
    method: 'GET',
    url: '/api/reviews/requests/due',
    headers: { cookie: user.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  const due = (response.json() as { due: Array<{ guestName: string }> }).due;

  assert.equal(
    due.some((entry) => entry.guestName === 'Old Guest'),
    true,
    'a stay that finished two days ago is due'
  );
  assert.equal(
    due.some((entry) => entry.guestName === 'Today Guest'),
    false,
    'a stay that finished today is not'
  );
});

test('T-59/T-60 asking a guest logs the request, and the logged list is not empty any more', async () => {
  const before = await app.inject({
    method: 'GET',
    url: '/api/reviews/requests',
    headers: { cookie: user.cookie },
  });
  const beforeRequests = (before.json() as { requests: unknown[] }).requests;
  assert.deepEqual(beforeRequests, [], 'nothing has been requested yet');

  const due = await app.inject({
    method: 'GET',
    url: '/api/reviews/requests/due',
    headers: { cookie: user.cookie },
  });
  const first = (due.json() as { due: Array<{ bookingId: string }> }).due[0];
  assert.ok(first);

  const asked = await app.inject({
    method: 'POST',
    url: '/api/reviews/requests',
    headers: { cookie: user.cookie },
    payload: { bookingId: first.bookingId },
  });
  assert.equal(asked.statusCode, 200, asked.body);

  const after = await app.inject({
    method: 'GET',
    url: '/api/reviews/requests',
    headers: { cookie: user.cookie },
  });
  const requests = (after.json() as { requests: Array<{ bookingId: string }> }).requests;
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.bookingId, first.bookingId);

  // Asking again does not create a second request.
  await app.inject({
    method: 'POST',
    url: '/api/reviews/requests',
    headers: { cookie: user.cookie },
    payload: { bookingId: first.bookingId },
  });
  const again = await app.inject({
    method: 'GET',
    url: '/api/reviews/requests',
    headers: { cookie: user.cookie },
  });
  assert.equal((again.json() as { requests: unknown[] }).requests.length, 1, 'still one request');
});

test('T-61 the auto-request switch and the delay are stored', async () => {
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/reviews/settings',
    headers: { cookie: user.cookie },
    payload: { autoRequest: true, daysAfterCheckout: 3 },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual((saved.json() as { settings: unknown }).settings, {
    autoRequest: true,
    daysAfterCheckout: 3,
  });

  const data = await load();
  assert.equal(data.settings.autoRequest, true);
  assert.equal(data.settings.daysAfterCheckout, 3);

  const nonsense = await app.inject({
    method: 'PUT',
    url: '/api/reviews/settings',
    headers: { cookie: user.cookie },
    payload: { autoRequest: true, daysAfterCheckout: 99 },
  });
  assert.equal(nonsense.statusCode, 422, nonsense.body);
});
