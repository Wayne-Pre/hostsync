import { useCallback, useEffect, useState } from 'react';
import { getJson, sendJson } from './client.ts';
import { useToast } from './toast.tsx';

/**
 * F-56 – F-61 — reputation.
 *
 * Four numbers, the reviews themselves, who we still owe an answer, and the
 * guests we have not asked yet.
 */

interface Review {
  id: string;
  rating: number;
  channel: string | null;
  guestName: string | null;
  body: string | null;
  receivedAt: string;
  repliedAt: string | null;
  replyBody: string | null;
  propertyName: string | null;
}

interface Kpis {
  averageRating: number | null;
  reviewCount: number;
  repliedCount: number;
  responseRatePct: number;
  awaitingReply: number;
  requestsDue: number;
}

interface DueRequest {
  bookingId: string;
  guestName: string;
  propertyName: string | null;
  channel: string;
  checkedOutAt: string;
}

interface LoggedRequest {
  id: string;
  bookingId: string | null;
  guestName: string;
  channel: string;
  requestedAt: string;
}

interface Settings {
  autoRequest: boolean;
  daysAfterCheckout: number;
}

interface ReviewsPayload {
  kpis: Kpis;
  reviews: Review[];
  settings: Settings;
}

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: 'Africa/Nairobi',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function Reviews() {
  const toast = useToast();
  const [data, setData] = useState<ReviewsPayload | null>(null);
  const [due, setDue] = useState<DueRequest[]>([]);
  const [logged, setLogged] = useState<LoggedRequest[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await getJson<ReviewsPayload>('/api/reviews');
      setData(payload);
      const [dueList, loggedList] = await Promise.all([
        getJson<{ due: DueRequest[] }>('/api/reviews/requests/due'),
        getJson<{ requests: LoggedRequest[] }>('/api/reviews/requests'),
      ]);
      setDue(dueList.due);
      setLogged(loggedList.requests);
      setError(null);
    } catch {
      setError('Could not load the reviews.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function postReply(reviewId: string) {
    const body = drafts[reviewId] ?? '';
    if (!body.trim()) return;
    try {
      await sendJson('POST', `/api/reviews/${reviewId}/reply`, { body });
      toast('Reply posted');
      setDrafts((current) => ({ ...current, [reviewId]: '' }));
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not post that reply', 'error');
    }
  }

  async function request(bookingId: string) {
    try {
      await sendJson('POST', '/api/reviews/requests', { bookingId });
      toast('Review requested');
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not log that request', 'error');
    }
  }

  async function saveSettings(autoRequest: boolean, daysAfterCheckout: number) {
    try {
      await sendJson('PUT', '/api/reviews/settings', { autoRequest, daysAfterCheckout });
      toast('Review settings saved');
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not save the settings', 'error');
    }
  }

  if (error) {
    return (
      <p className="alert" role="alert">
        {error}
      </p>
    );
  }

  if (!data) return <p className="loading">Loading the reviews…</p>;

  const { kpis, reviews, settings } = data;

  return (
    <div className="stack">
      <section className="kpis" aria-label="Reputation">
        <article className="kpi" data-kpi="rating">
          <span className="kpi-label">Average rating</span>
          <strong className="kpi-value">
            {kpis.averageRating === null ? '—' : kpis.averageRating.toFixed(2)}
          </strong>
          <span className="kpi-note">
            {kpis.reviewCount} review{kpis.reviewCount === 1 ? '' : 's'}
          </span>
        </article>
        <article className="kpi" data-kpi="response-rate">
          <span className="kpi-label">Response rate</span>
          <strong className="kpi-value">{kpis.responseRatePct} %</strong>
          <span className="kpi-note">
            {kpis.repliedCount} of {kpis.reviewCount} answered
          </span>
        </article>
        <article className="kpi" data-kpi="awaiting">
          <span className="kpi-label">Awaiting reply</span>
          <strong className="kpi-value">{kpis.awaitingReply}</strong>
          <span className="kpi-note">reviews with no answer yet</span>
        </article>
        <article className="kpi" data-kpi="requests-due">
          <span className="kpi-label">Requests due</span>
          <strong className="kpi-value">{kpis.requestsDue}</strong>
          <span className="kpi-note">stays we could ask today</span>
        </article>
      </section>

      <section className="panel" aria-labelledby="feed-title">
        <header className="panel-head">
          <h2 id="feed-title">Reviews</h2>
          <p>Newest first. Every answer we gave is kept with the review.</p>
        </header>

        {reviews.length === 0 ? (
          <p className="board-empty" style={{ padding: '18px' }}>
            No reviews yet.
          </p>
        ) : (
          <ul className="review-list" data-testid="review-feed">
            {reviews.map((review) => (
              <li className="review" key={review.id}>
                <div className="review-head">
                  <strong>{review.guestName ?? 'Guest'}</strong>
                  <span className="review-stars" aria-label={`${review.rating} out of 5`}>
                    {'★'.repeat(review.rating)}
                    <span className="review-stars-empty">{'★'.repeat(5 - review.rating)}</span>
                  </span>
                  <span className="review-meta">
                    {review.channel ?? 'direct'} · {review.propertyName ?? 'No property'} ·{' '}
                    {dayLabel(review.receivedAt)}
                  </span>
                </div>
                <p className="review-body">{review.body ?? ''}</p>

                {review.repliedAt ? (
                  <div className="review-reply" data-testid="review-reply">
                    <span className="review-reply-label">Your reply</span>
                    <p>{review.replyBody}</p>
                  </div>
                ) : (
                  <div className="review-compose">
                    <label htmlFor={`reply-${review.id}`}>Write a reply</label>
                    <textarea
                      id={`reply-${review.id}`}
                      rows={2}
                      value={drafts[review.id] ?? ''}
                      onChange={(event) =>
                        setDrafts((current) => ({ ...current, [review.id]: event.target.value }))
                      }
                    />
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={!(drafts[review.id] ?? '').trim()}
                      onClick={() => postReply(review.id)}
                    >
                      Post reply
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="split">
        <div className="panel">
          <header className="panel-head">
            <h2>Requests due</h2>
            <p>Stays that finished and were never asked.</p>
          </header>
          {due.length === 0 ? (
            <p className="board-empty" style={{ padding: '18px' }}>
              Nothing to ask for right now.
            </p>
          ) : (
            <ul className="request-list" data-testid="requests-due">
              {due.map((entry) => (
                <li key={entry.bookingId}>
                  <span>
                    {entry.guestName} · {entry.propertyName ?? 'No property'} · checked out{' '}
                    {dayLabel(entry.checkedOutAt)}
                  </span>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => request(entry.bookingId)}
                  >
                    Request
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="panel">
          <header className="panel-head">
            <h2>Already requested</h2>
            <p>Everyone we have already asked.</p>
          </header>
          {logged.length === 0 ? (
            <p className="board-empty" style={{ padding: '18px' }} data-testid="requests-empty">
              No requests logged yet.
            </p>
          ) : (
            <ul className="request-list" data-testid="requests-logged">
              {logged.map((entry) => (
                <li key={entry.id}>
                  <span>
                    {entry.guestName} · {entry.channel} · asked {dayLabel(entry.requestedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="panel">
        <header className="panel-head">
          <h2>Auto-request schedule</h2>
          <p>Ask every guest automatically, and how long after checkout.</p>
        </header>
        <div className="settings-row">
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.autoRequest}
              onChange={(event) => void saveSettings(event.target.checked, settings.daysAfterCheckout)}
            />
            <span>
              Auto-request {settings.daysAfterCheckout}d after checkout
            </span>
          </label>
          <label className="field-inline">
            Days after checkout
            <input
              type="number"
              min={0}
              max={30}
              defaultValue={settings.daysAfterCheckout}
              onBlur={(event) =>
                void saveSettings(settings.autoRequest, Number(event.target.value))
              }
            />
          </label>
        </div>
      </section>
    </div>
  );
}
