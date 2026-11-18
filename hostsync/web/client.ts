/** Thin JSON client + formatters shared by every screen. */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;

  constructor(status: number, code: string, message: string, field?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const payload = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new ApiError(
      response.status,
      String(payload.error ?? 'request_failed'),
      String(payload.message ?? 'That did not work'),
      typeof payload.field === 'string' ? payload.field : undefined
    );
  }
  return payload as T;
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  return parse<T>(response);
}

export async function sendJson<T>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown
): Promise<T> {
  // A request with no body must not claim to be JSON: Fastify refuses an empty
  // body with a JSON content type ("Body cannot be empty").
  const hasBody = body !== undefined;
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    ...(hasBody
      ? {
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        }
      : { headers: { accept: 'application/json' } }),
  });
  return parse<T>(response);
}

const currencyFormatters = new Map<string, Intl.NumberFormat>();

/** Money arrives as integer minor units; the UI never invents decimals. */
export function money(cents: number, currency = 'KES'): string {
  let formatter = currencyFormatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-KE', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    });
    currencyFormatters.set(currency, formatter);
  }
  return formatter.format(Math.round(cents / 100));
}

/** `KES 55K` — the compact form the dashboard KPIs use. */
export function moneyCompact(cents: number, currency = 'KES'): string {
  const units = cents / 100;
  const compact =
    Math.abs(units) >= 1_000_000
      ? `${(units / 1_000_000).toFixed(units % 1_000_000 === 0 ? 0 : 1)}M`
      : Math.abs(units) >= 1_000
        ? `${Math.round(units / 1_000)}K`
        : `${Math.round(units)}`;
  return `${currency} ${compact}`;
}

const DAY = 86_400_000;

export function isoDate(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString().slice(0, 10);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);
}

export function nightsBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function dayLabel(iso: string): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

export function longDayLabel(iso: string): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export const CHANNELS = {
  airbnb: 'Airbnb',
  booking_com: 'Booking.com',
  vrbo: 'Vrbo',
  direct: 'Direct',
  whatsapp: 'WhatsApp',
} as const;

export type ChannelId = keyof typeof CHANNELS;

export function channelLabel(channel: string): string {
  return (CHANNELS as Record<string, string>)[channel] ?? channel;
}

export function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** "Today" / "Tomorrow" / "In 4 days" — the card's promise about the next arrival. */
export function arrivalLabel(iso: string | null, today = todayIso()): string {
  if (!iso) return '—';
  const days = nightsBetween(today, iso);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return days > 0 ? `In ${days} days` : `${-days} days ago`;
}
