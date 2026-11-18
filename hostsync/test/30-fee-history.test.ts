/**
 * Stage 3 upgrade (spec §6.3): effective-dated fee overrides.
 *
 * A fee change backdated into a settled month must not rewrite that statement;
 * a new statement built for a period after the override's effective date must
 * use the new rate and store the bps it applied.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { closePool, pool } from '../src/db.ts';
import { createCaptureTransport } from '../src/mail.ts';
import { createProperty, deleteUser, signUp } from './api-helpers.ts';
import type { ApiUser } from './api-helpers.ts';

const mailer = createCaptureTransport();
let app: FastifyInstance;
let user: ApiUser;
let propertyId: string;
let oldStatementId: string;
let currentStatementId: string;
const emails: string[] = [];

function month(offset: number): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return date.toISOString().slice(0, 7);
}

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

async function paidStay(start: string, reference: string): Promise<void> {
  const row = await pool.query<{ id: string }>(
    `insert into booking (
       property_id, reference, guest_name, channel, stay, guests,
       gross_cents, commission_bps, net_cents, rate_version,
       payment_status, status, source
     ) values (
       $1, $2, 'Fee Guest', 'direct',
       daterange($3::date, $3::date + 3, '[)'), 2,
       3000000, 0, 3000000, 1, 'unpaid', 'confirmed', 'import'
     ) returning id`,
    [propertyId, reference, start]
  );
  await post(`/api/bookings/${row.rows[0]!.id}/payment`, { paymentStatus: 'paid' });
}

before(async () => {
  app = buildApp({ mailer });
  await app.ready();
  user = await signUp(app, mailer, 'FEES');
  emails.push(user.email);

  const property = await createProperty(app, user, {
    name: 'Fee House',
    nightlyRateCents: 1_000_000,
    cleaningFeeCents: 0,
    managementFeePercent: 15,
  });
  propertyId = property.id;
  await app.inject({
    method: 'PUT',
    url: `/api/properties/${property.id}/account`,
    headers: { cookie: user.cookie },
    payload: { label: 'KCB 4004', verified: true, balanceCents: 0 },
  });

  await paidStay(`${month(-1)}-01`, 'HS-OLD-FEE');
  await paidStay(`${month(0)}-01`, 'HS-NOW-FEE');

  const preview = await get<{ preview: { feeBps: number; feeCents: number } }>(
    `/api/statements/preview?propertyId=${propertyId}&month=${month(-1)}`
  );
  assert.equal(preview.preview.feeBps, 1500);
  assert.equal(preview.preview.feeCents, 450_000);
  const created = await post<{ statement: { id: string } }>(
    '/api/statements',
    { propertyId, month: month(-1) },
    201
  );
  oldStatementId = created.statement.id;
});

after(async () => {
  await app.close();
  for (const email of emails) await deleteUser(email);
  await closePool();
});

test('a backdated override cannot rewrite a settled statement', async () => {
  await post(`/api/statements/${oldStatementId}/approve`, {});
  await post(`/api/statements/${oldStatementId}/pay`, {});

  const added = await post<{ fee: { effectiveFrom: string; feeBps: number } }>(
    `/api/properties/${propertyId}/fees`,
    { effectiveFrom: `${month(-1)}-01`, managementFeePercent: 25 },
    201
  );
  assert.equal(added.fee.effectiveFrom, `${month(-1)}-01`);
  assert.equal(added.fee.feeBps, 2500);

  const history = await get<{ fees: Array<{ effectiveFrom: string; feeBps: number }> }>(
    `/api/properties/${propertyId}/fees`
  );
  assert.deepEqual(
    history.fees.map((fee) => ({ effectiveFrom: fee.effectiveFrom, feeBps: fee.feeBps })),
    [{ effectiveFrom: `${month(-1)}-01`, feeBps: 2500 }]
  );

  const settled = await pool.query<{ fee_bps: number; fee_cents: number; net_cents: number }>(
    'select fee_bps, fee_cents, net_cents from statement where id = $1',
    [oldStatementId]
  );
  assert.equal(settled.rows[0]!.fee_bps, 1500, 'the old statement kept its snapshot');
  assert.equal(settled.rows[0]!.fee_cents, 450_000);
  assert.equal(settled.rows[0]!.net_cents, 2_550_000);
});

test('new statements use the fee in force at their period start', async () => {
  const preview = await get<{ preview: { feeBps: number; feeCents: number; netCents: number } }>(
    `/api/statements/preview?propertyId=${propertyId}&month=${month(0)}`
  );
  assert.equal(preview.preview.feeBps, 2500, 'the backdated 25 % is now in force');
  assert.equal(preview.preview.feeCents, 750_000);
  assert.equal(preview.preview.netCents, 3_000_000 - 750_000);

  const created = await post<{
    statement: { id: string; feeBps: number; feeCents: number; status: string };
  }>('/api/statements', { propertyId, month: month(0) }, 201);
  currentStatementId = created.statement.id;
  assert.equal(created.statement.feeBps, 2500);
  assert.equal(created.statement.feeCents, 750_000);
  assert.equal(created.statement.status, 'draft');

  // A future override changes next month, not the one already drafted.
  await post(`/api/properties/${propertyId}/fees`, {
    effectiveFrom: `${month(1)}-01`,
    feeBps: 1000,
  }, 201);

  const still = await get<{ preview: { feeBps: number } }>(
    `/api/statements/preview?propertyId=${propertyId}&month=${month(0)}`
  );
  assert.equal(still.preview.feeBps, 2500);
  const next = await get<{ preview: { feeBps: number } }>(
    `/api/statements/preview?propertyId=${propertyId}&month=${month(1)}`
  );
  assert.equal(next.preview.feeBps, 1000);
  const stored = await get<{ statements: Array<{ id: string; feeBps: number }> }>('/api/statements');
  assert.equal(stored.statements.find((s) => s.id === currentStatementId)?.feeBps, 2500);
});

test('invalid fee history is refused', async () => {
  await post(
    `/api/properties/${propertyId}/fees`,
    { effectiveFrom: 'yesterday', feeBps: 2500 },
    422
  );
  await post(
    `/api/properties/${propertyId}/fees`,
    { effectiveFrom: `${month(2)}-01`, feeBps: 15_000 },
    422
  );
  await post(
    `/api/properties/${propertyId}/fees`,
    { effectiveFrom: `${month(-1)}-01`, feeBps: 2500 },
    409
  );
});
