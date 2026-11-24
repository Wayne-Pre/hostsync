/**
 * E-level field-worker screen: login, phone layout, checklist, proof photo,
 * done, and an audit trail with the worker's name on every step.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext } from 'playwright-core';
import { closePool } from '../src/db.ts';
import { addDays, todayUTC } from '../src/dates.ts';
import { createProperty, deleteUser } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';
import { newUser, startUi } from './ui-helpers.ts';
import type { UiHarness } from './ui-helpers.ts';

const PASSWORD = 'FieldUIPass123!';
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/7ZkAAAAASUVORK5CYII=',
  'base64'
);

let ui: UiHarness;
let owner: ApiUser;
let workerEmail: string;
let workerCookie: { name: string; value: string };
let context: BrowserContext;
let taskId: string;

before(async () => {
  ui = await startUi();
  owner = await newUser(ui.app, 'FIELD');
  const property = await createProperty(ui.app, owner, { name: 'Field House' });

  const member = await ui.app.inject({
    method: 'POST',
    url: '/api/team',
    headers: { cookie: owner.cookie },
    payload: { name: 'Otieno Kefa', role: 'cleaner' },
  });
  assert.equal(member.statusCode, 201, member.body);
  const memberId = (member.json() as { member: { id: string } }).member.id;

  workerEmail = `ui-worker-${Date.now()}@example.test`;
  const account = await ui.app.inject({
    method: 'POST',
    url: `/api/team/${memberId}/worker-account`,
    headers: { cookie: owner.cookie },
    payload: { email: workerEmail, password: PASSWORD },
  });
  assert.equal(account.statusCode, 201, account.body);

  const login = await ui.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: workerEmail, password: PASSWORD },
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = login.cookies.find((entry) => entry.name === 'hs_session');
  assert.ok(cookie);
  workerCookie = { name: cookie.name, value: cookie.value };

  const created = await ui.app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: { cookie: owner.cookie },
    payload: {
      propertyId: property.id,
      kind: 'turnover',
      title: 'Clean after checkout',
      date: addDays(todayUTC(), 1),
      windowStart: '11:00',
      windowEnd: '15:00',
      assignee: 'Otieno Kefa',
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  taskId = (created.json() as { task: { id: string } }).task.id;
});

after(async () => {
  if (context) await context.close();
  await deleteUser(owner.email).catch(() => {});
  await deleteUser(workerEmail).catch(() => {});
  await ui.close();
  await closePool();
});

test('a cleaner works a job end to end on a phone-sized screen', async () => {
  context = await ui.context();
  await context.addCookies([{ ...workerCookie, url: ui.baseUrl }]);

  const page = await context.newPage();
  await page.setViewportSize({ width: 390, height: 820 });
  await page.goto('/my-jobs');

  await page.getByRole('heading', { name: /Today's work/i }).waitFor();
  assert.match(await page.locator('.worker-who strong').innerText(), /Otieno Kefa/);

  const job = page.locator(`[data-task="${taskId}"]`).filter({ hasText: 'Clean after checkout' });
  assert.equal(await job.count(), 1, 'only the worker’s own job is on the screen');

  const widths = await page.evaluate(() => {
    const g = globalThis as any;
    return {
      viewport: g.innerWidth as number,
      scroll: g.document.documentElement.scrollWidth as number,
    };
  });
  assert.ok(widths.scroll <= widths.viewport + 1, 'no horizontal overflow on a phone');

  await job.locator('[data-testid="worker-start"]').click();
  await page.waitForSelector('[data-testid="worker-done"]');

  const boxes = job.locator('.worker-checklist input[type="checkbox"]');
  assert.equal(await boxes.count(), 5);
  for (let i = 0; i < 5; i += 1) {
    await boxes.nth(i).click();
    await job.locator('.worker-progress').filter({ hasText: `${i + 1}/5 checks` }).waitFor();
  }

  await job.locator('[data-testid="worker-photo-input"]').setInputFiles({
    name: 'finished.png',
    mimeType: 'image/png',
    buffer: TINY_PNG,
  });
  // Uploading opens the history panel by itself and shows the proof.
  await job.locator('.worker-photo-grid img').waitFor();

  await job.locator('[data-testid="worker-done"]').click();

  // Completed jobs move to the Done tab, as on the manager's board.
  await page.locator('.worker-tabs button').filter({ hasText: /Done/ }).click();
  const finished = page.locator(`[data-task="${taskId}"]`);
  await finished.locator('[data-testid="worker-reopen"]').waitFor();

  const panel = finished.locator('[data-testid="worker-proof-panel"]');
  await panel.waitFor();
  assert.equal(await panel.locator('img').count(), 1, 'the proof photo is shown');
  const history = await panel.locator('.worker-events').innerText();
  assert.match(history, /Otieno Kefa/, 'the audit trail names the worker');
  assert.match(history, /check checked|photo added|complete/i);
});
