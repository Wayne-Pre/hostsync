import { useCallback, useEffect, useState } from 'react';
import { getJson, sendJson, todayIso } from './client.ts';
import { useToast } from './toast.tsx';

/**
 * F-43 – F-49 — the operations board, on one screen.
 *
 * A card has to answer, without being opened: what kind of work is this, where,
 * what time, how much of it is done, who is doing it, and what happens next.
 * The board can also create work (F-47) and hand it to somebody, because a
 * turnover that cannot be assigned is a turnover nobody owns.
 */

interface ChecklistItem {
  position: number;
  label: string;
  done: boolean;
}

interface TaskCard {
  id: string;
  kind: string;
  title: string;
  propertyId: string;
  propertyName: string;
  bookingId: string | null;
  status: string;
  column: string;
  assignee: string | null;
  assigneeActive: boolean;
  windowStart: string;
  windowEnd: string;
  priority: string;
  expectedCostCents: number;
  checklist: ChecklistItem[];
  checklistDone: number;
  checklistTotal: number;
  blocked: boolean;
  dueToday: boolean;
}

interface Board {
  counters: { unassigned: number; dueToday: number; blocked: number; needsSomeone: number };
  columns: Array<{ key: string; label: string; count: number; tasks: TaskCard[] }>;
}

interface TaskProof {
  photos: Array<{ id: string; dataUrl: string; caption: string | null; createdAt: string; by: string | null }>;
  events: Array<{ id: string; action: string; detail: Record<string, unknown>; createdAt: string; by: string | null }>;
}

interface PropertyOption {
  id: string;
  name: string;
}

interface TeamOption {
  name: string;
  active: boolean;
}

const KIND_LABEL: Record<string, string> = {
  turnover: 'TURNOVER',
  maintenance: 'MAINTENANCE',
  inspection: 'INSPECTION',
  other: 'OTHER',
};

const KIND_OPTIONS: Array<[string, string]> = [
  ['turnover', 'Turnover'],
  ['maintenance', 'Maintenance'],
  ['inspection', 'Inspection'],
  ['other', 'Other'],
];

const PRIORITY_OPTIONS = ['low', 'normal', 'high', 'urgent'];

function newForm(propertyId: string) {
  return {
    propertyId,
    kind: 'turnover',
    title: '',
    date: todayIso(),
    windowStart: '11:00',
    windowEnd: '15:00',
    assignee: '',
    priority: 'normal',
    expectedCostCents: '0',
    notes: '',
  };
}

function windowText(card: TaskCard): string {
  const format = (iso: string) =>
    new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Africa/Nairobi',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  return `${format(card.windowStart)} – ${format(card.windowEnd)}`;
}

function nextAction(card: TaskCard): { label: string; move: 'start' | 'complete' | 'reopen' } {
  if (card.status === 'done') return { label: 'Reopen', move: 'reopen' };
  if (card.status === 'in_progress') return { label: 'Mark done', move: 'complete' };
  return { label: 'Start', move: 'start' };
}

