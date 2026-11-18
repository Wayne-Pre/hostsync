/**
 * F-47 / F-48 / F-49 — creating a task, moving it through its lifecycle and
 * ticking its checklist.
 *
 * The board is the product's promise that a confirmed stay becomes work; these
 * are the only three things you can do to a task, so they are deliberately
 * small and strictly validated.
 */
import { queryOne, withTransaction } from './db.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import { TURNOVER_CHECKLIST, loadBoard } from './operations.ts';
import type { TaskCard, TaskKind, TaskStatus } from './operations.ts';

export const TASK_KINDS: readonly TaskKind[] = ['turnover', 'maintenance', 'inspection', 'other'];
export const TASK_PRIORITIES: readonly string[] = ['low', 'normal', 'high', 'urgent'];

export interface CreateTaskInput {
  portfolioId: string;
  propertyId: string;
  kind: string;
  title: string;
  date: string;
  windowStart: string;
  windowEnd: string;
  assignee: string | null;
  priority: string;
  expectedCostCents: number;
  notes: string | null;
}

interface TaskIdRow {
  id: string;
}

async function ownedTask(taskId: string, portfolioId: string): Promise<void> {
  const row = await queryOne<{ id: string }>(
    `select t.id from task t
       join property p on p.id = t.property_id
      where t.id = $1 and p.portfolio_id = $2`,
    [taskId, portfolioId]
  );
  if (!row) throw new NotFoundError('task');
}

export async function createTask(input: CreateTaskInput): Promise<TaskCard> {
  const kind = input.kind as TaskKind;
  if (!TASK_KINDS.includes(kind)) {
    throw new ValidationError(`kind must be one of: ${TASK_KINDS.join(', ')}`, 'kind');
  }
  const title = input.title.trim();
  if (!title) throw new ValidationError('a task needs a title', 'title');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new ValidationError('date must be YYYY-MM-DD', 'date');
  }
  const priority = TASK_PRIORITIES.includes(input.priority) ? input.priority : 'normal';
  const cost = Number.isFinite(input.expectedCostCents) ? Math.max(0, input.expectedCostCents) : 0;

  const id = await withTransaction(async (client) => {
    const property = await client.query<{ id: string }>(
      'select id from property where id = $1 and portfolio_id = $2 and deleted_at is null',
      [input.propertyId, input.portfolioId]
    );
    if (!property.rows[0]) throw new NotFoundError('property');

    const inserted = await client.query<TaskIdRow>(
      `insert into task (
         property_id, kind, title, window_start, window_end,
         status, assignee, priority, expected_cost_cents, notes
       )
       values (
         $1, $2, $3,
         (($4::date + $5::time) at time zone (select timezone from property where id = $1)),
         (($4::date + $6::time) at time zone (select timezone from property where id = $1)),
         'scheduled', $7, $8, $9, $10
       )
       returning id`,
      [
        input.propertyId,
        kind,
        title,
        input.date,
        input.windowStart,
        input.windowEnd,
        input.assignee,
        priority,
        cost,
        input.notes,
      ]
    );
    const taskId = inserted.rows[0]?.id;
    if (!taskId) throw new Error('task insert returned no row');

    // A hand-made turnover still carries the standard checklist.
    if (kind === 'turnover') {
      for (const [index, label] of TURNOVER_CHECKLIST.entries()) {
        await client.query(
          `insert into task_checklist_item (task_id, position, label)
           values ($1, $2, $3) on conflict (task_id, position) do nothing`,
          [taskId, index + 1, label]
        );
      }
    }

    return taskId;
  });

  const card = await readTask(id, input.portfolioId);
  if (!card) throw new NotFoundError('task');
  return card;
}

export async function readTask(taskId: string, portfolioId: string): Promise<TaskCard | null> {
  const board = await loadBoard(portfolioId, new Date().toISOString().slice(0, 10));
  for (const column of board.columns) {
    const found = column.tasks.find((task) => task.id === taskId);
    if (found) return found;
  }
  return null;
}

/** F-48 — the three legal moves, and nothing else. */
export async function moveTask(
  taskId: string,
  portfolioId: string,
  move: 'start' | 'complete' | 'reopen'
): Promise<TaskStatus> {
  await ownedTask(taskId, portfolioId);

  const status: TaskStatus = move === 'start' ? 'in_progress' : move === 'complete' ? 'done' : 'scheduled';

  if (move === 'complete') {
    const open = await queryOne<{ open_items: number }>(
      `select count(*)::int as open_items
         from task_checklist_item
        where task_id = $1 and not done`,
      [taskId]
    );
    if ((open?.open_items ?? 0) > 0) {
      throw new ConflictError(
        `the checklist is not finished — ${open?.open_items} item${open?.open_items === 1 ? '' : 's'} still open`
      );
    }
  }

  const updated = await queryOne<{ status: TaskStatus }>(
    `update task t
        set status = $3, updated_at = now()
       from property p
      where t.id = $1 and p.id = t.property_id and p.portfolio_id = $2
      returning t.status`,
    [taskId, portfolioId, status]
  );
  if (!updated) throw new NotFoundError('task');
  return updated.status;
}

/** F-49 — tick or untick one checklist item. */
export async function setChecklistItem(
  taskId: string,
  portfolioId: string,
  position: number,
  done: boolean
): Promise<{ done: boolean }> {
  await ownedTask(taskId, portfolioId);
  const updated = await queryOne<{ done: boolean }>(
    `update task_checklist_item
        set done = $3, done_at = case when $3 then now() else null end
      where task_id = $1 and position = $2
      returning done`,
    [taskId, position, done]
  );
  if (!updated) throw new NotFoundError('checklist item');
  return { done: updated.done };
}
