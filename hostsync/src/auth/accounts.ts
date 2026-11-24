import { query, queryOne, withTransaction } from '../db.ts';
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from '../errors.ts';
import type { MailTransport } from '../mail.ts';
import { assertPasswordAcceptable, hashPassword, verifyPassword } from './passwords.ts';
import { issueOtp, recordAttempt, verifyOtp } from './otp.ts';
import { revokeAllSessions } from './sessions.ts';
import { normalizeEmail, randomToken, sha256 } from './tokens.ts';

const RESET_TTL_MINUTES = 30;
const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_MAX_FAILURES = 10;

export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
  isVerified: boolean;
  onboardingComplete: boolean;
  forcePasswordReset: boolean;
  accountRole: 'owner' | 'cleaner';
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  is_verified: boolean;
  onboarding_complete: boolean;
  force_password_reset: boolean;
  disabled: boolean;
  account_role?: 'owner' | 'cleaner';
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isVerified: row.is_verified,
    onboardingComplete: row.onboarding_complete,
    forcePasswordReset: row.force_password_reset,
    accountRole: row.account_role ?? 'owner',
  };
}

function requireEmail(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError('email is required', 'email');
  }
  const email = normalizeEmail(value);
  if (email.length > 320 || !EMAIL.test(email)) {
    throw new ValidationError('email is not a valid address', 'email');
  }
  return email;
}

async function findUserByEmail(email: string): Promise<UserRow | null> {
  return queryOne<UserRow>(
    `select id, email, password_hash, display_name, is_verified,
            onboarding_complete, force_password_reset, disabled, account_role
       from app_user where lower(email) = lower($1)`,
    [email]
  );
}

export async function getUserById(id: string): Promise<UserRow> {
  const row = await queryOne<UserRow>(
    `select id, email, password_hash, display_name, is_verified,
            onboarding_complete, force_password_reset, disabled, account_role
       from app_user where id = $1`,
    [id]
  );
  if (!row) throw new NotFoundError('user');
  return row;
}

export function toPublicUser(row: UserRow): PublicUser {
  return publicUser(row);
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName?: string | null;
}

export interface RegisterResult {
  user: PublicUser;
  /** The code is returned only by the capture transport; never by the HTTP route. */
  otpSent: true;
}

/**
 * F-05 + F-06. Registration always lands unverified and always mails exactly
 * one code, so "is_verified" can never be true without a delivered challenge.
 */
export async function registerUser(
  input: RegisterInput,
  mailer: MailTransport
): Promise<RegisterResult> {
  const email = requireEmail(input.email);
  const password = assertPasswordAcceptable(input.password);

  const existing = await findUserByEmail(email);
  if (existing) {
    throw new ConflictError('an account with this email already exists — sign in instead');
  }

  const passwordHash = await hashPassword(password);
  const displayName =
    typeof input.displayName === 'string' && input.displayName.trim().length > 0
      ? input.displayName.trim().slice(0, 120)
      : null;

  let row: UserRow | null = null;
  try {
    row = await queryOne<UserRow>(
      `insert into app_user (email, password_hash, display_name)
       values ($1, $2, $3)
       returning id, email, password_hash, display_name, is_verified,
                 onboarding_complete, force_password_reset, disabled, account_role`,
      [email, passwordHash, displayName]
    );
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === '23505'
    ) {
      throw new ConflictError('an account with this email already exists — sign in instead');
    }
    throw error;
  }
  if (!row) throw new Error('user insert returned no row');

  const otp = await issueOtp(row.id, 'verify_email');
  await mailer.send({
    to: email,
    subject: `HostSync verification code: ${otp.code}`,
    text:
      `Your HostSync verification code is ${otp.code}.\n\n` +
      `It expires in 10 minutes and can be used once. ` +
      `If you did not create this account, ignore this message.`,
  });

  return { user: publicUser(row), otpSent: true };
}

