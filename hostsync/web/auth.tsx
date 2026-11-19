import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, sendJson } from './client.ts';
import { useToast } from './toast.tsx';

/**
 * F-05 / F-06 / F-07 / F-08 as screens.
 *
 * The API already proves the rules; these forms only collect the input and show
 * the server's answer. Every field has a real <label>, and every failure lands
 * in a live region rather than a floating tooltip.
 */

export function AuthFrame({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="auth">
      <a className="brand" href="/">
        <img className="brand-mark" src="/assets/logo.jpeg" alt="" aria-hidden="true" />
        HostSync
      </a>
      <div className="auth-card">
        <h1>{title}</h1>
        <p className="auth-sub">{subtitle}</p>
        {children}
      </div>
      <p className="auth-foot">{footer}</p>
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  return (
    <p className="alert" role="alert" aria-live="assertive" data-testid="form-error">
      {message ?? ''}
    </p>
  );
}

export function Login() {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sendJson('POST', '/auth/login', { email, password });
      toast('Signed in');
      window.location.assign('/dashboard');
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : 'Could not sign you in';
      setError(
        caught instanceof ApiError && caught.status === 403
          ? 'Verify your email first — we sent you a code.'
          : message
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame
      title="Sign in"
      subtitle="Your portfolio, calendar and ledger."
      footer={
        <>
          New here? <a href="/register">Create account</a>
        </>
      }
    >
      <form onSubmit={submit} className="form" noValidate>
        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <FormError message={error} />
        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <a className="link-quiet" href="/forgot-password">
          Forgot your password?
        </a>
      </form>
    </AuthFrame>
  );
}

export function Register() {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sendJson('POST', '/auth/register', { email, password, displayName });
      window.location.assign(`/verify?email=${encodeURIComponent(email)}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create the account');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame
      title="Create account"
      subtitle="One workspace, every property you manage."
      footer={
        <>
          Already have an account? <a href="/login">Sign in</a>
        </>
      }
    >
      <form onSubmit={submit} className="form" noValidate>
        <div className="field">
          <label htmlFor="register-name">Your name</label>
          <input
            id="register-name"
            name="displayName"
            autoComplete="name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="register-email">Email</label>
          <input
            id="register-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="register-password">Password</label>
          <input
            id="register-password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <small className="hint">At least 12 characters.</small>
        </div>
        <FormError message={error} />
        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
    </AuthFrame>
  );
}

export function Verify() {
  const toast = useToast();
  const params = new URLSearchParams(window.location.search);
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sendJson('POST', '/auth/verify', { email, code });
      toast('Email verified');
      window.location.assign('/onboarding');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That code did not work');
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setError(null);
    try {
      await sendJson('POST', '/auth/verify/resend', { email });
      setResent(true);
      toast('A new code is on its way');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not resend the code');
    }
  }

  return (
    <AuthFrame
      title="Verify your email"
      subtitle="We sent a six-digit code. It expires in ten minutes."
      footer={
        <>
          Wrong address? <a href="/register">Start again</a>
        </>
      }
    >
      <form onSubmit={submit} className="form" noValidate>
        <div className="field">
          <label htmlFor="verify-email">Email</label>
          <input
            id="verify-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="verify-code">Six-digit code</label>
          <input
            id="verify-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            required
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        <FormError message={error} />
        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? 'Checking…' : 'Verify email'}
        </button>
        <button type="button" className="btn btn-ghost btn-block" onClick={resend}>
          {resent ? 'Send another code' : 'Resend code'}
        </button>
      </form>
    </AuthFrame>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await sendJson('POST', '/auth/password/forgot', { email });
      setSent(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not send the link');
    }
  }

  return (
    <AuthFrame
      title="Reset password"
      subtitle="We will email a link that works once, for thirty minutes."
      footer={
        <>
          Remembered it? <a href="/login">Sign in</a>
        </>
      }
    >
      <form onSubmit={submit} className="form" noValidate>
        <div className="field">
          <label htmlFor="forgot-email">Email</label>
          <input
            id="forgot-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <FormError message={error} />
        <button className="btn btn-primary btn-block" type="submit">
          Send reset link
        </button>
        {sent ? (
          <p className="notice" role="status" data-testid="reset-sent">
            If that address has an account, the link is on its way.
          </p>
        ) : null}
      </form>
    </AuthFrame>
  );
}

export function ResetPassword() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const token = new URLSearchParams(window.location.search).get('token') ?? '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await sendJson('POST', '/auth/password/reset', { token, password });
      setDone(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reset the password');
    }
  }

  return (
    <AuthFrame
      title="Choose a new password"
      subtitle="Signing in again revokes every older session."
      footer={
        <>
          <a href="/login">Back to sign in</a>
        </>
      }
    >
      {done ? (
        <p className="notice" role="status">
          Password changed. <a href="/login">Sign in</a>
        </p>
      ) : (
        <form onSubmit={submit} className="form" noValidate>
          <div className="field">
            <label htmlFor="reset-password">New password</label>
            <input
              id="reset-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <FormError message={error} />
          <button className="btn btn-primary btn-block" type="submit">
            Set password
          </button>
        </form>
      )}
    </AuthFrame>
  );
}
