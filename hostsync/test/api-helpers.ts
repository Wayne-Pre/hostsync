import type { FastifyInstance } from 'fastify';
import { pool } from '../src/db.ts';
import type { MailTransport } from '../src/mail.ts';
import { SESSION_COOKIE } from '../src/app.ts';

export interface ApiUser {
  email: string;
  cookie: string;
  userId: string;
  portfolioId: string;
}

type CaptureTransport = MailTransport & {
  outbox: Array<{ to: string; subject: string; text: string }>;
};

const PASSWORD = 'correct-horse-battery';
/** The password every API-created user has; exported for the browser tests. */
export const TEST_PASSWORD = PASSWORD;
let counter = 0;

function uniqueEmail(label: string): string {
  counter += 1;
  return `api-${label}-${Date.now()}-${counter}@example.test`;
}

function cookieOf(response: { cookies: Array<{ name: string; value: string }> }): string {
  const cookie = response.cookies.find((entry) => entry.name === SESSION_COOKIE);
  if (!cookie) throw new Error('expected a session cookie');
  return `${SESSION_COOKIE}=${cookie.value}`;
}

export async function signUp(
  app: FastifyInstance,
  mailer: CaptureTransport,
  portfolioName = 'TEST'
): Promise<ApiUser> {
  const email = uniqueEmail('user');

  const registered = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: PASSWORD, displayName: 'Test Owner' },
  });
  if (registered.statusCode !== 201) throw new Error(registered.body);

  const message = mailer.outbox.filter((entry) => entry.to === email).at(-1);
  const code = message ? /\b(\d{6})\b/.exec(message.text)?.[1] : undefined;
  if (!code) throw new Error('no verification code was sent');

  const verified = await app.inject({
    method: 'POST',
    url: '/auth/verify',
    payload: { email, code },
  });
  if (verified.statusCode !== 200) throw new Error(verified.body);
  const cookie = cookieOf(verified);

  const onboarded = await app.inject({
    method: 'POST',
    url: '/onboarding',
    headers: { cookie },
    payload: { portfolioName },
  });
  if (onboarded.statusCode !== 200) throw new Error(onboarded.body);

  const body = onboarded.json() as {
    user: { id: string };
    portfolio: { id: string };
  };

  return { email, cookie, userId: body.user.id, portfolioId: body.portfolio.id };
}

export async function createProperty(
  app: FastifyInstance,
  user: ApiUser,
  overrides: Record<string, unknown> = {}
): Promise<{ id: string; name: string; nightlyRateCents: number }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/properties',
    headers: { cookie: user.cookie },
    payload: {
      name: 'Karen Cottage',
      status: 'live',
      type: 'cottage',
      neighbourhood: 'Karen',
      city: 'Nairobi',
      bedrooms: 2,
      baths: 2,
      guests: 4,
      nightlyRateCents: 1_500_000,
      cleaningFeeCents: 300_000,
      managementFeePercent: 15,
      ownerName: 'David Mwangi',
      ownerEmail: 'd.mwangi@outlook.com',
      channels: ['airbnb', 'booking_com'],
      ...overrides,
    },
  });
  if (response.statusCode !== 201) throw new Error(response.body);
  return (response.json() as { property: { id: string; name: string; nightlyRateCents: number } })
    .property;
}

export async function createBooking(
  app: FastifyInstance,
  user: ApiUser,
  payload: Record<string, unknown>
): Promise<{ id: string; reference: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/bookings',
    headers: { cookie: user.cookie },
    payload,
  });
  if (response.statusCode !== 201) throw new Error(response.body);
  return (response.json() as { booking: { id: string; reference: string } }).booking;
}

export async function deleteUser(email: string): Promise<void> {
  // The ledger is append-only (migration 011). Account erasure is the one
  // caller allowed to remove rows, and it says so explicitly in the session.
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("set local hostsync.ledger_purge = 'on'");
    await client.query(
      `delete from booking
        where property_id in (
          select p.id from property p
            join portfolio pf on pf.id = p.portfolio_id
            join app_user u on u.id = pf.owner_id
           where u.email = $1
        )`,
      [email]
    );
    await client.query('delete from app_user where email = $1', [email]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
