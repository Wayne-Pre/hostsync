/**
 * Stage 3 upgrade (spec §6.3): the ledger is append-only.
 *
 * The database itself refuses UPDATE and DELETE. A mistake is corrected by a
 * reversing entry, never by rewriting history; classification is by category
 * so a booking reversal reduces revenue instead of inflating expenses.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { closePool, pool } from '../src/db.ts';
import { createCaptureTransport } from '../src/mail.ts';
import { addDays, todayUTC } from '../src/dates.ts';
import { createBooking, createProperty, deleteUser, signUp } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';

const mailer = createCaptureTransport();
let app: FastifyInstance;
let user: ApiUser;
let propertyId: string;
const emails: string[] = [];

async function get<T>(url: string): Promise<T> {
  const response = await app.inject({ method: 'GET', url, headers: { cookie: user.cookie } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as T;
}

async function post<T>(url: string, payload: Record<string, unknown>, expected = 200): Promise<T> {
  const response = await app.inject({
    method: 'POST',
    url,
    headers: { cookie: user.cookie },
    payload,
  });
  assert.equal(response.statusCode, expected, response.body);
  return response.json() as T;
}

interface Kpis {
  revenueCents: number;
  expensesCents: number;
  netIncomeCents: number;
  outstandingCents: number;
}

async function kpis(): Promise<Kpis> {
  return (await get<{ kpis: Kpis }>('/api/financials')).kpis;
}

async function balance(): Promise<number> {
  const data = await get<{ accounts: Array<{ propertyId: string; balanceCents: number }> }>(
    '/api/financials/accounts'
  );
  return data.accounts.find((entry) => entry.propertyId === propertyId)!.balanceCents;
}

before(async () => {
  app = buildApp({ mailer });
  await app.ready();
  user = await signUp(app, mailer, 'LEDGER');
  emails.push(user.email);

  const property = await createProperty(app, user, {
    name: 'Ledger House',
    nightlyRateCents: 1_000_000,
    cleaningFeeCents: 0,
    managementFeePercent: 0,
  });
  propertyId = property.id;

  await app.inject({
    method: 'PUT',
    url: `/api/properties/${property.id}/account`,
    headers: { cookie: user.cookie },
    payload: { label: 'KCB 9001', verified: true, balanceCents: 0 },
  });
});

after(async () => {
  await app.close();
  for (const email of emails) await deleteUser(email);
  await closePool();
});

test('the database refuses UPDATE and DELETE on the ledger', async () => {
  const result = await post<{ transaction: { id: string; amountCents: number; kind: string } }>(
    '/api/transactions/expense',
    {
      propertyId,
      date: todayUTC(),
      category: 'housekeeping',
      amountCents: 10_000,
      description: 'Linen',
    },
    201
  );
  const id = result.transaction.id;
  assert.equal(result.transaction.kind, 'debit');
  assert.equal(result.transaction.amountCents, -10_000, 'direction is carried by the sign');

  await assert.rejects(
    pool.query('update transaction set description = $2 where id = $1', [id, 'edited']),
    /append-only: UPDATE is forbidden/
  );
  await assert.rejects(
    pool.query('delete from transaction where id = $1', [id]),
    /append-only: DELETE is forbidden/
  );

  const after = await pool.query<{ description: string }>(
    'select description from transaction where id = $1',
    [id]
  );
  assert.equal(after.rows[0]?.description, 'Linen');
});

test('a payment flip appends a reversal, and the reversal nets to zero', async () => {
  const booking = await createBooking(app, user, {
    propertyId,
    guestName: 'Reversal Guest',
    channel: 'direct',
    checkIn: todayUTC(),
    checkOut: addDays(todayUTC(), 2),
    guests: 2,
  });
  const id = booking.id;
  const rows = async () =>
    pool.query<{
      id: string;
      kind: string;
      category: string;
      amount_cents: string;
      reversal_of: string | null;
      description: string;
    }>(
      `select id, kind, category, amount_cents, reversal_of, description
         from transaction where booking_id = $1 order by created_at, id`,
      [id]
    );

  const before = await kpis();
  const balanceBefore = await balance();

  await post(`/api/bookings/${id}/payment`, { paymentStatus: 'paid' });
  const paid = await kpis();
  assert.equal(paid.revenueCents, before.revenueCents + 2_000_000);
  assert.equal(paid.expensesCents, before.expensesCents);
  assert.equal(await balance(), balanceBefore + 2_000_000);

  const credits = (await rows()).rows;
  assert.equal(credits.length, 1);
  assert.equal(credits[0]!.kind, 'credit');
  assert.equal(Number(credits[0]!.amount_cents), 2_000_000);
  assert.equal(credits[0]!.reversal_of, null);

  await post(`/api/bookings/${id}/payment`, { paymentStatus: 'unpaid' });
  const unpaid = await kpis();
  assert.equal(unpaid.revenueCents, before.revenueCents, 'the reversal removes the revenue');
  assert.equal(unpaid.expensesCents, before.expensesCents, 'and is not booked as an expense');
  assert.equal(await balance(), balanceBefore);

  const reversed = (await rows()).rows;
  assert.equal(reversed.length, 2, 'the original row is still there');
  assert.equal(reversed[0]!.id, credits[0]!.id, 'history was not rewritten');
  const debit = reversed[1]!;
  assert.equal(debit.kind, 'debit');
  assert.equal(debit.category, 'booking_revenue');
  assert.equal(Number(debit.amount_cents), -2_000_000);
  assert.equal(debit.reversal_of, credits[0]!.id);
  assert.match(debit.description, /^Reversal/);

  // A second payment is a new fact, not an edit of the reversal.
  await post(`/api/bookings/${id}/payment`, { paymentStatus: 'paid' });
  assert.equal((await kpis()).revenueCents, before.revenueCents + 2_000_000);
  const again = (await rows()).rows;
  assert.equal(again.length, 3);
  assert.equal(
    again.reduce((sum, row) => sum + Number(row.amount_cents), 0),
    2_000_000
  );

  // Posting the same status twice appends nothing.
  await post(`/api/bookings/${id}/payment`, { paymentStatus: 'paid' });
  assert.equal((await rows()).rows.length, 3);
});

test('a booking reversal stays out of the expense feed', async () => {
  const feed = await get<{
    transactions: Array<{ kind: string; category: string; amountCents: number; description: string }>;
  }>('/api/transactions');
  const reversal = feed.transactions.find((entry) => entry.description.startsWith('Reversal'));
  assert.ok(reversal, 'the reversal is visible in the full feed');
  assert.equal(reversal.amountCents, -2_000_000);
  assert.equal(reversal.category, 'booking_revenue');
  const expenses = await get<{
    transactions: Array<{ kind: string; category: string; amountCents: number }>;
  }>('/api/transactions?filter=expenses');
  assert.equal(
    expenses.transactions.every((entry) => entry.category !== 'booking_revenue'),
    true,
    'only real expenses are in the expense feed'
  );

  const revenue = await get<{
    transactions: Array<{ kind: string; category: string; amountCents: number }>;
  }>('/api/transactions?filter=revenue');
  assert.equal(
    revenue.transactions.every((entry) => entry.kind === 'credit'),
    true
  );
});
