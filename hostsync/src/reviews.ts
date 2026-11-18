/**
 * F-56 – F-61 — reputation.
 *
 * Four numbers and a feed: how guests rated us, how often we answered, what is
 * still waiting for an answer, and whose review we have not asked for yet.
 */
import { query, queryOne, withTransaction } from './db.ts';
import { NotFoundError, ValidationError } from './errors.ts';
import { todayUTC } from './dates.ts';

export interface ReviewRow {
  id: string;
  propertyId: string;
  propertyName: string | null;
  bookingId: string | null;
  rating: number;
  channel: string | null;
  guestName: string | null;
  body: string | null;
  receivedAt: string;
  repliedAt: string | null;
  replyBody: string | null;
}

export interface ReputationKpis {
  averageRating: number | null;
  reviewCount: number;
  repliedCount: number;
  responseRatePct: number;
  awaitingReply: number;
  requestsDue: number;
}

export interface RequestDue {
  bookingId: string;
  guestName: string;
  propertyName: string | null;
  channel: string;
  checkedOutAt: string;
}

export interface RequestLogged {
  id: string;
  bookingId: string | null;
  guestName: string;
  channel: string;
  requestedAt: string;
}

export interface ReviewSettings {
  autoRequest: boolean;
  daysAfterCheckout: number;
}

interface ReviewDbRow {
  id: string;
  property_id: string;
  property_name: string | null;
  booking_id: string | null;
  rating: string | number;
  channel: string | null;
  guest_name: string | null;
  body: string | null;
  received_at: Date;
  replied_at: Date | null;
  reply_body: string | null;
}

function mapReview(row: ReviewDbRow): ReviewRow {
  return {
    id: row.id,
    propertyId: row.property_id,
    propertyName: row.property_name,
    bookingId: row.booking_id,
    rating: Number(row.rating),
    channel: row.channel,
    guestName: row.guest_name,
    body: row.body,
    receivedAt: row.received_at.toISOString(),
    repliedAt: row.replied_at ? row.replied_at.toISOString() : null,
    replyBody: row.reply_body,
  };
}

const SELECT_REVIEWS = `
  select r.id, r.property_id, p.name as property_name, r.booking_id, r.rating, r.channel,
         r.guest_name, r.body, r.received_at, r.replied_at, r.reply_body
    from review r
    left join property p on p.id = r.property_id
   where p.portfolio_id = $1
`;

export async function listReviews(portfolioId: string): Promise<ReviewRow[]> {
  const rows = await query<ReviewDbRow>(
    `${SELECT_REVIEWS} order by r.received_at desc, r.id desc`,
    [portfolioId]
  );
  return rows.map(mapReview);
}

/** F-59 — stays that finished at least `days` ago and were never asked. */
export async function requestsDue(portfolioId: string, days: number): Promise<RequestDue[]> {
  const today = todayUTC();
  const rows = await query<{
    booking_id: string;
    guest_name: string;
    property_name: string | null;
    channel: string;
    checked_out: string;
  }>(
    `select b.id as booking_id, b.guest_name, p.name as property_name, b.channel,
            upper(b.stay)::text as checked_out
       from booking b
       join property p on p.id = b.property_id
      where p.portfolio_id = $1
        and b.status in ('confirmed', 'completed')
        and upper(b.stay) <= (current_date - ($2 || ' days')::interval)::date
        and not exists (
          select 1 from review_request rq where rq.booking_id = b.id
        )
      order by upper(b.stay)`,
    [portfolioId, String(Math.max(0, Math.round(days)))]
  );

  return rows.map((row) => ({
    bookingId: row.booking_id,
    guestName: row.guest_name,
    propertyName: row.property_name,
    channel: row.channel,
    checkedOutAt: row.checked_out,
  }));
}

/** F-60 — the guests already asked. */
export async function listRequests(portfolioId: string): Promise<RequestLogged[]> {
  const rows = await query<{
    id: string;
    booking_id: string | null;
    guest_name: string;
    channel: string;
    requested_at: Date;
  }>(
    `select id, booking_id, guest_name, channel, requested_at
       from review_request where portfolio_id = $1
      order by requested_at desc`,
    [portfolioId]
  );

  return rows.map((row) => ({
    id: row.id,
    bookingId: row.booking_id,
    guestName: row.guest_name,
    channel: row.channel,
    requestedAt: row.requested_at.toISOString(),
  }));
}

