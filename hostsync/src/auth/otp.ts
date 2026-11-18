import { query, queryOne, withTransaction } from '../db.ts';
import { otpHash, randomOtp, safeEqual } from './tokens.ts';

export type OtpPurpose = 'verify_email' | 'reset_password';

export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;

export interface IssuedOtp {
  code: string;
  expiresAt: Date;
}

interface OtpRow {
  id: string;
  code_hash: Buffer;
  attempts: number;
  expires_at: Date;
}

/**
 * One live code per purpose. Issuing a new one consumes the previous, so a
 * "resend" cannot leave a second working key behind (T-06).
 */
export async function issueOtp(userId: string, purpose: OtpPurpose): Promise<IssuedOtp> {
  const code = randomOtp();
  return withTransaction(async (client) => {
    await client.query(
      `update otp_code set consumed_at = now()
        where user_id = $1 and purpose = $2 and consumed_at is null`,
      [userId, purpose]
    );
    const { rows } = await client.query<{ expires_at: Date }>(
      `insert into otp_code (user_id, purpose, code_hash, expires_at)
       values ($1, $2, $3, now() + ($4 || ' minutes')::interval)
       returning expires_at`,
      [userId, purpose, otpHash(userId, purpose, code), String(OTP_TTL_MINUTES)]
    );
    const row = rows[0];
    if (!row) throw new Error('otp insert returned no row');
    return { code, expiresAt: row.expires_at };
  });
}

export type OtpFailure =
  | 'no_code'
  | 'expired'
  | 'too_many_attempts'
  | 'wrong_code';

export interface OtpResult {
  ok: boolean;
  failure?: OtpFailure;
}

/**
 * Verification is a single UPDATE ... RETURNING so a burst of guesses cannot
 * all read the same attempt counter and slip past the cap.
 */
export async function verifyOtp(
  userId: string,
  purpose: OtpPurpose,
  code: string
): Promise<OtpResult> {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return { ok: false, failure: 'wrong_code' };

  return withTransaction(async (client) => {
    const { rows } = await client.query<OtpRow>(
      `select id, code_hash, attempts, expires_at
         from otp_code
        where user_id = $1 and purpose = $2 and consumed_at is null
        for update`,
      [userId, purpose]
    );
    const row = rows[0];
    if (!row) return { ok: false, failure: 'no_code' as const };

    if (row.expires_at.getTime() <= Date.now()) {
      await client.query('update otp_code set consumed_at = now() where id = $1', [row.id]);
      return { ok: false, failure: 'expired' as const };
    }

    const attempts = row.attempts + 1;
    if (attempts > OTP_MAX_ATTEMPTS) {
      await client.query(
        'update otp_code set attempts = $2, consumed_at = now() where id = $1',
        [row.id, attempts]
      );
      return { ok: false, failure: 'too_many_attempts' as const };
    }

    const matches = safeEqual(row.code_hash, otpHash(userId, purpose, code));

    await client.query(
      `update otp_code
          set attempts = $2,
              consumed_at = case when $3 then now() else consumed_at end
        where id = $1`,
      [row.id, attempts, matches]
    );

    return matches ? { ok: true } : { ok: false, failure: 'wrong_code' as const };
  });
}

/** Used by the rate limiter and by tests; counts rejected OTP attempts. */
export async function countRecentOtpFailures(email: string, minutes = 15): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `select count(*)::int as count from auth_attempt
      where lower(email) = lower($1) and kind = 'otp' and succeeded = false
        and created_at > now() - ($2 || ' minutes')::interval`,
    [email, String(minutes)]
  );
  return row?.count ?? 0;
}

export async function recordAttempt(email: string, kind: 'login' | 'otp' | 'reset', succeeded: boolean): Promise<void> {
  await query('insert into auth_attempt (email, kind, succeeded) values ($1, $2, $3)', [
    email,
    kind,
    succeeded,
  ]);
}
