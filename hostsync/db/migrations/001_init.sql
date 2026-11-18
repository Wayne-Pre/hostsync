-- 001_init.sql — Stage 1 foundation
-- The invariant of the product lives at the bottom of this file: booking.no_double_booking.

create extension if not exists btree_gist;

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

create table if not exists portfolio (
  id                         uuid primary key default gen_random_uuid(),
  name                       text not null check (length(btrim(name)) > 0),
  currency                   char(3) not null default 'KES',
  default_management_fee_bps int not null default 1800
                             check (default_management_fee_bps between 0 and 10000),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

create table if not exists property (
  id                   uuid primary key default gen_random_uuid(),
  portfolio_id         uuid not null references portfolio(id) on delete cascade,
  name                 text not null check (length(btrim(name)) > 0),
  status               text not null default 'onboarding'
                       check (status in ('onboarding', 'live', 'archived')),
  type                 text
                       check (type in ('apartment','house','cottage','villa','studio','penthouse','other')),
  neighbourhood        text,
  city                 text,
  address              text,
  bedrooms             int check (bedrooms >= 0),
  baths                int check (baths >= 0),
  guests               int check (guests >= 1),                 -- capacity
  nightly_rate_cents   bigint not null check (nightly_rate_cents > 0),
  cleaning_fee_cents   bigint not null default 0 check (cleaning_fee_cents >= 0),
  management_fee_bps   int check (management_fee_bps between 0 and 10000),  -- null = inherit portfolio
  owner_name           text,
  owner_email          text,
  photo_key            text,
  currency             char(3) not null default 'KES',
  timezone             text not null default 'Africa/Nairobi',
  checkin_time         time not null default '15:00',
  checkout_time        time not null default '11:00',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);

create index if not exists property_portfolio_idx on property (portfolio_id) where deleted_at is null;

-- References are human-facing (HS-1042, MRD-1057). A sequence keeps them unique without a race.
create sequence if not exists booking_ref_seq start 1000;

create table if not exists booking (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references property(id),
  reference       text not null unique,
  guest_name      text not null check (length(btrim(guest_name)) > 0),
  guest_email     text,
  guest_phone     text,
  channel         text not null
                  check (channel in ('airbnb','booking_com','vrbo','direct','whatsapp')),
  stay            daterange not null,
  guests          int not null check (guests >= 1),
  -- price snapshot: computed once, server-side, from the versioned pricing rule
  gross_cents     bigint not null check (gross_cents >= 0),
  commission_bps  int not null check (commission_bps between 0 and 10000),
  net_cents       bigint not null check (net_cents >= 0),
  rate_version    int not null,
  payment_status  text not null check (payment_status in ('paid','unpaid','partial')),
  status          text not null default 'pending'
                  check (status in ('pending','confirmed','completed','cancelled')),
  source          text not null check (source in ('import','manual','direct_site')),
  notes           text,
  version         int not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint stay_positive check (upper(stay) > lower(stay)),
  constraint stay_half_open check (lower_inc(stay) and not upper_inc(stay)),
  constraint net_matches_gross check (net_cents <= gross_cents)
);

create index if not exists booking_property_idx on booking (property_id);
create index if not exists booking_status_idx on booking (status);
create index if not exists booking_stay_idx on booking using gist (stay);

-- THE INVARIANT.
-- Only nights that are actually held (confirmed or completed) are exclusive.
-- Pending rows are deliberately allowed to collide so an imported conflict can land,
-- be surfaced in the UI, and be resolved at "confirm" time rather than silently rejected.
alter table booking drop constraint if exists no_double_booking;
alter table booking add constraint no_double_booking
  exclude using gist (
    property_id with =,
    stay with &&
  ) where (status in ('confirmed', 'completed'));

drop trigger if exists property_set_updated_at on property;
create trigger property_set_updated_at before update on property
  for each row execute function set_updated_at();

drop trigger if exists booking_set_updated_at on booking;
create trigger booking_set_updated_at before update on booking
  for each row execute function set_updated_at();
