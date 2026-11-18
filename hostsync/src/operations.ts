/**
 * F-46 — a confirmed arrival schedules its own turnover.
 *
 * The original app left this to a human: a note, a phone call, a cleaner who
 * happens to know the guest leaves at 11. Here the booking transaction creates
 * the task, its window and its checklist, so the work exists the moment the
 * stay is real.
 */
import type { PoolClient } from 'pg';
import { query } from './db.ts';
import type { Booking } from './bookings.ts';

/** The five-item checklist a turnover always carries. */
export const TURNOVER_CHECKLIST: readonly string[] = [
  'Strip the beds and remake them with fresh linen',
  'Restock consumables — water, coffee, toiletries',
  'Clean the bathroom and the kitchen',
  'Check the appliances, the linen and the safety kit',
  'Photograph the finished space',
];

interface PropertyTimes {
  checkin_time: string;
  checkout_time: string;
  timezone: string;
}

async function propertyTimes(client: PoolClient, propertyId: string): Promise<PropertyTimes> {
  const result = await client.query<PropertyTimes>(
    'select checkin_time::text, checkout_time::text, timezone from property where id = $1',
    [propertyId]
  );
  const row = result.rows[0];
  if (!row) throw new Error(`property ${propertyId} not found`);
  return row;
}

/**
 * Create the turnover for a confirmed booking, if it does not exist yet.
 *
 * Idempotent: confirming the same booking twice schedules one turnover, and the
 * partial unique index `task_one_turnover_per_booking` is the backstop if two
 * confirmations ever race.
 */
export async function scheduleTurnover(client: PoolClient, booking: Booking): Promise<string | null> {
  if (booking.status !== 'confirmed' && booking.status !== 'completed') return null;

  const times = await propertyTimes(client, booking.propertyId);

  const inserted = await client.query<{ id: string }>(
    `insert into task (
       property_id, booking_id, kind, title, window_start, window_end, status, notes
     )
     select $1, $2, 'turnover', $3,
            (($4::date + $5::time) at time zone $6),
            (($4::date + $7::time) at time zone $6),
            'scheduled', $8
      where not exists (
        select 1 from task
         where booking_id = $2 and kind = 'turnover' and status <> 'cancelled'
      )
     returning id`,
    [
      booking.propertyId,
      booking.id,
      `Turnover for ${booking.guestName}`,
      booking.checkIn,
      times.checkout_time,
      times.timezone,
      times.checkin_time,
      'Scheduled automatically when the stay was confirmed.',
    ]
  );

  const taskId = inserted.rows[0]?.id;
  if (!taskId) return null;

  for (const [index, label] of TURNOVER_CHECKLIST.entries()) {
    await client.query(
      `insert into task_checklist_item (task_id, position, label)
       values ($1, $2, $3)
       on conflict (task_id, position) do nothing`,
      [taskId, index + 1, label]
    );
  }

  return taskId;
}

/**
 * A cancelled stay must not leave a turnover sitting on the board pretending
 * somebody still has to clean the flat. The task is cancelled explicitly —
 * never silently deleted — so the history stays readable.
 */
export async function cancelTurnover(client: PoolClient, bookingId: string): Promise<number> {
  const result = await client.query(
    `update task
        set status = 'cancelled', updated_at = now()
      where booking_id = $1 and kind = 'turnover' and status in ('scheduled', 'in_progress')`,
    [bookingId]
  );
  return result.rowCount ?? 0;
}

/* ------------------------------------------------------------------ board -- */

export type TaskStatus = 'scheduled' | 'in_progress' | 'done' | 'cancelled';
export type TaskKind = 'turnover' | 'maintenance' | 'inspection' | 'other';
export type BoardColumn = 'unassigned' | 'scheduled' | 'on_site' | 'complete';

export const BOARD_COLUMNS: readonly { key: BoardColumn; label: string }[] = [
  { key: 'unassigned', label: 'UNASSIGNED' },
  { key: 'scheduled', label: 'SCHEDULED' },
  { key: 'on_site', label: 'ON SITE' },
  { key: 'complete', label: 'COMPLETE' },
];

export interface ChecklistItem {
  position: number;
  label: string;
  done: boolean;
}

