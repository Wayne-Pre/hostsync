import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { getJson, sendJson } from './client.ts';
import { useToast } from './toast.tsx';

/**
 * F-50 / F-51 — the guest inbox.
 *
 * The one thing this screen must never do is lie about delivery: a WhatsApp or
 * SMS reply is labelled "Recorded only", because that is what happened.
 */

interface Thread {
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

interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  authorName: string | null;
  body: string;
  channel: string;
  delivery: 'sent' | 'recorded' | 'failed';
  createdAt: string;
}

const CHANNEL_OPTIONS = [
  { value: 'email', label: 'Email' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'sms', label: 'SMS' },
];

export function Inbox() {
  const toast = useToast();
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [body, setBody] = useState('');
  const [channel, setChannel] = useState('email');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [composing, setComposing] = useState(false);
  const [properties, setProperties] = useState<Array<{ propertyId: string; propertyName: string }>>([]);
  const [compose, setCompose] = useState({
    guestName: '',
    guestEmail: '',
    propertyId: '',
    channel: 'email',
    subject: '',
    body: '',
  });

  const load = useCallback(async () => {
    try {
      const data = await getJson<{ threads: Thread[] }>('/api/inbox');
      setThreads(data.threads);
      setError(null);
    } catch {
      setError('Could not load the inbox.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!openId) {
      setMessages([]);
      return;
    }
    getJson<{ messages: Message[] }>(`/api/inbox/${openId}`)
      .then((data) => setMessages(data.messages))
      .catch(() => setError('Could not open that conversation.'));
  }, [openId]);

  async function send() {
    if (!openId || !body.trim()) return;
    setSending(true);
    try {
      const result = await sendJson<{ message: Message }>('POST', `/api/inbox/${openId}/reply`, {
        body,
        channel,
      });
      toast(
        result.message.delivery === 'recorded'
          ? 'Recorded only — this app cannot send WhatsApp or SMS'
          : 'Reply sent'
      );
      setBody('');
      const data = await getJson<{ messages: Message[] }>(`/api/inbox/${openId}`);
      setMessages(data.messages);
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not send that reply', 'error');
    } finally {
      setSending(false);
    }
  }

  async function openCompose() {
    try {
      const data = await getJson<{
        properties: Array<{ id: string; name: string }>;
      }>('/api/properties');
      setProperties(
        data.properties.map((p) => ({ propertyId: p.id, propertyName: p.name }))
      );
      setCompose({ guestName: '', guestEmail: '', propertyId: '', channel: 'email', subject: '', body: '' });
      setComposing(true);
    } catch {
      toast('Could not load your properties', 'error');
    }
  }

  async function createThread(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    try {
      const result = await sendJson<{ conversationId: string; message: Message | null }>(
        'POST',
        '/api/inbox',
        {
          guestName: compose.guestName,
          guestEmail: compose.guestEmail,
          propertyId: compose.propertyId || null,
          channel: compose.channel,
          subject: compose.subject,
          body: compose.body,
        }
      );
      toast(result.message?.delivery === 'sent' ? 'Email sent' : 'Conversation created');
      setComposing(false);
      await load();
      if (result.conversationId) setOpenId(result.conversationId);
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not create that conversation', 'error');
    } finally {
      setSending(false);
    }
  }

  if (error) {
    return (
      <p className="alert" role="alert">
        {error}
      </p>
    );
  }

  if (!threads) return <p className="loading">Loading the inbox…</p>;

  return (
    <div className="inbox-layout">
      <div className="threads-pane">
        <button type="button" className="btn btn-primary btn-block" data-testid="new-conversation" onClick={openCompose}>
          Email a guest
        </button>
        {composing ? (
          <form className="form compose-form" data-testid="compose-form" onSubmit={createThread}>
            <div className="field">
              <label htmlFor="compose-guest">Guest name</label>
              <input id="compose-guest" required value={compose.guestName}
                onChange={(e) => setCompose({ ...compose, guestName: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="compose-email">Guest email</label>
              <input id="compose-email" type="email" value={compose.guestEmail}
                onChange={(e) => setCompose({ ...compose, guestEmail: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="compose-property">Property</label>
              <select id="compose-property" value={compose.propertyId}
                onChange={(e) => setCompose({ ...compose, propertyId: e.target.value })}>
                <option value="">No property</option>
                {properties.map((p) => (
                  <option key={p.propertyId} value={p.propertyId}>{p.propertyName}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="compose-channel">Channel</label>
              <select id="compose-channel" value={compose.channel}
                onChange={(e) => setCompose({ ...compose, channel: e.target.value })}>
                {CHANNEL_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="compose-subject">Subject</label>
              <input id="compose-subject" value={compose.subject}
                onChange={(e) => setCompose({ ...compose, subject: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="compose-body">First message</label>
              <textarea id="compose-body" rows={3} value={compose.body}
                onChange={(e) => setCompose({ ...compose, body: e.target.value })} />
            </div>
            <div className="composer-row">
              <button className="btn btn-primary" type="submit" disabled={sending} data-testid="compose-submit">
                {sending ? 'Creating…' : 'Create conversation'}
              </button>
              <button className="btn" type="button" onClick={() => setComposing(false)}>Cancel</button>
            </div>
          </form>
        ) : null}
        <section className="thread-list" aria-label="Conversations" data-testid="thread-list">
        {threads.length === 0 ? (
          <p className="board-empty">No conversations yet.</p>
        ) : (
          threads.map((thread) => (
            <button
              type="button"
              key={thread.id}
              className={`thread${openId === thread.id ? ' is-open' : ''}`}
              data-thread={thread.id}
              onClick={() => setOpenId(thread.id)}
            >
              <span className="thread-top">
                <strong>{thread.guestName}</strong>
                {thread.unreadCount > 0 ? (
                  <span className="unread" data-unread={thread.id}>
                    {thread.unreadCount}
                  </span>
                ) : null}
              </span>
              <span className="thread-meta">
                {thread.channel} · {thread.propertyName ?? 'No property'}
              </span>
              <span className="thread-snippet">{thread.snippet}</span>
            </button>
          ))
        )}
      </section>
      </div>

      <section className="conversation" aria-label="Conversation">
        {openId === null ? (
          <p className="board-empty">Choose a conversation.</p>
        ) : (
          <>
            <div className="messages" data-testid="messages">
              {messages.map((message) => (
                <article
                  key={message.id}
                  className={`message is-${message.direction}`}
                  data-delivery={message.delivery}
                  data-direction={message.direction}
                >
                  <header className="message-head">
                    <strong>{message.authorName ?? 'Guest'}</strong>
                    <span className="message-channel">{message.channel}</span>
                    {message.direction === 'outbound' ? (
                      <span className="delivery">
                        {message.delivery === 'sent' ? 'Sent' : 'Recorded only'}
                      </span>
                    ) : null}
                  </header>
                  <p className="message-body">{message.body}</p>
                </article>
              ))}
            </div>

            <div className="composer">
              <label htmlFor="reply-body">Reply</label>
              <textarea
                id="reply-body"
                value={body}
                rows={3}
                onChange={(event) => setBody(event.target.value)}
                placeholder="Write a reply…"
              />
              <div className="composer-row">
                <label htmlFor="reply-channel">Send via</label>
                <select
                  id="reply-channel"
                  value={channel}
                  onChange={(event) => setChannel(event.target.value)}
                >
                  {CHANNEL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={send}
                  disabled={sending || !body.trim()}
                >
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
              {channel !== 'email' ? (
                <p className="composer-note">
                  WhatsApp and SMS are recorded in this thread only — the app does not send them.
                </p>
              ) : null}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
