-- Run AFTER schema.sql and multi-user.sql. No schedule or external request is created.
-- Reservations count even if starting the worker fails or its response is lost.
begin;

create table if not exists public.cloud_check_jobs (
  id uuid primary key default gen_random_uuid(),
  -- Deliberately keep quota records after a rule/account is deleted.
  watch_rule_id uuid not null,
  user_id uuid not null,
  trigger_source text not null default 'manual' check (trigger_source in ('manual','scheduled')),
  status text not null default 'reserved' check (status in ('reserved', 'running', 'succeeded', 'failed', 'expired')),
  run_id text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  started_at timestamptz,
  finished_at timestamptz,
  total_price numeric(10,2) check (total_price > 0),
  currency text check (currency = 'TWD'),
  error_code text check (error_code ~ '^[a-z][a-z0-9_-]{0,63}$'),
  email_status text check (email_status in ('accepted', 'preview', 'not-triggered'))
);
-- Existing reservations remain manual; attempts never disappear when their rule does.
alter table public.cloud_check_jobs add column if not exists trigger_source text not null default 'manual';
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.cloud_check_jobs'::regclass
    and conname='cloud_check_jobs_trigger_source_check') then
    alter table public.cloud_check_jobs add constraint cloud_check_jobs_trigger_source_check
      check (trigger_source in ('manual','scheduled'));
  end if;
