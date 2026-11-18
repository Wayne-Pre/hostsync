import { query, queryOne } from './db.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import {
  optionalEmail,
  optionalPhotoKey,
  optionalString,
  requireIntInRange,
  requireString,
} from './validation.ts';

export const PROPERTY_TYPES = [
  'apartment',
  'house',
  'cottage',
  'villa',
  'studio',
  'penthouse',
  'other',
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const PROPERTY_STATUSES = ['onboarding', 'live', 'archived'] as const;
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number];

export interface Property {
  id: string;
  portfolioId: string;
  name: string;
  status: PropertyStatus;
  type: PropertyType | null;
  neighbourhood: string | null;
  city: string | null;
  address: string | null;
  bedrooms: number | null;
  baths: number | null;
  guests: number | null;
  nightlyRateCents: number;
  cleaningFeeCents: number;
  managementFeeBps: number | null;
  ownerName: string | null;
  ownerEmail: string | null;
  photoKey: string | null;
  currency: string;
  timezone: string;
  checkinTime: string;
  checkoutTime: string;
}

interface PropertyRow {
  id: string;
  portfolio_id: string;
  name: string;
  status: PropertyStatus;
  type: PropertyType | null;
  neighbourhood: string | null;
  city: string | null;
  address: string | null;
  bedrooms: number | null;
  baths: number | null;
  guests: number | null;
  nightly_rate_cents: number;
  cleaning_fee_cents: number;
  management_fee_bps: number | null;
  owner_name: string | null;
  owner_email: string | null;
  photo_key: string | null;
  currency: string;
  timezone: string;
  checkin_time: string;
  checkout_time: string;
}

const COLUMNS = `
  id, portfolio_id, name, status, type, neighbourhood, city, address,
  bedrooms, baths, guests, nightly_rate_cents, cleaning_fee_cents,
  management_fee_bps, owner_name, owner_email, photo_key, currency,
  timezone, to_char(checkin_time, 'HH24:MI') as checkin_time,
  to_char(checkout_time, 'HH24:MI') as checkout_time
`;

function mapProperty(row: PropertyRow): Property {
  return {
    id: row.id,
    portfolioId: row.portfolio_id,
    name: row.name,
    status: row.status,
    type: row.type,
    neighbourhood: row.neighbourhood,
    city: row.city,
    address: row.address,
    bedrooms: row.bedrooms,
    baths: row.baths,
    guests: row.guests,
    nightlyRateCents: row.nightly_rate_cents,
    cleaningFeeCents: row.cleaning_fee_cents,
    managementFeeBps: row.management_fee_bps,
    ownerName: row.owner_name,
    ownerEmail: row.owner_email,
    photoKey: row.photo_key,
    currency: row.currency,
    timezone: row.timezone,
    checkinTime: row.checkin_time,
    checkoutTime: row.checkout_time,
  };
}

export interface CreatePropertyInput {
  portfolioId: string;
  name: string;
  status?: PropertyStatus;
  type?: string | null;
  neighbourhood?: string | null;
  city?: string | null;
  address?: string | null;
  bedrooms?: number | null;
  baths?: number | null;
  guests?: number | null;
  nightlyRateCents: number;
  cleaningFeeCents?: number;
  managementFeeBps?: number | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
  photoKey?: string | null;
  timezone?: string;
  checkinTime?: string;
  checkoutTime?: string;
}

function validatePropertyType(type: unknown): PropertyType | null {
  if (type === undefined || type === null || type === '') return null;
  if (typeof type !== 'string' || !(PROPERTY_TYPES as readonly string[]).includes(type)) {
    throw new ValidationError(
      `type must be one of: ${PROPERTY_TYPES.join(', ')}`,
      'type'
    );
  }
  return type as PropertyType;
}

function validateTime(value: unknown, field: string, fallback: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new ValidationError(`${field} must be HH:MM`, field);
  }
  return value;
}

function validateNonNegativeInt(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  return requireIntInRange(value, field, 0, 1000);
}

