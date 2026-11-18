/**
 * F-62 – F-72 — money that reconciles itself.
 *
 * Three ideas hold this module together:
 *
 *  1. Money is integer minor units, and it is computed here, never in the
 *     browser. A statement stores the numbers it was generated with, so a rate
 *     change next month cannot rewrite last month's payout.
 *  2. A stay is a *credit* only once it is paid. An unpaid stay is still
 *     visible as "outstanding", never as revenue.
 *  3. An expense debits the property's own settling account, so the balance on
 *     the card and the money in the statement are the same money.
 */
import { query, queryOne, withTransaction } from './db.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import type { PoolClient } from 'pg';

export const EXPENSE_CATEGORIES = [
  'housekeeping',
  'maintenance',
  'consumables',
  'utilities',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<string, string> = {
  booking_revenue: 'BOOKING REVENUE',
  housekeeping: 'HOUSEKEEPING',
  maintenance: 'MAINTENANCE',
  consumables: 'CONSUMABLES',
  utilities: 'UTILITIES',
  payout: 'PAYOUT',
};

export interface TransactionRow {
  id: string;
  kind: 'credit' | 'debit';
  category: string;
  categoryLabel: string;
  /** Signed: a credit is positive, an expense is negative. */
  amountCents: number;
  description: string;
  occurredOn: string;
  posted: boolean;
  propertyId: string | null;
  propertyName: string | null;
  accountLabel: string | null;
  bookingId: string | null;
}

interface TxRow {
  id: string;
  kind: 'credit' | 'debit';
  category: string;
  amount_cents: string | number;
  description: string;
  occurred_on: Date;
  posted: boolean;
  property_id: string | null;
  property_name: string | null;
  account_label: string | null;
  booking_id: string | null;
}

function mapTransaction(row: TxRow): TransactionRow {
  const amount = Number(row.amount_cents);
  return {
    id: row.id,
    kind: row.kind,
    category: row.category,
    categoryLabel: CATEGORY_LABEL[row.category] ?? row.category.toUpperCase(),
    amountCents: row.kind === 'credit' ? amount : -amount,
    description: row.description,
    occurredOn: row.occurred_on.toISOString().slice(0, 10),
    posted: row.posted,
    propertyId: row.property_id,
    propertyName: row.property_name,
    accountLabel: row.account_label,
    bookingId: row.booking_id,
  };
}

const TX_SELECT = `
  select t.id, t.kind, t.category, t.amount_cents, t.description, t.occurred_on, t.posted,
         t.property_id, p.name as property_name, t.booking_id, a.label as account_label
    from transaction t
    left join property p on p.id = t.property_id
    left join property_account a on a.property_id = t.property_id
`;

/* --------------------------------------------------------- booking credits -- */

interface BookingMoney {
  id: string;
  propertyId: string;
  reference: string;
  guestName: string;
  grossCents: number;
  paymentStatus: string;
  checkIn: string;
  status: string;
}

/**
 * Keep the ledger row for a stay in step with its payment status.
 *
 * One row per booking (enforced by a unique index), so marking a stay paid
 * twice cannot double the revenue — it flips the same row to posted.
 */
export async function syncBookingCredit(
  client: PoolClient,
  booking: BookingMoney
): Promise<void> {
  const posted = booking.paymentStatus === 'paid';

  // What the ledger believed before this change — the account moves by the
  // difference, so marking a stay paid twice cannot credit it twice.
  const previous = await client.query<{ id: string; posted: boolean; amount_cents: string | number }>(
    `select id, posted, amount_cents from transaction
      where booking_id = $1 and category = 'booking_revenue'`,
    [booking.id]
  );
  const before = previous.rows[0];

  const inserted = await client.query<{ id: string }>(
    `insert into transaction (
       portfolio_id, property_id, booking_id, account_id, kind, category,
       amount_cents, description, posted, occurred_on
     )
     select p.portfolio_id, p.id, $1, p.id, 'credit', 'booking_revenue', $2, $3, $4, $5::date
       from property p
      where p.id = $6
     on conflict (booking_id) where booking_id is not null and category = 'booking_revenue'
     do update set amount_cents = excluded.amount_cents,
                   posted = excluded.posted,
                   description = excluded.description,
                   occurred_on = excluded.occurred_on
     returning id`,
    [
      booking.id,
      booking.grossCents,
      `Stay ${booking.reference} — ${booking.guestName}`,
      posted,
      booking.checkIn,
      booking.propertyId,
    ]
  );

  const rowId = inserted.rows[0]?.id;
  if (!rowId) return;

  const wasPosted = before?.posted === true ? Number(before.amount_cents) : 0;
  const isPosted = posted ? booking.grossCents : 0;
  const delta = isPosted - wasPosted;
  if (delta === 0) return;

  // The settling account moves with the money: a posted credit lands in it.
  await client.query(
    `update property_account
        set balance_cents = balance_cents + $2, updated_at = now()
      where property_id = $1`,
    [booking.propertyId, delta]
  );
}

/** Mark a stay paid (or unpaid) and keep the ledger in step. */
export async function setBookingPayment(
  portfolioId: string,
  bookingId: string,
  paymentStatus: string
): Promise<{ id: string; paymentStatus: string }> {
  if (!['paid', 'unpaid', 'partial'].includes(paymentStatus)) {
    throw new ValidationError('payment status must be paid, unpaid or partial', 'paymentStatus');
  }

  return withTransaction(async (client) => {
    const row = await client.query<{
      id: string;
      property_id: string;
      reference: string;
      guest_name: string;
      gross_cents: string | number;
      payment_status: string;
      check_in: string;
      status: string;
    }>(
      `select b.id, b.property_id, b.reference, b.guest_name, b.gross_cents, b.payment_status,
              lower(b.stay)::text as check_in, b.status
         from booking b join property p on p.id = b.property_id
        where b.id = $1 and p.portfolio_id = $2
        for update`,
      [bookingId, portfolioId]
    );
    const booking = row.rows[0];
    if (!booking) throw new NotFoundError('booking');

    await client.query('update booking set payment_status = $2, version = version + 1 where id = $1', [
      booking.id,
      paymentStatus,
    ]);

    await syncBookingCredit(client, {
      id: booking.id,
      propertyId: booking.property_id,
      reference: booking.reference,
      guestName: booking.guest_name,
      grossCents: Number(booking.gross_cents),
      paymentStatus,
      checkIn: booking.check_in,
      status: booking.status,
    });

    return { id: booking.id, paymentStatus };
  });
}

/* -------------------------------------------------------------- financials -- */

export interface FinancialKpis {
  revenueCents: number;
  expensesCents: number;
  netIncomeCents: number;
  outstandingCents: number;
}

/** F-62 — revenue is posted credits; outstanding is what has not been paid. */
export async function financialKpis(portfolioId: string): Promise<FinancialKpis> {
  const month = await queryOne<{ revenue: string | number; expenses: string | number }>(
    `select
       coalesce(sum(case when t.kind = 'credit' then t.amount_cents else 0 end), 0)::bigint as revenue,
       coalesce(sum(case when t.kind = 'debit' then t.amount_cents else 0 end), 0)::bigint as expenses
     from transaction t
    where t.portfolio_id = $1
      and t.posted
      and t.occurred_on >= date_trunc('month', current_date)::date
      and t.occurred_on < (date_trunc('month', current_date) + interval '1 month')::date`,
    [portfolioId]
  );

  const outstanding = await queryOne<{ amount: string | number }>(
    `select coalesce(sum(b.net_cents), 0)::bigint as amount
       from booking b join property p on p.id = b.property_id
      where p.portfolio_id = $1
        and b.status in ('confirmed', 'completed')
        and b.payment_status <> 'paid'`,
    [portfolioId]
  );

  const revenue = Number(month?.revenue ?? 0);
  const expenses = Number(month?.expenses ?? 0);

  return {
    revenueCents: revenue,
    expensesCents: expenses,
    netIncomeCents: revenue - expenses,
    outstandingCents: Number(outstanding?.amount ?? 0),
  };
}

/** F-63 — six months of posted money, oldest first. */
export async function monthlySeries(
  portfolioId: string,
  months = 6
): Promise<Array<{ month: string; revenueCents: number; expensesCents: number }>> {
  const rows = await query<{ month: string; revenue: string | number; expenses: string | number }>(
    `select to_char(date_trunc('month', t.occurred_on), 'YYYY-MM') as month,
            coalesce(sum(case when t.kind = 'credit' then t.amount_cents else 0 end), 0)::bigint as revenue,
            coalesce(sum(case when t.kind = 'debit' then t.amount_cents else 0 end), 0)::bigint as expenses
       from transaction t
      where t.portfolio_id = $1
        and t.posted
        and t.occurred_on >= (date_trunc('month', current_date) - ($2 || ' months')::interval)::date
      group by 1
      order by 1`,
    [portfolioId, String(Math.max(1, months) - 1)]
  );

  const byMonth = new Map(rows.map((row) => [row.month, row]));
  const series: Array<{ month: string; revenueCents: number; expensesCents: number }> = [];

  const cursor = new Date();
  cursor.setUTCDate(1);
  for (let index = Math.max(1, months) - 1; index >= 0; index -= 1) {
    const date = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - index, 1));
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const row = byMonth.get(key);
    series.push({
      month: key,
      revenueCents: Number(row?.revenue ?? 0),
      expensesCents: Number(row?.expenses ?? 0),
    });
  }

  return series;
}

