/**
 * F-68 / F-69 — the statement "View" action (§7.4 #2 was a dead button).
 *
 * Draft detail is derived from the current ledger. Approval freezes the lines
 * into `statement_line`, so a later ledger entry cannot rewrite what an owner
 * already approved. Every line keeps the ids of the entries behind it, which
 * is what makes the drill-down honest.
 *
 * This module is intentionally independent of money.ts: it reads the statement
 * row directly and money.ts calls freezeLines() inside its approval transaction.
 */
import { withTransaction } from './db.ts';
import { NotFoundError } from './errors.ts';
import type { PoolClient } from 'pg';

export interface StatementEntry {
  id: string;
  occurredOn: string;
  description: string;
  category: string;
  amountCents: number;
  bookingReference: string | null;
  reversalOf: string | null;
}

export interface StatementLine {
  id: string | null;
  lineType: 'booking' | 'expense' | 'fee';
  label: string;
  /** Signed effect on the payout: revenue positive, expenses and fee negative. */
  amountCents: number;
  entryCount: number;
  entries: StatementEntry[];
}

export interface StatementDetail {
  statementId: string;
  propertyName: string;
  periodStart: string;
  periodEnd: string;
  status: 'draft' | 'approved' | 'paid';
  frozen: boolean;
  lines: StatementLine[];
  totalCents: number;
}

export interface DetailStatement {
  id: string;
  propertyId: string;
  propertyName: string;
  periodStart: string;
  periodEnd: string;
  feeBps: number;
  feeCents: number;
  status: StatementDetail['status'];
}

interface StatementRowDb {
  id: string;
  property_id: string;
  property_name: string;
  period_start: Date;
  period_end: Date;
  fee_bps: number;
  fee_cents: string | number;
  status: StatementDetail['status'];
}

interface DetailEntryRow {
  id: string;
  occurred_on: Date;
  description: string;
  category: string;
  amount_cents: string | number;
  booking_reference: string | null;
  reversal_of: string | null;
}

interface FrozenLineRow {
  id: string;
  line_type: StatementLine['lineType'];
  label: string;
  amount_cents: string | number;
  entry_count: number;
  source_ids: string[] | null;
}

const CATEGORY_LABEL: Record<string, string> = {
  booking_revenue: 'BOOKING REVENUE',
  housekeeping: 'HOUSEKEEPING',
  maintenance: 'MAINTENANCE',
  consumables: 'CONSUMABLES',
  utilities: 'UTILITIES',
  payout: 'PAYOUT',
};

const DETAIL_ENTRY_SELECT = `
  select t.id, t.occurred_on, t.description, t.category, t.amount_cents,
         b.reference as booking_reference, t.reversal_of
    from transaction t
    left join booking b on b.id = t.booking_id
`;

