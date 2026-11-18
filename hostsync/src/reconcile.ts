/**
 * Nightly reconciliation (spec §6.3): booking money vs ledger entries vs the
 * statement that was made from them vs the settling account.
 *
 * Every comparison is in integer cents. A nonzero result is drift: a bug that
 * cannot be seen on any single screen. The job never repairs anything by
 * itself — money is append-only, so a repair is a deliberate reversing entry.
 */
import { query, queryOne } from './db.ts';

export interface DriftRow {
  kind: 'booking' | 'statement' | 'account';
  ref: string;
  expectedCents: number;
  actualCents: number;
  detail: string;
}

export interface Reconciliation {
  balanced: boolean;
  checked: { bookings: number; statements: number; accounts: number; entries: number };
  drift: DriftRow[];
}

export async function reconcilePortfolio(portfolioId: string): Promise<Reconciliation> {
  const counts = await queryOne<{
    bookings: string | number;
    statements: string | number;
    accounts: string | number;
    entries: string | number;
  }>(
    `select
       (select count(*) from booking b join property p on p.id = b.property_id
         where p.portfolio_id = $1)::bigint as bookings,
       (select count(*) from statement where portfolio_id = $1)::bigint as statements,
       (select count(*) from property_account a join property p on p.id = a.property_id
         where p.portfolio_id = $1)::bigint as accounts,
       (select count(*) from transaction where portfolio_id = $1)::bigint as entries`,
    [portfolioId]
  );

  // Paid stays must have exactly their gross in the ledger; unpaid stays must
  // have none. Reversals are included in the sum, so a paid → unpaid flip is
  // reconciled without a special case.
  const bookings = await query<{
    ref: string;
    expected: string | number;
    actual: string | number;
  }>(
    `select b.reference as ref,
            (case when b.payment_status = 'paid' then b.gross_cents else 0 end)::bigint as expected,
            coalesce(sum(t.amount_cents), 0)::bigint as actual
       from booking b
       join property p on p.id = b.property_id
       left join transaction t on t.booking_id = b.id and t.category = 'booking_revenue'
      where p.portfolio_id = $1
      group by b.id, b.reference, b.payment_status, b.gross_cents
     having (case when b.payment_status = 'paid' then b.gross_cents else 0 end)
            <> coalesce(sum(t.amount_cents), 0)`,
    [portfolioId]
  );

  // A statement is a snapshot: its gross and expenses must still match the
  // ledger entries in its period. If they do not, a month was closed over a
  // changed ledger and needs a deliberate correction.
  const statements = await query<{
    ref: string;
    expected: string | number;
    actual: string | number;
    detail: string;
  }>(
    `with checks as (
       select s.id::text as ref, s.gross_cents as expected,
              coalesce((
                select sum(t.amount_cents) from transaction t
                 where t.property_id = s.property_id
                   and t.category = 'booking_revenue'
                   and t.occurred_on >= s.period_start
                   and t.occurred_on < s.period_end
              ), 0)::bigint as actual,
              'gross' as detail
         from statement s where s.portfolio_id = $1
       union all
       select s.id::text as ref, s.expenses_cents as expected,
              coalesce((
                select sum(-t.amount_cents) from transaction t
                 where t.property_id = s.property_id
                   and t.category <> 'booking_revenue'
                   and t.occurred_on >= s.period_start
                   and t.occurred_on < s.period_end
              ), 0)::bigint as actual,
              'expenses' as detail
         from statement s where s.portfolio_id = $1
     )
     select ref, expected, actual, detail from checks where expected <> actual`,
    [portfolioId]
  );

  // The stored balance is a cache. The ledger + the opening balance is the
  // truth; if they disagree the account card must not be trusted.
  const accounts = await query<{
    ref: string;
    expected: string | number;
    actual: string | number;
  }>(
    `select p.name as ref,
            (a.opening_balance_cents + coalesce(sum(t.amount_cents), 0))::bigint as expected,
            a.balance_cents as actual
       from property_account a
       join property p on p.id = a.property_id
       left join transaction t on t.property_id = a.property_id
      where p.portfolio_id = $1
      group by a.property_id, p.name, a.opening_balance_cents, a.balance_cents
     having a.balance_cents <> (a.opening_balance_cents + coalesce(sum(t.amount_cents), 0))`,
    [portfolioId]
  );

  const drift: DriftRow[] = [
    ...bookings.map((row) => ({
      kind: 'booking' as const,
      ref: row.ref,
      expectedCents: Number(row.expected),
      actualCents: Number(row.actual),
      detail: 'booking credit vs ledger',
    })),
    ...statements.map((row) => ({
      kind: 'statement' as const,
      ref: row.ref,
      expectedCents: Number(row.expected),
      actualCents: Number(row.actual),
      detail: `statement ${row.detail} vs ledger`,
    })),
    ...accounts.map((row) => ({
      kind: 'account' as const,
      ref: row.ref,
      expectedCents: Number(row.expected),
      actualCents: Number(row.actual),
      detail: 'derived balance vs stored balance',
    })),
  ];

  return {
    balanced: drift.length === 0,
    checked: {
      bookings: Number(counts?.bookings ?? 0),
      statements: Number(counts?.statements ?? 0),
      accounts: Number(counts?.accounts ?? 0),
      entries: Number(counts?.entries ?? 0),
    },
    drift,
  };
}
