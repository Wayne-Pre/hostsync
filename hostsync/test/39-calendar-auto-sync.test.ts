/**
 * The scheduled sync finds every workspace with a calendar link — not just the
 * one whose owner happened to click "Refresh" — and stays idempotent.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { closePool, query, queryOne } from '../src/db.ts';
import type { FetchLike } from '../src/ics/sync.ts';
import { syncAllPortfolios } from '../src/ics/sync.ts';
import { createCaptureTransport } from '../src/mail.ts';
import { addDays, todayUTC } from '../src/dates.ts';
import { createProperty, deleteUser, signUp } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';

const mailer = createCaptureTransport();
let app: FastifyInstance;
const users: ApiUser[] = [];
const propertyIds: string[] = [];

const feed: FetchLike = async () => ({
  status: 200,
  ok: true,
  headers: { get: () => null },
  text: async () =>
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Airbnb//Calendar//EN',
      'BEGIN:VEVENT',
      'UID:auto-sync-1',
      `DTSTART;VALUE=DATE:${addDays(todayUTC(), 3).replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${addDays(todayUTC(), 5).replace(/-/g, '')}`,
      'SUMMARY:Imported stay',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n'),
});

before(async () => {
  app = buildApp({ mailer });
  await app.ready();
  for (const name of ['SYNC A', 'SYNC B']) {
    const user = await signUp(app, mailer, name);
    users.push(user);
    const property = await createProperty(app, user, { name: `${name} House` });
    propertyIds.push(property.id);
    await query(
      `insert into calendar_feed (property_id, url, source)
       values ($1, $2, 'airbnb')`,
      [property.id, `https://www.airbnb.com/calendar/ical/${name.replace(' ', '-')}.ics?s=1`]
    );
  }
});

after(async () => {
  await app.close();
  for (const user of users) await deleteUser(user.email);
  await closePool();
});

test('the scheduled pass syncs every portfolio and does not duplicate stays', async () => {
  const first = await syncAllPortfolios({ fetchImpl: feed });
  assert.equal(first.portfolios, 2, 'both workspaces with a feed were visited');
  assert.equal(first.outcomes.length, 2);
  assert.ok(first.outcomes.every((outcome) => outcome.status === 'ok'));
  assert.ok(first.outcomes.every((outcome) => outcome.created === 1));

  for (const propertyId of propertyIds) {
    const row = await queryOne<{ count: number }>(
      'select count(*)::int as count from booking where property_id = $1',
      [propertyId]
    );
    assert.equal(row?.count, 1, 'each portfolio got its imported stay');
  }

  const second = await syncAllPortfolios({ fetchImpl: feed });
  assert.equal(second.outcomes.length, 2);
  assert.ok(second.outcomes.every((outcome) => outcome.created === 0), 'a second pass creates nothing');

  for (const propertyId of propertyIds) {
    const row = await queryOne<{ count: number }>(
      'select count(*)::int as count from booking where property_id = $1',
      [propertyId]
    );
    assert.equal(row?.count, 1, 'still one stay per property after two passes');
  }
});