/** F-66 — the transaction feed, with a filter that really filters. */
export async function listTransactions(
  portfolioId: string,
  filter: 'all' | 'revenue' | 'expenses' = 'all'
): Promise<TransactionRow[]> {
  const rows = await query<TxRow>(
    `${TX_SELECT}
      where t.portfolio_id = $1
        and ($2::text = 'all'
             or ($2::text = 'revenue' and t.kind = 'credit')
             or ($2::text = 'expenses' and t.kind = 'debit'))
      order by t.occurred_on desc, t.created_at desc
      limit 200`,
    [portfolioId, filter]
  );
  return rows.map(mapTransaction);
}

export interface RecordExpenseInput {
  portfolioId: string;
  propertyId: string;
  date: string;
  category: string;
  amountCents: number;
  description: string;
  paidTo: string | null;
}

/** F-67 — an expense charges the property's own account. */
export async function recordExpense(input: RecordExpenseInput): Promise<TransactionRow> {
  const category = input.category as ExpenseCategory;
  if (!EXPENSE_CATEGORIES.includes(category)) {
    throw new ValidationError(`category must be one of: ${EXPENSE_CATEGORIES.join(', ')}`, 'category');
  }
  const amount = Math.round(Number(input.amountCents));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ValidationError('the amount must be more than zero', 'amountCents');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new ValidationError('date must be YYYY-MM-DD', 'date');
  }
  const description = input.description.trim();
  if (!description) throw new ValidationError('an expense needs a description', 'description');

  const id = await withTransaction(async (client) => {
    const property = await client.query<{ id: string }>(
      'select id from property where id = $1 and portfolio_id = $2 and deleted_at is null',
      [input.propertyId, input.portfolioId]
    );
    if (!property.rows[0]) throw new NotFoundError('property');

    const inserted = await client.query<{ id: string }>(
      `insert into transaction (
         portfolio_id, property_id, account_id, kind, category,
         amount_cents, description, posted, occurred_on
       )
       values ($1, $2, $2, 'debit', $3, $4, $5, true, $6::date)
       returning id`,
      [
        input.portfolioId,
        input.propertyId,
        category,
        amount,
        input.paidTo ? `${description} — paid to ${input.paidTo}` : description,
        input.date,
      ]
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('transaction insert returned no row');

    await client.query(
      `update property_account
          set balance_cents = balance_cents - $2, updated_at = now()
        where property_id = $1`,
      [input.propertyId, amount]
    );

    return row.id;
  });

  const row = await queryOne<TxRow>(`${TX_SELECT} where t.id = $1`, [id]);
  if (!row) throw new Error('transaction could not be read back');
  return mapTransaction(row);
}

