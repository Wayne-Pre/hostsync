/**
 * Landing-page content (F-01 / F-02).
 *
 * It lives in one module so the test can assert *this* text renders — the copy
 * is a product decision, not something to be re-typed inside a component.
 */

export interface FeatureCopy {
  id: string;
  title: string;
  body: string;
}

/** The eight explainer cards of F-02, in the order the original shows them. */
export const FEATURES: readonly FeatureCopy[] = [
  {
    id: 'property-hub',
    title: 'Property hub',
    body: 'Rate, layout, channel mix, settling account and next arrival for every property on one card that never disagrees with the ledger.',
  },
  {
    id: 'calendar',
    title: 'One calendar',
    body: 'Twenty-one days across the whole portfolio. A confirmed stay physically cannot share a night with another one.',
  },
  {
    id: 'turnovers',
    title: 'Turnovers',
    body: 'Every confirmed arrival schedules its cleaning window with a checklist, an assignee and a due time — not a note in someone’s phone.',
  },
  {
    id: 'inbox',
    title: 'Guest inbox',
    body: 'Every channel’s messages in one thread per stay, with replies recorded against the booking they belong to.',
  },
  {
    id: 'reviews',
    title: 'Reviews',
    body: 'Ratings, response rate and review requests, so a good stay turns into the next booking instead of a missed follow-up.',
  },
  {
    id: 'financials',
    title: 'Financials',
    body: 'Credits, expenses and net income per property, with posted money separated from what is only expected.',
  },
  {
    id: 'statements',
    title: 'Owner statements',
    body: 'Gross, expenses and management fee reconciled to the shilling, snapshotted at the rate that applied when the stay happened.',
  },
  {
    id: 'sync-health',
    title: 'Sync health',
    body: 'Which calendars are live, which are stale and which failed — with the last successful check, never a silent stale feed.',
  },
];

export const STEPS: readonly { title: string; body: string }[] = [
  {
    title: 'Add the property',
    body: 'Rate, cleaning fee, owner and the accounts that settle it. Two minutes, no spreadsheet.',
  },
  {
    title: 'Point it at your channels',
    body: 'Paste each iCal link once. HostSync holds the nights and refuses a double booking at the database.',
  },
  {
    title: 'Work the week',
    body: 'Turndays, guests, reviews and money are already attached to the stays on the grid.',
  },
];

export const STATS: readonly { value: string; label: string }[] = [
  { value: '1 grid', label: 'every property' },
  { value: '0 double bookings', label: 'enforced by the database' },
  { value: '3 ways in', label: 'import, manual, direct' },
];