export async function createProperty(input: CreatePropertyInput): Promise<Property> {
  const name = requireString(input.name, 'name', 120);

  if (typeof input.nightlyRateCents !== 'number' || !Number.isInteger(input.nightlyRateCents)) {
    throw new ValidationError('nightlyRateCents must be a whole number of cents', 'nightlyRateCents');
  }
  if (input.nightlyRateCents <= 0) {
    throw new ValidationError('nightly rate must be greater than zero', 'nightlyRateCents');
  }

  const cleaningFeeCents = input.cleaningFeeCents ?? 0;
  if (!Number.isInteger(cleaningFeeCents) || cleaningFeeCents < 0) {
    throw new ValidationError('cleaning fee cannot be negative', 'cleaningFeeCents');
  }

  let managementFeeBps: number | null = null;
  if (input.managementFeeBps !== undefined && input.managementFeeBps !== null) {
    managementFeeBps = requireIntInRange(input.managementFeeBps, 'managementFeeBps', 0, 10_000);
  }

  const guests = input.guests === undefined || input.guests === null
    ? null
    : requireIntInRange(input.guests, 'guests', 1, 100);
  const bedrooms = validateNonNegativeInt(input.bedrooms, 'bedrooms');
  const baths = validateNonNegativeInt(input.baths, 'baths');

  const row = await queryOne<PropertyRow>(
    `insert into property (
       portfolio_id, name, status, type, neighbourhood, city, address,
       bedrooms, baths, guests, nightly_rate_cents, cleaning_fee_cents,
       management_fee_bps, owner_name, owner_email, photo_key,
       timezone, checkin_time, checkout_time
     ) values (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12,
       $13, $14, $15, $16,
       $17, $18::time, $19::time
     )
     returning ${COLUMNS}`,
    [
      input.portfolioId,
      name,
      input.status ?? 'onboarding',
      validatePropertyType(input.type),
      optionalString(input.neighbourhood, 'neighbourhood', 120),
      optionalString(input.city, 'city', 120),
      optionalString(input.address, 'address', 300),
      bedrooms,
      baths,
      guests,
      input.nightlyRateCents,
      cleaningFeeCents,
      managementFeeBps,
      optionalString(input.ownerName, 'ownerName', 120),
      optionalEmail(input.ownerEmail, 'ownerEmail'),
      optionalPhotoKey(input.photoKey),
      optionalString(input.timezone, 'timezone', 64) ?? 'Africa/Nairobi',
      validateTime(input.checkinTime, 'checkinTime', '15:00'),
      validateTime(input.checkoutTime, 'checkoutTime', '11:00'),
    ]
  );

  if (!row) throw new Error('property insert returned no row');
  return mapProperty(row);
}

export type UpdatePropertyInput = Partial<Omit<CreatePropertyInput, 'portfolioId'>>;