/** F-64 — one card per settling account. */
export interface AccountCard {
  propertyId: string;
  propertyName: string;
  label: string;
  verified: boolean;
  balanceCents: number;
}

export async function listAccounts(portfolioId: string): Promise<AccountCard[]> {
  const rows = await query<{
    property_id: string;
    property_name: string;
    label: string;
    verified: boolean;
    balance_cents: string | number;
  }>(
    `select a.property_id, p.name as property_name, a.label, a.verified, a.balance_cents
       from property_account a join property p on p.id = a.property_id
      where p.portfolio_id = $1
      order by p.name`,
    [portfolioId]
  );

  return rows.map((row) => ({
    propertyId: row.property_id,
    propertyName: row.property_name,
    label: row.label,
    verified: row.verified,
    balanceCents: Number(row.balance_cents),
  }));
}

/** F-65 — all-time performance per property. */
export interface PerformanceRow {
  propertyId: string;
  propertyName: string;
  revenueCents: number;
  expensesCents: number;
  netCents: number;
  feeBps: number;
  feeCents: number;
  accountLabel: string | null;
}

export async function propertyPerformance(portfolioId: string): Promise<PerformanceRow[]> {
  const rows = await query<{
    property_id: string;
    property_name: string;
    revenue: string | number;
    expenses: string | number;
    fee_bps: number | null;
    default_fee_bps: number;
    account_label: string | null;
  }>(
    `select p.id as property_id, p.name as property_name,
            coalesce(sum(case when t.kind = 'credit' and t.posted then t.amount_cents else 0 end), 0)::bigint as revenue,
            coalesce(sum(case when t.kind = 'debit' and t.posted then t.amount_cents else 0 end), 0)::bigint as expenses,
            p.management_fee_bps as fee_bps,
            pf.default_management_fee_bps as default_fee_bps,
            a.label as account_label
       from property p
       join portfolio pf on pf.id = p.portfolio_id
       left join transaction t on t.property_id = p.id
       left join property_account a on a.property_id = p.id
      where p.portfolio_id = $1 and p.deleted_at is null
      group by p.id, p.name, p.management_fee_bps, pf.default_management_fee_bps, a.label
      order by p.name`,
    [portfolioId]
  );

  return rows.map((row) => {
    const revenue = Number(row.revenue);
    const expenses = Number(row.expenses);
    const feeBps = row.fee_bps ?? row.default_fee_bps;
    const feeCents = Math.round((revenue * feeBps) / 10_000);
    return {
      propertyId: row.property_id,
      propertyName: row.property_name,
      revenueCents: revenue,
      expensesCents: expenses,
      netCents: revenue - expenses - feeCents,
      feeBps,
      feeCents,
      accountLabel: row.account_label,
    };
  });
}

