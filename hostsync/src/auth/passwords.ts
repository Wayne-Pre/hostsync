import { hash, verify } from '@node-rs/argon2';
import { ValidationError } from '../errors.ts';

/**
 * argon2id, OWASP baseline (19 MiB, t=2, p=1).
 * The original stored nothing locally at all; this is the replacement for a
 * localStorage token (§6.1 "Auth").
 */
export const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

export function assertPasswordAcceptable(password: unknown): string {
  if (typeof password !== 'string') {
    throw new ValidationError('password is required', 'password');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(
      `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      'password'
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new ValidationError(
      `password must be at most ${MAX_PASSWORD_LENGTH} characters`,
      'password'
    );
  }
  return password;
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // A malformed stored hash must read as "wrong password", never as a crash.
    return false;
  }
}
