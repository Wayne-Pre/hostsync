-- 015_fee_history.sql — effective-dated management fee overrides
--
-- Stage 3 upgrade (spec §6.3): "Effective-dated override history; statement
-- stores the bps applied" — backdating a fee change must not rewrite settled
-- months. A statement snapshot already stores its fee_bps; this table supplies
-- the historical value used to build a *new* statement for a past period.
--
-- Resolution: the latest override whose effective_from is on or before the
-- statement period start wins; otherwise the property's current bps, otherwise
-- the portfolio default. Overrides are append-only in practice — editing one
-- would rewrite history for every statement generated from it.

create table if not exists fee_override (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references property(id) on delete cascade,
  effective_from date not null,
  fee_bps       int not null check (fee_bps between 0 and 10000),
  created_at    timestamptz not null default now(),
  unique (property_id, effective_from)
);

create index if not exists fee_override_property_idx
  on fee_override (property_id, effective_from desc);
