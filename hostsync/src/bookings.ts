import {
  EXCLUSION_VIOLATION,
  isPostgresError,
  query,
  queryOne,
  withTransaction,
} from './db.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import { priceStay, isChannel } from './pricing.ts';
import type { Channel, PriceBreakdown } from './pricing.ts';
import { getProperty } from './properties.ts';
import { cancelTurnover, scheduleTurnover } from './operations.ts';
import { optionalEmail, optionalString, requireString, validateStay } from './validation.ts';

export const BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const PAYMENT_STATUSES = ['paid', 'unpaid', 'partial'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const BOOKING_SOURCES = ['import', 'manual', 'direct_site'] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];

export interface Booking {
  id: string;
  propertyId: string;
  reference: string;
  guestName: string;
  guestEmail: string | null;
  guestPhone: string | null;
  channel: Channel;
  checkIn: string;
  checkOut: string;
  nights: number;
  guests: number;
  grossCents: number;
  commissionBps: number;
  netCents: number;
  rateVersion: number;
  paymentStatus: PaymentStatus;
  status: BookingStatus;
  source: BookingSource;
  notes: string | null;
  version: number;
}

interface BookingRow {
  id: string;
  property_id: string;
  reference: string;
  guest_name: string;
  guest_email: string | null;
  guest_phone: string | null;
  channel: Channel;
  check_in: string;
  check_out: string;
  guests: number;
  gross_cents: number;
  commission_bps: number;
  net_cents: number;
  rate_version: number;
  payment_status: PaymentStatus;
  status: BookingStatus;
  source: BookingSource;
  notes: string | null;
  version: number;
}

const COLUMNS = `
  id, property_id, reference, guest_name, guest_email, guest_phone, channel,
  lower(stay)::text as check_in, upper(stay)::text as check_out,
  guests, gross_cents, commission_bps, net_cents, rate_version,
  payment_status, status, source, notes, version
`;

function mapBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    propertyId: row.property_id,
    reference: row.reference,
    guestName: row.guest_name,
    guestEmail: row.guest_email,
    guestPhone: row.guest_phone,
    channel: row.channel,
    checkIn: row.check_in,
    checkOut: row.check_out,
    nights: daysBetween(row.check_in, row.check_out),
    guests: row.guests,
    grossCents: row.gross_cents,
    commissionBps: row.commission_bps,
    netCents: row.net_cents,
    rateVersion: row.rate_version,
    paymentStatus: row.payment_status,
    status: row.status,
    source: row.source,
    notes: row.notes,
    version: row.version,
  };
}

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((end - start) / 86_400_000);
}

export interface Overlap {
  id: string;
  reference: string;
  guestName: string;
  checkIn: string;
  checkOut: string;
  status: BookingStatus;
}

export interface OverlapQuery {
  propertyId: string;
  checkIn: string;
  checkOut: string;
  excludeBookingId?: string | null;
  /** pending rows do not hold nights; include them when previewing an entry form */
  includePending?: boolean;
}

/**
 * Half-open range overlap: a checkout on the 15th does not collide with a
 * check-in on the 15th. This is the same predicate the constraint uses.
 */
export async function findOverlaps(input: OverlapQuery): Promise<Overlap[]> {
  const statuses = input.includePending === false
    ? ['confirmed', 'completed']
    : ['pending', 'confirmed', 'completed'];

  const rows = await query<{
    id: string;
    reference: string;
    guest_name: string;
    check_in: string;
    check_out: string;
    status: BookingStatus;
  }>(
    `select id, reference, guest_name,
            lower(stay)::text as check_in, upper(stay)::text as check_out, status
       from booking
      where property_id = $1
        and status = any($4::text[])
        and stay && daterange($2::date, $3::date, '[)')
        and ($5::uuid is null or id <> $5::uuid)
      order by lower(stay)`,
    [input.propertyId, input.checkIn, input.checkOut, statuses, input.excludeBookingId ?? null]
  );

  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    guestName: row.guest_name,
    checkIn: row.check_in,
    checkOut: row.check_out,
    status: row.status,
  }));
}

