import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, getJson, sendJson } from './client.ts';
import { AuthFrame, FormError } from './auth.tsx';
import { useToast } from './toast.tsx';

/**
 * F-10 — the first screen a verified user sees.
 *
 * Without this screen a new account has no portfolio, so every dashboard API
 * legitimately refuses to load data. Creating the workspace here is what makes
 * an empty (but working) dashboard possible, and it means data entered later
 * survives a sign-out and sign-in because it lives in Postgres, not the browser.
 */
export function Onboarding() {
  const toast = useToast();
  const [ready, setReady] = useState(false);
  const [name, setName] = useState('My Portfolio');
  const [currency, setCurrency] = useState('KES');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await getJson('/api/portfolio');
        if (!cancelled) window.location.assign('/dashboard');
      } catch (caught) {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.status === 401) {
          window.location.assign('/login');
          return;
        }
        // 409/404 means signed in but no workspace yet — show the form.
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sendJson('POST', '/onboarding', {
        portfolioName: name.trim(),
        currency,
        displayName: displayName.trim() || null,
      });
      toast('Workspace ready');
      window.location.assign('/dashboard');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create your workspace');
    } finally {
      setBusy(false);
    }
  }

  if (!ready) {
    return (
      <div className="auth">
        <p className="loading">Preparing your workspace…</p>
      </div>
    );
  }

  return (
    <AuthFrame
      title="Set up your workspace"
      subtitle="Give your portfolio a name. You can change it any time in Settings."
      footer={
        <>
          Already set up? <a href="/dashboard">Go to overview</a>
        </>
      }
    >
      <form onSubmit={submit} className="form" data-testid="onboarding-form" noValidate>
        <div className="field">
          <label htmlFor="onboarding-name">Portfolio name</label>
          <input
            id="onboarding-name"
            data-testid="onboarding-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="onboarding-currency">Currency</label>
          <select
            id="onboarding-currency"
            data-testid="onboarding-currency"
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
          >
            <option value="KES">KES — Kenyan shilling</option>
            <option value="USD">USD — US dollar</option>
            <option value="EUR">EUR — Euro</option>
            <option value="GBP">GBP — British pound</option>
            <option value="ZAR">ZAR — South African rand</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="onboarding-display-name">Your name (optional)</label>
          <input
            id="onboarding-display-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            autoComplete="name"
          />
        </div>
        <FormError message={error} />
        <button className="btn btn-primary btn-block" type="submit" disabled={busy} data-testid="onboarding-submit">
          {busy ? 'Creating…' : 'Create workspace'}
        </button>
      </form>
    </AuthFrame>
  );
}
