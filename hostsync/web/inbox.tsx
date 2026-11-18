import { useCallback, useEffect, useState } from 'react';
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
