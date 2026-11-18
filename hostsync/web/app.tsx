import { ToastProvider } from './toast.tsx';
import { AppShell } from './shell.tsx';
import { NAV } from './nav.ts';
import { Landing } from './landing.tsx';
import { ForgotPassword, Login, Register, ResetPassword, Verify } from './auth.tsx';
import { Dashboard } from './dashboard.tsx';
import { CalendarScreen } from './calendar.tsx';
import { Operations } from './operations.tsx';
import { Inbox } from './inbox.tsx';
import { Reviews } from './reviews.tsx';
import { Financials } from './financials.tsx';
import { Payouts } from './payouts.tsx';
import { SettingsScreen } from './settings.tsx';
import { Properties } from './properties.tsx';
import { Bookings } from './bookings.tsx';

/**
 * The whole router.
 *
 * Screens are real pages: every navigation is a document load the server can
 * guard, which is why F-09's redirect is enforced before any markup is sent.
 */
export function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';

  return (
    <ToastProvider>
      {path === '/' ? <Landing /> : null}
      {path === '/login' ? <Login /> : null}
      {path === '/register' ? <Register /> : null}
      {path === '/verify' ? <Verify /> : null}
      {path === '/forgot-password' ? <ForgotPassword /> : null}
      {path === '/reset-password' ? <ResetPassword /> : null}
      {isAppPage(path) ? <AppShell>{screenFor(path)}</AppShell> : null}
    </ToastProvider>
  );
}

function isAppPage(path: string): boolean {
  return NAV.some((item) => item.href === path);
}

function screenFor(path: string) {
  if (path === '/dashboard') return <Dashboard />;
  if (path === '/calendar') return <CalendarScreen />;
  if (path === '/operations') return <Operations />;
  if (path === '/inbox') return <Inbox />;
  if (path === '/reviews') return <Reviews />;
  if (path === '/financials') return <Financials />;
  if (path === '/payouts') return <Payouts />;
  if (path === '/settings') return <SettingsScreen />;
  if (path === '/properties') return <Properties />;
  if (path === '/bookings') return <Bookings />;
  return <Planned path={path} />;
}

function Planned({ path }: { path: string }) {
  const label = NAV.find((item) => item.href === path)?.label ?? 'This screen';
  return (
    <section className="empty" data-testid="planned">
      <h2>{label} does not exist</h2>
      <p>
        There is nothing at {path}. No placeholder numbers are shown here, because a screen that
        invents data is worse than one that admits it is missing.
      </p>
      <a className="btn" href="/dashboard">
        Back to overview
      </a>
    </section>
  );
}