/* --------------------------------------------------------------- statements -- */

export interface StatementRow {
  id: string;
  propertyId: string;
  propertyName: string;
  ownerName: string;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  expensesCents: number;
  feeBps: number;
  feeCents: number;
  netCents: number;
  status: 'draft' | 'approved' | 'paid';
  approvedAt: string | null;
  paidAt: string | null;
}

interface StatementDbRow {
  id: string;
  property_id: string;
  property_name: string;
  owner_name: string;
  period_start: Date;
  period_end: Date;
  gross_cents: string | number;
  expenses_cents: string | number;
  fee_bps: number;
  fee_cents: string | number;
  net_cents: string | number;
  status: 'draft' | 'approved' | 'paid';
  approved_at: Date | null;
  paid_at: Date | null;
}

function mapStatement(row: StatementDbRow): StatementRow {
  return {
    id: row.id,
    propertyId: row.property_id,
    propertyName: row.property_name,
    ownerName: row.owner_name,
    periodStart: row.period_start.toISOString().slice(0, 10),
    periodEnd: row.period_end.toISOString().slice(0, 10),
    grossCents: Number(row.gross_cents),
    expensesCents: Number(row.expenses_cents),
    feeBps: Number(row.fee_bps),
    feeCents: Number(row.fee_cents),
    netCents: Number(row.net_cents),
    status: row.status,
    approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
    paidAt: row.paid_at ? row.paid_at.toISOString() : null,
  };
}

