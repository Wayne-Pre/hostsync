import { useCallback, useEffect, useState } from 'react';
import { getJson, sendJson } from './client.ts';
import { useToast } from './toast.tsx';

/**
 * F-45 — the task card anatomy, on one board.
 *
 * A card has to answer, without being opened: what kind of work is this, where,
 * what time, how much of it is done, who is doing it, and what happens next.
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

const KIND_LABEL: Record<string, string> = {
  turnover: 'TURNOVER',
  maintenance: 'MAINTENANCE',
  inspection: 'INSPECTION',
  other: 'OTHER',
};

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

  const load = useCallback(async () => {
    try {
      setBoard(await getJson<Board>('/api/tasks'));
      setError(null);
    } catch {
      setError('Could not load the board.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
                      <p className="task-assignee">
                        {card.assignee ? (
                          <>
                            {card.assignee}
                            {card.assigneeActive ? '' : ' · paused'}
                          </>
                        ) : (
                          'Nobody yet'
                        )}
                      </p>
                      <button
                        type="button"
                        className="btn btn-block"
                        data-action={action.move}
                        onClick={() => move(card, action.move)}
                      >
                        {action.label}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
