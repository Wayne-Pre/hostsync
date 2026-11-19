/**
 * F-54 on screen: "Email a guest" creates the thread and sends its first
 * message. Without this button the inbox can only ever be empty for a new user.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../src/db.ts';
import { createProperty, deleteUser } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';
import { mailer, newUser, startUi } from './ui-helpers.ts';
import type { UiHarness } from './ui-helpers.ts';

let ui: UiHarness;
let user: ApiUser;
let propertyId: string;

async function post<T>(url: string, payload: Record<string, unknown>, expected = 200): Promise<T> {
  const response = await ui.app.inject({
    method: 'POST',
    url,
    headers: { cookie: user.cookie },
    payload,
  });
  assert.equal(response.statusCode, expected, response.body);
  return response.json() as T;
}

async function get<T>(url: string): Promise<T> {
  const response = await ui.app.inject({ method: 'GET', url, headers: { cookie: user.cookie } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as T;
}

before(async () => {
  ui = await startUi();
  user = await newUser(ui.app);
  const property = await createProperty(ui.app, user, { name: 'Inbox House' });
  propertyId = property.id;
});

after(async () => {
  await ui.close();
  await deleteUser(user.email);
  await closePool();
});

test('the API creates a thread and really sends the first email', async () => {
  const before = mailer.outbox.length;
  const created = await post<{
    conversationId: string;
    message: { delivery: string; body: string } | null;
  }>('/api/inbox', {
    guestName: 'API Guest',
    guestEmail: 'api.guest@example.test',
    propertyId,
    channel: 'email',
    subject: 'Your stay',
    body: 'Welcome, we are ready for you.',
  }, 201);
  assert.ok(created.conversationId);
  assert.equal(created.message?.delivery, 'sent');
  assert.equal(mailer.outbox.length, before + 1, 'exactly one email went out');

  const list = await get<{ threads: Array<{ id: string; guestName: string; snippet: string }> }>('/api/inbox');
  const thread = list.threads.find((entry) => entry.id === created.conversationId);
  assert.ok(thread);
  assert.equal(thread.guestName, 'API Guest');
  assert.match(thread.snippet, /ready for you/);

  await post('/api/inbox', { guestName: 'No Address', channel: 'email', body: 'Hi' }, 422);
  await post('/api/inbox', { guestName: 'Bad Channel', channel: 'carrier-pigeon', body: 'Hi' }, 422);
});

test('the View button creates a conversation in the browser', async () => {
  const page = await ui.signedIn(user);
  await page.goto('/inbox');
  await page.locator('[data-testid="new-conversation"]').click();
  const form = page.locator('[data-testid="compose-form"]');
  await form.waitFor();
  await form.locator('#compose-guest').fill('Browser Guest');
  await form.locator('#compose-email').fill('browser.guest@example.test');
  await form.locator('#compose-property').selectOption(propertyId);
  await form.locator('#compose-body').fill('See you on Friday.');
  await form.locator('[data-testid="compose-submit"]').click();

  const thread = page.locator('.thread').filter({ hasText: 'Browser Guest' });
  await thread.waitFor();
  await thread.click();
  await page.locator('[data-testid="messages"]').filter({ hasText: 'See you on Friday.' }).waitFor();
});
