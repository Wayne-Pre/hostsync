/**
 * The pricing rule, ported from the running product and verified against
 * 20 of 20 live bookings (spec §2.1, §2.2).
 *
 *   gross = nights × nightly_rate + cleaning_fee
 *   net   = gross − round(gross × commission_bps / 10000)
 *
 * A booking stores the result plus PRICING_VERSION, so editing a property's
 * rate or this table never rewrites history.
 */
export const PRICING_VERSION = 1;

export const CHANNELS = ['airbnb', 'booking_com', 'vrbo', 'direct', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Basis points. 1500 = 15 %. */
export const COMMISSION_BPS: Readonly<Record<Channel, number>> = Object.freeze({
  airbnb: 1500,
  booking_com: 1500,
  vrbo: 800,
  direct: 0,
  whatsapp: 0,
});

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}

export function commissionBpsFor(channel: Channel): number {
  const bps = COMMISSION_BPS[channel];
  if (typeof bps !== 'number') throw new RangeError(`unknown channel: ${channel}`);
  return bps;
}

export interface PriceInput {
  nights: number;
  nightlyRateCents: number;
  cleaningFeeCents: number;
  channel: Channel;
}

export interface PriceBreakdown {
  nights: number;
  nightlyRateCents: number;
  cleaningFeeCents: number;
  grossCents: number;
  commissionBps: number;
  commissionCents: number;
  netCents: number;
  rateVersion: number;
}

function requireInteger(value: unknown, name: string, { min = 0 } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RangeError(`${name} must be an integer`);
  }
  if (value < min) throw new RangeError(`${name} must be >= ${min}`);
  return value;
}

export function priceStay(input: PriceInput): PriceBreakdown {
  const nights = requireInteger(input.nights, 'nights', { min: 1 });
  const nightlyRateCents = requireInteger(input.nightlyRateCents, 'nightlyRateCents', { min: 1 });
  const cleaningFeeCents = requireInteger(input.cleaningFeeCents, 'cleaningFeeCents', { min: 0 });

  if (!isChannel(input.channel)) throw new RangeError(`unknown channel: ${String(input.channel)}`);

  const commissionBps = commissionBpsFor(input.channel);
  const grossCents = nights * nightlyRateCents + cleaningFeeCents;
  const commissionCents = Math.round((grossCents * commissionBps) / 10_000);
  const netCents = grossCents - commissionCents;

  return {
    nights,
    nightlyRateCents,
    cleaningFeeCents,
    grossCents,
    commissionBps,
    commissionCents,
    netCents,
    rateVersion: PRICING_VERSION,
  };
}

/** Port of the form's live summary line: "2 nights · base KES 15,000 + cleaning KES 3,000". */
export function describeStay(price: PriceBreakdown, currency = 'KES'): string {
  const fmt = (cents: number) =>
    `${currency} ${(cents / 100).toLocaleString('en-KE', { maximumFractionDigits: 0 })}`;
  const plural = price.nights === 1 ? 'night' : 'nights';
  return (
    `${price.nights} ${plural} · base ${fmt(price.nightlyRateCents)}` +
    ` + cleaning ${fmt(price.cleaningFeeCents)}`
  );
}
