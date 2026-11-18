-- 011_append_only_ledger.sql — the ledger becomes the only write path for money
--
-- Stage 3 upgrade: "Append-only: DB trigger blocks UPDATE/DELETE; corrections
-- are reversing entries" (spec §6.3). A row in `transaction` is a fact that
-- happened. A mistake is corrected by posting the opposite fact, never by
-- editing history.
--
-- Two consequences:
--
--   1. Amounts carry their own direction: a credit is positive, a debit is
--      negative. The sign is checked against `kind` by the database, so no
--      reader has to remember a convention.
--   2. The one-row-per-booking upsert is gone. A stay that is marked paid,
--      then unpaid, then paid again leaves three rows whose sum is the money
--      that has actually been booked. `reversal_of` points a correction at the
--      entry it cancels.
--
-- Deletion survives for exactly one caller: account erasure, which sets the
-- session flag `hostsync.ledger_purge = 'on'` inside the deleting transaction.
-- Nothing in the application sets it.

alter table transaction drop constraint if exists transaction_amount_cents_check;

-- Unposted rows were placeholders for "not yet paid"; outstanding is computed
-- from the booking itself, so they carry no information.
delete from transaction where not posted;

-- Direction is the sign now, from the negative side first so the old positive
-- debits cannot collide with the new check.
update transaction set amount_cents = -amount_cents where kind = 'debit' and amount_cents > 0;

alter table transaction
  add constraint transaction_amount_cents_direction
  check (
    (kind = 'credit' and amount_cents > 0)
    or (kind = 'debit' and amount_cents < 0)
  );

-- A correction names the entry it reverses. One entry can be reversed once:
-- reversing it twice would be a second, different fact.
alter table transaction add column if not exists reversal_of uuid
  references transaction(id) on delete cascade;

create unique index if not exists transaction_reversal_once
  on transaction (reversal_of)
  where reversal_of is not null;

-- The unique booking index was what forced an UPDATE. Append-only rows mean a
-- booking legitimately owns several entries over its life.
drop index if exists transaction_one_per_booking;

create index if not exists transaction_booking_revenue_idx
  on transaction (booking_id, created_at desc)
  where booking_id is not null and category = 'booking_revenue';

create or replace function transaction_append_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE'
     and coalesce(current_setting('hostsync.ledger_purge', true), 'off') = 'on' then
    return old;
  end if;

  raise exception using
    errcode = 'restrict_violation',
    message = format(
      'transaction is append-only: % is forbidden; post a reversing entry instead',
      tg_op
    );
end;
$$;

drop trigger if exists transaction_no_update on transaction;
create trigger transaction_no_update
  before update on transaction
  for each row execute function transaction_append_only();

drop trigger if exists transaction_no_delete on transaction;
create trigger transaction_no_delete
  before delete on transaction
  for each row execute function transaction_append_only();
