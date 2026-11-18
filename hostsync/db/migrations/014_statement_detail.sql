-- 014_statement_detail.sql — the "View" button finally has something to show
--
-- A draft's detail is derived live from the ledger. Approval freezes the lines
-- (spec §6.3: "approval freezes a snapshot of inputs + lines"), so changing the
-- ledger afterwards cannot silently rewrite an approved statement's detail.
--
-- Each line carries the ids of the ledger entries behind it. Sum of line
-- amounts == statement.net_cents: booking credits minus expenses minus fee.

create table if not exists statement_line (
  id           uuid primary key default gen_random_uuid(),
  statement_id uuid not null references statement(id) on delete cascade,
  line_type    text not null check (line_type in ('booking', 'expense', 'fee')),
  label        text not null,
  amount_cents bigint not null,
  entry_count  int not null default 0,
  source_ids   uuid[] not null default '{}',
  sort_order   int not null default 0,
  unique (statement_id, line_type, label)
);

create index if not exists statement_line_stmt_idx
  on statement_line (statement_id, sort_order);
