/**
 * F-10 as a real screen: a verified user with no workspace is sent to
 * onboarding instead of a dashboard full of failing API calls, and anything
 * they add afterwards survives a fresh login.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, pool } from '../src/db.ts';
import { SESSION_COOKIE } from '../src/app.ts';
import { createProperty, deleteUser, TEST_PASSWORD } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';
import { newUser, startUi } from './ui-helpers.ts';
import type { UiHarness } from './ui-helpers.ts';

let ui: UiHarness;
let user: ApiUser;

before(async () => {
  ui = await startUi();
  user = await newUser(ui.app);
  // Simulate the real bug: an account that never completed onboarding.
  await pool.query('delete from portfolio where id = $1', [user.portfolioId]);
});

after(async () => {
  await ui.close();
  await deleteUser(user.email);
  await closePool();
});

test('a signed-in user without a workspace is sent to onboarding', async () => {
  const page = await ui.app.inject({
    method: 'GET',
    url: '/dashboard',
    headers: { cookie: user.cookie },
  });
  assert.equal(page.statusCode, 302);
  assert.equal(page.headers.location, '/onboarding');

  const api = await ui.app.inject({
    method: 'GET',
    url: '/api/portfolio',
    headers: { cookie: user.cookie },
  });
  assert.equal(api.statusCode, 409, 'the API honestly reports the missing workspace');
});

test('onboarding creates the workspace and data survives a new login', async () => {
  const browser = await ui.signedIn(user);
  await browser.goto('/dashboard');
  await browser.waitForURL('**/onboarding');

  const form = browser.locator('[data-testid="onboarding-form"]');
  await form.waitFor({ state: 'visible', timeout: 60000 });
  await form.locator('[data-testid="onboarding-name"]').fill('Persisted Workspace');
  await form.locator('[data-testid="onboarding-currency"]').selectOption('USD');
  await form.locator('[data-testid="onboarding-submit"]').click();
  await browser.waitForURL('**/dashboard');
  await browser.locator('.checklist li').first().waitFor();

  assert.equal(await browser.locator('.checklist li').count(), 4, 'an honest empty checklist');
  assert.equal(await browser.locator('[role="alert"]').count(), 0, 'no failing API banners');

  const property = await createProperty(ui.app, user, { name: 'Persisted House' });
  const login = await ui.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: user.email, password: TEST_PASSWORD },
  });
  assert.equal(login.statusCode, 200, login.body);
  const token = login.cookies.find((entry) => entry.name === SESSION_COOKIE)?.value;
  assert.ok(token, 'a fresh session cookie was issued');

  const reloaded = await ui.app.inject({
    method: 'GET',
    url: '/api/properties',
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
  assert.equal(reloaded.statusCode, 200, reloaded.body);
  const rows = reloaded.json() as { properties: Array<{ id: string; name: string }> };
  assert.ok(
    rows.properties.some((entry) => entry.id === property.id),
    'the property is still there after signing in again'
  );
});
