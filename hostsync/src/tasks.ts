/**
 * F-47 / F-48 / F-49 — creating a task, moving it through its lifecycle and
 * ticking its checklist.
 *
 * The board is the product's promise that a confirmed stay becomes work; these
 * are the only three things you can do to a task, so they are deliberately
 * small and strictly validated.
 */
import { query, queryOne, withTransaction } from './db.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors.ts';
import { TURNOVER_CHECKLIST, loadBoard } from './operations.ts';
import type { Board, TaskCard, TaskKind, TaskStatus } from './operations.ts';
import type { WorkerMembership } from './team.ts';

const DATA_IMAGE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

/** Every job step is an attributed event, so "who did it" is never a guess. */
async function recordEvent(
  taskId: string,
  actorId: string | null,
  action: string,
  detail: Record<string, unknown> = {}
): Promise<void> {
  await query(
    `insert into task_event (task_id, actor_id, action, detail)
     values ($1, $2, $3, $4::jsonb)`,
    [taskId, actorId, action, JSON.stringify(detail)]
  );
}

/** A cleaner may only touch work assigned to their own roster name. */
export async function assertAssignedTo(
  taskId: string,
  membership: WorkerMembership
): Promise<void> {
  const row = await queryOne<{ ok: boolean }>(
    `select true::boolean as ok
       from task t join property p on p.id = t.property_id
      where t.id = $1 and p.portfolio_id = $2 and t.assignee = $3`,
    [taskId, membership.portfolioId, membership.name]
  );
  if (!row) throw new ForbiddenError('that job is not assigned to you');
}

/** The cleaner's own jobs, scoped to their portfolio and their roster name. */
export async function listMyJobs(membership: WorkerMembership): Promise<Board> {
  return loadBoard(membership.portfolioId, new Date().toISOString().slice(0, 10)).then((board) => {
    const columns = board.columns.map((column) => ({
      ...column,
      tasks: column.tasks.filter((task) => task.assignee === membership.name),
      count: column.tasks.filter((task) => task.assignee === membership.name).length,
    }));
    const tasks = columns.flatMap((column) => column.tasks);
    return {
      ...board,
      columns,
      counters: {
        unassigned: 0,
        dueToday: tasks.filter((task) => task.status !== 'done' && task.dueToday).length,
        blocked: tasks.filter((task) => task.status !== 'done' && task.blocked).length,
        needsSomeone: 0,
      },
    };
  });
}

export interface TaskProof {
  photos: Array<{ id: string; dataUrl: string; caption: string | null; createdAt: string; by: string | null }>;
  events: Array<{ id: string; action: string; detail: Record<string, unknown>; createdAt: string; by: string | null }>;
}

/** The manager's view of the proof behind a card. */
export async function taskProof(taskId: string, portfolioId: string): Promise<TaskProof> {
  await ownedTask(taskId, portfolioId);
  const [photos, events] = await Promise.all([
    query<{ id: string; data_url: string; caption: string | null; created_at: Date; by: string | null }>(
      `select ph.id, ph.data_url, ph.caption, ph.created_at, u.display_name as by
         from task_photo ph left join app_user u on u.id = ph.uploaded_by
        where ph.task_id = $1 order by ph.created_at`,
      [taskId]
    ),
    query<{ id: string; action: string; detail: Record<string, unknown>; created_at: Date; by: string | null }>(
      `select ev.id, ev.action, ev.detail, ev.created_at, u.display_name as by
         from task_event ev left join app_user u on u.id = ev.actor_id
        where ev.task_id = $1 order by ev.created_at`,
      [taskId]
    ),
  ]);
  return {
    photos: photos.map((row) => ({
      id: row.id, dataUrl: row.data_url, caption: row.caption,
      createdAt: row.created_at.toISOString(), by: row.by,
    })),
    events: events.map((row) => ({
      id: row.id, action: row.action, detail: row.detail,
      createdAt: row.created_at.toISOString(), by: row.by,
    })),
  };
}

/** A photo of the finished space, stored in Postgres like property photos. */
export async function addTaskPhoto(input: {
  taskId: string;
  portfolioId: string;
  dataUrl: string;
  caption: string | null;
  actorId: string | null;
}): Promise<void> {
  await ownedTask(input.taskId, input.portfolioId);
  if (!DATA_IMAGE.test(input.dataUrl)) {
    throw new ValidationError('a photo must be a data image', 'dataUrl');
  }
  const client = await withTransaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `insert into task_photo (task_id, uploaded_by, data_url, caption)
       values ($1, $2, $3, $4) returning id`,
      [input.taskId, input.actorId, input.dataUrl.slice(0, 1_500_000), input.caption]
    );
    return inserted.rows[0]?.id;
  });
  if (!client) throw new Error('photo insert returned no row');
  await recordEvent(input.taskId, input.actorId, 'photo_added', { caption: input.caption });
}

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
  move: 'start' | 'complete' | 'reopen',
  actorId: string | null = null
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

  const stamp =
    move === 'start'
      ? ', started_at = now(), completed_at = null'
      : move === 'complete'
        ? ', completed_at = now()'
        : ', started_at = null, completed_at = null';
  const updated = await queryOne<{ status: TaskStatus }>(
    `update task t
        set status = $3, updated_at = now()${stamp}
       from property p
      where t.id = $1 and p.id = t.property_id and p.portfolio_id = $2
      returning t.status`,
    [taskId, portfolioId, status]
  );
  if (!updated) throw new NotFoundError('task');
  await recordEvent(taskId, actorId, move, { status });
  return updated.status;
}

/**
 * Hand a task to a team member (or back to the unassigned column).
 *
 * The board's promise is that work always has an honest owner, so the only
 * legal values are `null` and the name of somebody in this portfolio's roster.
 */
export async function assignTask(
  taskId: string,
  portfolioId: string,
  assignee: string | null,
  actorId: string | null = null
): Promise<TaskStatus> {
  await ownedTask(taskId, portfolioId);

  if (assignee !== null) {
    const member = await queryOne<{ id: string }>(
      'select id from team_member where portfolio_id = $1 and name = $2',
      [portfolioId, assignee]
    );
    if (!member) {
      throw new ValidationError('assignee must be a member of this portfolio', 'assignee');
    }
  }

  const updated = await queryOne<{ status: TaskStatus }>(
    `update task t
        set assignee = $3, updated_at = now()
       from property p
      where t.id = $1 and p.id = t.property_id and p.portfolio_id = $2
      returning t.status`,
    [taskId, portfolioId, assignee]
  );
  if (!updated) throw new NotFoundError('task');
  await recordEvent(taskId, actorId, 'assigned', { assignee });
  return updated.status;
}

/** F-49 — tick or untick one checklist item. */
export async function setChecklistItem(
  taskId: string,
  portfolioId: string,
  position: number,
  done: boolean,
  actorId: string | null = null
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
  await recordEvent(taskId, actorId, done ? 'check_checked' : 'check_unchecked', { position });
  return { done: updated.done };
}
