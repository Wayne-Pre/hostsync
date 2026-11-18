/**
 * §7.4 defect #2 — the statement "View" button must open a real detail view:
 * line items that drill down to the ledger entries behind them, frozen at
 * approval so a later ledger write cannot rewrite an approved statement.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import type { FastifyInstance } from 'fastify';
import { closePool, pool } from '../src/db.ts';
import { createCaptureTransport } from '../src/mail.ts';
import { todayUTC } from '../src/dates.ts';
import { money } from '../web/client.ts';
import { createProperty, deleteUser } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';
import { newUser, startUi } from './ui-helpers.ts';
import type { UiHarness } from './ui-helpers.ts';

interface Detail {
  statementId: string;
  propertyName: string;
  status: string;
  frozen: boolean;
  totalCents: number;
  lines: Array<{
    lineType: 'booking' | 'expense' | 'fee';
    label: string;
    amountCents: number;
    entryCount: number;
    entries: Array<{ id: string; description: string; amountCents: number }>;
  }>;
}

let ui: UiHarness;
let app: FastifyInstance;
let user: ApiUser;
let propertyId: string;
let statementId: string;
let page: Page;

async function post<T>(url: string, payload: Record<string, unknown>, expected = 200): Promise<T> {
  const response = await app.inject({
    method: 'POST',
    url,
    headers: { cookie: user.cookie },
    payload,
  });
  assert.equal(response.statusCode, expected, response.body);
  return response.json() as T;
}

async function get<T>(url: string): Promise<T> {
  const response = await app.inject({ method: 'GET', url, headers: { cookie: user.cookie } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as T;
}

async function detail(): Promise<Detail> {
  return (await get<{ detail: Detail }>(`/api/statements/${statementId}`)).detail;
}

before(async () => {
  ui = await startUi();
  app = ui.app;
  user = await newUser(app, 'DETAIL');

  const property = await createProperty(app, user, {
    name: 'Detail House',
    nightlyRateCents: 1_000_000,
    cleaningFeeCents: 0,
    managementFeePercent: 15,
  });
  propertyId = property.id;
  await app.inject({
    method: 'PUT',
    url: `/api/properties/${property.id}/account`,
    headers: { cookie: user.cookie },
    payload: { label: 'KCB 5005', verified: true, balanceCents: 0 },
  });

  const monthStart = `${todayUTC().slice(0, 7)}-01`;
  const paid = await pool.query<{ id: string }>(
    `insert into booking (
       property_id, reference, guest_name, channel, stay, guests,
       gross_cents, commission_bps, net_cents, rate_version,
       payment_status, status, source
     ) values (
       $1, 'HS-DETAIL', 'Detail Guest', 'direct',
       daterange($2::date, $2::date + 3, '[)'), 2,
       3000000, 0, 3000000, 1, 'unpaid', 'confirmed', 'import'
     ) returning id`,
    [propertyId, monthStart]
  );
  await post(`/api/bookings/${paid.rows[0]!.id}/payment`, { paymentStatus: 'paid' });
  await post('/api/transactions/expense', {
    propertyId,
    date: monthStart,
    category: 'housekeeping',
    amountCents: 100_000,
    description: 'Linen',
  }, 201);

  const month = todayUTC().slice(0, 7);
  const created = await post<{ statement: { id: string; netCents: number } }>(
    '/api/statements',
    { propertyId, month },
    201
  );
  statementId = created.statement.id;
  assert.equal(created.statement.netCents, 2_450_000);
});

after(async () => {
  await ui.close();
  await deleteUser(user.email);
  await closePool();
});

test('draft detail derives lines and entries from the current ledger', async () => {
  const data = await detail();
  assert.equal(data.frozen, false);
  assert.equal(data.propertyName, 'Detail House');
  assert.equal(data.totalCents, 2_450_000);
  assert.deepEqual(
    data.lines.map((line) => line.lineType),
    ['booking', 'expense', 'fee']
  );
  const booking = data.lines[0]!;
  assert.equal(booking.amountCents, 3_000_000);
  assert.equal(booking.entries.length, 1);
  assert.match(booking.entries[0]!.description, /HS-DETAIL/);
  assert.equal(data.lines[1]!.amountCents, -100_000);
  assert.equal(data.lines[1]!.entries[0]!.description, 'Linen');
  assert.equal(data.lines[2]!.amountCents, -450_000);
  assert.equal(data.lines[2]!.entries.length, 0);
});

test('approval freezes the detail; a later expense cannot change it', async () => {
  await post(`/api/statements/${statementId}/approve`, {});
  const frozen = await detail();
  assert.equal(frozen.frozen, true);

  await post('/api/transactions/expense', {
    propertyId,
    date: todayUTC(),
    category: 'maintenance',
    amountCents: 25_000,
    description: 'New repair',
  }, 201);

  const after = await detail();
  assert.deepEqual(after, frozen, 'the frozen lines did not move');
  assert.equal(after.totalCents, 2_450_000);
});

test('the View button opens the drill-down in the browser', async () => {
  page = await ui.signedIn(user);
  await page.goto('/payouts');
  const row = page.locator(`[data-statement="${statementId}"]`);
  await row.locator('button[data-action="view"]').click();

  const dialog = page.locator('[data-testid="statement-detail"]');
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('[data-testid="statement-lines"]').waitFor({ state: 'visible' });
  assert.match(await dialog.locator('.sheet-sub').innerText(), /frozen when approved/);

  const lines = dialog.locator('[data-testid="statement-line"]');
  assert.equal(await lines.count(), 3);
  assert.match(await lines.nth(0).innerText(), /HS-DETAIL/);
  assert.equal(await dialog.locator('[data-testid="detail-total"]').innerText(), `Lines total ${money(2_450_000)}`);

  const first = lines.nth(0);
  assert.equal(await first.locator('[data-testid="ledger-entry"]').first().isVisible(), false);
  await first.locator('summary').click();
  const entries = first.locator('[data-testid="ledger-entry"]');
  await entries.first().waitFor({ state: 'visible' });
  assert.equal(await entries.count(), 1);
  assert.match(await entries.first().innerText(), /HS-DETAIL/);

  await dialog.getByRole('button', { name: 'Close' }).click();
  await dialog.waitFor({ state: 'hidden' });
});
