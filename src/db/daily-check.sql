-- Run AFTER schema.sql, multi-user.sql and cloud-check.sql. Does not create an external schedule.
-- Enabling this singleton and the Apify schedule is a separate operator action.
begin;

create table if not exists public.cloud_monitor_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  allowed_emails text[] not null default array[]::text[],
  updated_at timestamptz not null default now()
);
insert into public.cloud_monitor_settings(singleton) values (true) on conflict do nothing;
alter table public.cloud_monitor_settings enable row level security;
revoke all on public.cloud_monitor_settings from public,anon,authenticated;
grant all on public.cloud_monitor_settings to service_role;

create or replace function public.get_cloud_schedule_status()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_enabled boolean := false; v_eligible boolean := false; v_rule_count integer := 0;
begin
  select s.enabled, exists (
    select 1 from auth.users u, unnest(s.allowed_emails) e
    where u.id=auth.uid() and u.email_confirmed_at is not null and lower(u.email)=lower(btrim(e))
  ) into v_enabled,v_eligible from public.cloud_monitor_settings s where s.singleton;
  if v_eligible then
    select count(*) into v_rule_count from public.watch_rules r join auth.users u on u.id=r.user_id
    join public.cloud_monitor_settings s on s.singleton
    where r.enabled and r.provider='google-flights' and u.email_confirmed_at is not null
      and r.departure_date >= (now() at time zone 'Asia/Taipei')::date
      and exists (select 1 from unnest(s.allowed_emails) e where lower(btrim(e))=lower(u.email));
  end if;
  return jsonb_build_object('enabled',coalesce(v_enabled and v_eligible,false),
    'eligible',coalesce(v_eligible,false),'timeZone','Asia/Taipei',
    'windowStart','09:00','windowEnd','09:20','eveningWindowStart','21:00','eveningWindowEnd','21:20',
    'checksPerRulePerDay',case when v_eligible and v_rule_count<=5 then 2 else 1 end,
    'scheduledDailyLimit',10,'manualDailyLimit',2);
end;
$$;

create or replace function public.reserve_scheduled_cloud_check_job(p_allowed_emails text[] default array[]::text[])
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_settings public.cloud_monitor_settings;
  v_rule public.watch_rules;
  v_job public.cloud_check_jobs;
  v_today timestamptz := date_trunc('day',now() at time zone 'Asia/Taipei') at time zone 'Asia/Taipei';
  v_window timestamptz := (((now() at time zone 'Asia/Taipei')::date-30)::timestamp at time zone 'Asia/Taipei');
  v_period_start timestamptz := (date_trunc('day',now() at time zone 'Asia/Taipei') +
    case when (now() at time zone 'Asia/Taipei')::time >= time '18:00' then interval '18 hours' else interval '0 hours' end)
    at time zone 'Asia/Taipei';
  v_rule_count integer;
  v_day_count integer; v_month_count integer;
  v_global_day_count integer; v_global_month_count integer;
begin
  -- Both reservation paths use the same transaction lock: no quota or same-rule race.
  perform pg_advisory_xact_lock(hashtextextended('flight-monitor-cloud-check-v1',0));
  select * into v_settings from public.cloud_monitor_settings where singleton;
  if not found or not v_settings.enabled or cardinality(v_settings.allowed_emails)=0
    or p_allowed_emails is null or coalesce(cardinality(p_allowed_emails),0)=0 then
    return jsonb_build_object('status','disabled');
  end if;
  update public.cloud_check_jobs set status='expired',finished_at=now(),error_code='expired'
    where status in ('reserved','running') and expires_at<=now();
  if exists (select 1 from public.cloud_check_jobs where trigger_source='scheduled'
    and status in ('reserved','running') and expires_at>now()) then
    return jsonb_build_object('status','busy');
  end if;
  select count(*) filter (where trigger_source='scheduled'),count(*) into v_day_count,v_global_day_count
    from public.cloud_check_jobs where created_at>=v_today;
  select count(*) filter (where trigger_source='scheduled'),count(*) into v_month_count,v_global_month_count
    from public.cloud_check_jobs where created_at>=v_window;
  if v_day_count>=10 or v_global_day_count>=12 then return jsonb_build_object('status','daily-limit'); end if;
  if v_month_count>=310 or v_global_month_count>=372 then return jsonb_build_object('status','monthly-limit'); end if;

  -- Count all configured, invited eligible rules, independently of this worker's Runtime list.
  -- Five rules fit both daily rounds; a larger set gets one attempt each before capacity runs out.
  select count(*) into v_rule_count from public.watch_rules r join auth.users u on u.id=r.user_id
  where r.enabled and r.provider='google-flights' and u.email_confirmed_at is not null
    and r.departure_date >= (now() at time zone 'Asia/Taipei')::date
    and exists (select 1 from unnest(v_settings.allowed_emails) e where lower(btrim(e))=lower(u.email));

  select r.* into v_rule from public.watch_rules r join auth.users u on u.id=r.user_id
  left join (select watch_rule_id,max(created_at) last_attempt from public.cloud_check_jobs group by watch_rule_id) attempts
    on attempts.watch_rule_id=r.id
  where r.enabled and r.provider='google-flights' and u.email_confirmed_at is not null
    and r.departure_date >= (now() at time zone 'Asia/Taipei')::date
    and exists (select 1 from unnest(v_settings.allowed_emails) e where lower(btrim(e))=lower(u.email))
    and exists (select 1 from unnest(p_allowed_emails) e where lower(btrim(e))=lower(u.email))
    -- Every source/status counts for the current round (or whole day with more than five rules).
    -- Failed/expired/uncertain work cannot be retried by another slot in that same period.
    and not exists (select 1 from public.cloud_check_jobs j where j.watch_rule_id=r.id
      and j.created_at>=case when v_rule_count<=5 then v_period_start else v_today end)
    and (v_rule_count>5 or (select count(*) from public.cloud_check_jobs j where j.watch_rule_id=r.id
      and j.trigger_source='scheduled' and j.created_at>=v_today)<2)
    -- An SMTP result left uncertain by an earlier run must not be automatically sent again tonight.
    and not exists (select 1 from public.alerts a where a.watch_rule_id=r.id
      and a.status='pending' and a.created_at>now()-interval '23 hours')
    and not exists (select 1 from public.cloud_check_jobs j where j.watch_rule_id=r.id
      and j.status in ('reserved','running') and j.expires_at>now())
  order by attempts.last_attempt asc nulls first,r.id asc limit 1;
  if not found then return jsonb_build_object('status','no-eligible-rule'); end if;

  insert into public.cloud_check_jobs(watch_rule_id,user_id,trigger_source)
    values(v_rule.id,v_rule.user_id,'scheduled') returning * into v_job;
  return jsonb_build_object('jobId',v_job.id,'status',v_job.status,'expiresAt',v_job.expires_at,
    'remainingToday',least(9-v_day_count,11-v_global_day_count),
    'remainingMonth',least(309-v_month_count,371-v_global_month_count));