export function Operations() {
  const toast = useToast();
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [team, setTeam] = useState<TeamOption[]>([]);
  const [properties, setProperties] = useState<PropertyOption[]>([]);
  const [form, setForm] = useState(() => newForm(''));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [proofCard, setProofCard] = useState<TaskCard | null>(null);
  const [proof, setProof] = useState<TaskProof | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextBoard, roster] = await Promise.all([
        getJson<Board>('/api/tasks'),
        getJson<{ members: TeamOption[] }>('/api/team'),
      ]);
      setBoard(nextBoard);
      setTeam(roster.members.map((member) => ({ name: member.name, active: member.active })));
      setError(null);
    } catch {
      setError('Could not load the board.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDialog() {
    try {
      if (properties.length === 0) {
        const data = await getJson<{ properties: PropertyOption[] }>('/api/properties');
        setProperties(data.properties);
        setForm(newForm(data.properties[0]?.id ?? ''));
      } else {
        setForm(newForm(properties[0]?.id ?? ''));
      }
    } catch {
      // A portfolio with no properties yet still gets the form, with an error
      // from the server if somebody tries to save without one.
    }
    setDialogOpen(true);
  }

  function setField(name: keyof ReturnType<typeof newForm>, value: string) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await sendJson('POST', '/api/tasks', {
        propertyId: form.propertyId,
        kind: form.kind,
        title: form.title,
        date: form.date,
        windowStart: form.windowStart,
        windowEnd: form.windowEnd,
        assignee: form.assignee || null,
        priority: form.priority,
        expectedCostCents: Number(form.expectedCostCents) || 0,
        notes: form.notes || null,
      });
      toast('Task added');
      setDialogOpen(false);
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not add that task', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function move(card: TaskCard, action: 'start' | 'complete' | 'reopen') {
    try {
      await sendJson('POST', `/api/tasks/${card.id}/${action}`);
      toast(
        action === 'complete'
          ? 'Task completed'
          : action === 'reopen'
            ? 'Task reopened'
            : 'Task started'
      );
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not move that task', 'error');
    }
  }

  async function openProof(card: TaskCard) {
    setProofCard(card);
    setProof(null);
    try {
      setProof(await getJson<TaskProof>(`/api/tasks/${card.id}/proof`));
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not load the job history', 'error');
    }
  }

  async function assign(card: TaskCard, name: string) {
    try {
      await sendJson('POST', `/api/tasks/${card.id}/assign`, { assignee: name || null });
      toast(name ? `Assigned to ${name}` : 'Back to Unassigned');
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not assign that task', 'error');
    }
  }

  if (error) {
    return (
      <p className="alert" role="alert">
        {error}
      </p>
    );
  }

  if (!board) return <p className="loading">Loading the board…</p>;

  const counters: Array<{ key: string; label: string; value: number }> = [
    { key: 'unassigned', label: 'UNASSIGNED', value: board.counters.unassigned },
    { key: 'dueToday', label: 'DUE TODAY', value: board.counters.dueToday },
    { key: 'blocked', label: 'BLOCKED', value: board.counters.blocked },
    { key: 'needsSomeone', label: 'NEEDS SOMEONE', value: board.counters.needsSomeone },
  ];

  return (
    <div className="stack">
      <header className="section-head">
        <div>
          <p className="eyebrow">Turnovers &amp; maintenance</p>
          <h2 className="section-title">The cleaning window nobody misses.</h2>
          <p className="muted">
            Every stay creates the work, its window, its checklist and its owner.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="new-task-button"
          onClick={() => void openDialog()}
        >
          + New task
        </button>
      </header>

      <section className="kpis kpis-tight" aria-label="Board counters">
        {counters.map((counter) => (
          <article className="kpi kpi-small" key={counter.key} data-counter={counter.key}>
            <span className="kpi-label">{counter.label}</span>
            <strong className="kpi-value">{counter.value}</strong>
          </article>
        ))}
      </section>

      <section className="board" data-testid="board">
        {board.columns.map((column) => (
          <div className="board-column" key={column.key} data-column={column.key}>
            <header className="board-column-head">
              <h2>{column.label}</h2>
              <span className="board-count" data-count={column.key}>
                {column.count}
              </span>
            </header>

            {column.tasks.length === 0 ? (
              <p className="board-empty">Nothing here.</p>
            ) : (
              <ul className="board-list">
                {column.tasks.map((card) => {
                  const action = nextAction(card);
                  return (
                    <li className="task-card" key={card.id} data-task={card.id}>
                      <div className="task-top">
                        <span className={`kind kind-${card.kind}`}>{KIND_LABEL[card.kind] ?? card.kind}</span>
                        {card.blocked ? (
                          <span className="task-flag" title="Overlaps another task">
                            BLOCKED
                          </span>
                        ) : null}
                      </div>
                      <h3 className="task-title">{card.title}</h3>
                      <p className="task-property">{card.propertyName}</p>
                      <p className="task-window">{windowText(card)}</p>
                      <p className="task-checklist">
                        {card.checklistDone}/{card.checklistTotal} checks
                      </p>
                      <label className="task-assign">
                        <span className="sr-only">Assign {card.title}</span>
                        <select
                          className="task-assignee-select"
                          data-testid="task-assign-select"
                          aria-label={`Assign ${card.title}`}
                          value={card.assignee ?? ''}
                          onChange={(event) => void assign(card, event.target.value)}
                        >
                          <option value="">Unassigned</option>
                          {team.map((member) => (
                            <option key={member.name} value={member.name}>
                              {member.name}
                              {member.active ? '' : ' · paused'}
                            </option>
                          ))}
                          {card.assignee && !team.some((member) => member.name === card.assignee) ? (
                            <option value={card.assignee}>{card.assignee}</option>
                          ) : null}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="btn btn-block"
                        data-action={action.move}
                        onClick={() => move(card, action.move)}
                      >
                        {action.label}
                      </button>
                      <button
                        type="button"
                        className="btn btn-block btn-ghost"
                        data-testid="task-proof-button"
                        onClick={() => void openProof(card)}
                      >
                        Proof &amp; history
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ))}
      </section>

      {proofCard ? (
        <>
          <div className="sheet-overlay" onClick={() => setProofCard(null)} />
          <div className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="proof-title">
            <div className="dialog-head">
              <h2 className="dialog-title" id="proof-title">Proof &amp; history</h2>
              <button type="button" className="btn btn-ghost" aria-label="Close" onClick={() => setProofCard(null)}>
                ✕
              </button>
            </div>
            <p className="muted">{proofCard.title} · {proofCard.propertyName}</p>
            {!proof ? (
              <p className="loading">Loading…</p>
            ) : (
              <div className="dialog-form">
                <h3 className="worker-proof-heading">Photos</h3>
                {proof.photos.length === 0 ? (
                  <p className="muted">No photos yet.</p>
                ) : (
                  <div className="worker-photo-grid">
                    {proof.photos.map((photo) => (
                      <img key={photo.id} src={photo.dataUrl} alt={`Proof by ${photo.by ?? 'unknown'}`} />
                    ))}
                  </div>
                )}
                <h3 className="worker-proof-heading">Who did what</h3>
                <ol className="worker-events">
                  {proof.events.map((event) => (
                    <li key={event.id}>
                      <strong>{event.by ?? 'System'}</strong> · {event.action.replace(/_/g, ' ')}{' '}
                      <small>{new Date(event.createdAt).toLocaleString('en-GB', {
                        timeZone: 'Africa/Nairobi',
                        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                      })}</small>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        </>
      ) : null}

      {dialogOpen ? (
        <>
          <div className="sheet-overlay" onClick={() => setDialogOpen(false)} />
          <div className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="new-task-title">
            <div className="dialog-head">
              <h2 className="dialog-title" id="new-task-title">
                New task
              </h2>
              <button
                type="button"
                className="btn btn-ghost"
                aria-label="Close"
                onClick={() => setDialogOpen(false)}
              >
                ✕
              </button>
            </div>
            <form className="dialog-form" data-testid="new-task-form" onSubmit={(event) => void create(event)}>
              <div className="field">
                <label htmlFor="task-property">Property</label>
                <select
                  id="task-property"
                  name="propertyId"
                  value={form.propertyId}
                  onChange={(event) => setField('propertyId', event.target.value)}
                  required
                >
                  {properties.map((property) => (
                    <option key={property.id} value={property.id}>
                      {property.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="dialog-grid">
                <div className="field">
                  <label htmlFor="task-kind">Type</label>
                  <select
                    id="task-kind"
                    name="kind"
                    value={form.kind}
                    onChange={(event) => setField('kind', event.target.value)}
                  >
                    {KIND_OPTIONS.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="task-priority">Priority</label>
                  <select
                    id="task-priority"
                    name="priority"
                    value={form.priority}
                    onChange={(event) => setField('priority', event.target.value)}
                  >
                    {PRIORITY_OPTIONS.map((value) => (
                      <option key={value} value={value}>
                        {value.charAt(0).toUpperCase() + value.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="field">
                <label htmlFor="task-title">What needs doing</label>
                <input
                  id="task-title"
                  name="title"
                  value={form.title}
                  onChange={(event) => setField('title', event.target.value)}
                  placeholder="e.g. Clean the kitchen after checkout"
                  required
                />
              </div>
              <div className="dialog-grid">
                <div className="field">
                  <label htmlFor="task-date">Date</label>
                  <input
                    id="task-date"
                    name="date"
                    type="date"
                    value={form.date}
                    onChange={(event) => setField('date', event.target.value)}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="task-window">Window (turnover)</label>
                  <div className="dialog-window">
                    <input
                      aria-label="Window start"
                      name="windowStart"
                      type="time"
                      value={form.windowStart}
                      onChange={(event) => setField('windowStart', event.target.value)}
                      required
                    />
                    <span>–</span>
                    <input
                      aria-label="Window end"
                      name="windowEnd"
                      type="time"
                      value={form.windowEnd}
                      onChange={(event) => setField('windowEnd', event.target.value)}
                      required
                    />
                  </div>
                </div>
              </div>
              <div className="dialog-grid">
                <div className="field">
                  <label htmlFor="task-assignee">Assign to</label>
                  <select
                    id="task-assignee"
                    name="assignee"
                    value={form.assignee}
                    onChange={(event) => setField('assignee', event.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {team.map((member) => (
                      <option key={member.name} value={member.name}>
                        {member.name}
                        {member.active ? '' : ' · paused'}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="task-cost">Expected cost</label>
                  <input
                    id="task-cost"
                    name="expectedCostCents"
                    type="number"
                    min="0"
                    value={form.expectedCostCents}
                    onChange={(event) => setField('expectedCostCents', event.target.value)}
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="task-notes">Notes</label>
                <textarea
                  id="task-notes"
                  name="notes"
                  rows={3}
                  value={form.notes}
                  onChange={(event) => setField('notes', event.target.value)}
                />
              </div>
              <div className="sheet-actions dialog-actions">
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Adding…' : 'Add task'}
                </button>
                <button
                  type="button"
                  className="btn"
                  data-testid="new-task-cancel"
                  onClick={() => setDialogOpen(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </>
      ) : null}
    </div>
  );
}
