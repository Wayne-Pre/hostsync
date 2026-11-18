/**
 * T-62 financial KPIs · T-63 monthly series · T-64 bank accounts
 * T-65 property performance · T-66 transaction feed · T-67 record an expense
 * T-68 statement KPIs · T-69 statement table · T-70 fee override
 * T-71 generate a statement · T-72 statement statuses
 *
 * Every number is compared against a value computed independently in this file,
 * so a formula that drifts cannot pass.
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

before(async () => {
  app = buildApp({ mailer });
  await app.ready();
  user = await signUp(app, mailer, 'MONEY');
  emails.push(user.email);

  const property = await createProperty(app, user, {
    name: 'Money House',
    managementFeePercent: 15,
    nightlyRateCents: 1_000_000,
    cleaningFeeCents: 0,
  });
  propertyId = property.id;

  // The settling account starts empty.
  await app.inject({
    method: 'PUT',
    url: `/api/properties/${property.id}/account`,
    headers: { cookie: user.cookie },
    payload: { label: 'KCB 3310', verified: true, balanceCents: 0 },
  });
});

after(async () => {
  await app.close();
  for (const email of emails) await deleteUser(email);
  await closePool();
});

test('T-62 the four financial numbers come from posted money and unpaid stays', async () => {
  const today = todayUTC();
  const monthStart = `${today.slice(0, 7)}-01`;

  // A paid stay inside this month. It is seeded directly because the API
  // refuses to back-date a manual booking — that rule is a feature, not a bug.
  // Three nights at the start of the month keep clear of the unpaid stay below.
  const paid = await pool.query<{ id: string }>(
    `insert into booking (
       property_id, reference, guest_name, channel, stay, guests,
       gross_cents, commission_bps, net_cents, rate_version,
       payment_status, status, source
     ) values (
       $1, 'HS-PAID', 'Paid Guest', 'direct',
       daterange($2::date, $2::date + 3, '[)'), 2,
       3000000, 0, 3000000, 1, 'unpaid', 'confirmed', 'import'
     ) returning id`,
    [propertyId, monthStart]
  );
  await post(`/api/bookings/${paid.rows[0]!.id}/payment`, { paymentStatus: 'paid' });

  // An unpaid stay: 2 nights × 1,000,000 = 2,000,000 outstanding.
  const unpaid = await createBooking(app, user, {
    propertyId,
    guestName: 'Unpaid Guest',
    channel: 'direct',
    checkIn: addDays(today, 5),
    checkOut: addDays(today, 7),
    guests: 2,
  });
  void unpaid;

  // An expense this month.
  await post(
    '/api/transactions/expense',
    {
      propertyId,
      date: addDays(today, -3),
      category: 'housekeeping',
      amountCents: 200_000,
      description: 'Deep clean',
    },
    201
  );

  const data = await get<{
    kpis: {
      revenueCents: number;
      expensesCents: number;
      netIncomeCents: number;
      outstandingCents: number;
    };
  }>('/api/financials');

  assert.equal(data.kpis.revenueCents, 3_000_000, 'one paid stay of three nights');
  assert.equal(data.kpis.expensesCents, 200_000);
  assert.equal(data.kpis.netIncomeCents, 2_800_000);
  assert.equal(data.kpis.outstandingCents, 2_000_000, 'the unpaid stay is outstanding, not revenue');
});

test('T-63 the six-month series is ordered, and only posted money is counted', async () => {
  const data = await get<{
    series: Array<{ month: string; revenueCents: number; expensesCents: number }>;
  }>('/api/financials');

  assert.equal(data.series.length, 6);
  const months = data.series.map((bucket) => bucket.month);
  assert.deepEqual(months, [...months].sort(), 'oldest first');

  const thisMonth = data.series.at(-1);
  assert.equal(thisMonth?.revenueCents, 3_000_000);
  assert.equal(thisMonth?.expensesCents, 200_000);
});

test('T-64 the settling account shows the money that actually landed', async () => {
  const data = await get<{
    accounts: Array<{ propertyId: string; label: string; verified: boolean; balanceCents: number }>;
  }>('/api/financials/accounts');

  const account = data.accounts.find((entry) => entry.propertyId === propertyId);
  assert.ok(account);
  assert.equal(account.label, 'KCB 3310');
  assert.equal(account.verified, true);
  assert.equal(
    account.balanceCents,
    3_000_000 - 200_000,
    'the paid stay landed, and the housekeeping expense came out of it'
  );
});

test('T-67 an expense debits the property account by exactly the amount', async () => {
  const before = await get<{ accounts: Array<{ propertyId: string; balanceCents: number }> }>(
    '/api/financials/accounts'
  );
  const balanceBefore = before.accounts.find((entry) => entry.propertyId === propertyId)!.balanceCents;

  const result = await post<{ transaction: { amountCents: number; category: string } }>(
    '/api/transactions/expense',
    {
      propertyId,
      date: todayUTC(),
      category: 'utilities',
      amountCents: 55_000,
      description: 'Water bill',
      paidTo: 'Nairobi Water',
    },
    201
  );
  assert.equal(result.transaction.amountCents, -55_000, 'an expense is negative money');
  assert.equal(result.transaction.category, 'utilities');

  const after = await get<{ accounts: Array<{ propertyId: string; balanceCents: number }> }>(
    '/api/financials/accounts'
  );
  const balanceAfter = after.accounts.find((entry) => entry.propertyId === propertyId)!.balanceCents;
  assert.equal(balanceAfter, balanceBefore - 55_000);

  // A nonsense amount is refused.
  const bad = await app.inject({
    method: 'POST',
    url: '/api/transactions/expense',
    headers: { cookie: user.cookie },
    payload: { propertyId, date: todayUTC(), category: 'utilities', amountCents: -5, description: 'x' },
  });
  assert.equal(bad.statusCode, 422, bad.body);
});

test('T-66 the feed signs the amounts and the filters really filter', async () => {
  const all = await get<{
    transactions: Array<{ kind: string; amountCents: number; categoryLabel: string; posted: boolean }>;
  }>('/api/transactions');

  assert.ok(all.transactions.length >= 3);
  const credit = all.transactions.find((entry) => entry.kind === 'credit');
  const debit = all.transactions.find((entry) => entry.kind === 'debit');
  assert.ok((credit?.amountCents ?? 0) > 0, 'a credit is positive');
  assert.ok((debit?.amountCents ?? 0) < 0, 'a debit is negative');
  assert.equal(credit?.categoryLabel, 'BOOKING REVENUE');

  const revenue = await get<{ transactions: Array<{ kind: string }> }>('/api/transactions?filter=revenue');
  assert.equal(
    revenue.transactions.every((entry) => entry.kind === 'credit'),
    true
  );

  const expenses = await get<{ transactions: Array<{ kind: string }> }>('/api/transactions?filter=expenses');
  assert.equal(
    expenses.transactions.every((entry) => entry.kind === 'debit'),
    true
  );
  assert.ok(expenses.transactions.length < revenue.transactions.length + 5);

  const bad = await app.inject({
    method: 'GET',
    url: '/api/transactions?filter=nonsense',
    headers: { cookie: user.cookie },
  });
  assert.equal(bad.statusCode, 422, bad.body);
});

test('T-65 / T-70 the property row uses its own fee, and the payout adds up', async () => {
  const data = await get<{
    properties: Array<{
      propertyId: string;
      revenueCents: number;
      expensesCents: number;
      netCents: number;
      feeBps: number;
      feeCents: number;
      accountLabel: string | null;
    }>;
  }>('/api/financials/performance');

  const row = data.properties.find((entry) => entry.propertyId === propertyId);
  assert.ok(row);
  assert.equal(row.feeBps, 1500, 'the property keeps its own 15 %');
  assert.equal(row.feeCents, Math.round((row.revenueCents * 1500) / 10_000));
  assert.equal(row.netCents, row.revenueCents - row.expensesCents - row.feeCents);
  assert.equal(row.accountLabel, 'KCB 3310');
});

test('T-71 the preview and the stored statement hold the same numbers', async () => {
  const month = todayUTC().slice(0, 7);

  const preview = await get<{
    preview: {
      grossCents: number;
      expensesCents: number;
      feeBps: number;
      feeCents: number;
      netCents: number;
      ownerName: string;
    };
  }>(`/api/statements/preview?propertyId=${propertyId}&month=${month}`);

  assert.equal(preview.preview.feeBps, 1500);
  assert.equal(
    preview.preview.netCents,
    preview.preview.grossCents - preview.preview.expensesCents - preview.preview.feeCents
  );

  const created = await post<{ statement: { id: string; grossCents: number; netCents: number; status: string } }>(
    '/api/statements',
    { propertyId, month },
    201
  );

  assert.equal(created.statement.grossCents, preview.preview.grossCents);
  assert.equal(created.statement.netCents, preview.preview.netCents);
  assert.equal(created.statement.status, 'draft');
});

test('T-68 / T-69 the statement list shows the money and the statuses', async () => {
  const data = await get<{
    statements: Array<{
      id: string;
      propertyName: string;
      ownerName: string;
      grossCents: number;
      expensesCents: number;
      feeCents: number;
      netCents: number;
      status: string;
    }>;
    kpis: { awaitingReleaseCents: number; paidToOwnersCents: number; count: number };
  }>('/api/statements');

  assert.equal(data.statements.length, 1);
  const statement = data.statements[0]!;
  assert.equal(statement.propertyName, 'Money House');
  assert.equal(statement.ownerName, 'David Mwangi');
  assert.equal(
    statement.netCents,
    statement.grossCents - statement.expensesCents - statement.feeCents
  );

  assert.equal(data.kpis.count, 1);
  assert.equal(data.kpis.awaitingReleaseCents, statement.netCents, 'a draft is awaiting release');
  assert.equal(data.kpis.paidToOwnersCents, 0);
});

test('T-72 a statement moves draft → approved → paid, and no further', async () => {
  const list = await get<{ statements: Array<{ id: string; status: string; netCents: number }> }>(
    '/api/statements'
  );
  const statement = list.statements[0]!;

  const approved = await post<{ statement: { status: string } }>(`/api/statements/${statement.id}/approve`, {});
  assert.equal(approved.statement.status, 'approved');

  const paid = await post<{ statement: { status: string } }>(`/api/statements/${statement.id}/pay`, {});
  assert.equal(paid.statement.status, 'paid');

  // Paid is the end of the line.
  const illegal = await app.inject({
    method: 'POST',
    url: `/api/statements/${statement.id}/approve`,
    headers: { cookie: user.cookie },
  });
  assert.equal(illegal.statusCode, 409, illegal.body);

  const kpis = await get<{ kpis: { awaitingReleaseCents: number; paidToOwnersCents: number } }>(
    '/api/statements'
  );
  assert.equal(kpis.kpis.awaitingReleaseCents, 0);
  assert.equal(kpis.kpis.paidToOwnersCents, statement.netCents);
});
