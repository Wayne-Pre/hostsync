import { useEffect, useState } from 'react';
import { getJson, money, moneyCompact } from './client.ts';

/**
 * F-14 KPI strip · F-15 revenue & occupancy chart · F-16 calendar-clear card
 * F-17 payout widget · F-18 turnovers in the next 48 h · F-19 health table
 * F-20 empty state
 */

interface ChartBucket {
  month: string;
  revenueCents: number;
  nights: number;
  occupancyPct: number;
}

interface TurnoverRow {
  id: string;
  propertyName: string;
  windowStart: string;
  windowEnd: string;
  assignee: string | null;
  status: string;
}

interface DashboardData {
  currency: string;
  kpis: {
    netRevenueThisMonthCents: number;
    occupancyLast30Pct: number;
    turnoversDue48h: number;
    guestRating: number | null;
    reviewCount: number;
  };
  calendarClear: { clear: boolean; conflicts: number; label: string; detail: string };
  chart: ChartBucket[];
  payouts: { amountCents: number; count: number };
  turnovers: TurnoverRow[];
  health: Array<{
    propertyId: string;
    name: string;
    status: string;
    occupancyPct: number;
    nextArrival: string | null;
    nextArrivalLabel: string;
    account: { label: string; verified: boolean; balanceCents: number } | null;
    nightlyRateCents: number;
  }>;
}

