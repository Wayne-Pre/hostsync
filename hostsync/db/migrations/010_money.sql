-- 010_money.sql — F-62…F-72 (Stage 3: money that reconciles itself)
--
-- Two tables carry the money. `transaction` is the ledger of everything that
-- moved (a credit for a stay, a debit for an expense). `statement` is a frozen
-- snapshot of one property for one month: gross, expenses, fee and the payout
-- the owner receives. Statements are never recomputed silently — they store the
-- numbers they were generated with.

alter table property_account add column if not exists balance_cents bigint not null default 0;

update property_account
   set balance_cents = opening_balance_cents
 where balance_cents = 0 and opening_balance_cents <> 0;

create table if not exists transaction (
  id           uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references portfolio(id) on delete cascade,
  property_id  uuid references property(id) on delete set null,
  booking_id   uuid references booking(id) on delete cascade,
  account_id   uuid references property_account(property_id) on delete set null,
  kind         text not null check (kind in ('credit', 'debit')),
  category     text not null
               check (category in ('booking_revenue', 'housekeeping', 'maintenance', 'consumables', 'utilities', 'payout')),
  amount_cents bigint not null check (amount_cents > 0),
  description  text not null,
  posted       boolean not null default true,
  occurred_on  date not null,
  created_at   timestamptz not null default now()
);

create index if not exists transaction_portfolio_date_idx on transaction (portfolio_id, occurred_on desc);
create index if not exists transaction_property_idx on transaction (property_id, occurred_on desc);
create index if not exists transaction_booking_idx on transaction (booking_id);

-- One ledger row per booking: marking a stay paid posts it, unpaid stays stay
-- in the ledger as not-yet-posted, which is what "outstanding" means.
create unique index if not exists transaction_one_per_booking
  on transaction (booking_id)
  where booking_id is not null and category = 'booking_revenue';

create table if not exists statement (
  id             uuid primary key default gen_random_uuid(),
  portfolio_id   uuid not null references portfolio(id) on delete cascade,
  property_id    uuid not null references property(id) on delete cascade,
  owner_name     text not null,
  period_start   date not null,
  period_end     date not null,
  gross_cents    bigint not null default 0 check (gross_cents >= 0),
  expenses_cents bigint not null default 0 check (expenses_cents >= 0),
  fee_bps        int not null default 0 check (fee_bps between 0 and 10000),
  fee_cents      bigint not null default 0 check (fee_cents >= 0),
  net_cents      bigint not null default 0,
  status         text not null default 'draft' check (status in ('draft', 'approved', 'paid')),
  approved_at    timestamptz,
  paid_at        timestamptz,
  created_at     timestamptz not null default now(),
  unique (property_id, period_start, period_end)
);

create index if not exists statement_portfolio_idx on statement (portfolio_id, period_start desc);

alter table portfolio add column if not exists timezone text not null default 'Africa/Nairobi';
alter table portfolio add column if not exists business_name text;
alter table portfolio add column if not exists business_phone text;

-- F-75 — which channels are connected, and the WhatsApp business number.
create table if not exists channel_connection (
  portfolio_id    uuid not null references portfolio(id) on delete cascade,
  channel         text not null
                  check (channel in ('airbnb', 'booking_com', 'vrbo', 'direct', 'whatsapp')),
  connected       boolean not null default false,
  business_number text,
  account_ref     text,
  updated_at      timestamptz not null default now(),
  primary key (portfolio_id, channel)
);
