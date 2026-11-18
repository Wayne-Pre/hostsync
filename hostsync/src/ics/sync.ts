import { isPostgresError, EXCLUSION_VIOLATION, query, queryOne, withTransaction } from '../db.ts';
import { priceStay } from '../pricing.ts';
import type { Channel } from '../pricing.ts';
import { assertFetchableFeedUrl } from './urlSafety.ts';
import { parseIcs, IcsFormatError, IcsTooLargeError } from './parse.ts';
import type { IcsEvent } from './parse.ts';

export interface FetchResponseLike {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<FetchResponseLike>;

export interface SyncOutcome {
  feedId: string;
  propertyId: string;
  status: 'ok' | 'not_modified' | 'failed';
  created: number;
  updated: number;
  cancelled: number;
  conflicts: number;
  error: string | null;
}

export interface SyncOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

interface FeedRow {
  id: string;
  property_id: string;
  url: string;
  source: Channel;
  etag: string | null;
  consecutive_failures: number;
}

interface PropertyPricing {
  nightly_rate_cents: number;
  cleaning_fee_cents: number;
  guests: number | null;
  name: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

async function loadFeed(feedId: string): Promise<FeedRow> {
  const row = await queryOne<FeedRow>(
    `select id, property_id, url, source, etag, consecutive_failures
       from calendar_feed where id = $1`,
    [feedId]
  );
  if (!row) throw new Error(`calendar feed ${feedId} not found`);
  return row;
}

async function recordFailure(feed: FeedRow, message: string, attempts: number): Promise<void> {
  const status = attempts >= 3 ? 'failed' : 'stale';
  await query(
    `update calendar_feed
        set last_attempt_at = now(),
            last_status = $2,
            last_error = $3,
            consecutive_failures = $4
      where id = $1`,
    [feed.id, status, message, attempts]
  );
}

function friendlyFetchError(error: unknown): string {
  if (error instanceof IcsTooLargeError) return error.message;
  if (error instanceof IcsFormatError) return error.message;
  const name = (error as Error)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'Could not read that calendar (timed out)';
  if (name === 'UnsafeFeedUrlError') return (error as Error).message;
  return 'Could not read that calendar';
}

/**
 * Fetch one feed and reconcile its events.
 *
 * Rules (spec §6.1 "ICS sync"):
 *  - conditional GET with ETag, so an unchanged feed costs one 304;
 *  - imported rows land as `pending` so a collision is surfaced, not silently dropped;
 *  - a cancelled event cancels its booking and frees the nights;
 *  - a failed fetch never touches existing bookings.
 */
export async function syncFeed(feedId: string, options: SyncOptions = {}): Promise<SyncOutcome> {
  const feed = await loadFeed(feedId);
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const outcome: SyncOutcome = {
    feedId: feed.id,
    propertyId: feed.property_id,
    status: 'failed',
    created: 0,
    updated: 0,
    cancelled: 0,
    conflicts: 0,
    error: null,
  };

  let events: IcsEvent[];
  let etag: string | null = feed.etag;

  try {
    const url = assertFetchableFeedUrl(feed.url);
    const headers: Record<string, string> = { accept: 'text/calendar, text/plain;q=0.5' };
    if (feed.etag) headers['if-none-match'] = feed.etag;

    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url.toString(), { headers, signal });

    if (response.status === 304) {
      await query(
        `update calendar_feed
            set last_attempt_at = now(), last_synced_at = now(),
                last_status = 'ok', last_error = null, consecutive_failures = 0
          where id = $1`,
        [feed.id]
      );
      return { ...outcome, status: 'not_modified' };
    }

    if (!response.ok) {
      const message =
        response.status === 404
          ? 'Could not read that calendar (not found)'
          : `Could not read that calendar (HTTP ${response.status})`;
      await recordFailure(feed, message, feed.consecutive_failures + 1);
      return { ...outcome, error: message };
    }

    const text = await response.text();
    events = parseIcs(text);
    etag = response.headers.get('etag') ?? etag;
  } catch (error) {
    const message = friendlyFetchError(error);
    await recordFailure(feed, message, feed.consecutive_failures + 1);
    return { ...outcome, error: message };
  }

  const property = await queryOne<PropertyPricing>(
    `select nightly_rate_cents, cleaning_fee_cents, guests, name from property where id = $1`,
    [feed.property_id]
  );
  if (!property) {
    await recordFailure(feed, 'the property for this feed no longer exists', feed.consecutive_failures + 1);
    return { ...outcome, error: 'the property for this feed no longer exists' };
  }

