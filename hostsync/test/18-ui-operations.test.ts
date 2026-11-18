/**
 * T-45 — the task card carries its whole story, and the board moves it.
 *
 * The card anatomy is the contract: kind, property, title, when, how far along,
 * who, and what happens next. If any of those is missing, the host has to open
 * something to find out.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../src/db.ts';
import { addDays, todayUTC } from '../src/dates.ts';
import { createProperty, deleteUser } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';
import { newUser, startUi } from './ui-helpers.ts';
import type { UiHarness } from './ui-helpers.ts';

let ui: UiHarness;
let user: ApiUser;

before(async () => {
  ui = await startUi();
  user = await newUser(ui.app, 'OPS');
});

after(async () => {
  await ui.close();
  await deleteUser(user.email);
  await closePool();
});

test('T-45 a task card shows kind, property, title, window, progress, owner and the next action', async () => {
  const property = await createProperty(ui.app, user, { name: 'Board House' });
  const today = todayUTC();

  const created = await ui.app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: { cookie: user.cookie },
    payload: {
      propertyId: property.id,
      kind: 'maintenance',
      title: 'Replace the pool pump',
      date: addDays(today, 2),
      windowStart: '09:00',
      windowEnd: '12:00',
      assignee: 'Wanjiku',
    },
  });
  assert.equal(created.statusCode, 201, created.body);

  const page = await ui.signedIn(user);
  await page.goto('/operations', { waitUntil: 'domcontentloaded' });

  const card = page.locator('.task-card').first();
  await card.waitFor({ state: 'visible' });

  assert.equal((await card.locator('.kind').innerText()).trim(), 'MAINTENANCE');
  assert.equal((await card.locator('.task-title').innerText()).trim(), 'Replace the pool pump');
  assert.equal((await card.locator('.task-property').innerText()).trim(), 'Board House');
  assert.match(await card.locator('.task-window').innerText(), /09:00/);
  assert.match(await card.locator('.task-window').innerText(), /12:00/);
  assert.match(await card.locator('.task-checklist').innerText(), /\d+\/\d+ checks/);
  assert.match(await card.locator('.task-assignee').innerText(), /Wanjiku/);

  // It sits in the SCHEDULED column, because somebody owns it.
  const scheduled = page.locator('[data-column="scheduled"]');
  assert.equal(await scheduled.locator('.task-card').count(), 1);
  assert.equal(
    (await page.locator('[data-count="scheduled"]').innerText()).trim(),
    '1',
    'the column count matches'
  );

  // The counters read the same board.
  assert.equal((await page.locator('[data-counter="unassigned"] .kpi-value').innerText()).trim(), '0');

  // The action moves the card, and the app says so.
  await card.locator('[data-action="start"]').click();
  await page.waitForSelector('[data-testid="toast"][data-visible="true"]');
  assert.match(await page.locator('[data-testid="toast"]').innerText(), /started/i);

  await page.waitForSelector('[data-column="on_site"] .task-card');
  assert.equal(await page.locator('[data-column="on_site"] .task-card').count(), 1);
  assert.equal(await page.locator('[data-column="scheduled"] .task-card').count(), 0);

  await page.context().close();
});
