-- 005_dashboard.sql — F-14 / F-16 / F-19
-- The dashboard asks four questions of four different things: revenue, occupancy,
-- turnovers and guest rating. Turnovers and reviews are filled in by Stage 2;
-- the shape exists now so the KPIs are computed from real rows, never stubs.

create table if not exists task (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references property(id) on delete cascade,
  booking_id   uuid references booking(id) on delete set null,
  kind         text not null default 'turnover'
               check (kind in ('turnover', 'maintenance', 'inspection', 'other')),
  window_start timestamptz not null,
  window_end   timestamptz not null,
  status       text not null default 'scheduled'
               check (status in ('scheduled', 'in_progress', 'done', 'cancelled')),
  assignee     text,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint task_window_positive check (window_end > window_start)
);

create index if not exists task_due_idx on task (window_start)
  where status in ('scheduled', 'in_progress');

create table if not exists review (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references property(id) on delete cascade,
  booking_id    uuid references booking(id) on delete set null,
  rating        numeric(2,1) not null check (rating >= 1 and rating <= 5),
  channel       text,
  guest_name    text,
  body          text,
  received_at   timestamptz not null default now(),
  responded_at  timestamptz
);

create index if not exists review_property_idx on review (property_id);

drop trigger if exists task_set_updated_at on task;
create trigger task_set_updated_at before update on task
  for each row execute function set_updated_at();
