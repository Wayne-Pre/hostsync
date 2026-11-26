/**
 * The manager-side access flow, end to end in a browser: add a cleaner to the
 * roster, give them a login, then sign in as that cleaner and land on the jobs
 * screen. This is the exact path a real company follows.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext } from 'playwright-core';
import { closePool } from '../src/db.ts';
import { deleteUser } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';
import { newUser, startUi } from './ui-helpers.ts';
import type { UiHarness } from './ui-helpers.ts';

const WORKER_PASSWORD = 'Bench-4821-Kite';
let ui: UiHarness;
let owner: ApiUser;
let workerEmail: string;
const contexts: BrowserContext[] = [];

before(async () => {
  ui = await startUi();
  owner = await newUser(ui.app, 'ACCESS');
  workerEmail = `roster-${Date.now()}@example.test`;
});

after(async () => {
  for (const context of contexts) await context.close();
  await deleteUser(owner.email).catch(() => {});
  await deleteUser(workerEmail).catch(() => {});
  await ui.close();
  await closePool();
});

test('a manager adds a cleaner, gives access, and the cleaner signs in', async () => {
  const page = await ui.signedIn(owner);
  await page.goto('/team', { waitUntil: 'domcontentloaded' });

  await page.getByRole('heading', { name: 'How a cleaner gets access' }).waitFor();
  await page.getByTestId('add-member-button').click();
  await page.getByTestId('member-name').fill('Mercy Achieng');
  await page.getByLabel('Role').selectOption('cleaner');
  await page.getByRole('button', { name: 'Add to roster' }).click();

  const row = page.locator('.roster-row').filter({ hasText: 'Mercy Achieng' });
  await row.waitFor();
  assert.match(await row.innerText(), /no phone access yet/i);

  await row.getByTestId('give-access').click();
  await page.getByTestId('worker-email').fill(workerEmail);
  await page.getByTestId('worker-password').fill(WORKER_PASSWORD);
  await page.getByRole('button', { name: 'Create login' }).click();

  const credentials = page.getByTestId('credentials');
  await credentials.waitFor();
  const shown = await credentials.innerText();
  assert.match(shown, new RegExp(workerEmail.replace('.', '\\.')));
  assert.match(shown, new RegExp(WORKER_PASSWORD));
  await credentials.getByRole('button', { name: 'Done' }).click();

  await page.getByTestId('access-on').waitFor();
  assert.match(await row.innerText(), /phone access/i);

  // A different browser, no existing cookies: this is the cleaner's phone.
  const workerContext = await ui.context();
  contexts.push(workerContext);
  const phone = await workerContext.newPage();
  await phone.setViewportSize({ width: 390, height: 820 });
  await phone.goto('/login');
  await phone.locator('#login-email').fill(workerEmail);
  await phone.locator('#login-password').fill(WORKER_PASSWORD);
  await phone.getByRole('button', { name: 'Sign in' }).click();

  await phone.waitForURL('**/my-jobs');
  await phone.getByRole('heading', { name: /Today's work/i }).waitFor();
  assert.match(await phone.locator('.worker-who').innerText(), /Mercy Achieng/);
  const width = await phone.evaluate(() => {
    const g = globalThis as any;
    return { view: g.innerWidth as number, scroll: g.document.documentElement.scrollWidth as number };
  });
  assert.ok(width.scroll <= width.view + 1, 'the jobs screen fits a phone with no sideways scroll');
});