end;
$$;

-- Per-rule workers may overlap on different rules. Legacy whole-monitor runs are exclusive
-- with every per-rule worker. The same advisory lock closes check/insert races in both directions.
create or replace function public.acquire_monitor_lock(p_owner uuid)
returns boolean language plpgsql security invoker set search_path=public as $$
declare v_acquired boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('flight-monitor-monitor-locks-v1',0));
  if exists (select 1 from public.monitor_locks where name like 'rule:%' and expires_at>now()) then return false; end if;
  with acquired as (
    insert into public.monitor_locks(name,owner,expires_at) values('monitor',p_owner,now()+interval '20 minutes')
    on conflict(name) do update set owner=excluded.owner,expires_at=excluded.expires_at
    where monitor_locks.expires_at<=now() returning name
  ) select exists(select 1 from acquired) into v_acquired;
  return v_acquired;
end;
$$;

create or replace function public.acquire_rule_monitor_lock(p_rule_id uuid,p_user_id uuid,p_owner uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_acquired boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('flight-monitor-monitor-locks-v1',0));
  if p_owner is null or not exists (
    select 1 from public.watch_rules r join auth.users u on u.id=r.user_id
    where r.id=p_rule_id and r.user_id=p_user_id and r.provider='google-flights' and r.enabled
      and r.departure_date>=(now() at time zone 'Asia/Taipei')::date and u.email_confirmed_at is not null
  ) or exists(select 1 from public.monitor_locks where name='monitor' and expires_at>now()) then return false; end if;
  with acquired as (
    insert into public.monitor_locks(name,owner,expires_at) values('rule:'||p_rule_id::text,p_owner,now()+interval '5 minutes')
    on conflict(name) do update set owner=excluded.owner,expires_at=excluded.expires_at
    where monitor_locks.expires_at<=now() returning name
  ) select exists(select 1 from acquired) into v_acquired;
  return v_acquired;
end;
$$;

create or replace function public.release_rule_monitor_lock(p_rule_id uuid,p_user_id uuid,p_owner uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('flight-monitor-monitor-locks-v1',0));
  -- Release only this lease, including when its owner disabled/deleted the rule during the run.
  -- user_id is checked against any remaining rule or its retained job; owner UUID still must match.
  if exists(select 1 from public.watch_rules where id=p_rule_id and user_id=p_user_id)
    or exists(select 1 from public.cloud_check_jobs where watch_rule_id=p_rule_id and user_id=p_user_id) then
    delete from public.monitor_locks where name='rule:'||p_rule_id::text and owner=p_owner;
  end if;
end;
$$;

revoke all on function public.get_cloud_schedule_status() from public,anon,service_role;
grant execute on function public.get_cloud_schedule_status() to authenticated;
revoke all on function public.reserve_scheduled_cloud_check_job(text[]) from public,anon,authenticated;
revoke all on function public.acquire_monitor_lock(uuid) from public,anon,authenticated;
revoke all on function public.acquire_rule_monitor_lock(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.release_rule_monitor_lock(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.reserve_scheduled_cloud_check_job(text[]) to service_role;
grant execute on function public.acquire_monitor_lock(uuid) to service_role;
grant execute on function public.acquire_rule_monitor_lock(uuid,uuid,uuid) to service_role;
grant execute on function public.release_rule_monitor_lock(uuid,uuid,uuid) to service_role;
commit;
notify pgrst,'reload schema';
