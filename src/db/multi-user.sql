-- Run AFTER schema.sql in Supabase SQL Editor. Existing ownerless rules stay private to the operator.
begin;
alter table public.watch_rules add column if not exists user_id uuid references auth.users(id) on delete cascade;
create index if not exists watch_rules_user on public.watch_rules(user_id);

create or replace function public.validate_user_watch_rule()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is not null then
    if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
      raise exception 'Rule ownership cannot be changed';
    end if;
    if new.provider <> 'tigerair' or new.currency <> 'TWD' or
       new.origin !~ '^[A-Z]{3}$' or new.destination !~ '^[A-Z]{3}$' or new.origin = new.destination or
       new.adults not between 1 and 9 or new.new_low_days not between 1 and 365 or
       (new.return_date is not null and new.return_date < new.departure_date) or
       (new.target_price is not null and (new.target_price < 0 or new.target_price::text = 'NaN')) or
       (new.drop_amount is not null and (new.drop_amount <= 0 or new.drop_amount::text = 'NaN')) or
       (new.drop_percent is not null and (new.drop_percent <= 0 or new.drop_percent > 100 or new.drop_percent::text = 'NaN')) then
      raise exception 'Invalid monitoring rule';
    end if;
    if tg_op = 'INSERT' then
      if new.departure_date < (now() at time zone 'Asia/Taipei')::date then raise exception 'Departure date is in the past'; end if;
      perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 1));
      if (select count(*) from public.watch_rules where user_id = new.user_id) >= 10 then
        raise exception 'Each account can have at most 10 rules';
      end if;
    end if;
    new.updated_at = now();
  end if;
  return new;
end;
$$;
revoke all on function public.validate_user_watch_rule() from public, anon, authenticated;
drop trigger if exists validate_user_rule on public.watch_rules;
create trigger validate_user_rule before insert or update on public.watch_rules for each row execute function public.validate_user_watch_rule();

-- Exact column grants prevent browser writes to ownership on update or server-managed fields.
revoke all on public.watch_rules, public.price_history, public.alerts, public.monitor_locks from anon, authenticated;
grant select, delete on public.watch_rules to authenticated;
grant insert (user_id, provider, origin, destination, departure_date, return_date, adults, currency, target_price, notify_new_low, new_low_days, drop_amount, drop_percent, enabled) on public.watch_rules to authenticated;
grant update (origin, destination, departure_date, return_date, adults, target_price, notify_new_low, new_low_days, drop_amount, drop_percent, enabled) on public.watch_rules to authenticated;
grant select on public.price_history to authenticated;
grant select (id, watch_rule_id, price, type, status, created_at, sent_at) on public.alerts to authenticated;
drop policy if exists own_rules on public.watch_rules;
create policy own_rules on public.watch_rules for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists own_history on public.price_history;
create policy own_history on public.price_history for select to authenticated using (exists (select 1 from public.watch_rules r where r.id = watch_rule_id and r.user_id = (select auth.uid())));
drop policy if exists own_alerts on public.alerts;
create policy own_alerts on public.alerts for select to authenticated using (exists (select 1 from public.watch_rules r where r.id = watch_rule_id and r.user_id = (select auth.uid())));

-- Only the worker can resolve a current, confirmed account address for an owned rule.
create or replace function public.monitor_recipient(p_rule uuid, p_owner uuid)
returns text language sql security definer set search_path = public as $$
  select u.email::text from public.watch_rules r join auth.users u on u.id = r.user_id
  where r.id = p_rule and r.user_id = p_owner and r.enabled and u.email_confirmed_at is not null;
$$;
revoke all on function public.monitor_recipient(uuid, uuid) from public, anon, authenticated;
grant execute on function public.monitor_recipient(uuid, uuid) to service_role;
commit;
notify pgrst, 'reload schema';
