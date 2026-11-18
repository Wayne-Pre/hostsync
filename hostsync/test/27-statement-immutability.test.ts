/**
 * Stage 3 exit criteria (spec §6.3): a statement's arithmetic is a hard
 * database invariant, approval records who did it, and a paid statement
 * rejects modification with 409.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { closePool, pool } from '../src/db.ts';
import { createCaptureTransport } from '../src/mail.ts';
import { todayUTC } from '../src/dates.ts';
import { createProperty, deleteUser, signUp } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';

const mailer = createCaptureTransport();
let app: FastifyInstance;
let user: ApiUser;
let propertyId: string;
let statementId: string;
const emails: string[] = [];
let snapshot: { grossCents: number; expensesCents: number; feeCents: number; netCents: number };

async function get<T>(url: string): Promise<T> {
  const response = await app.inject({ method: 'GET', url, headers: { cookie: user.cookie } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as T;
}

async function post<T>(
  url: string,
  payload: Record<string, unknown>,
  expected = 200
): Promise<T> {
  const response = await app.inject({
    method: 'POST',
    url,
    headers: { cookie: user.cookie },
    payload,
  });
  assert.equal(response.statusCode, expected, response.body);
  return response.json() as T;
}

before(async () => {
  app = buildApp({ mailer });
  await app.ready();
  user = await signUp(app, mailer, 'FREEZE');
  emails.push(user.email);

  const property = await createProperty(app, user, {
    name: 'Frozen House',
    nightlyRateCents: 1_000_000,
    cleaningFeeCents: 0,
    managementFeePercent: 15,
  });
  propertyId = property.id;
  await app.inject({
    method: 'PUT',
    url: `/api/properties/${property.id}/account`,
    headers: { cookie: user.cookie },
    payload: { label: 'KCB 7007', verified: true, balanceCents: 0 },
  });

  // A paid stay in this month gives the statement real money to snapshot.
  const monthStart = `${todayUTC().slice(0, 7)}-01`;
  const paid = await pool.query<{ id: string }>(
    `insert into booking (
       property_id, reference, guest_name, channel, stay, guests,
       gross_cents, commission_bps, net_cents, rate_version,
       payment_status, status, source
     ) values (
       $1, 'HS-FROZEN', 'Frozen Guest', 'direct',
       daterange($2::date, $2::date + 3, '[)'), 2,
       3000000, 0, 3000000, 1, 'unpaid', 'confirmed', 'import'
     ) returning id`,
    [propertyId, monthStart]
  );
  await post(`/api/bookings/${paid.rows[0]!.id}/payment`, { paymentStatus: 'paid' });
  await post('/api/transactions/expense', {
    propertyId,
    date: monthStart,
    category: 'housekeeping',
    amountCents: 100_000,
    description: 'Linen',
  }, 201);

  const month = todayUTC().slice(0, 7);
  const preview = await get<{
    preview: { grossCents: number; expensesCents: number; feeCents: number; netCents: number };
  }>(`/api/statements/preview?propertyId=${propertyId}&month=${month}`);
  snapshot = {
    grossCents: preview.preview.grossCents,
    expensesCents: preview.preview.expensesCents,
    feeCents: preview.preview.feeCents,
    netCents: preview.preview.netCents,
  };
  assert.equal(snapshot.grossCents, 3_000_000);
  assert.equal(snapshot.expensesCents, 100_000);
  assert.equal(snapshot.feeCents, 450_000);
  assert.equal(snapshot.netCents, 2_450_000);

  const created = await post<{ statement: { id: string } }>(
    '/api/statements',
    { propertyId, month },
    201
  );
  statementId = created.statement.id;
});

after(async () => {
  await app.close();
  for (const email of emails) await deleteUser(email);
  await closePool();
});

test('the database refuses arithmetic that does not reconcile', async () => {
  await assert.rejects(
    pool.query('update statement set net_cents = net_cents + 1 where id = $1', [statementId]),
    /statement_net_check/
  );
  await assert.rejects(
    pool.query('update statement set fee_cents = fee_cents + 1 where id = $1', [statementId]),
    /statement_fee_check/
  );
});

test('approval records the actor, and payment seals the statement', async () => {
  const approved = await post<{
    statement: { status: string; approvedBy: string | null; paidBy: string | null };
  }>(`/api/statements/${statementId}/approve`, {});
  assert.equal(approved.statement.status, 'approved');
  assert.equal(approved.statement.approvedBy, user.userId);
  assert.equal(approved.statement.paidBy, null);

  const paid = await post<{
    statement: { status: string; approvedBy: string | null; paidBy: string | null };
  }>(`/api/statements/${statementId}/pay`, {});
  assert.equal(paid.statement.status, 'paid');
  assert.equal(paid.statement.approvedBy, user.userId);
  assert.equal(paid.statement.paidBy, user.userId);
});

test('regenerating a paid period is a 409 and leaves the numbers untouched', async () => {
  const month = todayUTC().slice(0, 7);
  const response = await app.inject({
    method: 'POST',
    url: '/api/statements',
    headers: { cookie: user.cookie },
    payload: { propertyId, month },
  });
  assert.equal(response.statusCode, 409, response.body);
  const payload = response.json() as { message?: string };
  assert.match(payload.message ?? '', /paid statement cannot be modified/i);

  const list = await get<{
    statements: Array<{
      id: string;
      status: string;
      grossCents: number;
      expensesCents: number;
      feeCents: number;
      netCents: number;
    }>;
  }>('/api/statements');
  assert.equal(list.statements.length, 1, 'no second statement was created');
  const stored = list.statements[0]!;
  assert.equal(stored.id, statementId);
  assert.equal(stored.status, 'paid');
  assert.deepEqual(
    {
      grossCents: stored.grossCents,
      expensesCents: stored.expensesCents,
      feeCents: stored.feeCents,
      netCents: stored.netCents,
    },
    snapshot
  );

  await assert.rejects(
    pool.query('update statement set gross_cents = gross_cents + 1 where id = $1', [statementId]),
    /paid statement is immutable/
  );
});
