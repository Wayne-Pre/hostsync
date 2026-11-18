/**
 * F-50 – F-55 — the guest inbox.
 *
 * One rule governs the whole module: the app must never claim it delivered a
 * message it did not deliver. Email is sent through the mail transport and
 * stored as `sent`; WhatsApp and SMS are stored as `recorded`, because no
 * adapter for them exists — the original app says "Recorded only" and so do we.
 */
import { query, queryOne } from './db.ts';
import { NotFoundError, ValidationError } from './errors.ts';
import { optionalEmail } from './validation.ts';
import type { MailTransport } from './mail.ts';

export const REPLY_CHANNELS = ['email', 'whatsapp', 'sms'] as const;
export type ReplyChannel = (typeof REPLY_CHANNELS)[number];

/** Channels we can actually deliver through. */
export const DELIVERABLE_CHANNELS: readonly ReplyChannel[] = ['email'];

export interface ThreadSummary {
  id: string;
  guestName: string;
  guestEmail: string | null;
  channel: string;
  propertyName: string | null;
  subject: string | null;
  unreadCount: number;
  snippet: string;
  lastMessageAt: string;
}

export interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  authorName: string | null;
  body: string;
  channel: string;
  delivery: 'sent' | 'recorded' | 'failed';
  createdAt: string;
}

interface ThreadRow {
  id: string;
  guest_name: string;
  guest_email: string | null;
  channel: string;
  property_name: string | null;
  subject: string | null;
  unread_count: number;
  snippet: string | null;
  last_message_at: Date;
}

function mapThread(row: ThreadRow): ThreadSummary {
  return {
    id: row.id,
    guestName: row.guest_name,
    guestEmail: row.guest_email,
    channel: row.channel,
    propertyName: row.property_name,
    subject: row.subject,
    unreadCount: Number(row.unread_count),
    snippet: (row.snippet ?? '').trim(),
    lastMessageAt: row.last_message_at.toISOString(),
  };
}

export async function listThreads(portfolioId: string): Promise<ThreadSummary[]> {
  const rows = await query<ThreadRow>(
    `select c.id, c.guest_name, c.guest_email, c.channel, c.subject, c.unread_count,
            c.last_message_at, p.name as property_name,
            (select m.body from message m
              where m.conversation_id = c.id
              order by m.created_at desc limit 1) as snippet
       from conversation c
       left join property p on p.id = c.property_id
      where c.portfolio_id = $1
      order by c.last_message_at desc`,
    [portfolioId]
  );
  return rows.map(mapThread);
}

export async function getThread(
  portfolioId: string,
  threadId: string
): Promise<{ thread: ThreadSummary; messages: Message[] }> {
  const row = await queryOne<ThreadRow>(
    `select c.id, c.guest_name, c.guest_email, c.channel, c.subject, c.unread_count,
            c.last_message_at, p.name as property_name,
            (select m.body from message m
              where m.conversation_id = c.id
              order by m.created_at desc limit 1) as snippet
       from conversation c
       left join property p on p.id = c.property_id
      where c.id = $1 and c.portfolio_id = $2`,
    [threadId, portfolioId]
  );
  if (!row) throw new NotFoundError('conversation');

  const messages = await query<{
    id: string;
    direction: 'inbound' | 'outbound';
    author_name: string | null;
    body: string;
    channel: string;
    delivery: 'sent' | 'recorded' | 'failed';
    created_at: Date;
  }>(
    `select id, direction, author_name, body, channel, delivery, created_at
       from message where conversation_id = $1
      order by created_at, id`,
    [threadId]
  );

  return {
    thread: mapThread(row),
    messages: messages.map((message) => ({
      id: message.id,
      direction: message.direction,
      authorName: message.author_name,
      body: message.body,
      channel: message.channel,
      delivery: message.delivery,
      createdAt: message.created_at.toISOString(),
    })),
  };
}

export interface CreateConversationInput {
  portfolioId: string;
  propertyId: string | null;
  bookingId: string | null;
  guestName: string;
  guestEmail: string | null;
  channel: string;
  subject: string | null;
}

/** Used by channel integrations, and by the tests that need a thread to exist. */
export async function createConversation(input: CreateConversationInput): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into conversation (
       portfolio_id, property_id, booking_id, guest_name, guest_email, channel, subject
     ) values ($1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [
      input.portfolioId,
      input.propertyId,
      input.bookingId,
      input.guestName,
      input.guestEmail,
      input.channel,
      input.subject,
    ]
  );
  if (!row) throw new Error('conversation insert returned no row');
  return row.id;
}

export async function recordInboundMessage(
  conversationId: string,
  input: { authorName: string | null; body: string; channel: string }
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into message (conversation_id, direction, author_name, body, channel, delivery)
     values ($1, 'inbound', $2, $3, $4, 'sent')
     returning id`,
    [conversationId, input.authorName, input.body, input.channel]
  );
  if (!row) throw new Error('message insert returned no row');

  await query(
    `update conversation
        set unread_count = unread_count + 1, last_message_at = now()
      where id = $1`,
    [conversationId]
  );
  return row.id;
}

/**
 * Send a reply.
 *
 * `email` goes out through the mail transport and is stored as `sent`.
 * `whatsapp` and `sms` are stored as `recorded` — the app has no adapter for
 * them, and saying otherwise would be a lie the host would rely on.
 */
export async function reply(
  portfolioId: string,
  conversationId: string,
  input: { body: string; channel: string },
  mailer: MailTransport
): Promise<Message> {
  const body = input.body.trim();
  if (!body) throw new ValidationError('a reply needs a message', 'body');

  const channel = input.channel as ReplyChannel;
  if (!REPLY_CHANNELS.includes(channel)) {
    throw new ValidationError(`channel must be one of: ${REPLY_CHANNELS.join(', ')}`, 'channel');
  }

  const thread = await queryOne<{ id: string; guest_name: string; guest_email: string | null; subject: string | null }>(
    `select id, guest_name, guest_email, subject
       from conversation where id = $1 and portfolio_id = $2`,
    [conversationId, portfolioId]
  );
  if (!thread) throw new NotFoundError('conversation');

  let delivery: 'sent' | 'recorded' = 'recorded';

  if (DELIVERABLE_CHANNELS.includes(channel)) {
    // F-54 / F-55: email is only possible with a real address.
    if (!thread.guest_email) {
      throw new ValidationError('this guest has no email address', 'guestEmail');
    }
    const address = optionalEmail(thread.guest_email, 'guestEmail');
    if (!address) throw new ValidationError('this guest has no email address', 'guestEmail');
    await mailer.send({
      to: address,
      subject: thread.subject ?? `Your stay at HostSync`,
      text: body,
    });
    delivery = 'sent';
  }

  const row = await queryOne<{
    id: string;
    direction: 'inbound' | 'outbound';
    author_name: string | null;
    body: string;
    channel: string;
    delivery: 'sent' | 'recorded' | 'failed';
    created_at: Date;
  }>(
    `insert into message (conversation_id, direction, author_name, body, channel, delivery)
     values ($1, 'outbound', $2, $3, $4, $5)
     returning id, direction, author_name, body, channel, delivery, created_at`,
    [conversationId, thread.guest_name, body, channel, delivery]
  );
  if (!row) throw new Error('message insert returned no row');

  await query(
    `update conversation
        set unread_count = 0, last_message_at = now()
      where id = $1`,
    [conversationId]
  );

  return {
    id: row.id,
    direction: row.direction,
    authorName: row.author_name,
    body: row.body,
    channel: row.channel,
    delivery: row.delivery,
    createdAt: row.created_at.toISOString(),
  };
}
