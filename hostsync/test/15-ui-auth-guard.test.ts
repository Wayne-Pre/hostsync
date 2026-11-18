/**
 * T-09 at the layer the spec asks for: a browser.
 *
 * 05-auth proves the guard at the HTTP level (`302` + `Location`). This proves
 * the shipped experience: a signed-out visitor lands on the sign-in form, the
 * form really signs in, and signing out closes the door again.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../src/db.ts';
import { deleteUser, TEST_PASSWORD } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';
import { newUser, startUi } from './ui-helpers.ts';
import type { UiHarness } from './ui-helpers.ts';

let ui: UiHarness;
let user: ApiUser;

before(async () => {
  ui = await startUi();
  user = await newUser(ui.app);
});

after(async () => {
  await ui.close();
  await deleteUser(user.email);
  await closePool();
});

test('T-09 an anonymous visitor is redirected to the form, signs in, and signs out again', async () => {
  const context = await ui.context();
  const page = await context.newPage();

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForURL((url) => url.pathname === '/login');

  // The form is the real one: labelled inputs, not an error page.
  assert.equal(await page.getByLabel('Email').isVisible(), true);
  assert.equal(await page.getByLabel('Password').isVisible(), true);

  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.pathname === '/dashboard');

  await page.waitForSelector('[data-testid="user-name"]');
  assert.equal((await page.locator('[data-testid="user-name"]').innerText()).trim(), 'Test Owner');

  // Sign out, then try to go straight back.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL((url) => url.pathname === '/login');

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForURL((url) => url.pathname === '/login');
});
