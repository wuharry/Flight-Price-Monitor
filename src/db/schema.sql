-- Run in Supabase SQL Editor. Re-runnable, preserves legacy data.
-- Legacy simulated history has no search_key, so it is never used as a baseline.
begin;

create table if not exists public.watch_rules (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'tigerair',
  origin varchar(3) not null,
  destination varchar(3) not null,
  departure_date date not null,
  return_date date,
  adults integer not null default 1,
  target_price numeric(10,2),
  notify_new_low boolean not null default true,
  drop_amount numeric(10,2),
  drop_percent numeric(5,2),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.watch_rules add column if not exists currency text not null default 'TWD';
alter table public.watch_rules add column if not exists new_low_days integer not null default 30;

create table if not exists public.price_history (
  id uuid primary key default gen_random_uuid(),
  watch_rule_id uuid not null references public.watch_rules(id) on delete cascade,
  price numeric(10,2) not null check (price > 0),
  outbound_price numeric(10,2),
  inbound_price numeric(10,2),
  tax_and_fees numeric(10,2),
  currency varchar(10) not null default 'TWD',
  checked_at timestamptz not null default now()
);
alter table public.price_history add column if not exists search_key text;
alter table public.price_history add column if not exists result jsonb;
create index if not exists price_history_search_date on public.price_history(watch_rule_id, search_key, checked_at desc);

create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  watch_rule_id uuid not null references public.watch_rules(id) on delete cascade,
  price numeric(10,2) not null,
  type varchar(30) not null,
  message text,
  sent_at timestamptz
);
alter table public.alerts alter column sent_at drop not null;
alter table public.alerts alter column sent_at drop default;
alter table public.alerts add column if not exists search_key text;
alter table public.alerts add column if not exists status text not null default 'sent';
alter table public.alerts add column if not exists created_at timestamptz not null default now();
alter table public.alerts add column if not exists payload jsonb;
create index if not exists alerts_pending on public.alerts(status, created_at);
create index if not exists alerts_dedupe on public.alerts(watch_rule_id, search_key, price, sent_at desc);

-- Extra operational table: prevents overlap between deployments / manual runs.
create table if not exists public.monitor_locks (
  name text primary key,
  owner uuid not null,
  expires_at timestamptz not null
);

create or replace function public.acquire_monitor_lock(p_owner uuid)
returns boolean language sql security invoker set search_path = public as $$
  with acquired as (
    insert into public.monitor_locks(name, owner, expires_at)
    values ('monitor', p_owner, now() + interval '20 minutes')
    on conflict (name) do update set owner = excluded.owner, expires_at = excluded.expires_at
    where monitor_locks.expires_at <= now()
    returning name
  )
  select exists(select 1 from acquired);
$$;

create or replace function public.release_monitor_lock(p_owner uuid)
returns void language sql security invoker set search_path = public as $$
  delete from public.monitor_locks where name = 'monitor' and owner = p_owner;
$$;

create or replace function public.record_price_check(p_history jsonb, p_alert jsonb default null)
returns void language plpgsql security invoker set search_path = public as $$
begin
  -- Serializes the dedupe check with its insert even if another caller uses the RPC.
  perform pg_advisory_xact_lock(hashtextextended(p_history->>'watchRuleId', 0));
  insert into public.price_history(id, watch_rule_id, search_key, price, currency, checked_at,
    outbound_price, inbound_price, tax_and_fees, result)
  values ((p_history->>'id')::uuid, (p_history->>'watchRuleId')::uuid, p_history->>'searchKey',
    (p_history->>'price')::numeric, p_history->>'currency', (p_history->>'checkedAt')::timestamptz,
    (p_history->'result'->>'outboundPrice')::numeric, (p_history->'result'->>'inboundPrice')::numeric,
    (p_history->'result'->>'taxAndFees')::numeric, p_history->'result');

  if p_alert is not null and p_alert <> 'null'::jsonb and not exists (
    select 1 from public.alerts where watch_rule_id = (p_alert->>'watchRuleId')::uuid
      and search_key = p_alert->>'searchKey' and price = (p_alert->>'price')::numeric
      and (status = 'pending' or (status = 'sent' and sent_at >= (p_history->>'checkedAt')::timestamptz - interval '24 hours'))
  ) then
    insert into public.alerts(id, watch_rule_id, search_key, price, type, message, status, created_at, payload, sent_at)
    values ((p_alert->>'id')::uuid, (p_alert->>'watchRuleId')::uuid, p_alert->>'searchKey',
      (p_alert->>'price')::numeric, p_alert->>'type', p_alert->'payload'->'trigger'->>'reason', 'pending',
      (p_alert->>'createdAt')::timestamptz, p_alert->'payload', null);
  end if;
end;
$$;

alter table public.watch_rules enable row level security;
alter table public.price_history enable row level security;
alter table public.alerts enable row level security;
alter table public.monitor_locks enable row level security;
revoke all on public.watch_rules, public.price_history, public.alerts, public.monitor_locks from anon, authenticated;
grant all on public.watch_rules, public.price_history, public.alerts, public.monitor_locks to service_role;
revoke all on function public.acquire_monitor_lock(uuid) from public, anon, authenticated;
revoke all on function public.release_monitor_lock(uuid) from public, anon, authenticated;
revoke all on function public.record_price_check(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.acquire_monitor_lock(uuid) to service_role;
grant execute on function public.release_monitor_lock(uuid) to service_role;
grant execute on function public.record_price_check(jsonb, jsonb) to service_role;
commit;
