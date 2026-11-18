/**
 * T-50 thread list · T-51 conversation order · T-52 reply channel
 * T-53 recorded-only · T-54 email a guest · T-55 email guard
 *
 * The honesty rule is the point of this file: a reply the system cannot send
 * is stored as `recorded`, and the mail transport is never called for it.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { closePool } from '../src/db.ts';
import { createCaptureTransport } from '../src/mail.ts';
import { createConversation, recordInboundMessage } from '../src/inbox.ts';
import { createProperty, deleteUser, signUp } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';

const mailer = createCaptureTransport();
let app: FastifyInstance;
let user: ApiUser;
let propertyId: string;
const emails: string[] = [];

interface Thread {
  id: string;
  guestName: string;
  guestEmail: string | null;
  channel: string;
  propertyName: string | null;
  unreadCount: number;
  snippet: string;
}

interface Message {
  id: string;
  direction: string;
  authorName: string | null;
  body: string;
  channel: string;
  delivery: string;
}

async function seedThread(input: {
  guestName: string;
  guestEmail?: string | null;
  channel?: string;
  body?: string;
}): Promise<string> {
  const threadId = await createConversation({
    portfolioId: user.portfolioId,
    propertyId,
    bookingId: null,
    guestName: input.guestName,
    guestEmail: input.guestEmail ?? null,
    channel: input.channel ?? 'airbnb',
    subject: `Your stay`,
  });
  await recordInboundMessage(threadId, {
    authorName: input.guestName,
    body: input.body ?? 'Hi, is the flat ready for our arrival?',
    channel: input.channel ?? 'airbnb',
  });
  return threadId;
}

before(async () => {
  app = buildApp({ mailer });
  await app.ready();
  user = await signUp(app, mailer, 'INBOX');
  emails.push(user.email);
  propertyId = (await createProperty(app, user, { name: 'Inbox House' })).id;
});

after(async () => {
  await app.close();
  for (const email of emails) await deleteUser(email);
  await closePool();
});

test('T-50 the thread list shows guest, channel, property, unread badge and snippet', async () => {
  await seedThread({ guestName: 'Sofia Almeida', channel: 'airbnb', body: 'Is early check-in possible?' });
  await seedThread({ guestName: 'Brian Kimani', channel: 'booking_com', body: 'The gate code please' });

  const response = await app.inject({
    method: 'GET',
    url: '/api/inbox',
    headers: { cookie: user.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  const threads = (response.json() as { threads: Thread[] }).threads;

  const sofia = threads.find((thread) => thread.guestName === 'Sofia Almeida');
  assert.ok(sofia);
  assert.equal(sofia.channel, 'airbnb');
  assert.equal(sofia.propertyName, 'Inbox House');
  assert.equal(sofia.unreadCount, 1);
  assert.match(sofia.snippet, /early check-in/i);

  const brian = threads.find((thread) => thread.guestName === 'Brian Kimani');
  assert.equal(brian?.channel, 'booking_com');
  assert.equal(brian?.unreadCount, 1);
  assert.equal(threads.filter((thread) => thread.unreadCount > 0).length, 2, 'the counts match the rows');
});

test('T-51 a conversation reads oldest → newest, with the author on every message', async () => {
  const threadId = await seedThread({ guestName: 'Order Guest' });

  await app.inject({
    method: 'POST',
    url: `/api/inbox/${threadId}/reply`,
    headers: { cookie: user.cookie },
    payload: { body: 'First reply from the host', channel: 'whatsapp' },
  });

  // Answering the guest clears the badge.
  const answered = await app.inject({
    method: 'GET',
    url: `/api/inbox/${threadId}`,
    headers: { cookie: user.cookie },
  });
  assert.equal(
    (answered.json() as { thread: Thread }).thread.unreadCount,
    0,
    'answering the guest clears the unread badge'
  );

  await recordInboundMessage(threadId, {
    authorName: 'Order Guest',
    body: 'Second message from the guest',
    channel: 'airbnb',
  });

  const response = await app.inject({
    method: 'GET',
    url: `/api/inbox/${threadId}`,
    headers: { cookie: user.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  const payload = response.json() as { messages: Message[]; thread: Thread };

  const bodies = payload.messages.map((message) => message.body);
  assert.deepEqual(bodies, [
    'Hi, is the flat ready for our arrival?',
    'First reply from the host',
    'Second message from the guest',
  ]);
  assert.equal(payload.messages[0]?.direction, 'inbound');
  assert.equal(payload.messages[1]?.direction, 'outbound');
  assert.equal(payload.messages[1]?.authorName, 'Order Guest');
  assert.equal(payload.messages[1]?.channel, 'whatsapp', 'the outbound message keeps its channel');
  assert.equal(payload.thread.unreadCount, 1, 'the guest wrote again, so it is unread once more');
});

test('T-52 the chosen reply channel is stored on the outbound message', async () => {
  const threadId = await seedThread({
    guestName: 'Channel Guest',
    guestEmail: 'channel@example.test',
  });

  for (const channel of ['email', 'whatsapp', 'sms']) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/inbox/${threadId}/reply`,
      headers: { cookie: user.cookie },
      payload: { body: `sent over ${channel}`, channel },
    });
    assert.equal(response.statusCode, 201, response.body);
    const message = (response.json() as { message: Message }).message;
    assert.equal(message.channel, channel, `${channel} is stored on the message`);
  }
});

test('T-53 a WhatsApp or SMS reply is recorded only, and the mail transport is never called', async () => {
  const threadId = await seedThread({
    guestName: 'Recorded Guest',
    guestEmail: 'recorded@example.test',
  });

  mailer.outbox.length = 0;

  for (const channel of ['whatsapp', 'sms']) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/inbox/${threadId}/reply`,
      headers: { cookie: user.cookie },
      payload: { body: `hello over ${channel}`, channel },
    });
    assert.equal(response.statusCode, 201, response.body);
    const message = (response.json() as { message: Message }).message;
    assert.equal(message.delivery, 'recorded', 'it is recorded, not sent');
  }

  assert.equal(mailer.outbox.length, 0, 'the email provider was not called at all');
});

test('T-54 emailing a guest sends exactly one message and stores it as sent', async () => {
  const threadId = await seedThread({
    guestName: 'Email Guest',
    guestEmail: 'email.guest@example.test',
  });

  mailer.outbox.length = 0;

  const response = await app.inject({
    method: 'POST',
    url: `/api/inbox/${threadId}/reply`,
    headers: { cookie: user.cookie },
    payload: { body: 'The gate code is 4417', channel: 'email' },
  });
  assert.equal(response.statusCode, 201, response.body);

  const message = (response.json() as { message: Message }).message;
  assert.equal(message.delivery, 'sent');
  assert.equal(message.channel, 'email');

  assert.equal(mailer.outbox.length, 1, 'the provider was called exactly once');
  assert.equal(mailer.outbox[0]?.to, 'email.guest@example.test');
  assert.match(mailer.outbox[0]?.text ?? '', /4417/);

  // A malformed address is refused before anything is sent.
  const broken = await seedThread({ guestName: 'Broken Address', guestEmail: 'not-an-address' });
  mailer.outbox.length = 0;
  const refused = await app.inject({
    method: 'POST',
    url: `/api/inbox/${broken}/reply`,
    headers: { cookie: user.cookie },
    payload: { body: 'The gate code is 4417', channel: 'email' },
  });
  assert.equal(refused.statusCode, 422, refused.body);
  assert.equal(mailer.outbox.length, 0, 'nothing was sent');
});

test('T-55 a guest with no address cannot be emailed, and nothing is sent', async () => {
  const threadId = await seedThread({ guestName: 'No Address Guest', guestEmail: null });

  mailer.outbox.length = 0;

  const response = await app.inject({
    method: 'POST',
    url: `/api/inbox/${threadId}/reply`,
    headers: { cookie: user.cookie },
    payload: { body: 'Here is the code', channel: 'email' },
  });
  assert.equal(response.statusCode, 422, response.body);
  assert.match(response.body, /email/i);
  assert.equal(mailer.outbox.length, 0, 'nothing was sent');

  // And the message was not stored either.
  const thread = await app.inject({
    method: 'GET',
    url: `/api/inbox/${threadId}`,
    headers: { cookie: user.cookie },
  });
  const messages = (thread.json() as { messages: Message[] }).messages;
  assert.equal(messages.filter((message) => message.direction === 'outbound').length, 0);
});