end $$;
create index if not exists cloud_check_jobs_created on public.cloud_check_jobs(created_at desc);
create index if not exists cloud_check_jobs_owner on public.cloud_check_jobs(user_id, created_at desc);
create index if not exists cloud_check_jobs_rule_created on public.cloud_check_jobs(watch_rule_id, created_at desc);
alter table public.cloud_check_jobs enable row level security;
revoke all on public.cloud_check_jobs from anon, authenticated;
grant select on public.cloud_check_jobs to authenticated;
grant all on public.cloud_check_jobs to service_role;
drop policy if exists own_cloud_check_jobs on public.cloud_check_jobs;
create policy own_cloud_check_jobs on public.cloud_check_jobs for select to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.reserve_cloud_check_job(
  p_rule_id uuid, p_user_id uuid,
  p_allowed_emails text[] default array[]::text[]
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_job public.cloud_check_jobs;
  v_today timestamptz := date_trunc('day', now() at time zone 'Asia/Taipei') at time zone 'Asia/Taipei';
  -- The current Taipei day plus its preceding 30 days, avoiding cron jitter at 09:00.
  v_window timestamptz := (((now() at time zone 'Asia/Taipei')::date - 30)::timestamp at time zone 'Asia/Taipei');
  v_day_count integer;
  v_month_count integer;
  v_global_day_count integer;
  v_global_month_count integer;
begin
  -- One transaction serializes the account-wide active/cooldown/quota checks.
  perform pg_advisory_xact_lock(hashtextextended('flight-monitor-cloud-check-v1', 0));
  select lower(u.email) into v_email from auth.users u
    where u.id = p_user_id and u.email_confirmed_at is not null;
  if v_email is null or p_allowed_emails is null or cardinality(p_allowed_emails) = 0
    or not exists (select 1 from unnest(p_allowed_emails) e where lower(btrim(e))=v_email) or not exists (
    select 1 from public.watch_rules r where r.id = p_rule_id and r.user_id = p_user_id
      and r.enabled and r.provider = 'google-flights'
      and r.departure_date >= (now() at time zone 'Asia/Taipei')::date
  ) then raise exception 'cloud_check_not_allowed'; end if;

  update public.cloud_check_jobs set status = 'expired', finished_at = now(), error_code = 'expired'
    where status in ('reserved','running') and expires_at <= now();
  if exists (select 1 from public.cloud_check_jobs where status in ('reserved','running') and expires_at > now()
    and (trigger_source='manual' or watch_rule_id=p_rule_id))
    then raise exception 'cloud_check_busy'; end if;
  if exists (select 1 from public.cloud_check_jobs where trigger_source='manual' and created_at > now() - interval '2 minutes')
    then raise exception 'cloud_check_cooldown'; end if;
  select count(*) filter (where trigger_source='manual'), count(*) into v_day_count,v_global_day_count
    from public.cloud_check_jobs where created_at >= v_today;
  select count(*) filter (where trigger_source='manual'), count(*) into v_month_count,v_global_month_count
    from public.cloud_check_jobs where created_at >= v_window;
  if v_day_count >= 2 or v_global_day_count >= 12 then raise exception 'cloud_check_daily_limit'; end if;
  if v_month_count >= 62 or v_global_month_count >= 372 then raise exception 'cloud_check_monthly_limit'; end if;
  insert into public.cloud_check_jobs(watch_rule_id,user_id,trigger_source) values (p_rule_id,p_user_id,'manual') returning * into v_job;
  return jsonb_build_object('jobId',v_job.id,'status',v_job.status,'expiresAt',v_job.expires_at,
    'remainingToday',least(1-v_day_count,11-v_global_day_count),
    'remainingMonth',least(61-v_month_count,371-v_global_month_count));
end;
$$;

create or replace function public.set_cloud_check_run(p_job_id uuid, p_run_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_run_id is null or p_run_id !~ '^[A-Za-z0-9]{1,80}$' then raise exception 'cloud_check_invalid_run'; end if;
  update public.cloud_check_jobs set run_id = p_run_id
    where id = p_job_id and (run_id is null or run_id = p_run_id);
  if not found then raise exception 'cloud_check_invalid_run'; end if;
end;
$$;

create or replace function public.claim_cloud_check_job(p_job_id uuid, p_run_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_job public.cloud_check_jobs; v_rule public.watch_rules;
begin
  if p_run_id is null or p_run_id !~ '^[A-Za-z0-9]{1,80}$' then raise exception 'cloud_check_invalid_run'; end if;
  select * into v_job from public.cloud_check_jobs where id = p_job_id for update;
  if not found or v_job.status <> 'reserved' or v_job.expires_at <= now()
    or (v_job.run_id is not null and v_job.run_id <> p_run_id)
    then raise exception 'cloud_check_not_claimable'; end if;
  select * into v_rule from public.watch_rules where id = v_job.watch_rule_id
    and user_id = v_job.user_id and enabled and provider = 'google-flights'
    and departure_date >= (now() at time zone 'Asia/Taipei')::date;
  if not found or not exists (select 1 from auth.users where id = v_job.user_id and email_confirmed_at is not null)
    then raise exception 'cloud_check_not_allowed'; end if;
  update public.cloud_check_jobs set status = 'running',run_id = p_run_id,started_at = now()
    where id = p_job_id returning * into v_job;
  return jsonb_build_object('id',v_job.id,'watch_rule_id',v_job.watch_rule_id,'user_id',v_job.user_id,
    'status',v_job.status,'expires_at',v_job.expires_at,'watch_rule', jsonb_strip_nulls(jsonb_build_object(
      'id',v_rule.id,'userId',v_rule.user_id,'provider',v_rule.provider,'origin',v_rule.origin,
      'destination',v_rule.destination,'departureDate',v_rule.departure_date,'returnDate',v_rule.return_date,
      'adults',v_rule.adults,'currency',v_rule.currency,'targetPrice',v_rule.target_price,
      'notifyNewLow',v_rule.notify_new_low,'newLowDays',v_rule.new_low_days,
      'dropAmount',v_rule.drop_amount,'dropPercent',v_rule.drop_percent,'enabled',v_rule.enabled)));
end;
$$;

create or replace function public.finish_cloud_check_job(
  p_job_id uuid, p_run_id text, p_status text,
  p_total_price numeric default null, p_currency text default null,
  p_error_code text default null, p_email_status text default null
)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('succeeded','failed') or p_status is null
    or (p_total_price is not null and (p_total_price <= 0 or p_total_price::text in ('NaN','Infinity','-Infinity')))
    or ((p_total_price is null) <> (p_currency is null))
    or (p_currency is not null and p_currency <> 'TWD')
    or (p_error_code is not null and p_error_code !~ '^[a-z][a-z0-9_-]{0,63}$')
    or (p_email_status is not null and p_email_status not in ('accepted','preview','not-triggered'))
    then raise exception 'cloud_check_invalid_result'; end if;
  update public.cloud_check_jobs set status=p_status,finished_at=now(),total_price=p_total_price,
    currency=p_currency,error_code=p_error_code,email_status=p_email_status
    where id=p_job_id and run_id=p_run_id and status='running' and expires_at>now();
  if not found then raise exception 'cloud_check_not_running'; end if;
end;
$$;

-- A definite dispatch rejection can finish a reservation, never refund its budget.
create or replace function public.reject_cloud_check_job(p_job_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.cloud_check_jobs set status='failed',finished_at=now(),error_code='cloud-start-rejected'
    where id=p_job_id and status='reserved' and run_id is null;
$$;

revoke all on function public.reserve_cloud_check_job(uuid,uuid,text[]) from public,anon,authenticated;
revoke all on function public.set_cloud_check_run(uuid,text) from public,anon,authenticated;
revoke all on function public.claim_cloud_check_job(uuid,text) from public,anon,authenticated;
revoke all on function public.finish_cloud_check_job(uuid,text,text,numeric,text,text,text) from public,anon,authenticated;
revoke all on function public.reject_cloud_check_job(uuid) from public,anon,authenticated;
grant execute on function public.reserve_cloud_check_job(uuid,uuid,text[]) to service_role;
grant execute on function public.set_cloud_check_run(uuid,text) to service_role;
grant execute on function public.claim_cloud_check_job(uuid,text) to service_role;
grant execute on function public.finish_cloud_check_job(uuid,text,text,numeric,text,text,text) to service_role;
grant execute on function public.reject_cloud_check_job(uuid) to service_role;
commit;
notify pgrst, 'reload schema';
