const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const MS_PER_DAY = 86_400_000;

/**
 * A calendar date, not an instant. Stays are compared as half-open date ranges,
 * so a guest checking out on the 15th frees the 15th for the next arrival.
 */
export function isISODate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  const start = Date.parse(`${checkIn}T00:00:00.000Z`);
  const end = Date.parse(`${checkOut}T00:00:00.000Z`);
  return Math.round((end - start) / MS_PER_DAY);
}

export function addDays(isoDate: string, days: number): string {
  const start = Date.parse(`${isoDate}T00:00:00.000Z`);
  return new Date(start + days * MS_PER_DAY).toISOString().slice(0, 10);
}

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Inclusive day count used by occupancy-style metrics. */
export function daysBetweenInclusive(from: string, to: string): number {
  return nightsBetween(from, to) + 1;
}
