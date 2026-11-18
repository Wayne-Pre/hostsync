import { useCallback, useEffect, useState } from 'react';
import { getJson, money, moneyCompact, sendJson } from './client.ts';
import { useToast } from './toast.tsx';

/**
 * F-62 KPIs · F-63 six-month chart · F-64 accounts · F-65 performance
 * F-66 transaction feed · F-67 record an expense
 */

interface Kpis {
  revenueCents: number;
  expensesCents: number;
  netIncomeCents: number;
  outstandingCents: number;
}

interface Bucket {
  month: string;
  revenueCents: number;
  expensesCents: number;
}

interface Transaction {
  id: string;
  kind: 'credit' | 'debit';
  categoryLabel: string;
  amountCents: number;
  description: string;
  occurredOn: string;
  posted: boolean;
  propertyName: string | null;
  accountLabel: string | null;
}

interface Account {
  propertyId: string;
  propertyName: string;
  label: string;
  verified: boolean;
  balanceCents: number;
}

interface Performance {
  propertyId: string;
  propertyName: string;
  revenueCents: number;
  expensesCents: number;
  netCents: number;
  feeBps: number;
  feeCents: number;
  accountLabel: string | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabel(key: string): string {
  const [year, month] = key.split('-');
  return `${MONTHS[Number(month) - 1] ?? key} ${String(year).slice(2)}`;
}

export function Financials() {
  const toast = useToast();
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [series, setSeries] = useState<Bucket[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [performance, setPerformance] = useState<Performance[]>([]);
  const [currency, setCurrency] = useState('KES');
  const [filter, setFilter] = useState<'all' | 'revenue' | 'expenses'>('all');
  const [seriesView, setSeriesView] = useState<'revenue' | 'expenses'>('revenue');
  const [error, setError] = useState<string | null>(null);

  const [expense, setExpense] = useState({
    propertyId: '',
    date: new Date().toISOString().slice(0, 10),
    category: 'housekeeping',
    amount: '',
    description: '',
    paidTo: '',
  });

  const load = useCallback(async (nextFilter: 'all' | 'revenue' | 'expenses') => {
    try {
      const [financials, feed, accountList, performanceRows] = await Promise.all([
        getJson<{ currency: string; kpis: Kpis; series: Bucket[] }>('/api/financials'),
        getJson<{ transactions: Transaction[] }>(`/api/transactions?filter=${nextFilter}`),
        getJson<{ accounts: Account[] }>('/api/financials/accounts'),
        getJson<{ properties: Performance[] }>('/api/financials/performance'),
      ]);
      setCurrency(financials.currency);
      setKpis(financials.kpis);
      setSeries(financials.series);
      setTransactions(feed.transactions);
      setAccounts(accountList.accounts);
      setPerformance(performanceRows.properties);
      setError(null);
    } catch {
      setError('Could not load the financials.');
    }
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  async function recordExpense() {
    const amount = Number(expense.amount);
    if (!expense.propertyId || !expense.description.trim() || !Number.isFinite(amount) || amount <= 0) {
      toast('A property, an amount and a description are needed', 'error');
      return;
    }
    try {
      await sendJson('POST', '/api/transactions/expense', {
        propertyId: expense.propertyId,
        date: expense.date,
        category: expense.category,
        amountCents: Math.round(amount * 100),
        description: expense.description,
        paidTo: expense.paidTo || null,
      });
      toast('Expense recorded');
      setExpense({ ...expense, amount: '', description: '', paidTo: '' });
      await load(filter);
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not record that expense', 'error');
    }
  }

  if (error) {
    return (
      <p className="alert" role="alert">
        {error}
      </p>
    );
  }
  if (!kpis) return <p className="loading">Loading the financials…</p>;

  const peak = Math.max(1, ...series.map((bucket) => Math.max(bucket.revenueCents, bucket.expensesCents)));

  return (
    <div className="stack">
      <section className="kpis" aria-label="Money">
        <article className="kpi" data-kpi="revenue">
          <span className="kpi-label">Revenue this month</span>
          <strong className="kpi-value">{moneyCompact(kpis.revenueCents, currency)}</strong>
          <span className="kpi-note">{money(kpis.revenueCents, currency)} posted</span>
        </article>
        <article className="kpi" data-kpi="expenses">
          <span className="kpi-label">Expenses</span>
          <strong className="kpi-value">{moneyCompact(kpis.expensesCents, currency)}</strong>
          <span className="kpi-note">operating costs this month</span>
        </article>
        <article className="kpi" data-kpi="net-income">
          <span className="kpi-label">Net income</span>
          <strong className="kpi-value">{moneyCompact(kpis.netIncomeCents, currency)}</strong>
          <span className="kpi-note">before owner payouts</span>
        </article>
        <article className="kpi" data-kpi="outstanding">
          <span className="kpi-label">Outstanding</span>
          <strong className="kpi-value">{moneyCompact(kpis.outstandingCents, currency)}</strong>
          <span className="kpi-note">unpaid stays</span>
        </article>
      </section>

      <section className="panel" aria-labelledby="chart-title">
        <header className="panel-head chart-head">
          <h2 id="chart-title">Last six months</h2>
          <div className="toggle" role="group" aria-label="Chart series">
            <button
              type="button"
              className={`toggle-btn${seriesView === 'revenue' ? ' is-on' : ''}`}
              onClick={() => setSeriesView('revenue')}
            >
              Revenue
            </button>
            <button
              type="button"
              className={`toggle-btn${seriesView === 'expenses' ? ' is-on' : ''}`}
              onClick={() => setSeriesView('expenses')}
            >
              Expenses
            </button>
          </div>
        </header>
        <div className="bars" data-testid="chart">
          {series.map((bucket) => {
            const value = seriesView === 'revenue' ? bucket.revenueCents : bucket.expensesCents;
            const height = Math.round((value / peak) * 100);
            return (
              <div className="bar-col" key={bucket.month} data-month={bucket.month}>
                <span className="bar-value">{moneyCompact(value, currency)}</span>
                <div className={`bar is-${seriesView}`} style={{ height: `${Math.max(2, height)}%` }} />
                <span className="bar-label">{monthLabel(bucket.month)}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="split">
        <div className="panel">
          <header className="panel-head">
            <h2>Settling accounts</h2>
            <p>One card per property account.</p>
          </header>
          {accounts.length === 0 ? (
            <p className="board-empty" style={{ padding: '18px' }}>
              No accounts yet.
            </p>
          ) : (
            <ul className="request-list" data-testid="accounts">
              {accounts.map((account) => (
                <li key={account.propertyId}>
                  <span>
                    {account.propertyName} · {account.label}
                    <small className="cell-note">
                      {account.verified ? 'Verified' : 'Pending'}
                    </small>
                  </span>
                  <strong>{money(account.balanceCents, currency)}</strong>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="panel">
          <header className="panel-head">
            <h2>Record an expense</h2>
            <p>Charges the property’s own account, so the statements stay accurate.</p>
          </header>
          <div className="expense-form">
            <div className="field">
              <label htmlFor="expense-property">Property</label>
              <select
                id="expense-property"
                value={expense.propertyId}
                onChange={(event) => setExpense({ ...expense, propertyId: event.target.value })}
              >
                <option value="">Choose…</option>
                {performance.map((row) => (
                  <option key={row.propertyId} value={row.propertyId}>
                    {row.propertyName}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="expense-category">Category</label>
              <select
                id="expense-category"
                value={expense.category}
                onChange={(event) => setExpense({ ...expense, category: event.target.value })}
              >
                <option value="housekeeping">Housekeeping</option>
                <option value="maintenance">Maintenance</option>
                <option value="consumables">Consumables</option>
                <option value="utilities">Utilities</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="expense-date">Date</label>
              <input
                id="expense-date"
                type="date"
                value={expense.date}
                onChange={(event) => setExpense({ ...expense, date: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="expense-amount">Amount ({currency})</label>
              <input
                id="expense-amount"
                inputMode="decimal"
                value={expense.amount}
                onChange={(event) => setExpense({ ...expense, amount: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="expense-description">What was it</label>
              <input
                id="expense-description"
                value={expense.description}
                onChange={(event) => setExpense({ ...expense, description: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="expense-paid-to">Paid to</label>
              <input
                id="expense-paid-to"
                value={expense.paidTo}
                onChange={(event) => setExpense({ ...expense, paidTo: event.target.value })}
              />
            </div>
            <button type="button" className="btn btn-primary" onClick={recordExpense}>
              Record expense
            </button>
          </div>
        </div>
      </section>

      <section className="panel" aria-labelledby="performance-title">
        <header className="panel-head">
          <h2 id="performance-title">Property performance</h2>
          <p>All time, after the management fee.</p>
        </header>
        <table className="table" data-testid="performance-table">
          <thead>
            <tr>
              <th scope="col">Property</th>
              <th scope="col">Revenue</th>
              <th scope="col">Expenses</th>
              <th scope="col">Fee</th>
              <th scope="col">Net</th>
              <th scope="col">Account</th>
            </tr>
          </thead>
          <tbody>
            {performance.map((row) => (
              <tr key={row.propertyId}>
                <th scope="row">{row.propertyName}</th>
                <td>{money(row.revenueCents, currency)}</td>
                <td>{money(row.expensesCents, currency)}</td>
                <td>
                  {money(row.feeCents, currency)}
                  <small className="cell-note">{row.feeBps / 100} %</small>
                </td>
                <td>{money(row.netCents, currency)}</td>
                <td>{row.accountLabel ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel" aria-labelledby="feed-title">
        <header className="panel-head chart-head">
          <h2 id="feed-title">Transactions</h2>
          <div className="toggle" role="group" aria-label="Filter">
            {(['all', 'revenue', 'expenses'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`toggle-btn${filter === option ? ' is-on' : ''}`}
                onClick={() => setFilter(option)}
              >
                {option === 'all' ? 'All' : option === 'revenue' ? 'Revenue' : 'Expenses'}
              </button>
            ))}
          </div>
        </header>
        <table className="table" data-testid="transaction-feed">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Description</th>
              <th scope="col">Category</th>
              <th scope="col">Property</th>
              <th scope="col">Account</th>
              <th scope="col">Amount</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((entry) => (
              <tr key={entry.id} data-kind={entry.kind}>
                <td>{entry.occurredOn}</td>
                <td>{entry.description}</td>
                <td>{entry.categoryLabel}</td>
                <td>{entry.propertyName ?? '—'}</td>
                <td>{entry.accountLabel ?? '—'}</td>
                <td className={entry.amountCents < 0 ? 'amount-negative' : 'amount-positive'}>
                  {money(entry.amountCents, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
