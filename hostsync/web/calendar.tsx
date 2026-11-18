import { useCallback, useEffect, useState } from 'react';
import {
  dayLabel,
  getJson,
  nightsBetween,
  sendJson,
  addDays,
  todayIso,
} from './client.ts';
import { BookingSheet } from './bookingSheet.tsx';
import { useToast } from './toast.tsx';
import { rangeLabel } from '../shared/calendarLabel.ts';

/**
 * F-37 grid · F-38 date navigation · F-39 legend · F-40 sync health
 * F-41 overlap flagging · F-42 cell opens the booking sheet
 *
 * The window lives in the URL (`?from=`), so a refresh, a bookmark and a shared
 * link all show the same week — and "Next week" is a plain 7-day step.
 */

interface CalendarBar {
  id: string;
  reference: string;
  guestName: string;
  channel: string;
  status: string;
  checkIn: string;
  checkOut: string;
  startIndex: number;
  endIndex: number;
  overlaps: string[];
}

interface CalendarRow {
  propertyId: string;
  name: string;
  status: string;
  bars: CalendarBar[];
}

interface CalendarData {
  range: { from: string; to: string; days: number; label: string };
  dates: string[];
  rows: CalendarRow[];
  conflicts: number;
  legend: Array<{ key: string; label: string }>;
}

interface SyncHealth {
  properties: number;
  confirmedStays: number;
  conflicts: number;
  state: 'live' | 'stale' | 'failed' | 'never';
  checkedAt: string | null;
  headline: string;
}


function initialFrom(): string {
  const params = new URLSearchParams(window.location.search);
  const from = params.get('from');
  return from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : todayIso();
}

function freshness(health: SyncHealth | null): string {
  if (!health) return 'Checking…';
  if (health.state === 'live') {
    const stamp = health.checkedAt ? new Date(health.checkedAt) : null;
    const time = stamp
      ? stamp.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : '—';
    return `Live — checked ${time}`;
  }
  if (health.state === 'failed') return 'Sync needs attention';
  if (health.state === 'stale') return 'Sync is stale';
  return 'Not synced yet';
}

