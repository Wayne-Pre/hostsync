/**
 * Stage 3 exit criterion (spec §6.3): the reconciliation job reports zero
 * drift on a clean seed set, and reports the exact rows when drift is injected.
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
import type { DriftRow, Reconciliation } from '../src/reconcile.ts';

const mailer = createCaptureTransport();
let app: FastifyInstance;
let user: ApiUser;
let propertyId: string;
let bookingId: string;
let statementId: string;
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

async function reconcile(): Promise<Reconciliation> {
  return (await get<{ reconciliation: Reconciliation }>('/api/financials/reconciliation'))
    .reconciliation;
}

before(async () => {
  app = buildApp({ mailer });
  await app.ready();
  user = await signUp(app, mailer, 'RECON');
  emails.push(user.email);

  const property = await createProperty(app, user, {
    name: 'Reconciled House',
    nightlyRateCents: 1_000_000,
    cleaningFeeCents: 0,
    managementFeePercent: 10,
  });
  propertyId = property.id;
  await app.inject({
    method: 'PUT',
    url: `/api/properties/${property.id}/account`,
    headers: { cookie: user.cookie },
    payload: { label: 'KCB 6006', verified: true, balanceCents: 0 },
  });

  const monthStart = `${todayUTC().slice(0, 7)}-01`;
  const paid = await pool.query<{ id: string }>(
    `insert into booking (
       property_id, reference, guest_name, channel, stay, guests,
       gross_cents, commission_bps, net_cents, rate_version,
       payment_status, status, source
     ) values (
       $1, 'HS-RECON', 'Reconciled Guest', 'direct',
       daterange($2::date, $2::date + 3, '[)'), 2,
       3000000, 0, 3000000, 1, 'unpaid', 'confirmed', 'import'
     ) returning id`,
    [propertyId, monthStart]
  );
  bookingId = paid.rows[0]!.id;
  await post(`/api/bookings/${bookingId}/payment`, { paymentStatus: 'paid' });
  await post('/api/transactions/expense', {
    propertyId,
    date: monthStart,
    category: 'housekeeping',
    amountCents: 100_000,
    description: 'Linen',
  }, 201);

  const month = todayUTC().slice(0, 7);
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

test('a clean seed set reconciles to zero drift', async () => {
  const report = await reconcile();
  assert.equal(report.balanced, true, JSON.stringify(report.drift));
  assert.deepEqual(report.drift, []);
  assert.ok(report.checked.bookings >= 1);
  assert.ok(report.checked.accounts >= 1);
  assert.ok(report.checked.statements >= 1);
  assert.ok(report.checked.entries >= 2);
});

test('the job names the exact rows that drifted', async () => {
  await pool.query('update booking set gross_cents = gross_cents + 1 where id = $1', [bookingId]);
  // Keep the arithmetic invariant satisfied while making the snapshot wrong.
  await pool.query(
    'update statement set gross_cents = gross_cents + 3, net_cents = net_cents + 3 where id = $1',
    [statementId]
  );
  await pool.query(
    'update property_account set balance_cents = balance_cents + 2 where property_id = $1',
    [propertyId]
  );

  const report = await reconcile();
  assert.equal(report.balanced, false);
  const byDetail = (kind: DriftRow['kind'], detail: string) =>
    report.drift.find((row) => row.kind === kind && row.detail === detail);

  const booking = byDetail('booking', 'booking credit vs ledger');
  assert.ok(booking);
  assert.equal(booking.expectedCents - booking.actualCents, 1);
  assert.equal(booking.ref, 'HS-RECON');

  const gross = byDetail('statement', 'statement gross vs ledger');
  assert.ok(gross);
  assert.equal(gross.expectedCents - gross.actualCents, 3);

  const account = byDetail('account', 'derived balance vs stored balance');
  assert.ok(account);
  assert.equal(account.expectedCents - account.actualCents, -2);

  // Repairing the tampered rows returns the portfolio to zero drift.
  await pool.query('update booking set gross_cents = gross_cents - 1 where id = $1', [bookingId]);
  await pool.query(
    'update statement set gross_cents = gross_cents - 3, net_cents = net_cents - 3 where id = $1',
    [statementId]
  );
  await pool.query(
    'update property_account set balance_cents = balance_cents - 2 where property_id = $1',
    [propertyId]
  );
  assert.equal((await reconcile()).balanced, true);
});