export interface TaskCard {
  id: string;
  kind: TaskKind;
  title: string;
  propertyId: string;
  propertyName: string;
  bookingId: string | null;
  status: TaskStatus;
  column: BoardColumn;
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

export interface BoardCounters {
  unassigned: number;
  dueToday: number;
  blocked: number;
  needsSomeone: number;
}

export interface Board {
  counters: BoardCounters;
  columns: Array<{ key: BoardColumn; label: string; count: number; tasks: TaskCard[] }>;
}

interface TaskRow {
  id: string;
  property_id: string;
  property_name: string;
  booking_id: string | null;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  assignee: string | null;
  window_start: Date;
  window_end: Date;
  priority: string;
  expected_cost_cents: number;
}

interface MemberRow {
  name: string;
  active: boolean;
}

/**
 * The operations board (F-43 counters, F-44 columns).
 *
 * The counters are derived from the task rows, not maintained by hand:
 *  - UNASSIGNED   — open work with nobody on it
 *  - DUE TODAY    — open work whose window starts today
 *  - BLOCKED      — two open tasks on one property whose windows overlap, so
 *                   one of them cannot happen as planned
 *  - NEEDS SOMEONE — work assigned to a team member who is paused
 */
export async function loadBoard(portfolioId: string, today: string): Promise<Board> {
  const rows = await query<TaskRow>(
    `select t.id, t.property_id, p.name as property_name, t.booking_id, t.kind, t.title,
            t.status, t.assignee, t.window_start, t.window_end, t.priority,
            t.expected_cost_cents
       from task t
       join property p on p.id = t.property_id
      where p.portfolio_id = $1 and t.status <> 'cancelled'
      order by t.window_start, t.created_at`,
    [portfolioId]
  );

  const members = await query<MemberRow>(
    'select name, active from team_member where portfolio_id = $1',
    [portfolioId]
  );
  const memberActive = new Map(members.map((member) => [member.name, member.active]));

  const items = rows.length
    ? await query<{ task_id: string; position: number; label: string; done: boolean }>(
        `select task_id, position, label, done
           from task_checklist_item
          where task_id = any($1::uuid[])
          order by task_id, position`,
        [rows.map((row) => row.id)]
      )
    : [];

  const checklistByTask = new Map<string, ChecklistItem[]>();
  for (const item of items) {
    const list = checklistByTask.get(item.task_id) ?? [];
    list.push({ position: item.position, label: item.label, done: item.done });
    checklistByTask.set(item.task_id, list);
  }

  const cards: TaskCard[] = rows.map((row) => {
    const checklist = checklistByTask.get(row.id) ?? [];
    const assigneeActive = row.assignee ? (memberActive.get(row.assignee) ?? true) : false;
    const done = checklist.filter((item) => item.done).length;

    const column: BoardColumn =
      row.status === 'done'
        ? 'complete'
        : row.status === 'in_progress'
          ? 'on_site'
          : row.assignee
            ? 'scheduled'
            : 'unassigned';

    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      propertyId: row.property_id,
      propertyName: row.property_name,
      bookingId: row.booking_id,
      status: row.status,
      column,
      assignee: row.assignee,
      assigneeActive,
      windowStart: row.window_start.toISOString(),
      windowEnd: row.window_end.toISOString(),
      priority: row.priority,
      expectedCostCents: Number(row.expected_cost_cents),
      checklist,
      checklistDone: done,
      checklistTotal: checklist.length,
      blocked: false, // resolved below
      dueToday: row.window_start.toISOString().slice(0, 10) === today,
    };
  });

  // Blocked: two open tasks on the same property whose windows overlap.
  const byProperty = new Map<string, TaskCard[]>();
  for (const card of cards) {
    if (card.status === 'done') continue;
    const list = byProperty.get(card.propertyId) ?? [];
    list.push(card);
    byProperty.set(card.propertyId, list);
  }
  for (const list of byProperty.values()) {
    for (const card of list) {
      const start = Date.parse(card.windowStart);
      const end = Date.parse(card.windowEnd);
      card.blocked = list.some((other) => {
        if (other.id === card.id) return false;
        return Date.parse(other.windowStart) < end && start < Date.parse(other.windowEnd);
      });
    }
  }

  const counters: BoardCounters = {
    unassigned: cards.filter((card) => card.status !== 'done' && !card.assignee).length,
    dueToday: cards.filter((card) => card.status !== 'done' && card.dueToday).length,
    blocked: cards.filter((card) => card.status !== 'done' && card.blocked).length,
    needsSomeone: cards.filter(
      (card) => card.status !== 'done' && card.assignee !== null && !card.assigneeActive
    ).length,
  };

  const columns = BOARD_COLUMNS.map((column) => {
    const tasks = cards.filter((card) => card.column === column.key);
    return { key: column.key, label: column.label, count: tasks.length, tasks };
  });

  return { counters, columns };
}
