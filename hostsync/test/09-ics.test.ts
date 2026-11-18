/**
 * T-25 / T-26 / T-36 — calendar import.
 *
 * The feed is never fetched from the network in this file: a fake fetch returns
 * fixtures, so the tests are deterministic and cannot be used to probe anything.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { closePool, pool } from '../src/db.ts';
import { createCaptureTransport } from '../src/mail.ts';
import { addDays, todayUTC } from '../src/dates.ts';
import { parseIcs, IcsFormatError, IcsTooLargeError } from '../src/ics/parse.ts';
import { assertFetchableFeedUrl, UnsafeFeedUrlError } from '../src/ics/urlSafety.ts';
import { syncFeed } from '../src/ics/sync.ts';
import type { FetchLike, FetchResponseLike } from '../src/ics/sync.ts';
import { createProperty, deleteUser, signUp } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';

const mailer = createCaptureTransport();
let app: FastifyInstance;
let user: ApiUser;
const emails: string[] = [];

/** The route-level fetch: set `nextFeed` to choose what the next sync receives. */
let nextFeed: { status: number; body: string; etag?: string | null } = { status: 200, body: '' };
const routeFetch: FetchLike = async () => ({
  status: nextFeed.status,
  ok: nextFeed.status >= 200 && nextFeed.status < 300,
  headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? nextFeed.etag ?? null : null) },
  text: async () => nextFeed.body,
});

function ics(events: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Airbnb//Calendar//EN',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n');
}