const CHECKLIST = [
  'Add your first property — rate, cleaning fee, owner',
  'Paste the Airbnb or Booking.com calendar link',
  'Confirm the first imported stay',
  'Open the calendar and check the week holds',
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabel(key: string): string {
  const [year, month] = key.split('-');
  return `${MONTHS[Number(month) - 1] ?? key} ${String(year).slice(2)}`;
}

/** "Tue 18 Nov · 11:00–15:00" — the window a cleaner can act on. */
function windowLabel(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const day = start.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
  const time = (value: Date) =>
    value.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} · ${time(start)}–${time(end)}`;
}

function statusLabel(status: string): string {
  return status
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seriesView, setSeriesView] = useState<'revenue' | 'occupancy'>('revenue');

  useEffect(() => {
    getJson<DashboardData>('/api/dashboard').then(setData).catch(() => setError('Could not load the dashboard.'));
  }, []);

  if (error) {
    return (
      <p className="alert" role="alert">
        {error}
      </p>
    );
  }

  if (!data) {
    return <p className="loading">Loading the workspace…</p>;
  }

  if (data.health.length === 0) {
    return <EmptyState />;
  }

  const { kpis, currency } = data;
  const chartPeak = Math.max(
    1,
    ...data.chart.map((bucket) =>
      seriesView === 'revenue' ? bucket.revenueCents : bucket.occupancyPct
    )
  );

  return (
    <div className="stack">
      <section className="kpis" aria-label="Key numbers">
        <article className="kpi" data-kpi="revenue">
          <span className="kpi-label">Net revenue this month</span>
          <strong className="kpi-value">{moneyCompact(kpis.netRevenueThisMonthCents, currency)}</strong>
          <span className="kpi-note">{money(kpis.netRevenueThisMonthCents, currency)} posted</span>
        </article>
        <article className="kpi" data-kpi="occupancy">
          <span className="kpi-label">Occupancy last 30 days</span>
          <strong className="kpi-value">{kpis.occupancyLast30Pct} %</strong>
          <span className="kpi-note">across every live property</span>
        </article>
        <article className="kpi" data-kpi="turnovers">
          <span className="kpi-label">Turnovers next 48 h</span>
          <strong className="kpi-value">{kpis.turnoversDue48h}</strong>
          <span className="kpi-note">scheduled or in progress</span>
        </article>
        <article className="kpi" data-kpi="rating">
          <span className="kpi-label">Guest rating</span>
          <strong className="kpi-value">
            {kpis.guestRating === null ? '—' : kpis.guestRating.toFixed(2)}
          </strong>
          <span className="kpi-note">
            {kpis.reviewCount} review{kpis.reviewCount === 1 ? '' : 's'}
          </span>
        </article>
      </section>

      <section className="split">
        <div className="panel" aria-labelledby="dashboard-chart-title">
          <header className="panel-head chart-head">
            <h2 id="dashboard-chart-title">Last six months</h2>
            <div className="toggle" role="group" aria-label="Chart series">
              <button
                type="button"
                className={`toggle-btn${seriesView === 'revenue' ? ' is-on' : ''}`}
                aria-pressed={seriesView === 'revenue'}
                onClick={() => setSeriesView('revenue')}
              >
                Revenue
              </button>
              <button
                type="button"
                className={`toggle-btn${seriesView === 'occupancy' ? ' is-on' : ''}`}
                aria-pressed={seriesView === 'occupancy'}
                onClick={() => setSeriesView('occupancy')}
              >
                Occupancy
              </button>
            </div>
          </header>
          <div className="bars" data-testid="dashboard-chart" data-series={seriesView}>
            {data.chart.map((bucket) => {
              const value = seriesView === 'revenue' ? bucket.revenueCents : bucket.occupancyPct;
              const height = Math.round((value / chartPeak) * 100);
              return (
                <div
                  className="bar-col"
                  key={bucket.month}
                  data-month={bucket.month}
                  data-value={value}
                >
                  <span className="bar-value">
                    {seriesView === 'revenue' ? moneyCompact(value, currency) : `${value} %`}
                  </span>
                  <div
                    className={`bar is-${seriesView}`}
                    style={{ height: `${Math.max(2, height)}%` }}
                  />
                  <span className="bar-label">{monthLabel(bucket.month)}</span>
                </div>
              );
            })}
          </div>
        </div>

        <aside className="panel" data-testid="payout-widget">
          <header className="panel-head">
            <h2>Payout run</h2>
            <p>What owners are owed right now.</p>
          </header>
          <div className="kpi" data-payout="due">
            <span className="kpi-label">Payable to owners</span>
            <strong className="kpi-value">{moneyCompact(data.payouts.amountCents, currency)}</strong>
            <span className="kpi-note">
              {money(data.payouts.amountCents, currency)} across {data.payouts.count} statement
              {data.payouts.count === 1 ? '' : 's'}
            </span>
          </div>
          <a className="btn" href="/payouts">
            Open payouts
          </a>
        </aside>
      </section>

      <section className="panel" aria-labelledby="turnovers-title">
        <header className="panel-head">
          <h2 id="turnovers-title">Turnovers in the next 48 hours</h2>
          <p>Scheduled or in progress — the work that cannot wait.</p>
        </header>
        {data.turnovers.length === 0 ? (
          <p className="board-empty" style={{ padding: '18px' }}>
            Nothing due in the next 48 hours.
          </p>
        ) : (
          <table className="table" data-testid="dashboard-turnovers">
            <thead>
              <tr>
                <th scope="col">Property</th>
                <th scope="col">Window</th>
                <th scope="col">Assignee</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.turnovers.map((row) => (
                <tr key={row.id} data-task={row.id}>
                  <th scope="row">{row.propertyName}</th>
                  <td>{windowLabel(row.windowStart, row.windowEnd)}</td>
                  <td>{row.assignee ?? 'Unassigned'}</td>
                  <td>
                    <span className={`status status-${row.status}`}>{statusLabel(row.status)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section
        className={`clear-card${data.calendarClear.clear ? ' is-clear' : ' is-conflict'}`}
        data-testid="calendar-clear"
        data-state={data.calendarClear.clear ? 'clear' : 'conflict'}
      >
        <div>
          <strong className="clear-label">{data.calendarClear.label}</strong>
          <p className="clear-detail">{data.calendarClear.detail}</p>
        </div>
        <a className="btn" href="/calendar">
          Open calendar
        </a>
      </section>

      <section className="panel" aria-labelledby="health-title">
        <header className="panel-head">
          <h2 id="health-title">Portfolio health</h2>
          <p>{data.health.length} properties · next arrival, occupancy and the account that settles it.</p>
        </header>
        <table className="table" data-testid="health-table">
          <thead>
            <tr>
              <th scope="col">Property</th>
              <th scope="col">Occupancy</th>
              <th scope="col">Next arrival</th>
              <th scope="col">Settling account</th>
              <th scope="col">Rate</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.health.map((row) => (
              <tr key={row.propertyId} data-property={row.propertyId}>
                <th scope="row">{row.name}</th>
                <td>{row.occupancyPct} %</td>
                <td>{row.nextArrival ? row.nextArrivalLabel : '—'}</td>
                <td>
                  {row.account ? (
                    <>
                      <span>{row.account.label}</span>
                      <small className="cell-note">
                        {money(row.account.balanceCents, currency)}
                        {row.account.verified ? ' · Verified' : ' · Pending'}
                      </small>
                    </>
                  ) : (
                    <span className="muted">Not set</span>
                  )}
                </td>
                <td>{money(row.nightlyRateCents, currency)}</td>
                <td>
                  <span className={`status status-${row.status}`}>
                    {row.status === 'live' ? 'Live' : 'Onboarding'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function EmptyState() {
  return (
    <section className="empty" data-testid="empty-state">
      <h2>No properties yet</h2>
      <p>Add one property and the calendar starts holding nights in the same minute.</p>
      <ol className="checklist">
        {CHECKLIST.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ol>
      <a className="btn btn-primary" href="/properties">
        Add your first property
      </a>
    </section>
  );
}
