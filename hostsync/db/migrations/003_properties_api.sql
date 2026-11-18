-- 003_properties_api.sql — F-21..F-27, F-37
-- A settling account is attached to a property (the card shows "KCB 3310 · Verified").
-- Calendar feeds are stored on the property so a refresh never needs a pasted URL again.

create table if not exists property_account (
  property_id           uuid primary key references property(id) on delete cascade,
  label                 text not null check (length(btrim(label)) > 0),
  verified              boolean not null default false,
  opening_balance_cents bigint not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

drop trigger if exists property_account_set_updated_at on property_account;
create trigger property_account_set_updated_at before update on property_account
  for each row execute function set_updated_at();

create table if not exists calendar_feed (
  id                     uuid primary key default gen_random_uuid(),
  property_id            uuid not null references property(id) on delete cascade,
  url                    text not null check (url ~ '^https://'),
  source                 text not null
                         check (source in ('airbnb', 'booking_com', 'vrbo', 'direct', 'whatsapp')),
  etag                   text,
  last_synced_at         timestamptz,
  last_attempt_at        timestamptz,
  last_status            text check (last_status in ('ok', 'stale', 'failed')),
  last_error             text,
  consecutive_failures   int not null default 0,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create unique index if not exists calendar_feed_url_key on calendar_feed (property_id, url);

drop trigger if exists calendar_feed_set_updated_at on calendar_feed;
create trigger calendar_feed_set_updated_at before update on calendar_feed
  for each row execute function set_updated_at();

create index if not exists booking_guest_trgm on booking (lower(guest_name) text_pattern_ops);

-- Which channels a property is sold on (the "channels" field on the add form).
create table if not exists property_channel (
  property_id uuid not null references property(id) on delete cascade,
  channel     text not null
              check (channel in ('airbnb', 'booking_com', 'vrbo', 'direct', 'whatsapp')),
  created_at  timestamptz not null default now(),
  primary key (property_id, channel)
);