const STATEMENT_SELECT = `
  select s.id, s.property_id, p.name as property_name, s.owner_name,
         s.period_start, s.period_end, s.gross_cents, s.expenses_cents,
         s.fee_bps, s.fee_cents, s.net_cents, s.status, s.approved_at, s.paid_at
    from statement s join property p on p.id = s.property_id
`;

/** F-70 — the property's own fee, or the portfolio's default when it has none. */
export async function feeBpsFor(portfolioId: string, propertyId: string): Promise<number> {
  const row = await queryOne<{ fee_bps: number | null; default_fee_bps: number }>(
    `select p.management_fee_bps as fee_bps, pf.default_management_fee_bps as default_fee_bps
       from property p join portfolio pf on pf.id = p.portfolio_id
      where p.id = $1 and pf.id = $2`,
    [propertyId, portfolioId]
  );
  if (!row) throw new NotFoundError('property');
  return row.fee_bps ?? row.default_fee_bps;
}

export interface StatementPreview {
  propertyId: string;
  propertyName: string;
  ownerName: string;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  expensesCents: number;
  feeBps: number;
  feeCents: number;
  netCents: number;
}

function monthBounds(month: string): { start: string; end: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new ValidationError('month must be YYYY-MM', 'month');
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  const start = new Date(Date.UTC(year, index, 1));
  const end = new Date(Date.UTC(year, index + 1, 1));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

/** F-71 — the numbers a statement *would* hold, computed the same way as the stored one. */
export async function previewStatement(
  portfolioId: string,
  propertyId: string,
  month: string
): Promise<StatementPreview> {
  const bounds = monthBounds(month);

  const property = await queryOne<{ id: string; name: string; owner_name: string | null }>(
    'select id, name, owner_name from property where id = $1 and portfolio_id = $2',
    [propertyId, portfolioId]
  );
  if (!property) throw new NotFoundError('property');

  const totals = await queryOne<{ revenue: string | number; expenses: string | number }>(
    `select
       coalesce(sum(case when t.kind = 'credit' and t.posted then t.amount_cents else 0 end), 0)::bigint as revenue,
       coalesce(sum(case when t.kind = 'debit' and t.posted then t.amount_cents else 0 end), 0)::bigint as expenses
     from transaction t
    where t.property_id = $1
      and t.occurred_on >= $2::date
      and t.occurred_on < $3::date`,
    [propertyId, bounds.start, bounds.end]
  );

  const gross = Number(totals?.revenue ?? 0);
  const expenses = Number(totals?.expenses ?? 0);
  const feeBps = await feeBpsFor(portfolioId, propertyId);
  const fee = Math.round((gross * feeBps) / 10_000);

  return {
    propertyId: property.id,
    propertyName: property.name,
    ownerName: property.owner_name ?? 'Owner',
    periodStart: bounds.start,
    periodEnd: bounds.end,
    grossCents: gross,
    expensesCents: expenses,
    feeBps,
    feeCents: fee,
    netCents: gross - expenses - fee,
  };
}

/** F-71 — the draft stores exactly the numbers the preview showed. */
export async function generateStatement(
  portfolioId: string,
  propertyId: string,
  month: string
): Promise<StatementRow> {
  const preview = await previewStatement(portfolioId, propertyId, month);

  const row = await queryOne<StatementDbRow>(
    `insert into statement (
       portfolio_id, property_id, owner_name, period_start, period_end,
       gross_cents, expenses_cents, fee_bps, fee_cents, net_cents, status
     )
     values ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, $10, 'draft')
     on conflict (property_id, period_start, period_end)
     do update set gross_cents = excluded.gross_cents,
                   expenses_cents = excluded.expenses_cents,
                   fee_bps = excluded.fee_bps,
                   fee_cents = excluded.fee_cents,
                   net_cents = excluded.net_cents
     returning id, property_id, (select name from property where id = statement.property_id) as property_name,
               owner_name, period_start, period_end, gross_cents, expenses_cents,
               fee_bps, fee_cents, net_cents, status, approved_at, paid_at`,
    [
      portfolioId,
      propertyId,
      preview.ownerName,
      preview.periodStart,
      preview.periodEnd,
      preview.grossCents,
      preview.expensesCents,
      preview.feeBps,
      preview.feeCents,
      preview.netCents,
    ]
  );
  if (!row) throw new Error('statement insert returned no row');
  return mapStatement(row);
}

/** F-68 / F-69 — the statements and the two money totals above them. */
export async function listStatements(portfolioId: string): Promise<{
  statements: StatementRow[];
  kpis: { awaitingReleaseCents: number; paidToOwnersCents: number; count: number };
}> {
  const rows = await query<StatementDbRow>(
    `${STATEMENT_SELECT} where s.portfolio_id = $1 order by s.period_start desc, p.name`,
    [portfolioId]
  );
  const statements = rows.map(mapStatement);

  const awaiting = statements
    .filter((statement) => statement.status === 'draft' || statement.status === 'approved')
    .reduce((sum, statement) => sum + statement.netCents, 0);
  const paid = statements
    .filter((statement) => statement.status === 'paid')
    .reduce((sum, statement) => sum + statement.netCents, 0);

  return {
    statements,
    kpis: { awaitingReleaseCents: awaiting, paidToOwnersCents: paid, count: statements.length },
  };
}

/** F-72 — draft → approved → paid, and nothing else. */
export async function transitionStatement(
  portfolioId: string,
  statementId: string,
  to: 'approved' | 'paid'
): Promise<StatementRow> {
  const row = await queryOne<{ status: 'draft' | 'approved' | 'paid' }>(
    `select status from statement where id = $1 and portfolio_id = $2`,
    [statementId, portfolioId]
  );
  if (!row) throw new NotFoundError('statement');

  if (to === 'approved' && row.status !== 'draft') {
    throw new ConflictError(`a ${row.status} statement cannot be approved`);
  }
  if (to === 'paid' && row.status !== 'approved') {
    throw new ConflictError(`a ${row.status} statement cannot be paid`);
  }

  const updated = await queryOne<StatementDbRow>(
    `update statement s
        set status = $3,
            approved_at = case when $3 = 'approved' then now() else s.approved_at end,
            paid_at = case when $3 = 'paid' then now() else s.paid_at end
       from property p
      where s.id = $1 and s.portfolio_id = $2 and p.id = s.property_id
      returning s.id, s.property_id, p.name as property_name, s.owner_name,
                s.period_start, s.period_end, s.gross_cents, s.expenses_cents,
                s.fee_bps, s.fee_cents, s.net_cents, s.status, s.approved_at, s.paid_at`,
    [statementId, portfolioId, to]
  );
  if (!updated) throw new NotFoundError('statement');
  return mapStatement(updated);
}