export function CalendarScreen() {
  const toast = useToast();
  const [from, setFrom] = useState(initialFrom);
  const [data, setData] = useState<CalendarData | null>(null);
  const [health, setHealth] = useState<SyncHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async (windowFrom: string) => {
    try {
      const [calendar, healthData] = await Promise.all([
        getJson<CalendarData>(`/api/calendar?from=${windowFrom}&days=21`),
        getJson<SyncHealth>('/api/sync/health'),
      ]);
      setData(calendar);
      setHealth(healthData);
      setError(null);
    } catch {
      setError('Could not read the calendar.');
    }
  }, []);

  useEffect(() => {
    void load(from);
    const url = new URL(window.location.href);
    url.searchParams.set('from', from);
    window.history.replaceState({}, '', url);
  }, [from, load]);

  function step(days: number) {
    setFrom((current) => addDays(current, days));
  }

  async function refreshCalendars() {
    setSyncing(true);
    try {
      const result = await sendJson<{ results: Array<{ status: string }> }>('POST', '/api/sync');
      const failed = result.results.filter((entry) => entry.status === 'failed').length;
      if (failed > 0) {
        toast(`${failed} calendar${failed === 1 ? '' : 's'} could not be read`, 'error');
      } else {
        toast(
          result.results.length === 0
            ? 'No calendars are linked yet'
            : `${result.results.length} calendar${result.results.length === 1 ? '' : 's'} refreshed`
        );
      }
      await load(from);
    } catch {
      toast('Could not refresh the calendars', 'error');
    } finally {
      setSyncing(false);
    }
  }

  const days = data?.range.days ?? 21;

  return (
    <div className="stack">
      <section className="cal-head">
        <div className="cal-head-text">
          <p className="cal-range" data-testid="range-label">
            {data?.range.label ?? rangeLabel(from, 21)}
          </p>
          <p className="cal-health" data-testid="sync-health">
            {health
              ? `${health.properties} properties · ${health.confirmedStays} confirmed stays · ${health.headline}`
              : 'Checking the calendar…'}
          </p>
          <p className={`cal-fresh is-${health?.state ?? 'never'}`} data-testid="freshness">
            {freshness(health)}
          </p>
        </div>
        <div className="cal-actions">
          <button type="button" className="btn" aria-label="Previous week" onClick={() => step(-7)}>
            ‹ Prev
          </button>
          <button type="button" className="btn" onClick={() => setFrom(todayIso())}>
            Today
          </button>
          <button type="button" className="btn" aria-label="Next week" onClick={() => step(7)}>
            Next ›
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={refreshCalendars}
            disabled={syncing}
          >
            {syncing ? 'Refreshing…' : 'Refresh calendars'}
          </button>
        </div>
      </section>

      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      <section className="panel cal-panel">
        <div
          className="cal-grid"
          data-testid="calendar-grid"
          data-range-from={from}
          data-days={days}
          style={{ ['--days' as string]: days }}
        >
          <div className="cal-corner" />
          {data?.dates.map((date) => {
            const weekend = [0, 6].includes(new Date(`${date}T00:00:00.000Z`).getUTCDay());
            return (
              <div className={`cal-day${weekend ? ' is-weekend' : ''}`} key={date} data-date={date}>
                <span className="cal-day-name">{dayLabel(date).split(' ')[0]}</span>
                <span className="cal-day-num">{Number(date.slice(8, 10))}</span>
              </div>
            );
          })}

          {data?.rows.length === 0 ? (
            <div className="cal-empty">
              <p>No properties on the grid yet.</p>
              <a className="btn btn-primary" href="/properties">
                Add your first property
              </a>
            </div>
          ) : null}

          {data?.rows.map((row) => (
            <div className="cal-row" key={row.propertyId} data-property={row.propertyId}>
              <div className="cal-row-label">
                <strong>{row.name}</strong>
                <small>{row.bars.length} stay{row.bars.length === 1 ? '' : 's'} in view</small>
              </div>
              <div className="cal-track">
                {Array.from({ length: days }, (_, index) => (
                  <div className="cal-cell" key={`${row.propertyId}-${index}`} />
                ))}
                {row.bars.map((bar) => {
                  const span = Math.max(1, bar.endIndex - bar.startIndex);
                  const conflict = bar.overlaps.length > 0;
                  return (
                    <button
                      type="button"
                      key={bar.id}
                      className={`cal-bar ch-${bar.channel}${conflict ? ' is-conflict' : ''}${
                        bar.status === 'pending' ? ' is-pending' : ''
                      }`}
                      data-testid="calendar-bar"
                      data-booking={bar.id}
                      data-reference={bar.reference}
                      data-channel={bar.channel}
                      data-start={bar.startIndex}
                      data-end={bar.endIndex}
                      data-conflict={conflict ? 'true' : 'false'}
                      style={{
                        left: `${(bar.startIndex / days) * 100}%`,
                        width: `${(span / days) * 100}%`,
                      }}
                      onClick={() => setOpenId(bar.id)}
                      title={`${bar.guestName} · ${nightsBetween(bar.checkIn, bar.checkOut)} nights`}
                    >
                      <span className="cal-bar-label">{bar.guestName}</span>
                      {conflict ? (
                        <span className="cal-bar-flag" aria-label="Overlaps another booking">
                          !
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <footer className="cal-legend" data-testid="legend">
          {data?.legend.map((entry) => (
            <span className="legend-item" key={entry.key} data-legend={entry.key}>
              <span className={`legend-swatch sw-${entry.key}`} aria-hidden="true" />
              {entry.label}
            </span>
          ))}
        </footer>
      </section>

      <BookingSheet id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}