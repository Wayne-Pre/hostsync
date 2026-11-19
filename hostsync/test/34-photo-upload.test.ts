/** Local photo uploads: a small compressed image lives with the property in Postgres. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../src/db.ts';
import { createProperty, deleteUser } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';
import { newUser, startUi } from './ui-helpers.ts';
import type { UiHarness } from './ui-helpers.ts';

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

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

test('a photo data URL is stored with the property', async () => {
  const created = await createProperty(ui.app, user, {
    name: 'Photo House',
    photoKey: TINY_PNG,
  });
  const response = await ui.app.inject({
    method: 'GET',
    url: '/api/properties',
    headers: { cookie: user.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  const rows = (response.json() as { properties: Array<{ id: string; photoKey: string | null }> })
    .properties;
  assert.equal(rows.find((row) => row.id === created.id)?.photoKey, TINY_PNG);

  const bad = await ui.app.inject({
    method: 'POST',
    url: '/api/properties',
    headers: { cookie: user.cookie },
    payload: { name: 'Bad Photo', nightlyRateCents: 100_000, photoKey: 'data:text/plain;base64,QQ==' },
  });
  assert.equal(bad.statusCode, 422, bad.body);
});

test('a photo can be chosen from the device and the stage caption is gone', async () => {
  const page = await ui.signedIn(user);
  await page.goto('/properties');
  assert.equal(await page.getByText('Stage 1 · one calendar that holds').count(), 0);

  await page.getByRole('button', { name: 'Add property' }).first().click();
  const form = page.locator('[data-testid="property-form"]');
  await form.locator('#p-name').fill('Uploaded House');
  await form.locator('#p-rate').fill('1500');
  await form.locator('[data-testid="photo-file"]').setInputFiles({
    name: 'house.png',
    mimeType: 'image/png',
    buffer: Buffer.from(TINY_PNG.split(',')[1]!, 'base64'),
  });
  await form.locator('[data-testid="photo-preview"]').waitFor();
  await form.getByRole('button', { name: 'Add property' }).click();

  const card = page.locator('[data-property]').filter({ hasText: 'Uploaded House' });
  await card.waitFor();
  await card.locator('[data-testid="property-photo"]').waitFor();
});