export async function updateProperty(id: string, patch: UpdatePropertyInput): Promise<Property> {
  const current = await getProperty(id);

  const fields: string[] = [];
  const values: unknown[] = [];
  const push = (column: string, value: unknown) => {
    values.push(value);
    fields.push(`${column} = $${values.length}`);
  };

  if (patch.name !== undefined) push('name', requireString(patch.name, 'name', 120));

  if (patch.status !== undefined) {
    if (!(PROPERTY_STATUSES as readonly string[]).includes(patch.status)) {
      throw new ValidationError('status must be onboarding, live or archived', 'status');
    }
    push('status', patch.status);
  }

  if (patch.type !== undefined) push('type', validatePropertyType(patch.type));

  if (patch.nightlyRateCents !== undefined) {
    if (!Number.isInteger(patch.nightlyRateCents) || patch.nightlyRateCents <= 0) {
      throw new ValidationError('nightly rate must be greater than zero', 'nightlyRateCents');
    }
    push('nightly_rate_cents', patch.nightlyRateCents);
  }

  if (patch.cleaningFeeCents !== undefined) {
    if (!Number.isInteger(patch.cleaningFeeCents) || patch.cleaningFeeCents < 0) {
      throw new ValidationError('cleaning fee cannot be negative', 'cleaningFeeCents');
    }
    push('cleaning_fee_cents', patch.cleaningFeeCents);
  }

  if (patch.managementFeeBps !== undefined) {
    push(
      'management_fee_bps',
      patch.managementFeeBps === null
        ? null
        : requireIntInRange(patch.managementFeeBps, 'managementFeeBps', 0, 10_000)
    );
  }

  if (patch.guests !== undefined) {
    push('guests', patch.guests === null ? null : requireIntInRange(patch.guests, 'guests', 1, 100));
  }
  if (patch.bedrooms !== undefined) push('bedrooms', validateNonNegativeInt(patch.bedrooms, 'bedrooms'));
  if (patch.baths !== undefined) push('baths', validateNonNegativeInt(patch.baths, 'baths'));

  if (patch.neighbourhood !== undefined) {
    push('neighbourhood', optionalString(patch.neighbourhood, 'neighbourhood', 120));
  }
  if (patch.city !== undefined) push('city', optionalString(patch.city, 'city', 120));
  if (patch.address !== undefined) push('address', optionalString(patch.address, 'address', 300));
  if (patch.ownerName !== undefined) {
    push('owner_name', optionalString(patch.ownerName, 'ownerName', 120));
  }
  if (patch.ownerEmail !== undefined) {
    push('owner_email', optionalEmail(patch.ownerEmail, 'ownerEmail'));
  }
  if (patch.photoKey !== undefined) push('photo_key', optionalPhotoKey(patch.photoKey));
  if (patch.timezone !== undefined) {
    push('timezone', optionalString(patch.timezone, 'timezone', 64) ?? current.timezone);
  }
  if (patch.checkinTime !== undefined) {
    push('checkin_time', validateTime(patch.checkinTime, 'checkinTime', current.checkinTime));
  }
  if (patch.checkoutTime !== undefined) {
    push('checkout_time', validateTime(patch.checkoutTime, 'checkoutTime', current.checkoutTime));
  }

  if (fields.length === 0) return current;

  values.push(id);
  const row = await queryOne<PropertyRow>(
    `update property set ${fields.join(', ')}
      where id = $${values.length} and deleted_at is null
      returning ${COLUMNS}`,
    values
  );
  if (!row) throw new NotFoundError('property');
  return mapProperty(row);
}

export async function getProperty(id: string): Promise<Property> {
  const row = await queryOne<PropertyRow>(
    `select ${COLUMNS} from property where id = $1 and deleted_at is null`,
    [id]
  );
  if (!row) throw new NotFoundError('property');
  return mapProperty(row);
}

export interface ListPropertiesOptions {
  /** the archive is a view of its own; the default list is the active portfolio */
  includeArchived?: boolean;
}

export async function listProperties(
  portfolioId: string,
  options: ListPropertiesOptions = {}
): Promise<Property[]> {
  const rows = await query<PropertyRow>(
    `select ${COLUMNS} from property
      where portfolio_id = $1 and deleted_at is null
        and ($2::boolean or status <> 'archived')
      order by name`,
    [portfolioId, options.includeArchived === true]
  );
  return rows.map(mapProperty);
}

/**
 * Soft delete only. A property with live bookings cannot be archived at all —
 * it would orphan a statement line later (§6.1 "Deletion").
 */
export async function archiveProperty(id: string): Promise<Property> {
  const blocking = await queryOne<{ count: number }>(
    `select count(*)::int as count from booking
      where property_id = $1
        and status in ('pending', 'confirmed')
        and upper(stay) >= current_date`,
    [id]
  );
  if (blocking && blocking.count > 0) {
    throw new ConflictError(
      `cannot archive: ${blocking.count} upcoming booking(s) still reference this property`
    );
  }
  return updateProperty(id, { status: 'archived' });
}