function describeOverlaps(overlaps: Overlap[]): string {
  const first = overlaps[0];
  if (!first) return 'those nights are already held';
  const more = overlaps.length > 1 ? ` (+${overlaps.length - 1} more)` : '';
  return `${first.guestName} · ${first.checkIn} → ${first.checkOut}${more}`;
}

export interface CreateBookingInput {
  propertyId: string;
  guestName: string;
  guestEmail?: string | null;
  guestPhone?: string | null;
  channel: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  paymentStatus?: PaymentStatus;
  status?: Extract<BookingStatus, 'pending' | 'confirmed'>;
  source?: BookingSource;
  notes?: string | null;
  /** injected for deterministic tests */
  today?: string;
}

export interface CreateBookingResult {
  booking: Booking;
  price: PriceBreakdown;
}

export async function createBooking(input: CreateBookingInput): Promise<Booking> {
  const property = await getProperty(input.propertyId);
  const guestName = requireString(input.guestName, 'guestName', 160);

  if (!isChannel(input.channel)) {
    throw new ValidationError(`channel must be one of: ${['airbnb', 'booking_com', 'vrbo', 'direct', 'whatsapp'].join(', ')}`, 'channel');
  }

  const source: BookingSource = input.source ?? 'manual';

  const stay = validateStay(
    { checkIn: input.checkIn, checkOut: input.checkOut, guests: input.guests },
    {
      capacity: property.guests,
      allowPast: source === 'import',
      ...(input.today === undefined ? {} : { today: input.today }),
    }
  );

  // Price is derived here, from the property — never accepted from the caller.
  const price = priceStay({
    nights: stay.nights,
    nightlyRateCents: property.nightlyRateCents,
    cleaningFeeCents: property.cleaningFeeCents,
    channel: input.channel,
  });

  const status: 'pending' | 'confirmed' = input.status ?? (source === 'import' ? 'pending' : 'confirmed');
  const paymentStatus: PaymentStatus = input.paymentStatus ?? 'unpaid';

  // Manual/direct entry is refused outright when the nights are *held* (§2.4 layer 1).
  // Only confirmed/completed nights are held — a pending import does not block a real
  // guest, otherwise a stale import could squat the calendar indefinitely.
  // Imported stays are still allowed to land as pending so the conflict can be
  // resolved in the UI rather than silently rejected.
  if (status === 'confirmed') {
    const overlaps = await findOverlaps({
      propertyId: property.id,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      includePending: false,
    });
    if (overlaps.length > 0) {
      throw new ConflictError(
        `This stay overlaps an existing booking — ${describeOverlaps(overlaps)}. ` +
          `Those nights are already held, so a second guest cannot take them.`
      );
    }
  }

  const prefix = source === 'import' ? 'MRD' : 'HS';
  const seq = await queryOne<{ n: number }>(`select nextval('booking_ref_seq') as n`);
  const reference = `${prefix}-${seq?.n ?? 0}`;

  try {
    const booking = await withTransaction(async (client) => {
      const inserted = await client.query<BookingRow>(
        `insert into booking (
           property_id, reference, guest_name, guest_email, guest_phone, channel,
           stay, guests, gross_cents, commission_bps, net_cents, rate_version,
           payment_status, status, source, notes
         ) values (
           $1, $2, $3, $4, $5, $6,
           daterange($7::date, $8::date, '[)'), $9, $10, $11, $12, $13,
           $14, $15, $16, $17
         )
         returning ${COLUMNS}`,
        [
          property.id,
          reference,
          guestName,
          optionalEmail(input.guestEmail, 'guestEmail'),
          optionalString(input.guestPhone, 'guestPhone', 40),
          input.channel,
          stay.checkIn,
          stay.checkOut,
          stay.guests,
          price.grossCents,
          price.commissionBps,
          price.netCents,
          price.rateVersion,
          paymentStatus,
          status,
          source,
          optionalString(input.notes, 'notes', 2000),
        ]
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('booking insert returned no row');
      const mapped = mapBooking(row);
      // A confirmed arrival brings its own turnover (F-46) — in the same
      // transaction, so a booking never exists without the work it implies.
      await scheduleTurnover(client, mapped);
      return mapped;
    });
    return booking;
  } catch (error) {
    if (isPostgresError(error, EXCLUSION_VIOLATION)) {
      const overlaps = await findOverlaps({
        propertyId: property.id,
        checkIn: stay.checkIn,
        checkOut: stay.checkOut,
      });
      throw new ConflictError(
        `This stay overlaps an existing booking — ${describeOverlaps(overlaps)}. ` +
          `Those nights are already held, so a second guest cannot take them.`
      );
    }
    throw error;
  }
}

export async function getBooking(id: string): Promise<Booking> {
  const row = await queryOne<BookingRow>(`select ${COLUMNS} from booking where id = $1`, [id]);
  if (!row) throw new NotFoundError('booking');
  return mapBooking(row);
}

/**
 * Confirmation is where exclusivity is enforced for imported stays.
 * The UPDATE below is what the exclusion constraint actually checks.
 */
export async function confirmBooking(id: string): Promise<Booking> {
  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query<BookingRow>(
        `select ${COLUMNS} from booking where id = $1 for update`,
        [id]
      );
      const current = rows[0];
      if (!current) throw new NotFoundError('booking');

      if (current.status === 'cancelled') {
        throw new ConflictError('a cancelled booking cannot be confirmed');
      }
      if (current.status === 'confirmed' || current.status === 'completed') {
        return mapBooking(current); // idempotent
      }

      const updated = await client.query<BookingRow>(
        `update booking
            set status = 'confirmed', version = version + 1
          where id = $1
          returning ${COLUMNS}`,
        [id]
      );
      const row = updated.rows[0];
      if (!row) throw new NotFoundError('booking');
      const booking = mapBooking(row);
      // Confirming an imported stay schedules the turnover it implies (F-46).
      await scheduleTurnover(client, booking);
      return booking;
    });
  } catch (error) {
    if (isPostgresError(error, EXCLUSION_VIOLATION)) {
      const booking = await getBooking(id);
      const overlaps = await findOverlaps({
        propertyId: booking.propertyId,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        excludeBookingId: booking.id,
      });
      throw new ConflictError(
        `Two guests cannot hold the same nights — ${describeOverlaps(overlaps)}. ` +
          `Resolve the overlap before this stay is confirmed.`
      );
    }
    throw error;
  }
}