function dateOnly(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function mapDetailEntry(row: DetailEntryRow): StatementEntry {
  return {
    id: row.id,
    occurredOn: dateOnly(row.occurred_on),
    description: row.description,
    category: row.category,
    amountCents: Number(row.amount_cents),
    bookingReference: row.booking_reference,
    reversalOf: row.reversal_of,
  };
}

function mapStatement(row: StatementRowDb): DetailStatement {
  return {
    id: row.id,
    propertyId: row.property_id,
    propertyName: row.property_name,
    periodStart: dateOnly(row.period_start),
    periodEnd: dateOnly(row.period_end),
    feeBps: row.fee_bps,
    feeCents: Number(row.fee_cents),
    status: row.status,
  };
}

async function deriveLines(client: PoolClient, statement: DetailStatement): Promise<StatementLine[]> {
  const result = await client.query<DetailEntryRow>(
    `${DETAIL_ENTRY_SELECT}
      where t.property_id = $1 and t.occurred_on >= $2::date and t.occurred_on < $3::date
        and t.posted
      order by t.occurred_on, t.created_at, t.id`,
    [statement.propertyId, statement.periodStart, statement.periodEnd]
  );

  const grouped = new Map<string, StatementLine>();
  for (const row of result.rows) {
    const entry = mapDetailEntry(row);
    const isBooking = row.category === 'booking_revenue';
    const key = isBooking ? `booking:${row.booking_reference ?? entry.id}` : `expense:${row.category}`;
    let line = grouped.get(key);
    if (!line) {
      line = {
        id: null,
        lineType: isBooking ? 'booking' : 'expense',
        label: isBooking
          ? entry.description
          : CATEGORY_LABEL[row.category] ?? row.category.toUpperCase(),
        amountCents: 0,
        entryCount: 0,
        entries: [],
      };
      grouped.set(key, line);
    }
    // Both booking entries and expenses already carry their sign in the
    // append-only ledger: a credit is positive, an expense or reversal is
    // negative. The line is simply their sum.
    line.amountCents += entry.amountCents;
    line.entryCount += 1;
    line.entries.push(entry);
  }

  const rank = { booking: 0, expense: 1, fee: 2 } as const;
  const lines = [...grouped.values()].sort(
    (a, b) => rank[a.lineType] - rank[b.lineType] || a.label.localeCompare(b.label)
  );
  lines.push({
    id: null,
    lineType: 'fee',
    label: `Management fee (${Number((statement.feeBps / 100).toFixed(2))} %)`,
    amountCents: -statement.feeCents,
    entryCount: 0,
    entries: [],
  });
  return lines;
}

async function frozenLines(client: PoolClient, rows: FrozenLineRow[]): Promise<StatementLine[]> {
  const ids = rows.flatMap((row) => row.source_ids ?? []);
  const result = ids.length
    ? await client.query<DetailEntryRow>(`${DETAIL_ENTRY_SELECT} where t.id = any($1::uuid[])`, [ids])
    : { rows: [] as DetailEntryRow[] };
  const byId = new Map(result.rows.map((row) => [row.id, mapDetailEntry(row)]));

  return rows.map((row) => ({
    id: row.id,
    lineType: row.line_type,
    label: row.label,
    amountCents: Number(row.amount_cents),
    entryCount: row.entry_count,
    entries: (row.source_ids ?? [])
      .map((id) => byId.get(id))
      .filter((entry): entry is StatementEntry => entry !== undefined),
  }));
}

/** Called inside the approval transaction, before the statement is readable. */
export async function freezeLines(client: PoolClient, statement: DetailStatement): Promise<void> {
  const lines = await deriveLines(client, statement);
  await client.query('delete from statement_line where statement_id = $1', [statement.id]);
  for (const [index, line] of lines.entries()) {
    await client.query(
      `insert into statement_line (
         statement_id, line_type, label, amount_cents, entry_count, source_ids, sort_order
       ) values ($1, $2, $3, $4, $5, $6::uuid[], $7)`,
      [
        statement.id,
        line.lineType,
        line.label,
        line.amountCents,
        line.entryCount,
        line.entries.map((entry) => entry.id),
        index,
      ]
    );
  }
}

/** F-68 detail — the numbers behind the statement, and the entries behind them. */
export async function statementDetail(
  portfolioId: string,
  statementId: string
): Promise<StatementDetail> {
  return withTransaction(async (client) => {
    const result = await client.query<StatementRowDb>(
      `select s.id, s.property_id, p.name as property_name, s.period_start, s.period_end,
              s.fee_bps, s.fee_cents, s.status
         from statement s join property p on p.id = s.property_id
        where s.id = $1 and s.portfolio_id = $2`,
      [statementId, portfolioId]
    );
    const dbRow = result.rows[0];
    if (!dbRow) throw new NotFoundError('statement');
    const statement = mapStatement(dbRow);

    const rowsResult = await client.query<FrozenLineRow>(
      `select id, line_type, label, amount_cents, entry_count, source_ids
         from statement_line where statement_id = $1 order by sort_order`,
      [statement.id]
    );
    const frozen = statement.status !== 'draft' && rowsResult.rows.length > 0;
    const lines = frozen
      ? await frozenLines(client, rowsResult.rows)
      : await deriveLines(client, statement);

    return {
      statementId: statement.id,
      propertyName: statement.propertyName,
      periodStart: statement.periodStart,
      periodEnd: statement.periodEnd,
      status: statement.status,
      frozen,
      lines,
      totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
    };
  });
}