/** F-06. A correct code verifies the account; the route then issues a session. */
export async function verifyEmail(emailInput: unknown, code: unknown): Promise<PublicUser> {
  const email = requireEmail(emailInput);
  const user = await findUserByEmail(email);
  if (!user) throw new ValidationError('this code is not valid', 'code');

  const result = await verifyOtp(user.id, 'verify_email', String(code ?? ''));
  await recordAttempt(email, 'otp', result.ok);

  if (!result.ok) {
    if (result.failure === 'too_many_attempts') {
      throw new ValidationError('too many incorrect codes — request a new one', 'code');
    }
    if (result.failure === 'expired') {
      throw new ValidationError('this code has expired — request a new one', 'code');
    }
    throw new ValidationError('this code is not valid', 'code');
  }

  const updated = await queryOne<UserRow>(
    `update app_user set is_verified = true
      where id = $1
      returning id, email, password_hash, display_name, is_verified,
                onboarding_complete, force_password_reset, disabled, account_role`,
    [user.id]
  );
  if (!updated) throw new NotFoundError('user');
  return publicUser(updated);
}

export async function resendVerification(emailInput: unknown, mailer: MailTransport): Promise<void> {
  const email = requireEmail(emailInput);
  const user = await findUserByEmail(email);
  // No account enumeration: an unknown address gets the same 202 and no mail.
  if (!user || user.is_verified) return;

  const otp = await issueOtp(user.id, 'verify_email');
  await mailer.send({
    to: email,
    subject: `HostSync verification code: ${otp.code}`,
    text:
      `Your new HostSync verification code is ${otp.code}.\n\n` +
      `The previous code no longer works. It expires in 10 minutes.`,
  });
}

async function failuresInWindow(email: string): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `select count(*)::int as count from auth_attempt
      where lower(email) = lower($1) and kind = 'login' and succeeded = false
        and created_at > now() - ($2 || ' minutes')::interval`,
    [email, String(LOGIN_WINDOW_MINUTES)]
  );
  return row?.count ?? 0;
}

/** F-07. Wrong credentials are indistinguishable from an unknown account. */
export async function authenticate(emailInput: unknown, password: unknown): Promise<UserRow> {
  const email = requireEmail(emailInput);
  if (typeof password !== 'string' || password.length === 0) {
    throw new ValidationError('password is required', 'password');
  }

  const failures = await failuresInWindow(email);
  if (failures >= LOGIN_MAX_FAILURES) {
    throw new RateLimitError('too many failed attempts — try again in a few minutes');
  }

  const user = await findUserByEmail(email);
  const ok = user ? await verifyPassword(user.password_hash, password) : false;

  await recordAttempt(email, 'login', ok);

  if (!user || !ok) {
    throw new ValidationError('email or password is incorrect', 'password');
  }
  if (user.disabled) {
    throw new ForbiddenError('this account is disabled', 'disabled');
  }
  if (!user.is_verified) {
    throw new ForbiddenError('verify your email before signing in', 'email_not_verified');
  }
  return user;
}

export async function logoutAllSessions(userId: string): Promise<void> {
  await revokeAllSessions(userId);
}

/**
 * F-08. Request always resolves the same way — whether or not the address is
 * registered — so the endpoint cannot be used to enumerate accounts.
 */
export async function requestPasswordReset(
  emailInput: unknown,
  mailer: MailTransport
): Promise<void> {
  const email = requireEmail(emailInput).trim();
  if (!EMAIL.test(email)) return;

  const user = await findUserByEmail(email);
  if (!user) return;

  const token = randomToken(32);
  await query(
    `insert into password_reset (user_id, token_hash, expires_at)
     values ($1, $2, now() + ($3 || ' minutes')::interval)`,
    [user.id, sha256(token), String(RESET_TTL_MINUTES)]
  );
  await mailer.send({
    to: email,
    subject: 'Reset your HostSync password',
    text:
      `Use this link to choose a new password (valid for ${RESET_TTL_MINUTES} minutes, one use):\n\n` +
      `/reset-password?token=${token}\n\n` +
      `If you did not ask for this, no action is needed.`,
  });
}