  const result = await withTransaction(async (client) => {
    let created = 0;
    let updated = 0;
    let cancelled = 0;
    let conflicts = 0;

    for (const event of events) {
      const existing = await client.query<{
        booking_id: string | null;
        check_in: string | null;
        check_out: string | null;
        state: string;
      }>(
        `select booking_id, check_in::text, check_out::text, state
           from imported_event where feed_id = $1 and uid = $2 for update`,
        [feed.id, event.uid]
      );
      const previous = existing.rows[0];

      if (event.cancelled) {
        if (previous?.booking_id) {
          const cancelledRow = await client.query(
            `update booking set status = 'cancelled', version = version + 1
              where id = $1 and status in ('pending', 'confirmed')`,
            [previous.booking_id]
          );
          if (cancelledRow.rowCount) cancelled += 1;
        }
        await client.query(
          `insert into imported_event (feed_id, uid, booking_id, sequence, check_in, check_out, state, last_seen_at)
           values ($1, $2, $3, $4, $5::date, $6::date, 'cancelled', now())
           on conflict (feed_id, uid) do update
             set state = 'cancelled', sequence = excluded.sequence,
                 check_in = excluded.check_in, check_out = excluded.check_out,
                 last_seen_at = now()`,
          [feed.id, event.uid, previous?.booking_id ?? null, event.sequence, event.start, event.end]
        );
        continue;
      }

      if (previous?.booking_id) {
        const datesChanged = previous.check_in !== event.start || previous.check_out !== event.end;
        if (datesChanged) {
          try {
            await client.query('savepoint move_event');
            await client.query(
              `update booking set stay = daterange($2::date, $3::date, '[)'), version = version + 1
                where id = $1`,
              [previous.booking_id, event.start, event.end]
            );
            await client.query('release savepoint move_event');
            updated += 1;
          } catch (error) {
            await client.query('rollback to savepoint move_event');
            if (isPostgresError(error, EXCLUSION_VIOLATION)) {
              // The moved dates would collide with a held stay: keep the old
              // dates and let the conflict be visible rather than corrupting.
              conflicts += 1;
            } else {
              throw error;
            }
          }
        }
        await client.query(
          `update imported_event
              set sequence = $3, check_in = $4::date, check_out = $5::date,
                  state = 'active', last_seen_at = now()
            where feed_id = $1 and uid = $2`,
          [feed.id, event.uid, event.sequence, event.start, event.end]
        );
        continue;
      }

      const usedCapacity = Math.min(1, property.guests ?? 1);

      // Price the whole stay: nights × rate (+ cleaning from the property).
      const nights = Math.round(
        (Date.parse(`${event.end}T00:00:00.000Z`) - Date.parse(`${event.start}T00:00:00.000Z`)) /
          86_400_000
      );
      const stayPrice = priceStay({
        nights: Math.max(1, nights),
        nightlyRateCents: property.nightly_rate_cents,
        cleaningFeeCents: property.cleaning_fee_cents,
        channel: feed.source,
      });

      const reference = await client.query<{ n: number }>(`select nextval('booking_ref_seq') as n`);
      const inserted = await client.query<{ id: string }>(
        `insert into booking (
           property_id, reference, guest_name, channel, stay, guests,
           gross_cents, commission_bps, net_cents, rate_version,
           payment_status, status, source, notes
         ) values (
           $1, $2, $3, $4, daterange($5::date, $6::date, '[)'), $7,
           $8, $9, $10, $11,
           'unpaid', 'pending', 'import', $12
         )
         returning id`,
        [
          feed.property_id,
          `MRD-${reference.rows[0]?.n ?? 0}`,
          event.blocked ? 'Blocked (channel calendar)' : event.summary,
          feed.source,
          event.start,
          event.end,
          usedCapacity,
          stayPrice.grossCents,
          stayPrice.commissionBps,
          stayPrice.netCents,
          stayPrice.rateVersion,
          `Imported from ${feed.source} calendar`,
        ]
      );
      const bookingId = inserted.rows[0]?.id;
      if (!bookingId) throw new Error('import insert returned no row');
      created += 1;

      await client.query(
        `insert into imported_event (feed_id, uid, booking_id, sequence, check_in, check_out, state, last_seen_at)
         values ($1, $2, $3, $4, $5::date, $6::date, 'active', now())
         on conflict (feed_id, uid) do update
           set booking_id = excluded.booking_id, sequence = excluded.sequence,
               check_in = excluded.check_in, check_out = excluded.check_out,
               state = 'active', last_seen_at = now()`,
        [feed.id, event.uid, bookingId, event.sequence, event.start, event.end]
      );
    }

    await client.query(
      `update calendar_feed
          set last_attempt_at = now(), last_synced_at = now(),
              last_status = 'ok', last_error = null,
              consecutive_failures = 0, etag = $2
        where id = $1`,
      [feed.id, etag]
    );

    return { created, updated, cancelled, conflicts };
  });

  return {
    ...outcome,
    status: 'ok',
    created: result.created,
    updated: result.updated,
    cancelled: result.cancelled,
    conflicts: result.conflicts,
  };
}

export async function syncPropertyFeeds(
  propertyId: string,
  options: SyncOptions = {}
): Promise<SyncOutcome[]> {
  const feeds = await query<{ id: string }>(
    'select id from calendar_feed where property_id = $1 order by created_at',
    [propertyId]
  );
  const results: SyncOutcome[] = [];
  for (const feed of feeds) results.push(await syncFeed(feed.id, options));
  return results;
}

export async function syncPortfolioFeeds(
  portfolioId: string,
  options: SyncOptions = {}
): Promise<SyncOutcome[]> {
  const feeds = await query<{ id: string }>(
    `select f.id from calendar_feed f
       join property p on p.id = f.property_id
      where p.portfolio_id = $1 and p.deleted_at is null
      order by f.created_at`,
    [portfolioId]
  );
  const results: SyncOutcome[] = [];
  for (const feed of feeds) results.push(await syncFeed(feed.id, options));
  return results;
}
