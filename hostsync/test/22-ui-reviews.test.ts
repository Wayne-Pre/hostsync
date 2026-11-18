/**
 * T-58 at the browser level — the reply is written in the feed, the button is
 * disabled until there is something to say, and the numbers move.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, pool } from '../src/db.ts';
import { createProperty, deleteUser } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';
import { newUser, startUi } from './ui-helpers.ts';
import type { UiHarness } from './ui-helpers.ts';

let ui: UiHarness;
let user: ApiUser;
let propertyId: string;

before(async () => {
  ui = await startUi();
  user = await newUser(ui.app, 'REVIEWS');
  propertyId = (await createProperty(ui.app, user, { name: 'Review House' })).id;

  for (const [rating, replied] of [
    [5, true],
    [4, false],
  ] as Array<[number, boolean]>) {
    await pool.query(
      `insert into review (property_id, rating, channel, guest_name, body, received_at, replied_at, reply_body)
       values ($1, $2, 'airbnb', 'Seeded Guest', 'Lovely stay', now(),
               case when $3 then now() else null end,
               case when $3 then 'Thank you for staying.' else null end)`,
      [propertyId, rating, replied]
    );
  }
});

after(async () => {
  await ui.close();
  await deleteUser(user.email);
  await closePool();
});

test('T-58 the feed answers a review, and the button waits for words', async () => {
  const page = await ui.signedIn(user);
  await page.goto('/reviews', { waitUntil: 'domcontentloaded' });

  await page.waitForSelector('[data-testid="review-feed"] .review');

  // One review is answered, one is not.
  assert.equal(await page.locator('[data-testid="review-reply"]').count(), 1);
  const composer = page.locator('.review-compose').first();
  await composer.waitFor({ state: 'visible' });

  const post = composer.getByRole('button', { name: 'Post reply' });
  assert.equal(await post.isDisabled(), true, 'the button is disabled until there is text');

  await composer.getByLabel('Write a reply').fill('Thank you — we would love to host you again.');
  await post.click();

  await page.waitForSelector('[data-testid="toast"][data-visible="true"]');
  assert.match(await page.locator('[data-testid="toast"]').innerText(), /reply posted/i);

  // The reply is now part of the review, and both are answered.
  await page.locator('[data-testid="review-reply"]').nth(1).waitFor({ state: 'visible' });
  const replies = await page.locator('[data-testid="review-reply"]').count();
  assert.equal(replies, 2, 'both reviews now carry a reply');
  assert.equal(await page.locator('[data-kpi="response-rate"] .kpi-value').innerText(), '100 %');
  assert.equal(await page.locator('[data-kpi="awaiting"] .kpi-value').innerText(), '0');

  await page.context().close();
});
