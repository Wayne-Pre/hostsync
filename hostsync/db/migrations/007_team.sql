-- 007_team.sql — F-76 / F-77 (Stage 2 roster)
--
-- The board's "NEEDS SOMEONE" counter is only honest if a paused member is
-- visible in the data: a task assigned to somebody who can no longer work is a
-- task that needs somebody else.

create table if not exists team_member (
  id                  uuid primary key default gen_random_uuid(),
  portfolio_id        uuid not null references portfolio(id) on delete cascade,
  name                text not null,
  role                text not null
                      check (role in ('owner', 'manager', 'front_desk', 'cleaner', 'maintenance', 'inspector')),
  phone               text,
  hourly_rate_cents   bigint not null default 0 check (hourly_rate_cents >= 0),
  reliability_pct     int not null default 100 check (reliability_pct between 0 and 100),
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists team_member_portfolio_idx on team_member (portfolio_id);

-- One member per phone number inside a portfolio; the phone may be null.
create unique index if not exists team_member_phone_unique
  on team_member (portfolio_id, phone)
  where phone is not null;

drop trigger if exists team_member_set_updated_at on team_member;
create trigger team_member_set_updated_at before update on team_member
  for each row execute function set_updated_at();
