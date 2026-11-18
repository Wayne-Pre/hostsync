-- 006_operations.sql — F-43…F-49 (Stage 2)
--
-- The task board, its checklist, and the columns the later features need
-- (title, priority, expected cost) so Stage 2 does not keep re-migrating.

alter table task add column if not exists title text not null default '';
alter table task add column if not exists priority text not null default 'normal'
  check (priority in ('low', 'normal', 'high', 'urgent'));
alter table task add column if not exists expected_cost_cents bigint not null default 0
  check (expected_cost_cents >= 0);

create index if not exists task_booking_idx on task (booking_id);

-- One live turnover per booking: the guarantee is in the database, not in a
-- service check that a second confirmation could race past.
create unique index if not exists task_one_turnover_per_booking
  on task (booking_id)
  where kind = 'turnover' and booking_id is not null and status <> 'cancelled';

create table if not exists task_checklist_item (
  id       uuid primary key default gen_random_uuid(),
  task_id  uuid not null references task(id) on delete cascade,
  position int not null check (position > 0),
  label    text not null,
  done     boolean not null default false,
  done_at  timestamptz,
  unique (task_id, position)
);

create index if not exists task_checklist_task_idx on task_checklist_item (task_id, position);
