/**
 * T-43 board counters · T-44 board columns · T-47 new task · T-48 lifecycle
 * T-49 checklist · T-76 roster · T-77 add member
 *
 * Every test gets its own portfolio, so the counters are absolute numbers and
 * not deltas — a counter that only works as a difference is not a counter.
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
const emails: string[] = [];

interface Card {
  id: string;
  kind: string;
  title: string;
  propertyName: string;
  column: string;
  status: string;
  assignee: string | null;
  checklistDone: number;
  checklistTotal: number;
  blocked: boolean;
  dueToday: boolean;
}

interface Board {
  counters: { unassigned: number; dueToday: number; blocked: number; needsSomeone: number };
  columns: Array<{ key: string; label: string; count: number; tasks: Card[] }>;
}

before(async () => {
  app = buildApp({ mailer });
  await app.ready();
});

after(async () => {
  await app.close();
  for (const email of emails) await deleteUser(email);
  await closePool();
});

async function freshPortfolio(): Promise<{ user: ApiUser; propertyId: string }> {
  const user = await signUp(app, mailer, 'OPS');
  emails.push(user.email);
  const property = await createProperty(app, user, { name: 'Ops House' });
  return { user, propertyId: property.id };
}

async function addTask(
  user: ApiUser,
  payload: Record<string, unknown>
): Promise<{ status: number; body: string; card?: Card }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: { cookie: user.cookie },
    payload,
  });
  const body = response.body;
  const card = response.statusCode === 201 ? (JSON.parse(body) as { task: Card }).task : undefined;
  return { status: response.statusCode, body, card };
}

async function board(user: ApiUser): Promise<Board> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/tasks',
    headers: { cookie: user.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as Board;
}

test('T-47 a new task is accepted with a full payload and refused without a title', async () => {
  const { user, propertyId } = await freshPortfolio();
  const today = todayUTC();

  const created = await addTask(user, {
    propertyId,
    kind: 'maintenance',
    title: 'Replace the pool pump',
    date: addDays(today, 2),
    windowStart: '09:00',
    windowEnd: '12:00',
    priority: 'high',
    expectedCostCents: 250_000,
    notes: 'The pump failed on Tuesday.',
  });
  assert.equal(created.status, 201, created.body);
  assert.equal(created.card?.kind, 'maintenance');
  assert.equal(created.card?.title, 'Replace the pool pump');
  assert.equal(created.card?.status, 'scheduled');

  const titleLess = await addTask(user, {
    propertyId,
    kind: 'maintenance',
    title: '   ',
    date: today,
  });
  assert.equal(titleLess.status, 422, titleLess.body);
  assert.match(titleLess.body, /title/i);
});

test('T-44 every task sits in exactly one column, and the counts match the cards', async () => {
  const { user, propertyId } = await freshPortfolio();
  const today = todayUTC();

  await addTask(user, { propertyId, kind: 'other', title: 'No owner yet', date: today });
  await addTask(user, {
    propertyId,
    kind: 'other',
    title: 'Has an owner',
    date: today,
    assignee: 'Wanjiku',
  });

  const scheduled = await addTask(user, {
    propertyId,
    kind: 'other',
    title: 'On site',
    date: today,
    assignee: 'Wanjiku',
  });
  assert.equal(scheduled.status, 201, scheduled.body);

  const data = await board(user);
  const all = data.columns.flatMap((column) => column.tasks);
  assert.equal(all.length, 3, 'three tasks, counted once');

  const keys = data.columns.map((column) => column.key);
  assert.deepEqual(keys, ['unassigned', 'scheduled', 'on_site', 'complete']);
  for (const column of data.columns) {
    assert.equal(column.count, column.tasks.length, `${column.label} count matches its cards`);
  }

  assert.equal(
    all.filter((card) => card.title === 'No owner yet').length,
    1,
    'a task with nobody on it is in UNASSIGNED'
  );
  assert.equal(all.find((card) => card.title === 'No owner yet')?.column, 'unassigned');
  assert.equal(all.find((card) => card.title === 'Has an owner')?.column, 'scheduled');
});

test('T-43 the four counters read the board, not a guess', async () => {
  const { user, propertyId } = await freshPortfolio();
  const today = todayUTC();

  // A member who will be paused, so one task needs somebody else.
  const member = await app.inject({
    method: 'POST',
    url: '/api/team',
    headers: { cookie: user.cookie },
    payload: { name: 'Wanjiku', role: 'cleaner', phone: '+254700000001' },
  });
  assert.equal(member.statusCode, 201, member.body);
  const memberId = (member.json() as { member: { id: string } }).member.id;

  // Distinct windows, so only the last two overlap — the counters must not
  // depend on a coincidence.
  await addTask(user, {
    propertyId,
    kind: 'other',
    title: 'Nobody',
    date: today,
    windowStart: '09:00',
    windowEnd: '10:00',
  });
  await addTask(user, {
    propertyId,
    kind: 'other',
    title: 'Due today',
    date: today,
    windowStart: '11:00',
    windowEnd: '12:00',
    assignee: 'Wanjiku',
  });
  await addTask(user, {
    propertyId,
    kind: 'other',
    title: 'Paused owner',
    date: addDays(today, 5),
    windowStart: '11:00',
    windowEnd: '12:00',
    assignee: 'Wanjiku',
  });
  // Two tasks on one property whose windows overlap: one of them cannot happen.
  await addTask(user, {
    propertyId,
    kind: 'other',
    title: 'Overlap A',
    date: addDays(today, 7),
    windowStart: '11:00',
    windowEnd: '15:00',
    assignee: 'Wanjiku',
  });
  await addTask(user, {
    propertyId,
    kind: 'other',
    title: 'Overlap B',
    date: addDays(today, 7),
    windowStart: '13:00',
    windowEnd: '17:00',
    assignee: 'Wanjiku',
  });

  const paused = await app.inject({
    method: 'POST',
    url: `/api/team/${memberId}/pause`,
    headers: { cookie: user.cookie },
  });
  assert.equal(paused.statusCode, 200, paused.body);

  const data = await board(user);
  assert.equal(data.counters.unassigned, 1, 'one task with nobody on it');
  assert.equal(data.counters.dueToday, 2, 'two tasks whose window starts today');
  assert.equal(data.counters.blocked, 2, 'the two overlapping tasks are blocked');
  assert.equal(
    data.counters.needsSomeone,
    4,
    'every task held by the paused member needs somebody else'
  );

  // The overlap is visible on the cards, not only in the counter.
  const overlap = data.columns
    .flatMap((column) => column.tasks)
    .find((card) => card.title === 'Overlap A');
  assert.equal(overlap?.blocked, true);
});

test('T-49 the checklist counts, and a task cannot be completed with items open', async () => {
  const { user, propertyId } = await freshPortfolio();

  const created = await addTask(user, {
    propertyId,
    kind: 'turnover',
    title: 'Turnover with a checklist',
    date: addDays(todayUTC(), 1),
  });
  assert.equal(created.status, 201, created.body);
  const taskId = created.card!.id;

  const detail = await board(user);
  const card = detail.columns.flatMap((column) => column.tasks).find((item) => item.id === taskId);
  assert.equal(card?.checklistTotal, 5, 'a turnover carries five checks');
  assert.equal(card?.checklistDone, 0);

  for (const position of [1, 2, 3]) {
    const ticked = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/checklist`,
      headers: { cookie: user.cookie },
      payload: { position, done: true },
    });
    assert.equal(ticked.statusCode, 200, ticked.body);
  }

  const afterTicks = await board(user);
  const ticked = afterTicks.columns.flatMap((column) => column.tasks).find((item) => item.id === taskId);
  assert.equal(ticked?.checklistDone, 3, 'three of five checks are ticked');

  // Two items are still open, so completing is refused.
  const tooEarly = await app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/complete`,
    headers: { cookie: user.cookie },
  });
  assert.equal(tooEarly.statusCode, 409, tooEarly.body);
  assert.match(tooEarly.body, /checklist/i);
});

test('T-48 a task moves scheduled → on site → complete → scheduled again', async () => {
  const { user, propertyId } = await freshPortfolio();

  const created = await addTask(user, {
    propertyId,
    kind: 'other',
    title: 'Lifecycle',
    date: addDays(todayUTC(), 1),
    assignee: 'Wanjiku',
  });
  const taskId = created.card!.id;

  const start = await app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/start`,
    headers: { cookie: user.cookie },
  });
  assert.equal(start.statusCode, 200, start.body);
  assert.equal((start.json() as { status: string }).status, 'in_progress');

  const complete = await app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/complete`,
    headers: { cookie: user.cookie },
  });
  assert.equal(complete.statusCode, 200, complete.body);
  assert.equal((complete.json() as { status: string }).status, 'done');

  const reopen = await app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/reopen`,
    headers: { cookie: user.cookie },
  });
  assert.equal(reopen.statusCode, 200, reopen.body);
  assert.equal((reopen.json() as { status: string }).status, 'scheduled');

  const data = await board(user);
  const card = data.columns.flatMap((column) => column.tasks).find((item) => item.id === taskId);
  assert.equal(card?.column, 'scheduled');
});

test('T-76 the roster shows the member, and pausing takes them out of the pickers', async () => {
  const { user } = await freshPortfolio();

  const added = await app.inject({
    method: 'POST',
    url: '/api/team',
    headers: { cookie: user.cookie },
    payload: { name: 'Brian Kimani', role: 'manager', phone: '+254700000002', hourlyRateCents: 45_000 },
  });
  assert.equal(added.statusCode, 201, added.body);
  const member = (added.json() as { member: { id: string; name: string; role: string } }).member;

  const roster = await app.inject({
    method: 'GET',
    url: '/api/team',
    headers: { cookie: user.cookie },
  });
  const members = (roster.json() as { members: Array<{ id: string; name: string; role: string; phone: string | null; hourlyRateCents: number; reliabilityPct: number; active: boolean }> }).members;
  const found = members.find((entry) => entry.id === member.id);
  assert.equal(found?.name, 'Brian Kimani');
  assert.equal(found?.role, 'manager');
  assert.equal(found?.phone, '+254700000002');
  assert.equal(found?.hourlyRateCents, 45_000);
  assert.equal(found?.reliabilityPct, 100);
  assert.equal(found?.active, true);

  const paused = await app.inject({
    method: 'POST',
    url: `/api/team/${member.id}/pause`,
    headers: { cookie: user.cookie },
  });
  assert.equal(paused.statusCode, 200, paused.body);
  assert.equal((paused.json() as { member: { active: boolean } }).member.active, false);

  const assignable = await app.inject({
    method: 'GET',
    url: '/api/team/assignable',
    headers: { cookie: user.cookie },
  });
  const pickers = (assignable.json() as { members: Array<{ id: string }> }).members;
  assert.equal(
    pickers.some((entry) => entry.id === member.id),
    false,
    'a paused member disappears from the assignment pickers'
  );
});

test('T-77 a member is added once: a bad role is 422 and a duplicate phone is 409', async () => {
  const { user } = await freshPortfolio();

  const good = await app.inject({
    method: 'POST',
    url: '/api/team',
    headers: { cookie: user.cookie },
    payload: { name: 'Achieng', role: 'cleaner', phone: '+254700000003' },
  });
  assert.equal(good.statusCode, 201, good.body);

  const badRole = await app.inject({
    method: 'POST',
    url: '/api/team',
    headers: { cookie: user.cookie },
    payload: { name: 'Achieng', role: 'wizard', phone: '+254700000004' },
  });
  assert.equal(badRole.statusCode, 422, badRole.body);
  assert.match(badRole.body, /role/i);

  const duplicate = await app.inject({
    method: 'POST',
    url: '/api/team',
    headers: { cookie: user.cookie },
    payload: { name: 'Achieng Two', role: 'cleaner', phone: '+254700000003' },
  });
  assert.equal(duplicate.statusCode, 409, duplicate.body);
});
