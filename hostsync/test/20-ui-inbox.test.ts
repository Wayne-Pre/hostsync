/**
 * T-51 (browser level) — the conversation reads in order and never lies about
 * delivery.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../src/db.ts';
import { createConversation, recordInboundMessage } from '../src/inbox.ts';
import { createProperty, deleteUser } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';
import { newUser, startUi } from './ui-helpers.ts';
import type { UiHarness } from './ui-helpers.ts';

let ui: UiHarness;
let user: ApiUser;

before(async () => {
  ui = await startUi();
  user = await newUser(ui.app, 'INBOX');
});

after(async () => {
  await ui.close();
  await deleteUser(user.email);
  await closePool();
});

test('T-51 the thread list, the message order and the "Recorded only" badge', async () => {
  const property = await createProperty(ui.app, user, { name: 'Inbox House' });

  const threadId = await createConversation({
    portfolioId: user.portfolioId,
    propertyId: property.id,
    bookingId: null,
    guestName: 'Sofia Almeida',
    guestEmail: 'sofia@example.test',
    channel: 'airbnb',
    subject: 'Early check-in',
  });
  await recordInboundMessage(threadId, {
    authorName: 'Sofia Almeida',
    body: 'Is an early check-in possible on Friday?',
    channel: 'airbnb',
  });

  const page = await ui.signedIn(user);
  await page.goto('/inbox', { waitUntil: 'domcontentloaded' });

  const thread = page.locator(`[data-thread="${threadId}"]`);
  await thread.waitFor({ state: 'visible' });
  assert.match(await thread.innerText(), /Sofia Almeida/);
  // The meta line is styled uppercase, so match case-insensitively.
  assert.match(await thread.innerText(), /airbnb/i);
  assert.match(await thread.innerText(), /Inbox House/i);
  assert.match(await thread.innerText(), /early check-in/i);
  assert.equal((await page.locator(`[data-unread="${threadId}"]`).innerText()).trim(), '1');

  await thread.click();

  const messages = page.locator('[data-testid="messages"] .message');
  await messages.first().waitFor({ state: 'visible' });
  assert.equal(await messages.count(), 1);
  assert.match(await messages.first().innerText(), /Sofia Almeida/);
  assert.match(await messages.first().innerText(), /early check-in possible on Friday/i);

  // Answer on WhatsApp: the app records it and says so — it does not pretend
  // it delivered anything.
  await page.getByLabel('Send via').selectOption('whatsapp');
  await page.getByLabel('Reply').fill('Sure, we can be ready by noon.');
  await page.getByRole('button', { name: 'Send' }).click();

  await page.waitForSelector('[data-testid="toast"][data-visible="true"]');
  assert.match(await page.locator('[data-testid="toast"]').innerText(), /recorded only/i);

  const after = page.locator('[data-testid="messages"] .message');
  await after.nth(1).waitFor({ state: 'visible' });
  assert.equal(await after.count(), 2);
  assert.equal(await after.nth(1).getAttribute('data-delivery'), 'recorded');
  assert.match(await after.nth(1).innerText(), /recorded only/i);

  await page.context().close();
});
