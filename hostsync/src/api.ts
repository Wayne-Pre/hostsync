import type { FastifyInstance, FastifyRequest } from 'fastify';
import { query, queryOne } from './db.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import { addDays, isISODate, nightsBetween, todayUTC } from './dates.ts';
import { findSession } from './auth/sessions.ts';
import type { AuthenticatedSession } from './auth/sessions.ts';
import {
  createBooking,
  confirmBooking,
  cancelBooking,
} from './bookings.ts';
import type { Booking, BookingStatus, PaymentStatus } from './bookings.ts';
import { CHANNELS, priceStay, describeStay } from './pricing.ts';
import type { Channel } from './pricing.ts';
import {
  archiveProperty,
  createProperty,
  getProperty,
  listProperties,
  updateProperty,
} from './properties.ts';
import { syncPortfolioFeeds, syncPropertyFeeds } from './ics/sync.ts';
import { loadBoard } from './operations.ts';
import { createTask, moveTask, setChecklistItem } from './tasks.ts';
import { addMember, listAssignableTeam, listTeam, setMemberActive } from './team.ts';
import { listThreads, getThread, createConversation, REPLY_CHANNELS, reply as sendGuestReply } from './inbox.ts';
import {
  getSettings as getReviewSettings,
  listRequests,
  listReviews,
  reputation,
  replyToReview,
  requestReview,
  requestsDue,
  setSettings as setReviewSettings,
} from './reviews.ts';
import { defaultTransport } from './mail.ts';
import type { MailTransport } from './mail.ts';
import {
  addFeeOverride,
  financialKpis,
  generateStatement,
  listAccounts,
  listFeeOverrides,
  listStatements,
  listTransactions,
  monthlySeries,
  previewStatement,
  propertyPerformance,
  recordExpense,
  setBookingPayment,
  transitionStatement,
} from './money.ts';
import {
  channelStates,
  portfolioSettings,
  setChannelState,
  updatePortfolioSettings,
} from './settings.ts';
import { reconcilePortfolio } from './reconcile.ts';
import { statementDetail } from './statementDetail.ts';
import { optionalEmail } from './validation.ts';
import type { FetchLike } from './ics/sync.ts';
import type { Property } from './properties.ts';
import { rangeLabel } from '../shared/calendarLabel.ts';

declare module 'fastify' {
  interface FastifyRequest {
    session?: AuthenticatedSession;
  }
}

export interface Portfolio {
  id: string;
  name: string;
  currency: string;
  defaultManagementFeeBps: number;
}

const CALENDAR_MAX_DAYS = 60;
const CALENDAR_DEFAULT_DAYS = 21;

function body(request: FastifyRequest): Record<string, unknown> {
  const value = request.body;
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function params(request: FastifyRequest): Record<string, string> {
  return (request.params ?? {}) as Record<string, string>;
}

function queryParams(request: FastifyRequest): Record<string, string | undefined> {
  return (request.query ?? {}) as Record<string, string | undefined>;
}

function optionalQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The form shows "management fee %" (18), the database stores basis points
 * (1800). A percentage above 100 is rejected rather than silently clamped.
 */
function resolveFeeBps(input: Record<string, unknown>): number | null | undefined {
  if (input.managementFeeBps !== undefined) return undefined;
  if (input.managementFeePercent === undefined || input.managementFeePercent === null) {
    return undefined;
  }
  const percent = Number(input.managementFeePercent);
  if (!Number.isFinite(percent)) {
    throw new ValidationError('management fee must be a number', 'managementFeePercent');
  }
  if (percent < 0 || percent > 100) {
    throw new ValidationError('managementFeeBps must be between 0 and 10000', 'managementFeeBps');
  }
  return Math.round(percent * 100);
}

async function requirePortfolio(userId: string): Promise<Portfolio> {
  const row = await queryOne<{
    id: string;
    name: string;
    currency: string;
    default_management_fee_bps: number;
  }>(
    `select id, name, currency, default_management_fee_bps
       from portfolio where owner_id = $1 order by created_at limit 1`,
    [userId]
  );
  if (!row) {
    throw new ConflictError(
      'this workspace has no portfolio yet — finish onboarding first'
    );
  }
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    defaultManagementFeeBps: row.default_management_fee_bps,
  };
}

async function requireProperty(propertyId: string, portfolioId: string): Promise<Property> {
  const property = await getProperty(propertyId).catch(() => null);
  // A property in someone else's portfolio is a 404, not a 403: existence must not leak.
  if (!property || property.portfolioId !== portfolioId) throw new NotFoundError('property');
  return property;
}

/** Occupancy and next arrival are derived, never stored. */
interface PropertyStats {
  nightsBooked: number;
  channels: string[];
  nextArrival: string | null;
  bookedToday: boolean;
}

async function statsFor(
  propertyIds: string[],
  from: string,
  days: number
): Promise<Map<string, PropertyStats>> {
  const out = new Map<string, PropertyStats>();
  if (propertyIds.length === 0) return out;
  const to = addDays(from, days);

  const rows = await query<{
    property_id: string;
    nights: number;
    channels: string[] | null;
    next_arrival: string | null;
    in_house: boolean;
  }>(
    `select p.id as property_id,
            coalesce((
              select sum(greatest(0, least(upper(b.stay), $2::date) - greatest(lower(b.stay), $1::date)))
                from booking b
               where b.property_id = p.id
                 and b.status in ('confirmed', 'completed')
                 and b.stay && daterange($1::date, $2::date, '[)')
            ), 0)::int as nights,
            (
              select array_agg(distinct b.channel)
                from booking b
               where b.property_id = p.id and b.status in ('confirmed', 'completed')
            ) as channels,
            (
              select min(lower(b.stay))::text
                from booking b
               where b.property_id = p.id
                 and b.status in ('confirmed', 'pending')
                 and lower(b.stay) >= current_date
            ) as next_arrival,
            exists(
              select 1 from booking b
               where b.property_id = p.id
                 and b.status in ('confirmed', 'completed')
                 and b.stay @> current_date
            ) as in_house
       from property p
      where p.id = any($3::uuid[])`,
    [from, to, propertyIds]
  );

  for (const row of rows) {
    out.set(row.property_id, {
      nightsBooked: row.nights,
      channels: row.channels ?? [],
      nextArrival: row.next_arrival,
      bookedToday: row.in_house,
    });
  }
  return out;
}

