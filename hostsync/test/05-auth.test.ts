/**
 * T-05 .. T-10 — auth, OTP, sessions, reset, guard, onboarding.
 * These run through real HTTP requests (Fastify inject) so cookie and
 * redirect behaviour is exercised, not simulated.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp, SESSION_COOKIE } from '../src/app.ts';
import { closePool, pool } from '../src/db.ts';
import { createCaptureTransport } from '../src/mail.ts';
import type { MailMessage } from '../src/mail.ts';

const mailer = createCaptureTransport();
let app: FastifyInstance;
const createdEmails: string[] = [];
let seq = 0;

const PASSWORD = 'correct-horse-battery';

function freshEmail(label: string): string {
  seq += 1;
  const email = `test-${label}-${Date.now()}-${seq}@example.test`;
  createdEmails.push(email);
  return email;
}

function lastMailTo(email: string): MailMessage {
  const messages = mailer.outbox.filter((message) => message.to === email);
  const last = messages[messages.length - 1];
  if (!last) throw new Error(`no mail was sent to ${email}`);
  return last;
}

function codeFrom(message: MailMessage): string {
  const match = /\b(\d{6})\b/.exec(message.text);
  if (!match?.[1]) throw new Error(`no 6-digit code in: ${message.text}`);
  return match[1];
}

function tokenFrom(message: MailMessage): string {
  const match = /token=([A-Za-z0-9_-]{20,})/.exec(message.text);
  if (!match?.[1]) throw new Error(`no reset token in: ${message.text}`);
  return match[1];
}

function sessionCookieOf(response: {
  cookies: Array<{ name: string; value: string }>;
}): string | null {
  const cookieValue = response.cookies.find((cookie) => cookie.name === SESSION_COOKIE);
  return cookieValue ? `${SESSION_COOKIE}=${cookieValue.value}` : null;
}

async function register(email: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: PASSWORD, displayName: 'Test Owner' },
  });
  assert.equal(response.statusCode, 201, response.body);
}

async function registerAndVerify(email: string): Promise<string> {
  await register(email);
  const code = codeFrom(lastMailTo(email));
  const response = await app.inject({
    method: 'POST',
    url: '/auth/verify',
    payload: { email, code },
  });
  assert.equal(response.statusCode, 200, response.body);
  const cookie = sessionCookieOf(response);
  assert.ok(cookie, 'verification must issue a session');
  return cookie;
}

before(async () => {
  app = buildApp({ mailer });
  await app.ready();
});

after(async () => {
  await app.close();
  if (createdEmails.length > 0) {
    // Sessions, codes, resets and portfolios all cascade from the user row.
    await pool.query('delete from app_user where email = any($1::text[])', [createdEmails]);
  }
  await closePool();
});

test('T-05 register: 201, unverified user row, exactly one code dispatched', async () => {
  const email = freshEmail('register');
  mailer.clear();

  const response = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: PASSWORD, displayName: 'Amina' },
  });

  assert.equal(response.statusCode, 201);
  const body = response.json() as { user: { email: string; isVerified: boolean }; otpSent: boolean };
  assert.equal(body.otpSent, true);
  assert.equal(body.user.email, email);
  assert.equal(body.user.isVerified, false, 'no account is verified at registration');
  assert.equal(response.headers['set-cookie'], undefined, 'registering must not sign you in');

  const row = await pool.query<{ is_verified: boolean; password_hash: string }>(
    'select is_verified, password_hash from app_user where email = $1',
    [email]
  );
  assert.equal(row.rows[0]?.is_verified, false);
  assert.match(row.rows[0]?.password_hash ?? '', /^\$argon2id\$/);
  assert.equal(row.rows[0]?.password_hash.includes(PASSWORD), false);

  const sent = mailer.outbox.filter((message) => message.to === email);
  assert.equal(sent.length, 1, 'exactly one code per registration');
  assert.match(codeFrom(sent[0] as MailMessage), /^\d{6}$/);

  // The code itself is never stored in clear text.
  const stored = await pool.query<{ code_hash: Buffer }>(
    `select o.code_hash from otp_code o join app_user u on u.id = o.user_id where u.email = $1`,
    [email]
  );
  assert.ok(stored.rows[0]);
  assert.equal(stored.rows[0]?.code_hash.includes(Buffer.from(codeFrom(sent[0] as MailMessage))), false);
});

test('T-05 duplicate email is refused, and a weak password never reaches the database', async () => {
  const email = freshEmail('duplicate');
  await register(email);

  const again = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email: email.toUpperCase(), password: PASSWORD },
  });
  assert.equal(again.statusCode, 409);

  const weak = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email: freshEmail('weak'), password: 'short' },
  });
  assert.equal(weak.statusCode, 422);
  assert.equal((weak.json() as { field?: string }).field, 'password');
});

test('T-06 OTP: wrong code sets no cookie, right code verifies, resend invalidates the old one', async () => {
  const email = freshEmail('otp');
  await register(email);
  const first = codeFrom(lastMailTo(email));

  const wrong = await app.inject({
    method: 'POST',
    url: '/auth/verify',
    payload: { email, code: first === '000000' ? '111111' : '000000' },
  });
  assert.equal(wrong.statusCode, 422);
  assert.equal(sessionCookieOf(wrong), null, 'a failed code must not issue a session');

  // Resend, then fetch a code that is definitely different from the first.
  let replacement = first;
  for (let attempt = 0; attempt < 3 && replacement === first; attempt += 1) {
    const resend = await app.inject({
      method: 'POST',
      url: '/auth/verify/resend',
      payload: { email },
    });
    assert.equal(resend.statusCode, 202);
    replacement = codeFrom(lastMailTo(email));
  }
  assert.notEqual(replacement, first);

  const stale = await app.inject({
    method: 'POST',
    url: '/auth/verify',
    payload: { email, code: first },
  });
  assert.equal(stale.statusCode, 422, 'the previous code must stop working after a resend');

  const good = await app.inject({
    method: 'POST',
    url: '/auth/verify',
    payload: { email, code: replacement },
  });
  assert.equal(good.statusCode, 200, good.body);
  const cookie = sessionCookieOf(good);
  assert.ok(cookie);

  const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal((me.json() as { user: { isVerified: boolean } }).user.isVerified, true);

  // A code is single-use.
  const reuse = await app.inject({
    method: 'POST',
    url: '/auth/verify',
    payload: { email, code: replacement },
  });
  assert.equal(reuse.statusCode, 422);
});

test('T-07 login: correct password sets an httpOnly cookie, wrong password sets nothing', async () => {
  const email = freshEmail('login');
  await registerAndVerify(email);

  const wrong = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: 'definitely-not-the-password' },
  });
  assert.equal(wrong.statusCode, 422);
  assert.equal(sessionCookieOf(wrong), null);
  assert.equal(wrong.body.includes('hs_session'), false, 'no token may leak into a body');

  const right = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  assert.equal(right.statusCode, 200, right.body);

  const header = String(right.headers['set-cookie']);
  assert.match(header, /HttpOnly/i);
  assert.match(header, /SameSite=Lax/i);
  assert.equal(JSON.stringify(right.json()).includes(PASSWORD), false);

  const cookie = sessionCookieOf(right);
  assert.ok(cookie);
  const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
  assert.equal(me.statusCode, 200);
});

test('T-07 an unverified account cannot sign in', async () => {
  const email = freshEmail('unverified');
  await register(email);

  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  assert.equal(response.statusCode, 403);
  assert.equal((response.json() as { error: string }).error, 'email_not_verified');
  assert.equal(sessionCookieOf(response), null);
});

test('T-08 reset: token arrives by mail, changes the password once, and kills old sessions', async () => {
  const email = freshEmail('reset');
  const originalCookie = await registerAndVerify(email);

  await pool.query('update app_user set force_password_reset = true where email = $1', [email]);

  const forgot = await app.inject({
    method: 'POST',
    url: '/auth/password/forgot',
    payload: { email },
  });
  assert.equal(forgot.statusCode, 202);

  const unknown = await app.inject({
    method: 'POST',
    url: '/auth/password/forgot',
    payload: { email: freshEmail('unknown') },
  });
  assert.equal(unknown.statusCode, 202, 'unknown addresses must look identical');

  const token = tokenFrom(lastMailTo(email));
  const newPassword = 'a-brand-new-passphrase';

  const reset = await app.inject({
    method: 'POST',
    url: '/auth/password/reset',
    payload: { token, password: newPassword },
  });
  assert.equal(reset.statusCode, 204, reset.body);

  const reuse = await app.inject({
    method: 'POST',
    url: '/auth/password/reset',
    payload: { token, password: 'another-passphrase-here' },
  });
  assert.equal(reuse.statusCode, 422, 'a reset token is single-use');

  const oldPassword = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  assert.equal(oldPassword.statusCode, 422);

  const newLogin = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: newPassword },
  });
  assert.equal(newLogin.statusCode, 200, newLogin.body);

  const cleared = await pool.query<{ force_password_reset: boolean }>(
    'select force_password_reset from app_user where email = $1',
    [email]
  );
  assert.equal(cleared.rows[0]?.force_password_reset, false);

  const revoked = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { cookie: originalCookie },
  });
  assert.equal(revoked.statusCode, 401, 'a password change must end existing sessions');
});

test('T-09 guard: /dashboard redirects anonymous visitors; logout kills the cookie', async () => {
  const anonymous = await app.inject({ method: 'GET', url: '/dashboard' });
  assert.equal(anonymous.statusCode, 302);
  assert.equal(anonymous.headers.location, '/login');

  const email = freshEmail('guard');
  const cookie = await registerAndVerify(email);

  // A verified account still needs a workspace before any app screen loads.
  const needsWorkspace = await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } });
  assert.equal(needsWorkspace.statusCode, 302);
  assert.equal(needsWorkspace.headers.location, '/onboarding');

  const onboarded = await app.inject({
    method: 'POST',
    url: '/onboarding',
    headers: { cookie },
    payload: { portfolioName: 'Guard Portfolio' },
  });
  assert.equal(onboarded.statusCode, 200, onboarded.body);

  const allowed = await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } });
  assert.equal(allowed.statusCode, 200);
  assert.match(String(allowed.headers['content-type']), /text\/html/);
  // The signed-in visitor gets the app shell, not a JSON stub.
  assert.match(allowed.body, /<div id="root">/);
  assert.equal(allowed.body.includes('"screen"'), false);

  const logout = await app.inject({
    method: 'POST',
    url: '/auth/logout',
    headers: { cookie },
  });
  assert.equal(logout.statusCode, 204);

  const afterLogout = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { cookie },
  });
  assert.equal(afterLogout.statusCode, 401, 'the token must be dead server-side, not just unset');

  const guardedAgain = await app.inject({
    method: 'GET',
    url: '/dashboard',
    headers: { cookie },
  });
  assert.equal(guardedAgain.statusCode, 302);
});

test('T-10 onboarding: portfolio persisted with name and currency, flag set', async () => {
  const email = freshEmail('onboarding');
  const cookie = await registerAndVerify(email);

  const anonymous = await app.inject({
    method: 'POST',
    url: '/onboarding',
    payload: { portfolioName: 'Nope' },
  });
  assert.equal(anonymous.statusCode, 401);

  const response = await app.inject({
    method: 'POST',
    url: '/onboarding',
    headers: { cookie },
    payload: { portfolioName: 'TEST', displayName: 'kefaswayne' },
  });
  assert.equal(response.statusCode, 200, response.body);

  const body = response.json() as {
    user: { onboardingComplete: boolean; displayName: string };
    portfolio: { id: string; name: string; currency: string };
  };
  assert.equal(body.portfolio.name, 'TEST');
  assert.equal(body.portfolio.currency, 'KES');
  assert.equal(body.user.onboardingComplete, true);
  assert.equal(body.user.displayName, 'kefaswayne');

  const row = await pool.query<{ name: string; currency: string; owner_id: string }>(
    'select name, currency, owner_id from portfolio where id = $1',
    [body.portfolio.id]
  );
  assert.equal(row.rows[0]?.name, 'TEST');
  assert.equal(row.rows[0]?.currency, 'KES');
  assert.ok(row.rows[0]?.owner_id);

  // Submitting again updates the same portfolio instead of creating a second one.
  const second = await app.inject({
    method: 'POST',
    url: '/onboarding',
    headers: { cookie },
    payload: { portfolioName: 'TEST PORTFOLIO' },
  });
  assert.equal(second.statusCode, 200);
  assert.equal(
    (second.json() as { portfolio: { id: string } }).portfolio.id,
    body.portfolio.id
  );

  const count = await pool.query<{ count: number }>(
    'select count(*)::int as count from portfolio where owner_id = $1',
    [row.rows[0]?.owner_id]
  );
  assert.equal(count.rows[0]?.count, 1);
});
