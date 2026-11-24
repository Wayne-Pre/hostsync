/**
 * F-73 / F-75 — portfolio details and channel connections.
 *
 * The channel rule the original gets right and keeps: connecting WhatsApp
 * needs a business number, because a personal number is not a business line.
 */
import { query, queryOne } from './db.ts';
import { NotFoundError, ValidationError } from './errors.ts';

export const CHANNELS = ['airbnb', 'booking_com', 'vrbo', 'direct', 'whatsapp'] as const;
export type ChannelId = (typeof CHANNELS)[number];

export interface PortfolioSettings {
  name: string;
  currency: string;
  timezone: string;
  defaultManagementFeeBps: number;
  businessName: string | null;
  businessPhone: string | null;
}

export interface ChannelState {
  channel: ChannelId;
  label: string;
  connected: boolean;
  businessNumber: string | null;
}

const CHANNEL_LABEL: Record<ChannelId, string> = {
  airbnb: 'Airbnb',
  booking_com: 'Booking.com',
  vrbo: 'Vrbo',
  direct: 'Direct',
  whatsapp: 'WhatsApp',
};

export async function portfolioSettings(portfolioId: string): Promise<PortfolioSettings> {
  const row = await queryOne<{
    name: string;
    currency: string;
    timezone: string;
    default_management_fee_bps: number;
    business_name: string | null;
    business_phone: string | null;
  }>(
    `select name, currency, timezone, default_management_fee_bps, business_name, business_phone
       from portfolio where id = $1`,
    [portfolioId]
  );
  if (!row) throw new NotFoundError('portfolio');

  return {
    name: row.name,
    currency: row.currency,
    timezone: row.timezone,
    defaultManagementFeeBps: Number(row.default_management_fee_bps),
    businessName: row.business_name,
    businessPhone: row.business_phone,
  };
}

/** F-73 — five fields, each validated on its own terms. */
export async function updatePortfolioSettings(
  portfolioId: string,
  input: Record<string, unknown>
): Promise<PortfolioSettings> {
  const current = await portfolioSettings(portfolioId);

  let name = current.name;
  if (input.name !== undefined) {
    const value = String(input.name).trim();
    if (!value) throw new ValidationError('the portfolio needs a name', 'name');
    name = value;
  }

  let currency = current.currency;
  if (input.currency !== undefined) {
    const value = String(input.currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(value)) throw new ValidationError('currency must be three letters', 'currency');
    currency = value;
  }

  let timezone = current.timezone;
  if (input.timezone !== undefined) {
    const value = String(input.timezone).trim();
    if (!value) throw new ValidationError('the timezone cannot be empty', 'timezone');
    timezone = value;
  }

  let feeBps = current.defaultManagementFeeBps;
  if (input.managementFeePercent !== undefined) {
    const percent = Number(input.managementFeePercent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new ValidationError('the management fee must be between 0 and 100 %', 'managementFeePercent');
    }
    feeBps = Math.round(percent * 100);
  }

  const businessName =
    input.businessName === undefined
      ? current.businessName
      : String(input.businessName).trim() || null;
  const businessPhone =
    input.businessPhone === undefined
      ? current.businessPhone
      : String(input.businessPhone).trim() || null;

  const updated = await queryOne<{ id: string }>(
    `update portfolio
        set name = $2, currency = $3, timezone = $4, default_management_fee_bps = $5,
            business_name = $6, business_phone = $7, updated_at = now()
      where id = $1
      returning id`,
    [portfolioId, name, currency, timezone, feeBps, businessName, businessPhone]
  );
  if (!updated) throw new NotFoundError('portfolio');

  return portfolioSettings(portfolioId);
}

/**
 * Channel indicators are derived from real setup, never from a click:
 *  - Airbnb / Booking.com / Vrbo — a calendar feed with that source exists.
 *  - Direct — at least one manual stay is being tracked.
 *  - WhatsApp — a business number has been saved.
 * A checkbox alone cannot fake any of them.
 */
export async function channelStates(portfolioId: string): Promise<ChannelState[]> {
  const [feeds, manual, whatsapp] = await Promise.all([
    query<{ source: ChannelId }>(
      `select distinct cf.source
         from calendar_feed cf
         join property p on p.id = cf.property_id
        where p.portfolio_id = $1`,
      [portfolioId]
    ),
    queryOne<{ yes: boolean }>(
      `select true::boolean as yes
         from booking b join property p on p.id = b.property_id
        where p.portfolio_id = $1 and b.source = 'manual'
        limit 1`,
      [portfolioId]
    ),
    queryOne<{ business_number: string | null }>(
      `select business_number from channel_connection
        where portfolio_id = $1 and channel = 'whatsapp'`,
      [portfolioId]
    ),
  ]);

  const sources = new Set(feeds.map((feed) => feed.source));
  const whatsappNumber = whatsapp?.business_number?.trim() ? whatsapp.business_number : null;

  return CHANNELS.map((channel) => ({
    channel,
    label: CHANNEL_LABEL[channel],
    connected:
      channel === 'whatsapp'
        ? whatsappNumber !== null
        : channel === 'direct'
          ? manual !== null
          : sources.has(channel),
    businessNumber: channel === 'whatsapp' ? whatsappNumber : null,
  }));
}

/** Save the one thing a human can actually configure: the WhatsApp line. */
export async function setChannelState(
  portfolioId: string,
  channel: string,
  input: { connected: boolean; businessNumber: string | null }
): Promise<ChannelState> {
  const id = channel as ChannelId;
  if (!CHANNELS.includes(id)) {
    throw new ValidationError(`channel must be one of: ${CHANNELS.join(', ')}`, 'channel');
  }

  // WhatsApp is a business line or it is nothing.
  if (id === 'whatsapp' && !input.businessNumber?.trim()) {
    throw new ValidationError('WhatsApp needs a business number', 'businessNumber');
  }

  await query(
    `insert into channel_connection (portfolio_id, channel, connected, business_number)
     values ($1, $2, $3, $4)
     on conflict (portfolio_id, channel)
     do update set connected = excluded.connected,
                   business_number = excluded.business_number,
                   updated_at = now()`,
    [portfolioId, id, input.businessNumber?.trim() ? true : false, input.businessNumber?.trim() || null]
  );

  const state = (await channelStates(portfolioId)).find((entry) => entry.channel === id);
  if (!state) throw new Error('channel state could not be read back');
  return state;
}
