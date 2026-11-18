-- 013_statement_freeze.sql — approval freezes the numbers; payment seals them
--
-- Stage 3 upgrades in spec §6.3:
--   "approval freezes a snapshot of inputs + lines, paid is immutable"
--   "Approval ... with actor + timestamp recorded, illegal transitions rejected 409"
--   "every statement satisfies gross − expenses − fee = net and fee = gross × bps"
--
-- The application already computes those numbers; the database now refuses to
-- store a statement that breaks either equation, and refuses to edit a paid
-- statement at all. Regenerating a paid or approved period is a 409 in the API
-- (the first line of defence); this trigger is the second.

alter table statement add column if not exists approved_by uuid
  references app_user(id) on delete set null;

alter table statement add column if not exists paid_by uuid
  references app_user(id) on delete set null;

alter table statement add constraint statement_net_check
  check (net_cents = gross_cents - expenses_cents - fee_cents);

alter table statement add constraint statement_fee_check
  check (fee_cents = round(gross_cents * fee_bps / 10000.0));

create or replace function statement_paid_immutable() returns trigger
language plpgsql as $$
begin
  if old.status = 'paid' and (
       new.gross_cents is distinct from old.gross_cents
       or new.expenses_cents is distinct from old.expenses_cents
       or new.fee_bps is distinct from old.fee_bps
       or new.fee_cents is distinct from old.fee_cents
       or new.net_cents is distinct from old.net_cents
       or new.period_start is distinct from old.period_start
       or new.period_end is distinct from old.period_end
       or new.owner_name is distinct from old.owner_name
       or new.property_id is distinct from old.property_id
     ) then
    raise exception using
      errcode = 'restrict_violation',
      message = 'a paid statement is immutable; issue a new statement instead';
  end if;
  return new;
end;
$$;

drop trigger if exists statement_paid_no_edit on statement;
create trigger statement_paid_no_edit
  before update on statement
  for each row execute function statement_paid_immutable();
