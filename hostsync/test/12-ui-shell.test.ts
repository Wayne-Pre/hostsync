/**
 * T-04 toast region · T-11 sidebar · T-12 identity header · T-13 mobile drawer.
 *
 * Each of these is a shell-level promise, so they are asserted in a browser
 * rather than against markup strings.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../src/db.ts';
import { NAV } from '../web/nav.ts';
import { createProperty, deleteUser } from './api-helpers.ts';
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

test('T-04 the app has one ARIA live region, and a save announces then auto-dismisses', async () => {
  const page = await ui.signedIn(user);
  await page.goto('/calendar');

  const region = page.locator('[role="region"][aria-label="Notifications alt+T"]');
  assert.equal(await region.count(), 1, 'exactly one notification region');
  assert.equal(await region.locator('[role="status"][aria-live="polite"]').count(), 1);

  // Refreshing the calendars is a server mutation: it is the app's "save".
  await page.getByRole('button', { name: 'Refresh calendars' }).click();

  const toast = page.locator('[data-testid="toast"]');
  await page.waitForSelector('[data-testid="toast"][data-visible="true"]');
  const announced = (await toast.innerText()).trim();
  assert.match(announced, /calendar/i, `the region announced: "${announced}"`);

  // …and it leaves on its own, no user action.
  await page.waitForSelector('[data-testid="toast"][data-visible="false"]', { timeout: 10_000 });
  assert.equal((await toast.innerText()).trim(), '');
});

test('T-11 each of the ten nav items routes to its screen and is the only active one', async () => {
  const page = await ui.signedIn(user);
  await page.goto('/dashboard');
  assert.equal(NAV.length, 10);

  for (const item of NAV) {
    await page.click(`[data-testid="sidebar"] a[data-nav="${item.label}"]`);
    await page.waitForURL((url) => url.pathname === item.href);

    const link = page.locator(`[data-testid="sidebar"] a[data-nav="${item.label}"]`);
    assert.equal(await link.getAttribute('aria-current'), 'page', `${item.label} is current`);
    assert.match((await link.getAttribute('class')) ?? '', /is-active/);

    assert.equal(
      await page.locator('[data-testid="sidebar"] a.nav-item.is-active').count(),
      1,
      'exactly one item is active'
    );

    // The screen itself rendered, not a blank shell.
    const content = await page.locator('main.content').innerText();
    assert.ok(content.trim().length > 0, `${item.label} rendered something`);
  }
});

test('T-12 the header shows the signed-in name, "Signed in" and the portfolio pill', async () => {
  const five = await newUser(ui.app, 'TEST');
  try {
    for (let index = 0; index < 5; index += 1) {
      await createProperty(ui.app, five, { name: `Header House ${index + 1}` });
    }

    const page = await ui.signedIn(five);
    await page.goto('/dashboard');

    await page.waitForSelector('[data-testid="portfolio-pill"]');
    assert.equal((await page.locator('[data-testid="portfolio-pill"]').innerText()).trim(), 'TEST · 5 PROPERTIES');
    assert.equal((await page.locator('[data-testid="user-name"]').innerText()).trim(), 'Test Owner');
    assert.match(await page.locator('[data-testid="user-chip"]').innerText(), /Signed in/);

    // The pill is not a hard-coded label: it follows the real count.
    await createProperty(ui.app, five, { name: 'Header House 6' });
    await page.reload();
    await page.waitForSelector('[data-testid="portfolio-pill"]');
    assert.equal((await page.locator('[data-testid="portfolio-pill"]').innerText()).trim(), 'TEST · 6 PROPERTIES');
  } finally {
    await deleteUser(five.email);
  }
});

test('T-13 at 390 px the sidebar hides, "Open navigation" opens a drawer and its links navigate', async () => {
  const page = await ui.signedIn(user);
  await page.setViewportSize({ width: 390, height: 820 });
  await page.goto('/dashboard');

  assert.equal(await page.locator('[data-testid="sidebar"]').isVisible(), false, 'sidebar is gone');

  await page.getByRole('button', { name: 'Open navigation' }).click();

  const drawer = page.locator('.drawer');
  await drawer.waitFor({ state: 'visible' });
  assert.equal(await drawer.locator('a.nav-item').count(), 10, 'the drawer carries the whole navigation');

  await drawer.locator('a[data-nav="Calendar"]').click();
  await page.waitForURL((url) => url.pathname === '/calendar');
  assert.equal(new URL(page.url()).pathname, '/calendar');
});
