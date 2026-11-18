-- 008_inbox.sql — F-50…F-55 (Stage 2 guest inbox)
--
-- One thread per guest conversation, one row per message. `delivery` is the
-- honest part: an outbound WhatsApp or SMS message is stored as `recorded`,
-- because the system cannot send it. Pretending otherwise is the defect this
-- table exists to prevent.

create table if not exists conversation (
  id             uuid primary key default gen_random_uuid(),
  portfolio_id   uuid not null references portfolio(id) on delete cascade,
  property_id    uuid references property(id) on delete set null,
  booking_id     uuid references booking(id) on delete set null,
  guest_name     text not null,
  guest_email    text,
  channel        text not null,
  subject        text,
  unread_count   int not null default 0 check (unread_count >= 0),
  last_message_at timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

create index if not exists conversation_portfolio_idx on conversation (portfolio_id, last_message_at desc);

create table if not exists message (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversation(id) on delete cascade,
  direction       text not null check (direction in ('inbound', 'outbound')),
  author_name     text,
  body            text not null,
  channel         text not null,
  delivery        text not null default 'sent'
                  check (delivery in ('sent', 'recorded', 'failed')),
  created_at      timestamptz not null default now()
);

create index if not exists message_conversation_idx on message (conversation_id, created_at);
