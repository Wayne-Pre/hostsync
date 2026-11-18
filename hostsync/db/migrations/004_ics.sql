-- 004_ics.sql — F-25/F-26/F-36
-- One row per (feed, UID) makes re-syncing idempotent: a feed that is fetched
-- twice creates nothing twice, and a cancelled event can find its booking.

create table if not exists imported_event (
  feed_id      uuid not null references calendar_feed(id) on delete cascade,
  uid          text not null,
  booking_id   uuid references booking(id) on delete set null,
  sequence     int not null default 0,
  check_in     date,
  check_out    date,
  state        text not null default 'active' check (state in ('active', 'cancelled')),
  last_seen_at timestamptz not null default now(),
  primary key (feed_id, uid)
);

create index if not exists imported_event_booking_idx on imported_event (booking_id);