interface ResetRow {
  id: string;
  user_id: string;
  expires_at: Date;
  consumed_at: Date | null;
}

/** F-08. A used, expired or unknown token is refused; sessions die with the change. */
export async function resetPassword(tokenInput: unknown, passwordInput: unknown): Promise<void> {
  if (typeof tokenInput !== 'string' || tokenInput.length < 20) {
    throw new ValidationError('this reset link is not valid', 'token');
  }
  const password = assertPasswordAcceptable(passwordInput);

  const row = await queryOne<ResetRow>(
    `select id, user_id, expires_at, consumed_at from password_reset where token_hash = $1`,
    [sha256(tokenInput)]
  );
  if (!row || row.consumed_at !== null || row.expires_at.getTime() <= Date.now()) {
    throw new ValidationError('this reset link is invalid or has expired', 'token');
  }

  const passwordHash = await hashPassword(password);
  const consumed = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `update password_reset set consumed_at = now()
        where id = $1 and consumed_at is null
        returning id`,
      [row.id]
    );
    if (!rows[0]) return false;
    await client.query(
      `update app_user
          set password_hash = $2, force_password_reset = false
        where id = $1`,
      [row.user_id, passwordHash]
    );
    return true;
  });

  if (!consumed) throw new ValidationError('this reset link is invalid or has expired', 'token');
  await revokeAllSessions(row.user_id);
}

export interface OnboardingInput {
  portfolioName: string;
  displayName?: string | null;
  currency?: string;
}

export interface OnboardingResult {
  user: PublicUser;
  portfolio: { id: string; name: string; currency: string };
}

/** F-10. Creates the workspace the header pill reads (`TEST · 5 PROPERTIES`). */
export async function completeOnboarding(
  userId: string,
  input: OnboardingInput
): Promise<OnboardingResult> {
  const name = typeof input.portfolioName === 'string' ? input.portfolioName.trim() : '';
  if (name.length === 0) throw new ValidationError('portfolio name is required', 'portfolioName');
  if (name.length > 120) throw new ValidationError('portfolio name is too long', 'portfolioName');

  const currency = (input.currency ?? 'KES').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ValidationError('currency must be a 3-letter code', 'currency');
  }

  const displayName =
    typeof input.displayName === 'string' && input.displayName.trim().length > 0
      ? input.displayName.trim().slice(0, 120)
      : null;

  const result = await withTransaction(async (client) => {
    const existing = await client.query<{ id: string }>(
      'select id from portfolio where owner_id = $1 order by created_at limit 1',
      [userId]
    );

    let portfolio: { id: string; name: string; currency: string };
    if (existing.rows[0]) {
      const updated = await client.query<{ id: string; name: string; currency: string }>(
        `update portfolio set name = $2, currency = $3 where id = $1
         returning id, name, currency`,
        [existing.rows[0].id, name, currency]
      );
      portfolio = updated.rows[0] as { id: string; name: string; currency: string };
    } else {
      const inserted = await client.query<{ id: string; name: string; currency: string }>(
        `insert into portfolio (name, currency, owner_id) values ($1, $2, $3)
         returning id, name, currency`,
        [name, currency, userId]
      );
      portfolio = inserted.rows[0] as { id: string; name: string; currency: string };
    }

    const userRow = await client.query<UserRow>(
      `update app_user
          set onboarding_complete = true,
              display_name = coalesce($2, display_name)
        where id = $1
        returning id, email, password_hash, display_name, is_verified,
                  onboarding_complete, force_password_reset, disabled, account_role`,
      [userId, displayName]
    );
    const row = userRow.rows[0];
    if (!row) throw new NotFoundError('user');

    return { user: publicUser(row), portfolio };
  });

  return result;
}