export async function cancelBooking(id: string): Promise<Booking> {
  const booking = await withTransaction(async (client) => {
    const updated = await client.query<BookingRow>(
      `update booking
        set status = 'cancelled', version = version + 1
      where id = $1
        and status in ('pending', 'confirmed')
      returning ${COLUMNS}`,
      [id]
    );
    const row = updated.rows[0];
    if (!row) return null;
    // The turnover for a cancelled stay is cancelled with it — explicitly, so
    // the board stops asking for work nobody needs (F-46).
    await cancelTurnover(client, id);
    return mapBooking(row);
  });

  if (booking) return booking;

  const existing = await getBooking(id);
  if (existing.status === 'cancelled') return existing;
  throw new ConflictError(`a ${existing.status} booking cannot be cancelled`);
}

export interface ListBookingsQuery {
  propertyId?: string;
  status?: BookingStatus;
  channel?: Channel;
  limit?: number;
  cursor?: string | null;
}

export async function listBookings(input: ListBookingsQuery = {}): Promise<Booking[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const rows = await query<BookingRow>(
    `select ${COLUMNS} from booking
      where ($1::uuid is null or property_id = $1::uuid)
        and ($2::text is null or status = $2::text)
        and ($3::text is null or channel = $3::text)
        and ($4::text is null or reference > $4::text)
      order by reference
      limit $5`,
    [
      input.propertyId ?? null,
      input.status ?? null,
      input.channel ?? null,
      input.cursor ?? null,
      limit,
    ]
  );
  return rows.map(mapBooking);
}
