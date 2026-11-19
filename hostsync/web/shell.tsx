import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { getJson, ApiError } from './client.ts';
import { NAV } from './nav.ts';

/**
 * F-11 / F-12 / F-13 — the persistent app shell.
 *
 * The sidebar is the only navigation: ten destinations, one of which is active.
 * Below the breakpoint it collapses into a focus-trapped drawer, which is why
 * Radix owns the dialog rather than a hand-rolled overlay.
 */

export type { NavItem } from './nav.ts';

export interface Identity {
  user: { id: string; email: string; displayName: string | null; isVerified?: boolean };
  portfolio: { id: string; name: string; currency: string };
  properties: number;
  confirmedStays: number;
}

export function displayNameOf(identity: Identity): string {
  return identity.user.displayName?.trim() || identity.user.email.split('@')[0] || 'You';
}

export function portfolioPill(identity: Identity): string {
  const count = identity.properties;
  return `${identity.portfolio.name.toUpperCase()} · ${count} ${count === 1 ? 'PROPERTY' : 'PROPERTIES'}`;
}

function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="nav" aria-label="Primary">
      {NAV.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <a
            key={item.href}
            href={item.href}
            className={`nav-item${active ? ' is-active' : ''}`}
            aria-current={active ? 'page' : undefined}
            data-nav={item.label}
            onClick={onNavigate}
          >
            <span className="nav-dot" aria-hidden="true" />
            <span>{item.label}</span>
          </a>
        );
      })}
    </nav>
  );
}

function IdentityHeader({ identity }: { identity: Identity }) {
  return (
    <div className="identity">
      <span className="pill" data-testid="portfolio-pill">
        {portfolioPill(identity)}
      </span>
      <span className="user-chip" data-testid="user-chip">
        <span className="user-avatar" aria-hidden="true">
          {displayNameOf(identity).slice(0, 1).toUpperCase()}
        </span>
        <span className="user-text">
          <strong data-testid="user-name">{displayNameOf(identity)}</strong>
          <small>Signed in</small>
        </span>
      </span>
      <form method="post" action="/auth/logout" className="logout-form">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={async () => {
            await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
            window.location.assign('/login');
          }}
        >
          Sign out
        </button>
      </form>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = window.location.pathname;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [me, portfolio] = await Promise.all([
          getJson<{ user: Identity['user'] }>('/auth/me'),
          getJson<{ portfolio: Identity['portfolio']; properties: number; confirmedStays: number }>(
            '/api/portfolio'
          ),
        ]);
        if (cancelled) return;
        setIdentity({
          user: me.user,
          portfolio: portfolio.portfolio,
          properties: portfolio.properties,
          confirmedStays: portfolio.confirmedStays,
        });
      } catch (caught) {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.status === 401) {
          window.location.assign('/login');
          return;
        }
        setError('Could not read your portfolio.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar" data-testid="sidebar">
        <a className="brand" href="/dashboard">
          <span className="brand-mark" aria-hidden="true" />
          HostSync
        </a>
        <NavLinks pathname={pathname} />
      </aside>

      <div className="main">
        <header className="topbar">
          <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
            <Dialog.Trigger asChild>
              <button type="button" className="btn btn-icon mobile-only" aria-label="Open navigation">
                <span aria-hidden="true">☰</span>
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="drawer-overlay" />
              <Dialog.Content className="drawer" aria-label="Navigation">
                <Dialog.Title className="drawer-title">Navigate</Dialog.Title>
                <Dialog.Description className="drawer-desc">
                  Every screen in the workspace.
                </Dialog.Description>
                <NavLinks pathname={pathname} onNavigate={() => setDrawerOpen(false)} />
                <Dialog.Close asChild>
                  <button type="button" className="btn btn-ghost">
                    Close
                  </button>
                </Dialog.Close>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>

          <div className="topbar-title">
            <h1>{NAV.find((item) => item.href === pathname)?.label ?? 'Overview'}</h1>
          </div>

          {identity ? <IdentityHeader identity={identity} /> : null}
        </header>

        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}

        <main className="content">{children}</main>
      </div>
    </div>
  );
}
