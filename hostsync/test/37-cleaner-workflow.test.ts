/**
 * Field-worker accounts: a cleaner gets their own login, sees only assigned
 * work, and every step is attributed to them with photo proof.
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
const PASSWORD = 'FieldWorker123!';
let app: FastifyInstance;
let owner: ApiUser;
let workerEmail: string;
let workerCookie: string;
let memberId: string;
let taskId: string;
let otherTaskId: string;

interface Job {
  id: string;
  title: string;
  assignee: string | null;
  status: string;
  checklist: Array<{ position: number; label: string; done: boolean }>;
}

before(async () => {
  app = buildApp({ mailer });
  await app.ready();
  owner = await signUp(app, mailer, 'STAFF');
  const property = await createProperty(app, owner, { name: 'Worker House' });

  const member = await app.inject({
    method: 'POST',
    url: '/api/team',
    headers: { cookie: owner.cookie },
    payload: { name: 'Otieno Kefa', role: 'cleaner', phone: '+254700000777' },
  });
  assert.equal(member.statusCode, 201, member.body);
  memberId = (member.json() as { member: { id: string } }).member.id;

  workerEmail = `worker-${Date.now()}@example.test`;
  const account = await app.inject({
    method: 'POST',
    url: `/api/team/${memberId}/worker-account`,
    headers: { cookie: owner.cookie },
    payload: { email: workerEmail, password: PASSWORD },
  });
  assert.equal(account.statusCode, 201, account.body);

  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: workerEmail, password: PASSWORD },
  });
  assert.equal(login.statusCode, 200, login.body);
  assert.equal((login.json() as { user: { accountRole: string } }).user.accountRole, 'cleaner');
  const token = login.cookies.find((entry) => entry.name === 'hs_session')?.value;
  assert.ok(token, 'the worker got a session');
  workerCookie = `hs_session=${token}`;

  const assigned = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: { cookie: owner.cookie },
    payload: {
      propertyId: property.id,
      kind: 'turnover',
      title: 'Clean after checkout',
      date: addDays(todayUTC(), 2),
      windowStart: '11:00',
      windowEnd: '15:00',
      assignee: 'Otieno Kefa',
    },
  });
  assert.equal(assigned.statusCode, 201, assigned.body);
  taskId = (assigned.json() as { task: { id: string } }).task.id;

  const unassigned = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: { cookie: owner.cookie },
    payload: { propertyId: property.id, kind: 'turnover', title: 'Not mine', date: todayUTC() },
  });
  assert.equal(unassigned.statusCode, 201, unassigned.body);
  otherTaskId = (unassigned.json() as { task: { id: string } }).task.id;
});

after(async () => {
  await app.close();
  await deleteUser(owner.email).catch(() => {});
  await deleteUser(workerEmail).catch(() => {});
  await closePool();
});

async function worker(
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>
) {
  return app.inject({
    method,
    url,
    headers: { cookie: workerCookie },
    ...(payload === undefined ? {} : { payload }),
  });
}

test('a cleaner sees only assigned jobs and cannot reach the admin APIs', async () => {
  const jobs = await worker('GET', '/api/my-jobs');
  assert.equal(jobs.statusCode, 200, jobs.body);
  const body = jobs.json() as { worker: string; jobs: { columns: Array<{ tasks: Job[] }> } };
  assert.equal(body.worker, 'Otieno Kefa');
  const all = body.jobs.columns.flatMap((column) => column.tasks);
  assert.equal(all.length, 1, 'only the job assigned to this worker');
  assert.equal(all[0]?.id, taskId);
  assert.equal(all[0]?.title, 'Clean after checkout');

  for (const url of ['/api/portfolio', '/api/tasks', '/api/financials', '/api/team']) {
    const blocked = await worker('GET', url);
    assert.equal(blocked.statusCode, 403, `${url} is refused for a worker`);
  }

  const someoneElses = await worker('POST', `/api/tasks/${otherTaskId}/start`);
  assert.equal(someoneElses.statusCode, 403, 'a worker cannot touch an unassigned job');
});

test('start, checklist, photo and done are attributed to the worker', async () => {
  const started = await worker('POST', `/api/tasks/${taskId}/start`);
  assert.equal(started.statusCode, 200, started.body);

  const board = await worker('GET', '/api/my-jobs');
  const job = (board.json() as { jobs: { columns: Array<{ tasks: Job[] }> } }).jobs.columns
    .flatMap((column) => column.tasks)
    .find((entry) => entry.id === taskId);
  assert.ok(job, 'the job is visible');
  assert.equal(job?.status, 'in_progress');
  assert.equal(job?.checklist.length, 5);

  for (const check of job!.checklist) {
    const ticked = await worker('POST', `/api/tasks/${taskId}/checklist`, {
      position: check.position,
      done: true,
    });
    assert.equal(ticked.statusCode, 200, ticked.body);
  }

  const photo = await worker('POST', `/api/tasks/${taskId}/photos`, {
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    caption: 'Finished space',
  });
  assert.equal(photo.statusCode, 200, photo.body);

  const done = await worker('POST', `/api/tasks/${taskId}/complete`);
  assert.equal(done.statusCode, 200, done.body);
});

test('the manager can read the proof and the named audit trail', async () => {
  const workerProof = await worker('GET', `/api/tasks/${taskId}/proof`);
  assert.equal(workerProof.statusCode, 200, workerProof.body);

  const proofResponse = await app.inject({
    method: 'GET',
    url: `/api/tasks/${taskId}/proof`,
    headers: { cookie: owner.cookie },
  });
  assert.equal(proofResponse.statusCode, 200, proofResponse.body);
  const proof = proofResponse.json() as {
    photos: Array<{ dataUrl: string; by: string | null }>;
    events: Array<{ action: string; by: string | null }>;
  };
  assert.equal(proof.photos.length, 1, 'one proof photo was saved');
  assert.equal(proof.photos[0]?.by, 'Otieno Kefa');
  const actions = proof.events.map((event) => event.action);
  assert.deepEqual(actions, ['start', 'check_checked', 'check_checked', 'check_checked',
    'check_checked', 'check_checked', 'photo_added', 'complete']);
  assert.ok(proof.events.every((event) => event.by === 'Otieno Kefa'), 'every step is attributed');
});

test('the roster says who has a login, and a manager can replace the password', async () => {
  const roster = await app.inject({
    method: 'GET',
    url: '/api/team',
    headers: { cookie: owner.cookie },
  });
  assert.equal(roster.statusCode, 200, roster.body);
  const mine = (roster.json() as {
    members: Array<{ id: string; hasAccount: boolean; loginEmail: string | null }>;
  }).members.find((member) => member.id === memberId);
  assert.equal(mine?.hasAccount, true, 'the roster shows the login exists');
  assert.equal(mine?.loginEmail, workerEmail, 'and which address it uses');

  const stranger = await app.inject({
    method: 'POST',
    url: '/api/team/00000000-0000-0000-0000-000000000000/worker-password',
    headers: { cookie: owner.cookie },
    payload: { password: 'Another123!' },
  });
  assert.equal(stranger.statusCode, 404, 'another portfolio cannot reset this login');

  const reset = await app.inject({
    method: 'POST',
    url: `/api/team/${memberId}/worker-password`,
    headers: { cookie: owner.cookie },
    payload: { password: 'Replaced123!' },
  });
  assert.equal(reset.statusCode, 200, reset.body);

  const oldSession = await worker('GET', '/api/my-jobs');
  assert.equal(oldSession.statusCode, 401, 'a reset ends the old sessions');
  const oldPassword = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: workerEmail, password: PASSWORD },
  });
  assert.equal(oldPassword.statusCode, 422, 'the old password no longer works');
  const newPassword = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: workerEmail, password: 'Replaced123!' },
  });
  assert.equal(newPassword.statusCode, 200, newPassword.body);
});
