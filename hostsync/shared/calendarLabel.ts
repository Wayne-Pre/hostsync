/**
 * The calendar's range label — one implementation, used by the server payload
 * and by the browser header.
 *
 * It is shared because the header has to move the instant you click "Next week",
 * before the request returns. If the browser re-derived the text its own way, the
 * two could drift and the header would disagree with the grid it labels.
 */
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** `Sat 14 November – 04 Dec` — the product's existing format. */
export function rangeLabel(from: string, days: number): string {
  const start = new Date(`${from}T00:00:00.000Z`);
  const endShown = new Date(start.getTime() + (Math.max(1, days) - 1) * 86_400_000);

  const left = `${DAY_NAMES[start.getUTCDay()]} ${start.getUTCDate()} ${MONTHS[start.getUTCMonth()]}`;
  const right = `${String(endShown.getUTCDate()).padStart(2, '0')} ${MONTHS[endShown.getUTCMonth()]!.slice(0, 3)}`;
  return `${left} – ${right}`;
}