async function accountsFor(propertyIds: string[]) {
  const rows = await query<{
    property_id: string;
    label: string;
    verified: boolean;
    balance_cents: number;
  }>(
    `select property_id, label, verified, balance_cents
       from property_account where property_id = any($1::uuid[])`,
    [propertyIds]
  );
  return new Map(rows.map((row) => [row.property_id, row]));
}

interface PropertyCard extends Property {
  occupancyPct: number;
  nightsBooked: number;
  channels: string[];
  nextArrival: string | null;
  account: { label: string; verified: boolean; balanceCents: number } | null;
}

async function buildCards(properties: Property[], from: string, days: number): Promise<PropertyCard[]> {
  const ids = properties.map((property) => property.id);
  const [stats, accounts] = await Promise.all([statsFor(ids, from, days), accountsFor(ids)]);

  return properties.map((property) => {
    const stat = stats.get(property.id);
    const account = accounts.get(property.id);
    return {
      ...property,
      nightsBooked: stat?.nightsBooked ?? 0,
      occupancyPct: Math.round(((stat?.nightsBooked ?? 0) / days) * 100),
      channels: stat?.channels ?? [],
      nextArrival: stat?.nextArrival ?? null,
      account: account
        ? {
            label: account.verified ? account.label : `${account.label} · pending`,
            verified: account.verified,
            balanceCents: account.balance_cents,
          }
        : null,
    };
  });
}

/** Card labels use the product's own words, so tests can assert the exact copy. */
export function nextArrivalLabel(nextArrival: string | null, today = todayUTC()): string {
  if (!nextArrival) return '—';
  const days = nightsBetween(today, nextArrival);
  if (days === 1) return 'Tomorrow';
  if (days === 0) return 'Today';
  return `In ${days} days`;
}

const CHANNEL_LABEL: Record<Channel, string> = {
  airbnb: 'Airbnb',
  booking_com: 'Booking.com',
  vrbo: 'Vrbo',
  direct: 'Direct',
  whatsapp: 'WhatsApp',
};

export interface CalendarCell {
  date: string;
  state: 'free' | 'held' | 'pending';
  bookingId: string | null;
  channel: Channel | null;
}

export interface CalendarBar {
  id: string;
  reference: string;
  guestName: string;
  channel: Channel;
  status: BookingStatus;
  checkIn: string;
  checkOut: string;
  startIndex: number;
  endIndex: number;
  overlaps: string[];
}

interface CalendarBookingRow {
  id: string;
  reference: string;
  guest_name: string;
  channel: Channel;
  status: BookingStatus;
  check_in: string;
  check_out: string;
  property_id: string;
}

