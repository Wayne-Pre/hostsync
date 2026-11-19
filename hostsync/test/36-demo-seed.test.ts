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

  await app.close();
});
