/**
 * Minimal, strict RFC 5545 reader — only what a channel calendar feed needs.
 *
 * The original app accepted any page that happened to be pasted and only
 * complained at render time. Here the text is checked before anything is
 * written: it must be a VCALENDAR, and every VEVENT must carry a usable range.
 */
export class IcsFormatError extends Error {
  readonly code = 'not_ical';
  constructor(message = "That page isn't an iCal (.ics) feed") {
    super(message);
    this.name = 'IcsFormatError';
  }
}

export class IcsTooLargeError extends Error {
  readonly code = 'too_large';
  constructor(message = 'That calendar is too large to import') {
    super(message);
    this.name = 'IcsTooLargeError';
  }
}

export interface IcsEvent {
  uid: string;
  summary: string;
  /** YYYY-MM-DD, inclusive */
  start: string;
  /** YYYY-MM-DD, exclusive — iCal DTEND is always exclusive */
  end: string;
  cancelled: boolean;
  /** A channel's "not available" block rather than a paying guest. */
  blocked: boolean;
  sequence: number;
}

export const MAX_ICS_BYTES = 2 * 1024 * 1024;

const BLOCKED_PATTERN = /not available|blocked|closed|unavailable/i;

function unfold(raw: string): string[] {
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseDate(value: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const iso = `${year}-${month}-${day}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

function addDays(iso: string, days: number): string {
  const start = Date.parse(`${iso}T00:00:00.000Z`);
  return new Date(start + days * 86_400_000).toISOString().slice(0, 10);
}

function parseDuration(value: string): number | null {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/i.exec(value.trim());
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  if (days === 0 && hours === 0 && minutes === 0) return null;
  return days + Math.ceil((hours * 60 + minutes) / (24 * 60));
}

interface Fields {
  [key: string]: string;
}

function readFields(lines: string[]): Fields {
  const fields: Fields = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const rawName = line.slice(0, colon);
    const name = rawName.split(';')[0]?.toUpperCase() ?? '';
    if (!name) continue;
    fields[name] = line.slice(colon + 1);
  }
  return fields;
}

export function parseIcs(raw: string): IcsEvent[] {
  if (Buffer.byteLength(raw, 'utf8') > MAX_ICS_BYTES) throw new IcsTooLargeError();

  const lines = unfold(raw.trim());
  if (!lines.some((line) => line.trim().toUpperCase() === 'BEGIN:VCALENDAR')) {
    throw new IcsFormatError();
  }

  const events: IcsEvent[] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const upper = trimmed.toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      current = [];
      continue;
    }
    if (upper === 'END:VEVENT') {
      if (current) {
        const event = toEvent(readFields(current), events.length);
        if (event) events.push(event);
      }
      current = null;
      continue;
    }
    if (current) current.push(trimmed);
  }

  if (events.length === 0 && /BEGIN:VEVENT/i.test(raw)) {
    throw new IcsFormatError('That calendar has no usable events');
  }

  return events;
}

function toEvent(fields: Fields, index: number): IcsEvent | null {
  const start = fields.DTSTART ? parseDate(fields.DTSTART) : null;
  if (!start) return null;

  let end = fields.DTEND ? parseDate(fields.DTEND) : null;
  if (!end && fields.DURATION) {
    const nights = parseDuration(fields.DURATION);
    if (nights !== null) end = addDays(start, nights);
  }
  if (!end) end = addDays(start, 1);

  // A zero-length or inverted range cannot hold a night.
  if (end <= start) return null;

  const summary = (fields.SUMMARY ?? '').trim();
  const cancelled = (fields.STATUS ?? '').toUpperCase() === 'CANCELLED';

  return {
    uid: (fields.UID ?? `event-${index}@import`).trim(),
    summary,
    start,
    end,
    cancelled,
    blocked: !cancelled && (summary.length === 0 || BLOCKED_PATTERN.test(summary)),
    sequence: Number(fields.SEQUENCE ?? 0) || 0,
  };
}