export async function registerApi(
  app: FastifyInstance,
  apiOptions: { fetchImpl?: FetchLike; mailer?: MailTransport } = {}
): Promise<void> {
  await app.register(
    async (api) => {
      api.addHook('preHandler', async (request, reply) => {
        const token = request.cookies.hs_session;
        const session = token ? await findSession(token) : null;
        if (!session) {
          reply.code(401).send({ error: 'not_authenticated', message: 'sign in to continue' });
          return reply;
        }
        request.session = session;
        return undefined;
      });

      // ---- portfolio header (F-12) ------------------------------------------
      api.get('/portfolio', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const counts = await queryOne<{ properties: number; bookings: number }>(
          `select
             (select count(*)::int from property where portfolio_id = $1 and deleted_at is null and status <> 'archived') as properties,
             (select count(*)::int from booking b join property p on p.id = b.property_id
               where p.portfolio_id = $1 and b.status in ('confirmed','completed')) as bookings`,
          [portfolio.id]
        );
        return {
          portfolio,
          properties: counts?.properties ?? 0,
          confirmedStays: counts?.bookings ?? 0,
        };
      });

      // ---- F-21 property cards ----------------------------------------------
      api.get('/properties', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const q = queryParams(request);
        const days = Math.min(Math.max(Number(q.days ?? 30) || 30, 1), 90);
        const properties = await listProperties(portfolio.id, {
          includeArchived: q.includeArchived === 'true',
        });
        const cards = await buildCards(properties, todayUTC(), days);
        return { properties: cards, days, currency: portfolio.currency };
      });

      // ---- F-22 add property --------------------------------------------------
      api.post('/properties', async (request, reply) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const input = body(request);
        const feeBps = resolveFeeBps(input);
        const property = await createProperty({
          portfolioId: portfolio.id,
          name: String(input.name ?? ''),
          ...(typeof input.status === 'string' ? { status: input.status as Property['status'] } : {}),
          ...(input.type === undefined ? {} : { type: input.type as string | null }),
          ...(input.neighbourhood === undefined ? {} : { neighbourhood: input.neighbourhood as string | null }),
          ...(input.city === undefined ? {} : { city: input.city as string | null }),
          ...(input.address === undefined ? {} : { address: input.address as string | null }),
          ...(input.bedrooms === undefined ? {} : { bedrooms: input.bedrooms as number | null }),
          ...(input.baths === undefined ? {} : { baths: input.baths as number | null }),
          ...(input.guests === undefined ? {} : { guests: input.guests as number | null }),
          nightlyRateCents: Number(input.nightlyRateCents),
          ...(input.cleaningFeeCents === undefined
            ? {}
            : { cleaningFeeCents: Number(input.cleaningFeeCents) }),
          ...(input.managementFeeBps === undefined
            ? feeBps === undefined
              ? {}
              : { managementFeeBps: feeBps }
            : { managementFeeBps: input.managementFeeBps as number | null }),
          ...(input.ownerName === undefined ? {} : { ownerName: input.ownerName as string | null }),
          ...(input.ownerEmail === undefined ? {} : { ownerEmail: input.ownerEmail as string | null }),
          ...(input.photoKey === undefined ? {} : { photoKey: input.photoKey as string | null }),
          ...(typeof input.timezone === 'string' ? { timezone: input.timezone } : {}),
          ...(typeof input.checkinTime === 'string' ? { checkinTime: input.checkinTime } : {}),
          ...(typeof input.checkoutTime === 'string' ? { checkoutTime: input.checkoutTime } : {}),
        });

        // Channels are declared on the property form (F-22).
        if (Array.isArray(input.channels)) {
          for (const channel of input.channels) {
            if (typeof channel !== 'string' || !(CHANNELS as readonly string[]).includes(channel)) {
              throw new ValidationError(`unknown channel: ${String(channel)}`, 'channels');
            }
            await query(
              `insert into property_channel (property_id, channel)
               values ($1, $2) on conflict do nothing`,
              [property.id, channel]
            );
          }
        }

        reply.code(201).send({ property });
      });

      // ---- F-23 / F-24 read and edit -----------------------------------------
      api.get('/properties/:id', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const property = await requireProperty(params(request).id!, portfolio.id);
        const [card] = await buildCards([property], todayUTC(), 30);
        return { property: card, currency: portfolio.currency };
      });

      api.patch('/properties/:id', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const property = await requireProperty(params(request).id!, portfolio.id);
        const input = body(request);

        const patch: Parameters<typeof updateProperty>[1] = {};
        const copy = <K extends keyof typeof patch>(key: K, value: unknown) => {
          if (value !== undefined) (patch as Record<string, unknown>)[key as string] = value;
        };
        copy('name', input.name);
        copy('status', input.status);
        copy('type', input.type);
        copy('neighbourhood', input.neighbourhood);
        copy('city', input.city);
        copy('address', input.address);
        copy('bedrooms', input.bedrooms);
        copy('baths', input.baths);
        copy('guests', input.guests);
        copy('nightlyRateCents', input.nightlyRateCents);
        copy('cleaningFeeCents', input.cleaningFeeCents);
        copy('managementFeeBps', input.managementFeeBps);
        const percentPatch = resolveFeeBps(input);
        if (input.managementFeeBps === undefined && percentPatch !== undefined) {
          patch.managementFeeBps = percentPatch;
        }
        copy('ownerName', input.ownerName);
        copy('ownerEmail', input.ownerEmail);
        copy('photoKey', input.photoKey);
        copy('timezone', input.timezone);
        copy('checkinTime', input.checkinTime);
        copy('checkoutTime', input.checkoutTime);

        const updated = await updateProperty(property.id, patch);

        // The form edits channels too, so a save replaces the declared set.
        if (Array.isArray(input.channels)) {
          for (const channel of input.channels) {
            if (typeof channel !== 'string' || !(CHANNELS as readonly string[]).includes(channel)) {
              throw new ValidationError(`unknown channel: ${String(channel)}`, 'channels');
            }
          }
          await query('delete from property_channel where property_id = $1', [property.id]);
          for (const channel of input.channels as string[]) {
            await query(
              `insert into property_channel (property_id, channel) values ($1, $2)
               on conflict do nothing`,
              [property.id, channel]
            );
          }
        }

        return { property: updated };
      });

      api.post('/properties/:id/archive', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const property = await requireProperty(params(request).id!, portfolio.id);
        return { property: await archiveProperty(property.id) };
      });

      // ---- F-70 fee history ---------------------------------------------------
      api.get('/properties/:id/fees', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const property = await requireProperty(params(request).id!, portfolio.id);
        return { fees: await listFeeOverrides(property.id) };
      });

      api.post('/properties/:id/fees', async (request, reply) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const property = await requireProperty(params(request).id!, portfolio.id);
        const input = body(request);
        const percent = input.managementFeePercent;
        const feeBps =
          input.feeBps !== undefined
            ? Number(input.feeBps)
            : percent !== undefined
              ? Number(percent) * 100
              : Number.NaN;
        const fee = await addFeeOverride(portfolio.id, property.id, {
          effectiveFrom: String(input.effectiveFrom ?? ''),
          feeBps,
        });
        reply.code(201).send({ fee });
      });

      // ---- F-27 settling account ---------------------------------------------
      api.put('/properties/:id/account', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const property = await requireProperty(params(request).id!, portfolio.id);
        const input = body(request);
        const label = typeof input.label === 'string' ? input.label.trim() : '';
        if (label.length === 0) throw new ValidationError('account label is required', 'label');
        if (label.length > 120) throw new ValidationError('account label is too long', 'label');
        const verified = input.verified === true;
        const openingBalance = Number(input.balanceCents ?? 0);
        if (!Number.isInteger(openingBalance)) {
          throw new ValidationError('balanceCents must be a whole number', 'balanceCents');
        }

        const row = await queryOne<{
          property_id: string;
          label: string;
          verified: boolean;
          balance_cents: number;
        }>(
          `insert into property_account (property_id, label, verified, opening_balance_cents, balance_cents)
           values ($1, $2, $3, $4, $4)
           on conflict (property_id) do update
             set label = excluded.label,
                 verified = excluded.verified,
                 balance_cents = property_account.balance_cents
                   + (excluded.opening_balance_cents - property_account.opening_balance_cents),
                 opening_balance_cents = excluded.opening_balance_cents
           returning property_id, label, verified, balance_cents`,
          [property.id, label, verified, openingBalance]
        );
        return {
          account: {
            label: row?.label,
            verified: row?.verified,
            balanceCents: row?.balance_cents,
            display: row?.verified ? row?.label : `${row?.label} · pending`,
          },
        };
      });

      // ---- F-25 calendar feed on the property --------------------------------
      api.put('/properties/:id/calendar-feed', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const property = await requireProperty(params(request).id!, portfolio.id);
        const input = body(request);
        const url = typeof input.url === 'string' ? input.url.trim() : '';
        const source = typeof input.source === 'string' ? input.source : '';

        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new ValidationError("That doesn't look like a web link", 'url');
        }
        if (parsed.protocol !== 'https:') {
          throw new ValidationError('calendar links must use https', 'url');
        }
        if (!(CHANNELS as readonly string[]).includes(source)) {
          throw new ValidationError('choose a channel for this calendar', 'source');
        }

        const row = await queryOne<{ id: string; url: string; source: string }>(
          `insert into calendar_feed (property_id, url, source)
           values ($1, $2, $3)
           on conflict (property_id, url) do update set source = excluded.source
           returning id, url, source`,
          [property.id, parsed.toString(), source]
        );
        return { feed: row };
      });

      api.get('/properties/:id/calendar-feeds', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const property = await requireProperty(params(request).id!, portfolio.id);
        const feeds = await query(
          `select id, url, source, last_synced_at, last_status, last_error, consecutive_failures
             from calendar_feed where property_id = $1 order by created_at`,
          [property.id]
        );
        return { feeds };
      });

      // ---- F-26 sync now ------------------------------------------------------
      api.post('/properties/:id/sync', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const property = await requireProperty(params(request).id!, portfolio.id);
        const results = await syncPropertyFeeds(property.id, apiOptions);
        return { results, anyFailed: results.some((result) => result.status === 'failed') };
      });

      api.post('/sync', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const results = await syncPortfolioFeeds(portfolio.id, apiOptions);
        return { results, anyFailed: results.some((result) => result.status === 'failed') };
      });

      // ---- F-14 / F-16 / F-19 dashboard essentials ---------------------------
      api.get('/dashboard', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const properties = await listProperties(portfolio.id);
        const cards = await buildCards(properties, todayUTC(), 30);
        const propertyIds = properties.map((property) => property.id);

        const revenue = await queryOne<{ net_cents: number }>(
          `select coalesce(sum(b.net_cents), 0)::bigint as net_cents
             from booking b join property p on p.id = b.property_id
            where p.portfolio_id = $1
              and b.status in ('confirmed','completed')
              and lower(b.stay) >= date_trunc('month', current_date)::date
              and lower(b.stay) < (date_trunc('month', current_date) + interval '1 month')::date`,
          [portfolio.id]
        );

        const occupancy = await queryOne<{ nights: number }>(
          `select coalesce(sum(
                    greatest(0, least(upper(b.stay), current_date) - greatest(lower(b.stay), current_date - 30))
                  ), 0)::int as nights
             from booking b join property p on p.id = b.property_id
            where p.portfolio_id = $1
              and b.status in ('confirmed','completed')
              and b.stay && daterange(current_date - 30, current_date, '[)')`,
          [portfolio.id]
        );

        const turnover = await query<{
          id: string;
          property_name: string;
          window_start: Date;
          window_end: Date;
          assignee: string | null;
          status: string;
        }>(
          `select t.id, p.name as property_name, t.window_start, t.window_end,
                  t.assignee, t.status
             from task t join property p on p.id = t.property_id
            where p.portfolio_id = $1
              and t.kind = 'turnover'
              and t.status in ('scheduled','in_progress')
              and t.window_start >= now()
              and t.window_start < now() + interval '48 hours'
            order by t.window_start`,
          [portfolio.id]
        );

        // F-15 — six months of revenue (by check-in month) and occupancy.
        const chartRows = await query<{
          month: string;
          revenue_cents: string | number;
          nights: string | number;
        }>(
          `with months as (
             select generate_series(
               (date_trunc('month', current_date) - interval '5 months')::date,
               date_trunc('month', current_date)::date,
               interval '1 month'
             )::date as month_start
           )
           select to_char(m.month_start, 'YYYY-MM') as month,
                  coalesce((
                    select sum(b.net_cents)
                      from booking b join property p on p.id = b.property_id
                     where p.portfolio_id = $1
                       and b.status in ('confirmed','completed')
                       and lower(b.stay) >= m.month_start
                       and lower(b.stay) < (m.month_start + interval '1 month')::date
                  ), 0)::bigint as revenue_cents,
                  coalesce((
                    select sum(greatest(0,
                             least(upper(b.stay), (m.month_start + interval '1 month')::date)
                             - greatest(lower(b.stay), m.month_start)))
                      from booking b join property p on p.id = b.property_id
                     where p.portfolio_id = $1
                       and b.status in ('confirmed','completed')
                       and b.stay && daterange(m.month_start, (m.month_start + interval '1 month')::date, '[)')
                  ), 0)::int as nights
             from months m
            order by m.month_start`,
          [portfolio.id]
        );

        // F-17 — only money that has not been released yet.
        const payables = await queryOne<{ amount_cents: string | number; count: number }>(
          `select coalesce(sum(net_cents), 0)::bigint as amount_cents, count(*)::int as count
             from statement
            where portfolio_id = $1 and status in ('draft','approved')`,
          [portfolio.id]
        );

        const rating = await queryOne<{ average: string | null; count: number }>(
          `select round(avg(r.rating), 2)::text as average, count(*)::int as count
             from review r join property p on p.id = r.property_id
            where p.portfolio_id = $1`,
          [portfolio.id]
        );

        const conflicts = await queryOne<{ pairs: number }>(
          `select count(*)::int as pairs
             from booking a
             join booking b on b.property_id = a.property_id and b.id > a.id
            where a.property_id = any($1::uuid[])
              and a.status in ('pending','confirmed','completed')
              and b.status in ('pending','confirmed','completed')
              and a.stay && b.stay`,
          [propertyIds.length > 0 ? propertyIds : ['00000000-0000-0000-0000-000000000000']]
        );

        const occupiedNights = occupancy?.nights ?? 0;
        const capacity = 30 * Math.max(properties.length, 1);

        // Occupancy is nights held / (nights in the month x properties), computed
        // from the same rows as the revenue, so the toggle cannot disagree.
        const chartBuckets = chartRows.map((row) => {
          const [year, month] = row.month.split('-').map(Number);
          const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
          const nights = Number(row.nights);
          return {
            month: row.month,
            revenueCents: Number(row.revenue_cents),
            nights,
            occupancyPct:
              properties.length === 0
                ? 0
                : Math.round((nights / (daysInMonth * properties.length)) * 100),
          };
        });

        return {
          currency: portfolio.currency,
          kpis: {
            netRevenueThisMonthCents: revenue?.net_cents ?? 0,
            occupancyLast30Pct:
              properties.length === 0 ? 0 : Math.round((occupiedNights / capacity) * 100),
            turnoversDue48h: turnover.length,
            guestRating: rating?.average === null ? null : Number(rating?.average),
            reviewCount: rating?.count ?? 0,
          },
          calendarClear: {
            clear: (conflicts?.pairs ?? 0) === 0,
            conflicts: conflicts?.pairs ?? 0,
            label: (conflicts?.pairs ?? 0) === 0 ? 'CALENDAR CLEAR' : 'OVERLAP FOUND',
            detail:
              (conflicts?.pairs ?? 0) === 0
                ? 'No overlapping nights'
                : `${conflicts?.pairs} overlapping night${(conflicts?.pairs ?? 0) === 1 ? '' : 's'}`,
          },
          health: cards.map((card) => ({
            propertyId: card.id,
            name: card.name,
            status: card.status,
            occupancyPct: card.occupancyPct,
            nextArrival: card.nextArrival,
            nextArrivalLabel: nextArrivalLabel(card.nextArrival),
            account: card.account,
            nightlyRateCents: card.nightlyRateCents,
          })),
          chart: chartBuckets,
          payouts: {
            amountCents: Number(payables?.amount_cents ?? 0),
            count: payables?.count ?? 0,
          },
          turnovers: turnover.map((row) => ({
            id: row.id,
            propertyName: row.property_name,
            windowStart: row.window_start.toISOString(),
            windowEnd: row.window_end.toISOString(),
            assignee: row.assignee,
            status: row.status,
          })),
        };
      });

      // ---- F-43 / F-44 operations board -------------------------------------
      api.get('/tasks', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        return loadBoard(portfolio.id, todayUTC());
      });

      // ---- F-47 new task -----------------------------------------------------
      api.post('/tasks', async (request, reply) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const input = body(request);
        const task = await createTask({
          portfolioId: portfolio.id,
          propertyId: String(input.propertyId ?? ''),
          kind: String(input.kind ?? 'other'),
          title: String(input.title ?? ''),
          date: String(input.date ?? todayUTC()),
          windowStart: String(input.windowStart ?? '11:00'),
          windowEnd: String(input.windowEnd ?? '15:00'),
          assignee: typeof input.assignee === 'string' && input.assignee ? input.assignee : null,
          priority: String(input.priority ?? 'normal'),
          expectedCostCents: Number(input.expectedCostCents ?? 0),
          notes: typeof input.notes === 'string' ? input.notes : null,
        });
        reply.code(201).send({ task });
      });

      // ---- F-48 task lifecycle ------------------------------------------------
      api.post('/tasks/:id/start', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const status = await moveTask(params(request).id!, portfolio.id, 'start');
        return { status };
      });

      api.post('/tasks/:id/complete', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const status = await moveTask(params(request).id!, portfolio.id, 'complete');
        return { status };
      });

      api.post('/tasks/:id/reopen', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const status = await moveTask(params(request).id!, portfolio.id, 'reopen');
        return { status };
      });

      // ---- F-49 checklist -----------------------------------------------------
      api.post('/tasks/:id/checklist', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const input = body(request);
        const result = await setChecklistItem(
          params(request).id!,
          portfolio.id,
          Number(input.position ?? 0),
          input.done === true
        );
        return result;
      });

      // ---- F-50 – F-55 guest inbox -------------------------------------------
      api.get('/inbox', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        return { threads: await listThreads(portfolio.id) };
      });

      // F-54 — "Email a guest": create the outbound thread, then send its first message.
      api.post('/inbox', async (request, reply) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const input = body(request);
        const guestName = String(input.guestName ?? '').trim();
        if (!guestName) throw new ValidationError('guest name is required', 'guestName');

        const channel = String(input.channel ?? 'email');
        if (!(REPLY_CHANNELS as readonly string[]).includes(channel)) {
          throw new ValidationError(`channel must be one of: ${REPLY_CHANNELS.join(', ')}`, 'channel');
        }
        const guestEmail = optionalEmail(input.guestEmail, 'guestEmail');
        if (channel === 'email' && !guestEmail) {
          throw new ValidationError('an email address is required to email a guest', 'guestEmail');
        }

        let propertyId: string | null = null;
        if (input.propertyId !== undefined && input.propertyId !== null && input.propertyId !== '') {
          propertyId = (await requireProperty(String(input.propertyId), portfolio.id)).id;
        }

        const conversationId = await createConversation({
          portfolioId: portfolio.id,
          propertyId,
          bookingId: null,
          guestName,
          guestEmail,
          channel,
          subject: String(input.subject ?? '').trim() || null,
        });

        const first = String(input.body ?? '').trim();
        const message = first
          ? await sendGuestReply(
              portfolio.id,
              conversationId,
              { body: first, channel },
              apiOptions.mailer ?? defaultTransport
            )
          : null;
        reply.code(201).send({ conversationId, message });
      });

      api.get('/inbox/:id', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        return getThread(portfolio.id, params(request).id!);
      });

      api.post('/inbox/:id/reply', async (request, reply) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const input = body(request);
        const message = await sendGuestReply(
          portfolio.id,
          params(request).id!,
          { body: String(input.body ?? ''), channel: String(input.channel ?? 'email') },
          apiOptions.mailer ?? defaultTransport
        );
        reply.code(201).send({ message });
      });

      // ---- F-76 / F-77 team roster -------------------------------------------
      api.get('/team', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        return { members: await listTeam(portfolio.id) };
      });

      api.get('/team/assignable', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        return { members: await listAssignableTeam(portfolio.id) };
      });

      api.post('/team', async (request, reply) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const input = body(request);
        const member = await addMember({
          portfolioId: portfolio.id,
          name: String(input.name ?? ''),
          role: String(input.role ?? ''),
          phone: typeof input.phone === 'string' && input.phone ? input.phone : null,
          hourlyRateCents: Number(input.hourlyRateCents ?? 0),
          reliabilityPct: Number(input.reliabilityPct ?? 100),
        });
        reply.code(201).send({ member });
      });

      api.post('/team/:id/pause', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const member = await setMemberActive(params(request).id!, portfolio.id, false);
        return { member };
      });

      api.post('/team/:id/resume', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const member = await setMemberActive(params(request).id!, portfolio.id, true);
        return { member };
      });

      // ---- F-56 – F-61 reviews -----------------------------------------------
      api.get('/reviews', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const settings = await getReviewSettings(portfolio.id);
        const kpis = await reputation(portfolio.id, settings.daysAfterCheckout);
        return { kpis, reviews: await listReviews(portfolio.id), settings };
      });

      api.post('/reviews/:id/reply', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const input = body(request);
        return { review: await replyToReview(portfolio.id, params(request).id!, String(input.body ?? '')) };
      });

      api.get('/reviews/requests', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        return { requests: await listRequests(portfolio.id) };
      });

      api.get('/reviews/requests/due', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const settings = await getReviewSettings(portfolio.id);
        return { due: await requestsDue(portfolio.id, settings.daysAfterCheckout) };
      });

      api.post('/reviews/requests', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const input = body(request);
        const bookingId = String(input.bookingId ?? '');
        return { request: await requestReview(portfolio.id, bookingId) };
      });

      api.put('/reviews/settings', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const input = body(request);
        const settings = await setReviewSettings(portfolio.id, {
          autoRequest: input.autoRequest === true,
          daysAfterCheckout: Number(input.daysAfterCheckout ?? 1),
        });
        return { settings };
      });

      // ---- F-62 – F-72 money --------------------------------------------------
      api.get('/financials', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const kpis = await financialKpis(portfolio.id);
        const series = await monthlySeries(portfolio.id, 6);
        return { currency: portfolio.currency, kpis, series };
      });

      api.get('/financials/accounts', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        return { accounts: await listAccounts(portfolio.id) };
      });

      api.get('/financials/performance', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        return { properties: await propertyPerformance(portfolio.id) };
      });

      api.get('/financials/reconciliation', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        return { reconciliation: await reconcilePortfolio(portfolio.id) };
      });

      api.get('/transactions', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const filter = String(queryParams(request).filter ?? 'all');
        if (!['all', 'revenue', 'expenses'].includes(filter)) {
          throw new ValidationError('filter must be all, revenue or expenses', 'filter');
        }
        return { transactions: await listTransactions(portfolio.id, filter as 'all' | 'revenue' | 'expenses') };
      });

      api.post('/transactions/expense', async (request, reply) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const input = body(request);
        const transaction = await recordExpense({
          portfolioId: portfolio.id,
          propertyId: String(input.propertyId ?? ''),
          date: String(input.date ?? ''),
          category: String(input.category ?? ''),
          amountCents: Number(input.amountCents ?? 0),
          description: String(input.description ?? ''),
          paidTo: typeof input.paidTo === 'string' ? input.paidTo : null,
        });
        reply.code(201).send({ transaction });
      });

      api.get('/statements', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        return listStatements(portfolio.id);
      });

      api.get('/statements/preview', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const q = queryParams(request);
        return {
          preview: await previewStatement(
            portfolio.id,
            String(q.propertyId ?? ''),
            String(q.month ?? '')
          ),
        };
      });

      api.get('/statements/:id', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        return { detail: await statementDetail(portfolio.id, params(request).id!) };
      });

      api.post('/statements', async (request, reply) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const input = body(request);
        const statement = await generateStatement(
          portfolio.id,
          String(input.propertyId ?? ''),
          String(input.month ?? '')
        );
        reply.code(201).send({ statement });
      });

      api.post('/statements/:id/approve', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        return { statement: await transitionStatement(portfolio.id, params(request).id!, 'approved', request.session!.user.id) };
      });

      api.post('/statements/:id/pay', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        return { statement: await transitionStatement(portfolio.id, params(request).id!, 'paid', request.session!.user.id) };
      });

      // ---- F-33 booking payment ----------------------------------------------
      api.post('/bookings/:id/payment', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const input = body(request);
        return setBookingPayment(
          portfolio.id,
          params(request).id!,
          String(input.paymentStatus ?? '')
        );
      });

      // ---- F-73 portfolio details ---------------------------------------------
      api.get('/portfolio/settings', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        return { settings: await portfolioSettings(portfolio.id) };
      });

      api.patch('/portfolio/settings', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const input = body(request);
        return { settings: await updatePortfolioSettings(portfolio.id, input) };
      });

      // ---- F-75 channel states ------------------------------------------------
      api.get('/channels', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        return { channels: await channelStates(portfolio.id) };
      });

      api.post('/channels/:channel', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const input = body(request);
        return {
          channel: await setChannelState(portfolio.id, params(request).channel ?? '', {
            connected: input.connected === true,
            businessNumber: typeof input.businessNumber === 'string' ? input.businessNumber : null,
          }),
        };
      });

      // ---- F-35 live quote ----------------------------------------------------
      api.get('/bookings/quote', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const q = queryParams(request);
        const property = await requireProperty(String(q.propertyId ?? ''), portfolio.id);
        const checkIn = String(q.checkIn ?? '');
        const checkOut = String(q.checkOut ?? '');
        const guests = Number(q.guests ?? 1);
        const channel = String(q.channel ?? 'direct');

        if (!isISODate(checkIn) || !isISODate(checkOut)) {
          throw new ValidationError('check-in and check-out must be dates', 'checkIn');
        }
        if (!(CHANNELS as readonly string[]).includes(channel)) {
          throw new ValidationError('unknown channel', 'channel');
        }

        const nights = nightsBetween(checkIn, checkOut);
        if (nights <= 0) {
          throw new ValidationError('check-out must be after check-in', 'checkOut');
        }
        if (guests < 1) throw new ValidationError('guests must be at least 1', 'guests');
        if (property.guests !== null && guests > property.guests) {
          throw new ValidationError(`this property sleeps ${property.guests}`, 'guests');
        }

        const price = priceStay({
          nights,
          nightlyRateCents: property.nightlyRateCents,
          cleaningFeeCents: property.cleaningFeeCents,
          channel: channel as Channel,
        });

        return {
          price,
          summary: describeStay(price, portfolio.currency),
          channelLabel: CHANNEL_LABEL[channel as Channel],
        };
      });

      // ---- F-28..F-32 ledger --------------------------------------------------
      api.get('/bookings', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const q = queryParams(request);
        const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
        const status = optionalQuery(q.status);
        const channel = optionalQuery(q.channel);
        const search = optionalQuery(q.q)?.trim();
        const propertyId = optionalQuery(q.propertyId);
        const cursor = optionalQuery(q.cursor);

        if (status && !['pending', 'confirmed', 'completed', 'cancelled'].includes(status)) {
          throw new ValidationError('unknown status', 'status');
        }
        if (channel && !(CHANNELS as readonly string[]).includes(channel)) {
          throw new ValidationError('unknown channel', 'channel');
        }

        const rows = await query<
          Record<string, unknown> & {
            id: string;
            reference: string;
          }
        >(
          `select b.id, b.reference, b.guest_name, b.guest_email, b.guest_phone,
                  b.channel, lower(b.stay)::text as check_in, upper(b.stay)::text as check_out,
                  b.guests, b.gross_cents, b.commission_bps, b.net_cents, b.rate_version,
                  b.payment_status, b.status, b.source, b.notes, b.version,
                  p.name as property_name, p.id as property_id
             from booking b
             join property p on p.id = b.property_id
            where p.portfolio_id = $1
              and ($2::text is null or b.status = $2::text)
              and ($3::text is null or b.channel = $3::text)
              and ($4::uuid is null or b.property_id = $4::uuid)
              and ($5::text is null
                   or b.guest_name ilike '%' || $5 || '%'
                   or b.reference ilike '%' || $5 || '%'
                   or p.name ilike '%' || $5 || '%')
              and ($6::text is null or b.reference > $6::text)
            order by b.reference
            limit $7`,
          [portfolio.id, status ?? null, channel ?? null, propertyId ?? null, search ?? null, cursor ?? null, limit]
        );

        const bookings = rows.map((row) => ({
          ...mapBookingRow(row),
          propertyName: String(row.property_name),
        }));

        return {
          bookings,
          nextCursor: bookings.length === limit ? bookings[bookings.length - 1]?.reference ?? null : null,
        };
      });

      // ---- F-29 ledger counters ----------------------------------------------
      api.get('/bookings/summary', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const q = queryParams(request);
        const propertyId = optionalQuery(q.propertyId) ?? null;

        const row = await queryOne<{
          in_house_now: number;
          arriving: number;
          net_booked: number;
        }>(
          `select
             count(*) filter (
               where b.status in ('confirmed','completed') and b.stay @> current_date
             )::int as in_house_now,
             count(*) filter (
               where b.status = 'confirmed' and lower(b.stay) >= current_date
             )::int as arriving,
             coalesce(sum(b.net_cents) filter (
               where b.status in ('confirmed','completed')
             ), 0)::bigint as net_booked
           from booking b
           join property p on p.id = b.property_id
          where p.portfolio_id = $1
            and ($2::uuid is null or b.property_id = $2::uuid)`,
          [portfolio.id, propertyId]
        );

        return {
          inHouseNow: row?.in_house_now ?? 0,
          arriving: row?.arriving ?? 0,
          netBookedCents: row?.net_booked ?? 0,
        };
      });

      // ---- F-33 create --------------------------------------------------------
      api.post('/bookings', async (request, reply) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const input = body(request);
        const property = await requireProperty(String(input.propertyId ?? ''), portfolio.id);

        const booking = await createBooking({
          propertyId: property.id,
          guestName: String(input.guestName ?? ''),
          guestEmail: (input.guestEmail as string | null | undefined) ?? null,
          guestPhone: (input.guestPhone as string | null | undefined) ?? null,
          channel: String(input.channel ?? ''),
          checkIn: String(input.checkIn ?? ''),
          checkOut: String(input.checkOut ?? ''),
          guests: Number(input.guests ?? 1),
          ...(typeof input.paymentStatus === 'string'
            ? { paymentStatus: input.paymentStatus as PaymentStatus }
            : {}),
          ...(input.status === 'pending' ? { status: 'pending' as const } : {}),
          ...(typeof input.notes === 'string' ? { notes: input.notes } : {}),
        });

        reply.code(201).send({ booking: { ...booking, propertyName: property.name } });
      });

      // ---- F-32 detail --------------------------------------------------------
      api.get('/bookings/:id', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const id = params(request).id!;
        const row = await queryOne<Record<string, unknown> & { id: string; property_name: string }>(
          `select b.id, b.reference, b.guest_name, b.guest_email, b.guest_phone,
                  b.channel, lower(b.stay)::text as check_in, upper(b.stay)::text as check_out,
                  b.guests, b.gross_cents, b.commission_bps, b.net_cents, b.rate_version,
                  b.payment_status, b.status, b.source, b.notes, b.version,
                  p.name as property_name, p.id as property_id,
                  to_char(p.checkin_time, 'HH24:MI') as checkin_time,
                  to_char(p.checkout_time, 'HH24:MI') as checkout_time
             from booking b join property p on p.id = b.property_id
            where b.id = $1 and p.portfolio_id = $2`,
          [id, portfolio.id]
        );
        if (!row) throw new NotFoundError('booking');

        const overlaps = await query<{
          id: string;
          reference: string;
          guest_name: string;
          check_in: string;
          check_out: string;
          status: string;
        }>(
          `select b.id, b.reference, b.guest_name,
                  lower(b.stay)::text as check_in, upper(b.stay)::text as check_out, b.status
             from booking b
            where b.property_id = $1 and b.id <> $2
              and b.status in ('pending','confirmed','completed')
              and b.stay && daterange($3::date, $4::date, '[)')
            order by lower(b.stay)`,
          [row.property_id, row.id, row.check_in, row.check_out]
        );

        const booking = mapBookingRow(row);
        return {
          booking: {
            ...booking,
            propertyName: row.property_name,
            checkinTime: row.checkin_time,
            checkoutTime: row.checkout_time,
            channelLabel: CHANNEL_LABEL[booking.channel],
          },
          overlaps: overlaps.map((overlap) => ({
            id: overlap.id,
            reference: overlap.reference,
            guestName: overlap.guest_name,
            checkIn: overlap.check_in,
            checkOut: overlap.check_out,
            status: overlap.status,
          })),
          overlapWarning:
            overlaps.length > 0
              ? `Overlaps ${overlaps.length} other booking${overlaps.length === 1 ? '' : 's'}`
              : null,
        };
      });

      // ---- F-33 confirm / F-34 cancel ----------------------------------------
      api.post('/bookings/:id/confirm', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        await bookingInPortfolio(params(request).id!, portfolio.id);
        return { booking: await confirmBooking(params(request).id!) };
      });

      api.post('/bookings/:id/cancel', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        await bookingInPortfolio(params(request).id!, portfolio.id);
        return { booking: await cancelBooking(params(request).id!) };
      });

      // ---- F-40 sync health header -------------------------------------------
      api.get('/sync/health', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const counts = await queryOne<{
          properties: number;
          confirmed_stays: number;
          conflicts: number;
        }>(
          `select
             (select count(*)::int from property
               where portfolio_id = $1 and deleted_at is null and status <> 'archived') as properties,
             (select count(*)::int from booking b join property p on p.id = b.property_id
               where p.portfolio_id = $1 and b.status in ('confirmed','completed')) as confirmed_stays,
             (select count(*)::int from booking a
                join booking b on b.property_id = a.property_id and b.id > a.id
               where a.property_id in (select id from property where portfolio_id = $1)
                 and a.status in ('pending','confirmed','completed')
                 and b.status in ('pending','confirmed','completed')
                 and a.stay && b.stay) as conflicts`,
          [portfolio.id]
        );

        const feed = await queryOne<{ last_attempt_at: Date | null; failed: number; total: number }>(
          `select max(f.last_attempt_at) as last_attempt_at,
                  count(*) filter (where f.last_status = 'failed')::int as failed,
                  count(*)::int as total
             from calendar_feed f
             join property p on p.id = f.property_id
            where p.portfolio_id = $1`,
          [portfolio.id]
        );

        const state =
          !feed || feed.total === 0
            ? 'never'
            : feed.failed > 0
              ? 'failed'
              : feed.last_attempt_at
                ? 'live'
                : 'stale';

        return {
          properties: counts?.properties ?? 0,
          confirmedStays: counts?.confirmed_stays ?? 0,
          conflicts: counts?.conflicts ?? 0,
          fresh: state === 'live',
          state,
          checkedAt: feed?.last_attempt_at ?? null,
          headline:
            state === 'live'
              ? 'No double bookings'
              : state === 'failed'
                ? 'Sync needs attention'
                : 'Waiting for the first sync',
        };
      });

      // ---- F-37 calendar grid -------------------------------------------------
      api.get('/calendar', async (request) => {
        const portfolio = await requirePortfolio(request.session!.user.id);
        const q = queryParams(request);
        const from = isISODate(q.from ?? '') ? String(q.from) : todayUTC();
        const days = Math.min(Math.max(Number(q.days ?? CALENDAR_DEFAULT_DAYS) || CALENDAR_DEFAULT_DAYS, 1), CALENDAR_MAX_DAYS);
        const to = addDays(from, days);

        const properties = await listProperties(portfolio.id);
        const dates = Array.from({ length: days }, (_, index) => addDays(from, index));

        if (properties.length === 0) {
          return {
            range: { from, to, days, label: rangeLabel(from, days) },
            dates,
            rows: [],
            conflicts: 0,
            legend: legend(),
          };
        }

        const bookings = await query<CalendarBookingRow>(
          `select b.id, b.reference, b.guest_name, b.channel, b.status,
                  lower(b.stay)::text as check_in, upper(b.stay)::text as check_out,
                  b.property_id
             from booking b
            where b.property_id = any($1::uuid[])
              and b.status <> 'cancelled'
              and b.stay && daterange($2::date, $3::date, '[)')
            order by lower(b.stay)`,
          [properties.map((property) => property.id), from, to]
        );

        const byProperty = new Map<string, CalendarBookingRow[]>();
        for (const booking of bookings) {
          const list = byProperty.get(booking.property_id) ?? [];
          list.push(booking);
          byProperty.set(booking.property_id, list);
        }

        let conflictCount = 0;

        const rows = properties.map((property) => {
          const propertyBookings = byProperty.get(property.id) ?? [];

          const bars: CalendarBar[] = propertyBookings.map((booking) => {
            const overlaps = propertyBookings
              .filter(
                (other) =>
                  other.id !== booking.id &&
                  nightsBetween(
                    later(booking.check_in, other.check_in),
                    earlier(booking.check_out, other.check_out)
                  ) > 0
              )
              .map((other) => other.id);

            return {
              id: booking.id,
              reference: booking.reference,
              guestName: booking.guest_name,
              channel: booking.channel,
              status: booking.status,
              checkIn: booking.check_in,
              checkOut: booking.check_out,
              startIndex: Math.max(0, nightsBetween(from, booking.check_in)),
              endIndex: Math.min(days, nightsBetween(from, booking.check_out)),
              overlaps,
            };
          });

          conflictCount += bars.filter((bar) => bar.overlaps.length > 0).length / 2;

          const cells: CalendarCell[] = dates.map((date) => {
            const holder = propertyBookings.find(
              (booking) => booking.check_in <= date && date < booking.check_out
            );
            return {
              date,
              state: holder ? (holder.status === 'pending' ? 'pending' : 'held') : 'free',
              bookingId: holder?.id ?? null,
              channel: holder?.channel ?? null,
            };
          });

          return {
            propertyId: property.id,
            name: property.name,
            status: property.status,
            bars,
            cells,
          };
        });

        return {
          range: { from, to, days, label: rangeLabel(from, days) },
          dates,
          rows,
          conflicts: Math.round(conflictCount),
          legend: legend(),
        };
      });
    },
    { prefix: '/api' }
  );
}

