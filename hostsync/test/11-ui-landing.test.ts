/**
 * T-01 / T-02 / T-03 — the public landing page.
 *
 * These are E-level: a real Chrome loads the real bundle from a real server, so
 * the assertion covers the whole chain (esbuild output → Fastify → DOM).
 */
import { after, before, test } from 'node:test';
import type { BrowserContext } from 'playwright-core';
import assert from 'node:assert/strict';
import { FEATURES } from '../web/content.ts';
import { closePool } from '../src/db.ts';
import { recordRequests, startUi } from './ui-helpers.ts';
import type { UiHarness } from './ui-helpers.ts';

let ui: UiHarness;
let context: BrowserContext;

before(async () => {
  ui = await startUi();
  // One context for the file: every extra document load costs 15–40 s here.
  context = await ui.context();
});

after(async () => {
  await context.close();
  await ui.close();
  await closePool();
});

test('T-01 the landing page renders the hero, all eight cards and both calls to action', async () => {
  const page = await context.newPage();
  const requests = recordRequests(page);

  const response = await page.goto('/');
  assert.equal(response?.status(), 200);

  const heading = await page.getByRole('heading', { level: 1 }).innerText();
  assert.equal(heading, 'Add your property. We hold every night.');

  assert.equal(await page.locator('[data-feature]').count(), 8, 'eight explainer cards');

  // Both CTAs are real links to the real screens.
  const register = page.getByRole('link', { name: 'Create account' }).first();
  const signIn = page.getByRole('link', { name: 'Sign in' }).first();
  assert.equal(await register.getAttribute('href'), '/register');
  assert.equal(await signIn.getAttribute('href'), '/login');

  // The stats strip carries the three promises, not a fake number.
  const stats = await page.locator('.stats li').allInnerTexts();
  assert.equal(stats.length, 3);
  assert.match(stats[0] ?? '', /1 grid/);
  assert.match(stats[1] ?? '', /0 double bookings/);
  assert.match(stats[2] ?? '', /3 ways in/);

  // T-03 is asserted here too: nothing on the page even tries to load a badge.
  assert.equal(
    requests.some((url) => /badge/i.test(url)),
    false,
    `no badge request was made, saw: ${requests.join(', ')}`
  );
});

test('T-02 every explainer card renders its title and body from the content fixture', async () => {
  const page = await context.newPage();
  await page.goto('/');

  for (const feature of FEATURES) {
    const card = page.locator(`[data-feature="${feature.id}"]`);
    assert.equal(await card.count(), 1, `${feature.id} is on the page`);

    const title = await card.locator('h3').innerText();
    const body = await card.locator('p').innerText();
    assert.equal(title.trim(), feature.title);
    assert.equal(body.trim(), feature.body);
  }
});

test('T-03 the shipped bundle has no Base44 badge, no badge script and no paid SDK', async () => {
  const page = await context.newPage();
  const requests = recordRequests(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const body = await page.content();
  assert.equal(/edit with/i.test(body), false, 'no "Edit with" overlay in the DOM');
  assert.equal(/base44/i.test(body), false, 'no Base44 reference in the DOM');
  assert.equal(/badge\.js/i.test(body), false, 'no badge script tag');

  assert.equal(
    requests.some((url) => /base44|badge/i.test(url)),
    false,
    `no request goes to a Base44 host, saw: ${requests.join(', ')}`
  );

  // The bundle itself is our own: one script, served from our origin.
  const scripts = await page.locator('script[src]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('src'))
  );
  assert.deepEqual(scripts, ['/assets/app.js']);
  assert.equal(scripts.every((src) => src?.startsWith('/assets/')), true);
});

test('the uploaded HostSync compass logo is served and used as the brand', async () => {
  const page = await context.newPage();
  await page.goto('/');
  const mark = page.locator('img.brand-mark').first();
  await mark.waitFor();
  assert.equal(await mark.getAttribute('src'), '/assets/logo.jpeg');

  const asset = await page.evaluate(async () => {
    const response = await fetch('/assets/logo.jpeg');
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      bytes: (await response.arrayBuffer()).byteLength,
    };
  });
  assert.equal(asset.status, 200);
  assert.match(asset.type ?? '', /image\/jpeg/);
  assert.ok(asset.bytes > 10_000, 'the real image is served, not a placeholder');
});
