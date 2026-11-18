import { nightsBetween, isISODate, todayUTC } from './dates.ts';
import { ValidationError } from './errors.ts';

export interface StayInput {
  checkIn: string;
  checkOut: string;
  guests: number;
}

export interface StayRules {
  /** null = unknown, skip the capacity check */
  capacity: number | null;
  minNights?: number;
  maxNights?: number;
  today?: string;
  /** imported stays may legitimately be historical */
  allowPast?: boolean;
}

export interface StayValidation {
  checkIn: string;
  checkOut: string;
  guests: number;
  nights: number;
}

export const DEFAULT_MIN_NIGHTS = 1;
export const DEFAULT_MAX_NIGHTS = 90;

/**
 * The rules the original app does not enforce (§7.4 #1, #6).
 * Every one of these is a 422 before anything reaches the database.
 */
export function validateStay(input: StayInput, rules: StayRules): StayValidation {
  const { checkIn, checkOut } = input;

  if (!isISODate(checkIn)) {
    throw new ValidationError('check-in must be a valid date (YYYY-MM-DD)', 'checkIn');
  }
  if (!isISODate(checkOut)) {
    throw new ValidationError('check-out must be a valid date (YYYY-MM-DD)', 'checkOut');
  }

  const nights = nightsBetween(checkIn, checkOut);

  if (nights <= 0) {
    throw new ValidationError(
      'check-out must be after check-in — a stay cannot be zero or negative nights',
      'checkOut'
    );
  }

  const minNights = rules.minNights ?? DEFAULT_MIN_NIGHTS;
  const maxNights = rules.maxNights ?? DEFAULT_MAX_NIGHTS;
  if (nights < minNights) {
    throw new ValidationError(`a stay must be at least ${minNights} night(s)`, 'checkOut');
  }
  if (nights > maxNights) {
    throw new ValidationError(`a stay cannot exceed ${maxNights} nights`, 'checkOut');
  }

  if (!rules.allowPast) {
    const today = rules.today ?? todayUTC();
    if (checkIn < today) {
      throw new ValidationError('check-in cannot be in the past', 'checkIn');
    }
  }

  const guests = input.guests;
  if (typeof guests !== 'number' || !Number.isInteger(guests) || guests < 1) {
    throw new ValidationError('guests must be a whole number of at least 1', 'guests');
  }
  if (rules.capacity !== null && guests > rules.capacity) {
    throw new ValidationError(
      `this property sleeps ${rules.capacity}; ${guests} guests do not fit`,
      'guests'
    );
  }

  return { checkIn, checkOut, guests, nights };
}

export function requireString(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} is required`, field);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ValidationError(`${field} is too long`, field);
  return trimmed;
}

export function optionalString(value: unknown, field: string, max = 200): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text`, field);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ValidationError(`${field} is too long`, field);
  return trimmed.length === 0 ? null : trimmed;
}

export function requireIntInRange(
  value: unknown,
  field: string,
  min: number,
  max: number
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError(`${field} must be a whole number`, field);
  }
  if (value < min || value > max) {
    throw new ValidationError(`${field} must be between ${min} and ${max}`, field);
  }
  return value;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function optionalEmail(value: unknown, field: string): string | null {
  const raw = optionalString(value, field, 320);
  if (raw === null) return null;
  if (!EMAIL.test(raw)) throw new ValidationError(`${field} is not a valid email address`, field);
  return raw;
}

/**
 * Photo references are storage keys in the rebuild (presigned S3 upload), not
 * arbitrary remote URLs — the original accepted any pasted URL (§6.1).
 */
export function optionalPhotoKey(value: unknown): string | null {
  const raw = optionalString(value, 'photoKey', 512);
  if (raw === null) return null;
  if (raw.startsWith('https://')) return raw;
  if (/^[\w./-]+$/.test(raw)) return raw;
  throw new ValidationError('photoKey must be a storage key or an https URL', 'photoKey');
}