function event(uid: string, start: string, end: string, summary: string, extra: string[] = []): string {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART;VALUE=DATE:${start.replace(/-/g, '')}`,
    `DTEND;VALUE=DATE:${end.replace(/-/g, '')}`,
    `SUMMARY:${summary}`,
    ...extra,
    'END:VEVENT',
  ].join('\r\n');
}

function fakeFetch(response: {
  status?: number;
  body?: string;
  etag?: string | null;
}): FetchLike {
  return async (): Promise<FetchResponseLike> => {
    const status = response.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? response.etag ?? null : null) },
      text: async () => response.body ?? '',
    };
  };
}

async function createFeed(propertyId: string, url: string, source = 'airbnb'): Promise<string> {
  const response = await app.inject({
    method: 'PUT',
    url: `/api/properties/${propertyId}/calendar-feed`,
    headers: { cookie: user.cookie },
    payload: { url, source },
  });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { feed: { id: string } }).feed.id;
}

before(async () => {
  app = buildApp({ mailer, fetchImpl: routeFetch });
  await app.ready();
  user = await signUp(app, mailer);
  emails.push(user.email);
});

after(async () => {
  await app.close();
  for (const email of emails) await deleteUser(email);
  await closePool();
});

test('the parser reads real iCal shapes: folded lines, date-times, durations, cancellations', () => {
  const text = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:abc-1',
    'DTSTART;VALUE=DATE:20270310',
    'DTEND;VALUE=DATE:20270315',
    'SUMMARY:Sofia Almeida',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:abc-2',
    'DTSTART:20270401T150000Z',
    'DTEND:20270404T110000Z',
    'SUMMARY:Airbnb (Not available)',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:abc-3',
    'DTSTART;VALUE=DATE:20270501',
    'DURATION:P3D',
    'SUMMARY:A guest with a very long name that has been folded',
    '  across two lines',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:abc-4',
    'DTSTART;VALUE=DATE:20270601',
    'DTEND;VALUE=DATE:20270603',
    'STATUS:CANCELLED',
    'SUMMARY:Cancelled stay',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const events = parseIcs(text);
  assert.equal(events.length, 4);

  assert.deepEqual(
    { start: events[0]?.start, end: events[0]?.end, blocked: events[0]?.blocked },
    { start: '2027-03-10', end: '2027-03-15', blocked: false }
  );
  assert.equal(events[1]?.blocked, true, '"Not available" is a block, not a guest');
  assert.equal(events[2]?.summary, 'A guest with a very long name that has been folded across two lines');
  assert.equal(events[2]?.end, '2027-05-04', 'DURATION:P3D is three nights');
  assert.equal(events[3]?.cancelled, true);

  assert.throws(() => parseIcs('<html><body>not a calendar</body></html>'), IcsFormatError);
  assert.throws(() => parseIcs(`BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nSUMMARY:no dates\nEND:VEVENT\nEND:VCALENDAR`), IcsFormatError);
  assert.throws(() => parseIcs(`BEGIN:VCALENDAR\n${'x'.repeat(3 * 1024 * 1024)}\nEND:VCALENDAR`), IcsTooLargeError);
});

test('the URL gate refuses the things an SSRF would try', () => {
  assert.throws(() => assertFetchableFeedUrl('http://example.com/a.ics'), UnsafeFeedUrlError);
  assert.throws(() => assertFetchableFeedUrl('not a url'), UnsafeFeedUrlError);
  assert.throws(() => assertFetchableFeedUrl('https://localhost/a.ics'), UnsafeFeedUrlError);
  assert.throws(() => assertFetchableFeedUrl('https://127.0.0.1/a.ics'), UnsafeFeedUrlError);
  assert.throws(() => assertFetchableFeedUrl('https://10.0.0.5/a.ics'), UnsafeFeedUrlError);
  assert.throws(() => assertFetchableFeedUrl('https://192.168.1.10/a.ics'), UnsafeFeedUrlError);
  assert.throws(() => assertFetchableFeedUrl('https://169.254.169.254/latest/meta-data'), UnsafeFeedUrlError);
  assert.throws(() => assertFetchableFeedUrl('https://[::1]/a.ics'), UnsafeFeedUrlError);
  assert.throws(() => assertFetchableFeedUrl('https://user:pass@example.com/a.ics'), UnsafeFeedUrlError);
  assert.throws(() => assertFetchableFeedUrl('https://example.com:8080/a.ics'), UnsafeFeedUrlError);

  const ok = assertFetchableFeedUrl('https://www.airbnb.com/calendar/ical/123456.ics?s=abc');
  assert.equal(ok.hostname, 'www.airbnb.com');
});

test('T-26 a feed with two events creates two bookings and is idempotent on re-sync', async () => {
  const today = todayUTC();
  const property = await createProperty(app, user, { name: 'Import House' });
  const feedId = await createFeed(property.id, 'https://www.airbnb.com/calendar/ical/777.ics?s=xyz');

  const body = ics([
    event('ev-1', addDays(today, 30), addDays(today, 34), 'Sofia Almeida'),
    event('ev-2', addDays(today, 40), addDays(today, 42), 'Brian Kimani'),
  ]);

  const first = await syncFeed(feedId, { fetchImpl: fakeFetch({ body, etag: '"v1"' }) });
  assert.equal(first.status, 'ok', first.error ?? '');
  assert.equal(first.created, 2);
  assert.equal(first.conflicts, 0);

  const rows = await pool.query<{ guest_name: string; status: string; source: string; reference: string }>(
    `select guest_name, status, source, reference from booking
      where property_id = $1 order by lower(stay)`,
    [property.id]
  );
  assert.equal(rows.rows.length, 2);
  assert.equal(rows.rows[0]?.guest_name, 'Sofia Almeida');
  assert.equal(rows.rows[0]?.status, 'pending', 'imports land pending, never silently confirmed');
  assert.equal(rows.rows[0]?.source, 'import');
  assert.match(rows.rows[0]?.reference ?? '', /^MRD-\d+$/);

  const synced = await pool.query<{ last_synced_at: Date | null; last_status: string; etag: string }>(
    'select last_synced_at, last_status, etag from calendar_feed where id = $1',
    [feedId]
  );
  assert.ok(synced.rows[0]?.last_synced_at instanceof Date);
  assert.equal(synced.rows[0]?.last_status, 'ok');
  assert.equal(synced.rows[0]?.etag, '"v1"');

  // Same feed again: nothing is duplicated.
  const second = await syncFeed(feedId, { fetchImpl: fakeFetch({ body, etag: '"v1"' }) });
  assert.equal(second.status, 'ok');
  assert.equal(second.created, 0);
  assert.equal(second.updated, 0);

  const count = await pool.query<{ count: number }>(
    'select count(*)::int as count from booking where property_id = $1',
    [property.id]
  );
  assert.equal(count.rows[0]?.count, 2);

  // A 304 is a success that costs nothing.
  const notModified = await syncFeed(feedId, { fetchImpl: fakeFetch({ status: 304 }) });
  assert.equal(notModified.status, 'not_modified');
});

test('T-36 a cancelled event releases the nights; a bad feed changes nothing', async () => {
  const today = todayUTC();
  const property = await createProperty(app, user, { name: 'Cancel House' });
  const feedId = await createFeed(property.id, 'https://www.airbnb.com/calendar/ical/888.ics?s=xyz');

  const active = ics([event('ev-c1', addDays(today, 50), addDays(today, 54), 'Guest To Cancel')]);
  const created = await syncFeed(feedId, { fetchImpl: fakeFetch({ body: active }) });
  assert.equal(created.created, 1);

  const cancelledFeed = ics([
    event('ev-c1', addDays(today, 50), addDays(today, 54), 'Guest To Cancel', ['STATUS:CANCELLED']),
  ]);
  const cancelled = await syncFeed(feedId, { fetchImpl: fakeFetch({ body: cancelledFeed }) });
  assert.equal(cancelled.cancelled, 1);

  const booking = await pool.query<{ status: string }>(
    `select status from booking where property_id = $1`,
    [property.id]
  );
  assert.equal(booking.rows[0]?.status, 'cancelled');

  // The nights are free again: a new guest can take them.
  const replacement = await app.inject({
    method: 'POST',
    url: '/api/bookings',
    headers: { cookie: user.cookie },
    payload: {
      propertyId: property.id,
      guestName: 'Replacement',
      channel: 'direct',
      checkIn: addDays(today, 51),
      checkOut: addDays(today, 53),
      guests: 1,
    },
  });
  assert.equal(replacement.statusCode, 201, replacement.body);

  // A 404 feed is surfaced and leaves the existing rows alone.
  const beforeFailure = await pool.query<{ count: number }>(
    'select count(*)::int as count from booking where property_id = $1',
    [property.id]
  );
  const failed = await syncFeed(feedId, { fetchImpl: fakeFetch({ status: 404 }) });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /not found/i);

  const afterFailure = await pool.query<{ count: number }>(
    'select count(*)::int as count from booking where property_id = $1',
    [property.id]
  );
  assert.equal(afterFailure.rows[0]?.count, beforeFailure.rows[0]?.count);

  const feedState = await pool.query<{ last_status: string; consecutive_failures: number; last_error: string }>(
    'select last_status, consecutive_failures, last_error from calendar_feed where id = $1',
    [feedId]
  );
  assert.notEqual(feedState.rows[0]?.last_status, 'ok');
  assert.equal(feedState.rows[0]?.consecutive_failures, 1);

  // A page that is not a calendar is refused with the product's own words.
  const notIcal = await syncFeed(feedId, {
    fetchImpl: fakeFetch({ body: '<!doctype html><html><body>Sign in</body></html>' }),
  });
  assert.equal(notIcal.status, 'failed');
  assert.match(notIcal.error ?? '', /isn't an iCal/i);

  // An oversized body is refused before parsing.
  const huge = await syncFeed(feedId, {
    fetchImpl: fakeFetch({ body: `BEGIN:VCALENDAR\n${'x'.repeat(3 * 1024 * 1024)}` }),
  });
  assert.equal(huge.status, 'failed');
  assert.match(huge.error ?? '', /too large/i);
});

test('the sync endpoint takes the portfolio feed list and reports per-feed results', async () => {
  const today = todayUTC();
  const property = await createProperty(app, user, { name: 'Endpoint House' });
  await createFeed(property.id, 'https://www.airbnb.com/calendar/ical/999.ics?s=xyz');

  nextFeed = {
    status: 200,
    body: ics([event('ev-endpoint', addDays(today, 70), addDays(today, 72), 'Endpoint Guest')]),
    etag: '"endpoint"',
  };

  const response = await app.inject({
    method: 'POST',
    url: `/api/properties/${property.id}/sync`,
    headers: { cookie: user.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as {
    results: Array<{ status: string; created: number; error: string | null }>;
    anyFailed: boolean;
  };
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0]?.status, 'ok', body.results[0]?.error ?? '');
  assert.equal(body.results[0]?.created, 1);
  assert.equal(body.anyFailed, false);
});
