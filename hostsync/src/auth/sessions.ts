import { query, queryOne } from '../db.ts';
import { randomToken, sha256 } from './tokens.ts';

export const SESSION_TTL_DAYS = 30;

export type AccountRole = 'owner' | 'cleaner';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  isVerified: boolean;
  onboardingComplete: boolean;
  forcePasswordReset: boolean;
  disabled: boolean;
  accountRole: AccountRole;
}

interface SessionRow {
  session_id: string;
  expires_at: Date;
  user_id: string;
  email: string;
  display_name: string | null;
  is_verified: boolean;
  onboarding_complete: boolean;
  force_password_reset: boolean;
  disabled: boolean;
  account_role: AccountRole;
}

export interface Session {
  id: string;
  token: string;
  expiresAt: Date;
}

/**
 * The cookie carries an opaque random token; the table carries only its hash.
 * Revoking a session is therefore a single UPDATE, not a token race.
 */
export async function createSession(userId: string, userAgent?: string): Promise<Session> {
  const token = randomToken(32);
  const row = await queryOne<{ id: string; expires_at: Date }>(
    `insert into session (user_id, token_hash, expires_at, user_agent)
     values ($1, $2, now() + ($3 || ' days')::interval, $4)
     returning id, expires_at`,
    [userId, sha256(token), String(SESSION_TTL_DAYS), userAgent ?? null]
  );
  if (!row) throw new Error('session insert returned no row');
  return { id: row.id, token, expiresAt: row.expires_at };
}

export interface AuthenticatedSession {
  sessionId: string;
  user: SessionUser;
}

export async function findSession(token: string): Promise<AuthenticatedSession | null> {
  if (!token) return null;
  const row = await queryOne<SessionRow>(
    `select s.id as session_id, s.expires_at,
            u.id as user_id, u.email, u.display_name, u.is_verified,
            u.onboarding_complete, u.force_password_reset, u.disabled,
            u.account_role
       from session s
       join app_user u on u.id = s.user_id
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()`,
    [sha256(token)]
  );
  if (!row) return null;
  if (row.disabled) return null;

  // Cheap liveness trail; not awaited so auth latency stays flat.
  void query('update session set last_seen_at = now() where id = $1', [row.session_id]).catch(
    () => {}
  );

  return {
    sessionId: row.session_id,
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      isVerified: row.is_verified,
      onboardingComplete: row.onboarding_complete,
      forcePasswordReset: row.force_password_reset,
      disabled: row.disabled,
      accountRole: row.account_role ?? 'owner',
    },
  };
}

export async function revokeSession(token: string): Promise<void> {
  await query(
    `update session set revoked_at = now()
      where token_hash = $1 and revoked_at is null`,
    [sha256(token)]
  );
}

export async function revokeAllSessions(userId: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `update session set revoked_at = now()
      where user_id = $1 and revoked_at is null
      returning id`,
    [userId]
  );
  return rows.length;
}