/** Ask one guest for a review. Asking twice is refused, not silently repeated. */
export async function requestReview(
  portfolioId: string,
  bookingId: string
): Promise<RequestLogged> {
  const booking = await queryOne<{
    id: string;
    guest_name: string;
    channel: string;
    property_id: string;
  }>(
    `select b.id, b.guest_name, b.channel, b.property_id
       from booking b join property p on p.id = b.property_id
      where b.id = $1 and p.portfolio_id = $2`,
    [bookingId, portfolioId]
  );
  if (!booking) throw new NotFoundError('booking');

  const row = await queryOne<{
    id: string;
    booking_id: string;
    guest_name: string;
    channel: string;
    requested_at: Date;
  }>(
    `insert into review_request (portfolio_id, property_id, booking_id, guest_name, channel)
     values ($1, $2, $3, $4, $5)
     on conflict (booking_id) do update set requested_at = now()
     returning id, booking_id, guest_name, channel, requested_at`,
    [
      portfolioId,
      booking.property_id,
      booking.id,
      booking.guest_name,
      booking.channel,
    ]
  );
  if (!row) throw new Error('review request insert returned no row');

  return {
    id: row.id,
    bookingId: row.booking_id,
    guestName: row.guest_name,
    channel: row.channel,
    requestedAt: row.requested_at.toISOString(),
  };
}

/** F-58 — answer a review. */
export async function replyToReview(
  portfolioId: string,
  reviewId: string,
  body: string
): Promise<ReviewRow> {
  const text = body.trim();
  if (!text) throw new ValidationError('a reply needs text', 'body');

  const row = await queryOne<ReviewDbRow>(
    `update review r
        set replied_at = now(), reply_body = $3
       from property p
      where r.id = $1 and p.id = r.property_id and p.portfolio_id = $2
      returning r.id, r.property_id, p.name as property_name, r.booking_id, r.rating, r.channel,
                r.guest_name, r.body, r.received_at, r.replied_at, r.reply_body`,
    [reviewId, portfolioId, text]
  );
  if (!row) throw new NotFoundError('review');
  return mapReview(row);
}

/** F-56 — the four numbers. */
export async function reputation(
  portfolioId: string,
  daysAfterCheckout: number
): Promise<ReputationKpis> {
  const stats = await queryOne<{
    average: string | null;
    total: number;
    replied: number;
    awaiting: number;
  }>(
    `select round(avg(r.rating), 2)::text as average,
            count(*)::int as total,
            count(*) filter (where r.replied_at is not null)::int as replied,
            count(*) filter (where r.replied_at is null)::int as awaiting
       from review r join property p on p.id = r.property_id
      where p.portfolio_id = $1`,
    [portfolioId]
  );

  const due = await requestsDue(portfolioId, daysAfterCheckout);

  const total = stats?.total ?? 0;
  const replied = stats?.replied ?? 0;

  return {
    averageRating: stats?.average === null || stats?.average === undefined ? null : Number(stats.average),
    reviewCount: total,
    repliedCount: replied,
    responseRatePct: total === 0 ? 0 : Math.round((replied / total) * 100),
    awaitingReply: stats?.awaiting ?? 0,
    requestsDue: due.length,
  };
}

/** F-61 — the switch and the delay. */
export async function getSettings(portfolioId: string): Promise<ReviewSettings> {
  const row = await queryOne<{ auto_review_request: boolean; review_request_days: number }>(
    'select auto_review_request, review_request_days from portfolio where id = $1',
    [portfolioId]
  );
  return {
    autoRequest: row?.auto_review_request ?? false,
    daysAfterCheckout: Number(row?.review_request_days ?? 1),
  };
}

export async function setSettings(
  portfolioId: string,
  input: { autoRequest: boolean; daysAfterCheckout: number }
): Promise<ReviewSettings> {
  const days = Number(input.daysAfterCheckout);
  if (!Number.isInteger(days) || days < 0 || days > 30) {
    throw new ValidationError('days after checkout must be between 0 and 30', 'daysAfterCheckout');
  }

  await withTransaction(async (client) => {
    const updated = await client.query(
      `update portfolio
          set auto_review_request = $2, review_request_days = $3
        where id = $1`,
      [portfolioId, input.autoRequest, days]
    );
    if (!updated.rowCount) throw new NotFoundError('portfolio');
  });

  return getSettings(portfolioId);
}
