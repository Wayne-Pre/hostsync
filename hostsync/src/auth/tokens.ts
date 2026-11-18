import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Nothing that grants access is ever stored in clear text. A session token is
 * 32 random bytes; the database only ever sees its SHA-256. A one-time code is
 * 6 digits (that is what the product shows), so it is additionally keyed with a
 * server secret — a stolen table cannot be brute-forced offline in seconds.
 */
const SECRET =
  process.env.AUTH_SECRET ?? 'hostsync-dev-secret-change-me-in-production';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function hmac(value: string): Buffer {
  return createHmac('sha256', SECRET).update(value, 'utf8').digest();
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 6 digits, uniformly distributed, no modulo bias. */
export function randomOtp(): string {
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

export function otpHash(userId: string, purpose: string, code: string): Buffer {
  return hmac(`${userId}:${purpose}:${code}`);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
