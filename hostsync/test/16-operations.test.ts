/**
 * T-46 — a confirmed arrival schedules its own turnover.
 *
 * The original app expected a human to notice the arrival and call a cleaner.
 * Here the booking transaction creates the task, its window and its checklist.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { closePool, pool } from '../src/db.ts';
import { createCaptureTransport } from '../src/mail.ts';
import { addDays, todayUTC } from '../src/dates.ts';
import { TURNOVER_CHECKLIST } from '../src/operations.ts';
import { createBooking, createProperty, deleteUser, signUp } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';

const mailer = createCaptureTransport();
let app: FastifyInstance;
let user: ApiUser;
const emails: string[] = [];

interface TaskRow {
  id: string;
  kind: string;
  status: string;
  day: string;
  title: string;
  window_start: string;
  window_end: string;
}

async function tasksFor(bookingId: string): Promise<TaskRow[]> {
  const result = await pool.query<TaskRow>(
    `select id, kind, status, title,
            (window_start at time zone (select timezone from property where id = property_id))::date::text as day,
            to_char(window_start at time zone (select timezone from property where id = property_id), 'YYYY-MM-DD HH24:MI') as window_start,
            to_char(window_end at time zone (select timezone from property where id = property_id), 'YYYY-MM-DD HH24:MI') as window_end
       from task where booking_id = $1 order by created_at`,
    [bookingId]
  );
  return result.rows;
}

async function checklistFor(taskId: string): Promise<string[]> {
  const result = await pool.query<{ label: string }>(
    'select label from task_checklist_item where task_id = $1 order by position',
    [taskId]
  );
  return result.rows.map((row) => row.label);
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

test('T-46 a confirmed arrival schedules exactly one turnover with a five-item checklist', async () => {
  const today = todayUTC();
  const property = await createProperty(app, user, { name: 'Turnover House' });

  const booking = await createBooking(app, user, {
    propertyId: property.id,
    guestName: 'Turnover Guest',
    channel: 'direct',
    checkIn: addDays(today, 3),
    checkOut: addDays(today, 6),
    guests: 2,
  });

  const tasks = await tasksFor(booking.id);
  assert.equal(tasks.length, 1, 'exactly one turnover');
  assert.equal(tasks[0]?.kind, 'turnover');
  assert.equal(tasks[0]?.status, 'scheduled');
  assert.equal(tasks[0]?.day, addDays(today, 3), 'it lands on the arrival day');
  assert.match(tasks[0]?.title ?? '', /Turnover Guest/);

  // The window is the property's own checkout→check-in window: 11:00 → 15:00.
  assert.equal(tasks[0]?.window_start, `${addDays(today, 3)} 11:00`);
  assert.equal(tasks[0]?.window_end, `${addDays(today, 3)} 15:00`);

  const checklist = await checklistFor(tasks[0]!.id);
  assert.equal(checklist.length, 5, 'five checklist items');
  assert.deepEqual(checklist, [...TURNOVER_CHECKLIST]);
});

test('T-46 a pending stay schedules nothing until it is confirmed, and only once', async () => {
  const today = todayUTC();
  const property = await createProperty(app, user, { name: 'Pending Turnover House' });

  const booking = await createBooking(app, user, {
    propertyId: property.id,
    guestName: 'Pending Guest',
    channel: 'airbnb',
    checkIn: addDays(today, 9),
    checkOut: addDays(today, 12),
    guests: 2,
    status: 'pending',
  });

  assert.deepEqual(await tasksFor(booking.id), [], 'a pending stay promises nothing yet');

  const confirmed = await app.inject({
    method: 'POST',
    url: `/api/bookings/${booking.id}/confirm`,
    headers: { cookie: user.cookie },
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);

  const afterConfirm = await tasksFor(booking.id);
  assert.equal(afterConfirm.length, 1, 'confirming schedules the turnover');

  // Confirming again is idempotent: one booking, one turnover.
  await app.inject({
    method: 'POST',
    url: `/api/bookings/${booking.id}/confirm`,
    headers: { cookie: user.cookie },
  });
  assert.equal((await tasksFor(booking.id)).length, 1, 'never two turnovers for one stay');
});

test('T-46 a cancelled stay orphans its turnover explicitly, never silently', async () => {
  const today = todayUTC();
  const property = await createProperty(app, user, { name: 'Cancelled Turnover House' });

  const booking = await createBooking(app, user, {
    propertyId: property.id,
    guestName: 'Cancelled Guest',
    channel: 'direct',
    checkIn: addDays(today, 20),
    checkOut: addDays(today, 22),
    guests: 2,
  });
  assert.equal((await tasksFor(booking.id)).length, 1);

  const cancelled = await app.inject({
    method: 'POST',
    url: `/api/bookings/${booking.id}/cancel`,
    headers: { cookie: user.cookie },
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);

  const tasks = await tasksFor(booking.id);
  assert.equal(tasks.length, 1, 'the row is kept — history is not rewritten');
  assert.equal(tasks[0]?.status, 'cancelled', 'and it says so');
});
