-- 002_auth.sql — F-05..F-10
-- Sessions and one-time codes are stored as hashes: a database read must not
-- hand someone a working credential.

create table if not exists app_user (
  id                   uuid primary key default gen_random_uuid(),
  email                text not null check (position('@' in email) > 1),
  password_hash        text not null,
  display_name         text,
  is_verified          boolean not null default false,
  force_password_reset boolean not null default false,
  onboarding_complete  boolean not null default false,
  disabled             boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Case-insensitive uniqueness without hunting for the citext extension.
create unique index if not exists app_user_email_key on app_user (lower(email));

drop trigger if exists app_user_set_updated_at on app_user;
create trigger app_user_set_updated_at before update on app_user
  for each row execute function set_updated_at();

create table if not exists session (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references app_user(id) on delete cascade,
  token_hash   bytea not null unique,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  user_agent   text
);

create index if not exists session_user_idx on session (user_id) where revoked_at is null;

create table if not exists otp_code (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references app_user(id) on delete cascade,
  purpose     text not null check (purpose in ('verify_email', 'reset_password')),
  code_hash   bytea not null,
  attempts    int not null default 0,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

-- At most one live code per purpose: issuing a new one invalidates the old.
create unique index if not exists otp_code_live_key
  on otp_code (user_id, purpose) where consumed_at is null;

create table if not exists password_reset (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references app_user(id) on delete cascade,
  token_hash  bytea not null unique,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

-- Failed-login accounting, so a password can be guessed at most N times per window.
create table if not exists auth_attempt (
  id         bigserial primary key,
  email      text not null,
  kind       text not null check (kind in ('login', 'otp', 'reset')),
  succeeded  boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists auth_attempt_window_idx on auth_attempt (lower(email), created_at desc);

-- A portfolio belongs to the user who created it (F-10). Null keeps pre-auth rows valid.
alter table portfolio add column if not exists owner_id uuid references app_user(id) on delete cascade;
create index if not exists portfolio_owner_idx on portfolio (owner_id);
