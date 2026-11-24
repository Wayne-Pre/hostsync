/** The marketing demo seeder must produce a real, login-able account. */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { buildApp } from '../src/app.ts';
import { closePool } from '../src/db.ts';
import { deleteUser } from './api-helpers.ts';

const EMAIL = 'demo@hostsync.app';
const PASSWORD = 'Demo12345!';

after(async () => {
  await deleteUser(EMAIL).catch(() => {});
  await closePool();
});

test('seed:demo creates an account that can sign in and read real data', () => {
  const output = execFileSync(process.execPath, ['scripts/seed-demo.ts'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
  });
  assert.match(output, /Demo account ready/);
  assert.match(output, /Field-worker login: cleaner@hostsync.app \/ Cleaner12345!/);
  assert.match(output, /6 properties, 36 stays/);
});

test('the seeded demo account has a working dashboard and ledger', async () => {
  const app = buildApp({ logger: false });
  await app.ready();

  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: EMAIL, password: PASSWORD },
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = login.cookies.find((entry) => entry.name === 'hs_session')?.value;
  assert.ok(cookie, 'a real session was issued');
  const headers = { cookie: `hs_session=${cookie}` };

  const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard', headers });
  assert.equal(dashboard.statusCode, 200, dashboard.body);
  const data = dashboard.json() as { health: unknown[]; chart: unknown[]; turnovers: unknown[] };
  assert.equal(data.health.length, 6);
  assert.equal(data.chart.length, 6);
  assert.ok(data.turnovers.length > 0, 'upcoming stays produced turnovers');

  const financials = await app.inject({ method: 'GET', url: '/api/financials', headers });
  assert.equal(financials.statusCode, 200, financials.body);
  const money = financials.json() as { kpis: { revenueCents: number }; series: unknown[] };
  assert.ok(money.kpis.revenueCents > 0, 'the ledger has real posted money');
  assert.equal(money.series.length, 6);

  const reconciliation = await app.inject({
    method: 'GET', url: '/api/financials/reconciliation', headers,
  });
  assert.equal(reconciliation.statusCode, 200, reconciliation.body);
  const report = reconciliation.json() as { reconciliation: { balanced: boolean; drift: unknown[] } };
  assert.equal(report.reconciliation.balanced, true, JSON.stringify(report.reconciliation.drift));

  const tasks = await app.inject({ method: 'GET', url: '/api/tasks', headers });
  assert.equal(tasks.statusCode, 200, tasks.body);
  const board = tasks.json() as {
    counters: { unassigned: number; needsSomeone: number };
    columns: Array<{ key: string; count: number; tasks: Array<{ title: string; kind: string; assignee: string | null }> }>;
  };
  assert.ok(board.counters.unassigned >= 1, 'the demo leaves cleaning work unassigned so it can be handed out');
  assert.ok(board.counters.needsSomeone >= 1, 'the demo shows work held by a paused member');
  const unassigned = board.columns.find((column) => column.key === 'unassigned');
  assert.ok(unassigned && unassigned.count >= 1, 'the UNASSIGNED column has a first row');
  assert.match(unassigned!.tasks[0]!.title, /Turnover/, 'the first row is a cleaning turnover');
  assert.equal(unassigned!.tasks[0]!.assignee, null, 'the first row is unscheduled');
  assert.equal(unassigned!.tasks[0]!.kind, 'turnover');

  const workerLogin = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'cleaner@hostsync.app', password: 'Cleaner12345!' },
  });
  assert.equal(workerLogin.statusCode, 200, workerLogin.body);
  const workerToken = workerLogin.cookies.find((entry) => entry.name === 'hs_session')?.value;
  assert.ok(workerToken, 'the demo cleaner can sign in');
  const workerJobs = await app.inject({
    method: 'GET',
    url: '/api/my-jobs',
    headers: { cookie: `hs_session=${workerToken}` },
  });
  assert.equal(workerJobs.statusCode, 200, workerJobs.body);
  const mine = (workerJobs.json() as { jobs: { columns: Array<{ tasks: unknown[] }> } }).jobs.columns
    .flatMap((column) => column.tasks);
  assert.ok(mine.length >= 12, 'the demo cleaner has real jobs across the board');

  await app.close();
});
