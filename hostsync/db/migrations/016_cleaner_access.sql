-- 016_cleaner_access.sql — field-worker accounts
--
-- A cleaner's work is only trustworthy if the app knows who did it. These
-- tables give a worker their own identity, link that identity to a roster
-- member (the name tasks are assigned to), and keep proof of the work:
-- photos and an append-only event trail with the actor on every step.

alter table app_user add column if not exists account_role text not null default 'owner'
  check (account_role in ('owner', 'cleaner'));

alter table team_member add column if not exists user_id uuid unique
  references app_user(id) on delete set null;

alter table task add column if not exists started_at timestamptz;
alter table task add column if not exists completed_at timestamptz;

create table if not exists task_photo (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references task(id) on delete cascade,
  uploaded_by uuid references app_user(id) on delete set null,
  data_url    text not null check (data_url like 'data:image/%'),
  caption     text,
  created_at  timestamptz not null default now()
);

create index if not exists task_photo_task_idx on task_photo (task_id, created_at);

create table if not exists task_event (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references task(id) on delete cascade,
  actor_id   uuid references app_user(id) on delete set null,
  action     text not null,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists task_event_task_idx on task_event (task_id, created_at);
