import { useCallback, useEffect, useState } from 'react';
import { getJson, money, moneyCompact, sendJson } from './client.ts';
import { useToast } from './toast.tsx';

/**
 * F-68 statement KPIs · F-69 statement table · F-71 generate a statement
 * F-72 statement statuses
 *
 * A statement is a snapshot: what it says today is what it said yesterday, and
 * a rate change next month cannot rewrite it.
 */

interface Statement {
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
}

interface Preview {
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

interface PropertyOption {
  propertyId: string;
  propertyName: string;
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  approved: 'Approved',
  paid: 'Paid',
};

function monthName(value: string): string {
  const date = new Date(`${value}-01T00:00:00.000Z`);
  return date.toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' });
}

export function Payouts() {
  const toast = useToast();
  const [statements, setStatements] = useState<Statement[]>([]);
  const [kpis, setKpis] = useState<{ awaitingReleaseCents: number; paidToOwnersCents: number; count: number } | null>(
    null
  );
  const [properties, setProperties] = useState<PropertyOption[]>([]);
  const [propertyId, setPropertyId] = useState('');
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [data, performance] = await Promise.all([
        getJson<{
          statements: Statement[];
          kpis: { awaitingReleaseCents: number; paidToOwnersCents: number; count: number };
        }>('/api/statements'),
        getJson<{ properties: Array<{ propertyId: string; propertyName: string }> }>(
          '/api/financials/performance'
        ),
      ]);
      setStatements(data.statements);
      setKpis(data.kpis);
      setProperties(performance.properties);
      setError(null);
    } catch {
      setError('Could not load the statements.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!propertyId) {
      setPreview(null);
      return;
    }
    getJson<{ preview: Preview }>(`/api/statements/preview?propertyId=${propertyId}&month=${month}`)
      .then((data) => setPreview(data.preview))
      .catch(() => setPreview(null));
  }, [propertyId, month]);

  async function generate() {
    if (!propertyId) {
      toast('Choose a property first', 'error');
      return;
    }
    try {
      await sendJson('POST', '/api/statements', { propertyId, month });
      toast('Statement drafted');
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not create that statement', 'error');
    }
  }

  async function move(statement: Statement, action: 'approve' | 'pay') {
    try {
      await sendJson('POST', `/api/statements/${statement.id}/${action}`, {});
      toast(action === 'approve' ? 'Statement approved' : 'Statement marked paid');
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not move that statement', 'error');
    }
  }

  if (error) {
    return (
      <p className="alert" role="alert">
        {error}
      </p>
    );
  }

  return (
    <div className="stack">
      <section className="kpis" aria-label="Payouts">
        <article className="kpi" data-kpi="awaiting-release">
          <span className="kpi-label">Awaiting release</span>
          <strong className="kpi-value">
            {kpis ? moneyCompact(kpis.awaitingReleaseCents) : '—'}
          </strong>
          <span className="kpi-note">drafts and approved statements</span>
        </article>
        <article className="kpi" data-kpi="paid-to-owners">
          <span className="kpi-label">Paid to owners</span>
          <strong className="kpi-value">{kpis ? moneyCompact(kpis.paidToOwnersCents) : '—'}</strong>
          <span className="kpi-note">settled statements</span>
        </article>
        <article className="kpi" data-kpi="statement-count">
          <span className="kpi-label">Statements</span>
          <strong className="kpi-value">{kpis?.count ?? 0}</strong>
          <span className="kpi-note">across every property</span>
        </article>
      </section>

      <section className="panel" aria-labelledby="generate-title">
        <header className="panel-head">
          <h2 id="generate-title">Generate a statement</h2>
          <p>The preview and the stored draft hold exactly the same numbers.</p>
        </header>
        <div className="statement-form">
          <div className="field">
            <label htmlFor="statement-property">Property</label>
            <select
              id="statement-property"
              value={propertyId}
              onChange={(event) => setPropertyId(event.target.value)}
            >
              <option value="">Choose…</option>
              {properties.map((option) => (
                <option key={option.propertyId} value={option.propertyId}>
                  {option.propertyName}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="statement-month">Month</label>
            <input
              id="statement-month"
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
            />
          </div>
          <button type="button" className="btn btn-primary" onClick={generate}>
            Create draft
          </button>
        </div>

        {preview ? (
          <dl className="statement-preview" data-testid="statement-preview">
            <div>
              <dt>Gross revenue</dt>
              <dd>{money(preview.grossCents)}</dd>
            </div>
            <div>
              <dt>Operating expenses</dt>
              <dd>{money(preview.expensesCents)}</dd>
            </div>
            <div>
              <dt>Management fee ({preview.feeBps / 100} %)</dt>
              <dd>{money(preview.feeCents)}</dd>
            </div>
            <div>
              <dt>Owner payout</dt>
              <dd>
                <strong>{money(preview.netCents)}</strong>
              </dd>
            </div>
          </dl>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="statements-title">
        <header className="panel-head">
          <h2 id="statements-title">Statements</h2>
          <p>Property, owner, period and the money.</p>
        </header>
        {statements.length === 0 ? (
          <p className="board-empty" style={{ padding: '18px' }}>
            No statements yet.
          </p>
        ) : (
          <table className="table" data-testid="statement-table">
            <thead>
              <tr>
                <th scope="col">Property</th>
                <th scope="col">Owner</th>
                <th scope="col">Period</th>
                <th scope="col">Gross</th>
                <th scope="col">Expenses</th>
                <th scope="col">Fee</th>
                <th scope="col">Net payout</th>
                <th scope="col">Status</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {statements.map((statement) => (
                <tr key={statement.id} data-statement={statement.id} data-status={statement.status}>
                  <th scope="row">{statement.propertyName}</th>
                  <td>{statement.ownerName}</td>
                  <td>
                    {monthName(statement.periodStart.slice(0, 7))}
                  </td>
                  <td>{money(statement.grossCents)}</td>
                  <td>{money(statement.expensesCents)}</td>
                  <td>
                    {money(statement.feeCents)}
                    <small className="cell-note">{statement.feeBps / 100} %</small>
                  </td>
                  <td>{money(statement.netCents)}</td>
                  <td>
                    <span className={`status status-${statement.status}`}>
                      {STATUS_LABEL[statement.status]}
                    </span>
                  </td>
                  <td>
                    {statement.status === 'draft' ? (
                      <button
                        type="button"
                        className="btn"
                        data-action="approve"
                        onClick={() => move(statement, 'approve')}
                      >
                        Approve
                      </button>
                    ) : null}
                    {statement.status === 'approved' ? (
                      <button
                        type="button"
                        className="btn"
                        data-action="pay"
                        onClick={() => move(statement, 'pay')}
                      >
                        Mark paid
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
