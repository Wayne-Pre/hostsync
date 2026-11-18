-- 012_ledger_trigger_message.sql
--
-- Correction to 011: PostgreSQL's format() needs a type specifier after `%`.
-- The trigger body used a bare `%`, so the intended append-only error was
-- replaced by "unrecognized format() type specifier". The trigger fired, but
-- the diagnostic was useless. Replace the function in place; the triggers keep
-- pointing at it.

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
      'transaction is append-only: %s is forbidden; post a reversing entry instead',
      tg_op
    );
end;
$$;