async function bookingInPortfolio(bookingId: string, portfolioId: string) {
  const row = await queryOne<{ id: string }>(
    `select b.id from booking b join property p on p.id = b.property_id
      where b.id = $1 and p.portfolio_id = $2`,
    [bookingId, portfolioId]
  );
  if (!row) throw new NotFoundError('booking');
  return row;
}

function later(a: string, b: string): string {
  return a >= b ? a : b;
}

function earlier(a: string, b: string): string {
  return a <= b ? a : b;
}

function legend() {
  return [
    ...CHANNELS.map((channel) => ({ key: channel, label: CHANNEL_LABEL[channel] })),
    { key: 'conflict', label: 'Conflict' },
    { key: 'turnover', label: 'Turnover scheduled' },
  ];
}

/** The product's range label: "Sat 14 November – 04 Dec". */
export { rangeLabel };

function mapBookingRow(row: Record<string, unknown>): Booking {
  return {
    id: String(row.id),
    propertyId: String(row.property_id),
    reference: String(row.reference),
    guestName: String(row.guest_name),
    guestEmail: (row.guest_email as string | null) ?? null,
    guestPhone: (row.guest_phone as string | null) ?? null,
    channel: row.channel as Channel,
    checkIn: String(row.check_in),
    checkOut: String(row.check_out),
    nights: nightsBetween(String(row.check_in), String(row.check_out)),
    guests: Number(row.guests),
    grossCents: Number(row.gross_cents),
    commissionBps: Number(row.commission_bps),
    netCents: Number(row.net_cents),
    rateVersion: Number(row.rate_version),
    paymentStatus: row.payment_status as PaymentStatus,
    status: row.status as BookingStatus,
    source: row.source as Booking['source'],
    notes: (row.notes as string | null) ?? null,
    version: Number(row.version),
  };
}
