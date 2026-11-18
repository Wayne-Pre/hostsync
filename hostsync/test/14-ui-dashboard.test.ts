/**
 * T-20 — a brand-new account sees the getting-started checklist, not fake zeros.
 * T-15 — six months become six bars, and the toggle re-labels them from the
 *        loaded payload instead of asking the server again.
 *
 * F-20's contract is "checklist instead of KPIs": a workspace with no properties
 * must not dress up an empty month as KES 0 revenue across four cards.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, pool } from '../src/db.ts';
import { addDays, todayUTC } from '../src/dates.ts';
import { createProperty, deleteUser } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';
import { newUser, recordRequests, startUi } from './ui-helpers.ts';
import type { UiHarness } from './ui-helpers.ts';

let ui: UiHarness;
let user: ApiUser;
let chartUser: ApiUser;

/** The first day of the month `offset` months from this one. */
function monthStart(offset: number): string {
  const [year, month] = todayUTC().split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1 + offset, 1)).toISOString().slice(0, 10);
}

function daysInMonth(monthKey: string): number {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(year!, month!, 0)).getUTCDate();
}

before(async () => {
  ui = await startUi();
  user = await newUser(ui.app, 'EMPTY');
  chartUser = await newUser(ui.app, 'CHART');
});

after(async () => {
  await ui.close();
  await deleteUser(user.email);
  await deleteUser(chartUser.email);
  await closePool();
});

test('T-20 an empty workspace renders the checklist, no invented KPI cards and no crash', async () => {
  const page = await ui.signedIn(user);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

  const empty = page.locator('[data-testid="empty-state"]');
  await empty.waitFor({ state: 'visible' });

  assert.match(await empty.innerText(), /No properties yet/);
  assert.equal(await empty.locator('.checklist li').count(), 4, 'the getting-started checklist');

  // No KPI cards and no health table: nothing pretends the portfolio has data.
  assert.equal(await page.locator('[data-kpi]').count(), 0);
  assert.equal(await page.locator('[data-testid="health-table"]').count(), 0);

  // The shell still works: navigation, identity, portfolio count of zero.
  await page.waitForSelector('[data-testid="portfolio-pill"]');
  assert.equal((await page.locator('[data-testid="portfolio-pill"]').innerText()).trim(), 'EMPTY · 0 PROPERTIES');

  assert.deepEqual(errors, []);
});

test('T-15 the chart draws six sorted months and the toggle swaps series without a refetch', async () => {
  const property = await createProperty(ui.app, chartUser, { name: 'Chart House' });

  const nightsPerMonth = [4, 6, 3, 5, 7, 2];
  const offsets = [-5, -4, -3, -2, -1, 0];
  const seeded = offsets.map((offset, index) => {
    const start = monthStart(offset);
    return {
      start,
      month: start.slice(0, 7),
      nights: nightsPerMonth[index]!,
      netCents: 250_000 + index * 150_000,
    };
  });

  for (const seed of seeded) {
    await pool.query(
      `insert into booking (
         property_id, reference, guest_name, channel, stay, guests,
         gross_cents, commission_bps, net_cents, rate_version,
         payment_status, status, source
       ) values (
         $1, 'CHART-' || nextval('booking_ref_seq'), 'Chart Guest', 'direct',
         daterange($2::date, $3::date, '[)'), 2,
         $4, 0, $4, 1, 'paid', 'confirmed', 'import'
       )`,
      [property.id, seed.start, addDays(seed.start, seed.nights), seed.netCents]
    );
  }

  const page = await ui.signedIn(chartUser);
  const requests = recordRequests(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

  const chart = page.locator('[data-testid="dashboard-chart"]');
  await chart.waitFor({ state: 'visible' });

  const bars = chart.locator('[data-month]');
  assert.equal(await bars.count(), 6, 'six bars, one per month');

  const months: string[] = [];
  const revenues: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    months.push((await bars.nth(index).getAttribute('data-month')) ?? '');
    revenues.push(Number(await bars.nth(index).getAttribute('data-value')));
  }

  assert.deepEqual(months, seeded.map((seed) => seed.month), 'oldest first, no gaps');
  assert.deepEqual(revenues, seeded.map((seed) => seed.netCents), 'each bar is its month revenue');

  // The chart asked for the data exactly once so far.
  const loads = () => requests.filter((url) => url.includes('/api/dashboard')).length;
  assert.equal(loads(), 1);

  await page.getByRole('button', { name: 'Occupancy' }).click();
  await page.locator('[data-testid="dashboard-chart"][data-series="occupancy"]').waitFor();

  const occupancies: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    occupancies.push(Number(await bars.nth(index).getAttribute('data-value')));
  }

  assert.deepEqual(
    occupancies,
    seeded.map((seed) => Math.round((seed.nights / daysInMonth(seed.month)) * 100)),
    'the occupancy series is nights over the days in each month'
  );
  assert.equal(loads(), 1, 'the toggle re-renders the loaded payload, it does not refetch');

  // F-17 — the payable widget renders the server's own total and links there.
  const payout = page.locator('[data-testid="payout-widget"]');
  await payout.waitFor({ state: 'visible' });
  assert.match(await payout.innerText(), /across 0 statements/i);
  assert.equal(await payout.getByRole('link', { name: 'Open payouts' }).getAttribute('href'), '/payouts');
});
