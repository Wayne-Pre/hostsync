/**
 * The ten sidebar destinations (F-11), in one plain module.
 *
 * It has no JSX on purpose: the E2E test imports this exact list, so the test
 * cannot drift from the navigation the browser actually renders.
 */
export interface NavItem {
  href: string;
  label: string;
}

export const NAV: readonly NavItem[] = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/bookings', label: 'Bookings' },
  { href: '/properties', label: 'Properties' },
  { href: '/operations', label: 'Operations' },
  { href: '/inbox', label: 'Inbox' },
  { href: '/reviews', label: 'Reviews' },
  { href: '/financials', label: 'Financials' },
  { href: '/payouts', label: 'Payouts' },
  { href: '/settings', label: 'Settings' },
];
