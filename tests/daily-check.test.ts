import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

type Reservation = {status: string; jobId?: string; remainingToday?: number; remainingMonth?: number};
const emails = ['uncle@example.com','owner@example.com'];

async function database() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
    create or replace function pg_catalog.now() returns timestamptz language sql stable
      as $$ select current_setting('test.clock')::timestamptz $$;
    select set_config('test.clock','2026-11-02T04:00:00Z',false);`);
  const migrations = ['src/db/schema.sql','src/db/multi-user.sql','src/db/cloud-check.sql','src/db/daily-check.sql'];
  for (const file of migrations) await db.exec(await readFile(file,'utf8'));
  const alice=randomUUID(),bob=randomUUID(),unverified=randomUUID();
  await db.query('insert into auth.users values($1,$2,now()),($3,$4,now()),($5,$6,null)',
    [alice,emails[0],bob,emails[1],unverified,'unverified@example.com']);
  const service = () => db.exec('reset role; set role service_role');
  const asUser = async (id:string) => { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]); await db.exec('set role authenticated'); };
  const rule = async (owner:string|null=alice,options:{id?:string;provider?:string;enabled?:boolean;dateOffset?:number}={}) => {
    const id=options.id??randomUUID();
    await db.query(`insert into watch_rules(id,user_id,provider,origin,destination,departure_date,enabled)
      values($1,$2,$3,'TPE','NRT',(now() at time zone 'Asia/Taipei')::date+30,$4)`,
      [id,owner,options.provider??'google-flights',options.enabled??true]);
    if (options.dateOffset!==undefined) await db.query("update watch_rules set departure_date=(now() at time zone 'Asia/Taipei')::date+$2::integer where id=$1",[id,options.dateOffset]);
    return id;
  };
  const enable = (allowed=emails,enabled=true) => db.query('update cloud_monitor_settings set enabled=$1,allowed_emails=$2::text[]',[enabled,allowed]);
  const scheduled = async (allowed=emails) => (await db.query<{r:Reservation}>(
    'select reserve_scheduled_cloud_check_job($1::text[]) r',[allowed])).rows[0].r;
  const manual = async (id:string,owner=alice) => (await db.query<{r:Reservation}>(
    'select reserve_cloud_check_job($1,$2,$3::text[]) r',[id,owner,emails])).rows[0].r;
  const finish = (id:string,status='failed') => db.query("update cloud_check_jobs set status=$2,finished_at=now(),expires_at=now()-interval '1 second' where id=$1",[id,status]);
  const seed = (source:'manual'|'scheduled',count:number,age:string,ruleId:string=randomUUID(),status='failed') => db.query(`
    insert into cloud_check_jobs(watch_rule_id,user_id,trigger_source,status,created_at,expires_at)
    select $1,$2,$3,$4,now()-$5::interval,now()-interval '1 hour' from generate_series(1,$6::integer)`,
    [ruleId,alice,source,status,age,count]);
  const selected = async (r:Reservation) => (await db.query<{watch_rule_id:string}>('select watch_rule_id from cloud_check_jobs where id=$1',[r.jobId])).rows[0].watch_rule_id;
  const count = async () => (await db.query<{n:number}>('select count(*)::integer n from cloud_check_jobs')).rows[0].n;
  return {db,migrations,alice,bob,unverified,service,asUser,rule,enable,scheduled,manual,finish,seed,selected,count};
}

test('daily migrations preserve settings and attempts; browser can read only its invitation and cannot enable, reserve or lock',async()=>{
  const f=await database();
  try {
    const {db}=f;
    assert.deepEqual((await db.query<{enabled:boolean;allowed_emails:string[]}>('select enabled,allowed_emails from cloud_monitor_settings')).rows,
      [{enabled:false,allowed_emails:[]}]);
    const id=await f.rule();
    // Recreate the shape of the deployed pre-scheduling jobs table, with a retained legacy attempt.
    await db.exec('alter table cloud_check_jobs drop column trigger_source');
    await db.query('insert into cloud_check_jobs(watch_rule_id,user_id) values($1,$2)',[id,f.alice]);
    await db.exec(await readFile('src/db/cloud-check.sql','utf8'));
    assert.equal((await db.query<{trigger_source:string}>('select trigger_source from cloud_check_jobs')).rows[0].trigger_source,'manual');
    await assert.rejects(db.query("insert into cloud_check_jobs(watch_rule_id,user_id,trigger_source) values($1,$2,'other')",[id,f.alice]),/check constraint/);
    await f.enable([emails[0]],false);
    for (const file of f.migrations.slice(2)) await db.exec(await readFile(file,'utf8'));
    assert.equal(await f.count(),1);
    await f.asUser(f.alice);
    const status=(await db.query<{s:Record<string,unknown>}>('select get_cloud_schedule_status() s')).rows[0].s;
    assert.deepEqual(status,{enabled:false,eligible:true,timeZone:'Asia/Taipei',windowStart:'09:00',windowEnd:'09:20',
      eveningWindowStart:'21:00',eveningWindowEnd:'21:20',checksPerRulePerDay:2,scheduledDailyLimit:10,manualDailyLimit:2});
    await assert.rejects(db.query('select * from cloud_monitor_settings'),/permission denied/);
    await assert.rejects(db.exec('update cloud_monitor_settings set enabled=true'),/permission denied/);
    await assert.rejects(f.scheduled(),/permission denied/);
    await assert.rejects(f.manual(id),/permission denied/);
    await assert.rejects(db.query('select acquire_rule_monitor_lock($1,$2,$3)',[id,f.alice,randomUUID()]),/permission denied/);
    await assert.rejects(db.query('select release_rule_monitor_lock($1,$2,$3)',[id,f.alice,randomUUID()]),/permission denied/);
    await f.asUser(f.bob);
    assert.equal((await db.query<{s:{eligible:boolean}}>('select get_cloud_schedule_status() s')).rows[0].s.eligible,false);
    assert.equal((await db.query<{s:{checksPerRulePerDay:number}}>('select get_cloud_schedule_status() s')).rows[0].s.checksPerRulePerDay,1);
    await f.asUser(f.unverified);
    assert.equal((await db.query<{s:{eligible:boolean}}>('select get_cloud_schedule_status() s')).rows[0].s.eligible,false);
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select get_cloud_schedule_status()'),/permission denied/);
    await f.service(); await f.enable([emails[0],'unverified@example.com'],true);
    await f.asUser(f.unverified);
    assert.equal((await db.query<{s:{eligible:boolean}}>('select get_cloud_schedule_status() s')).rows[0].s.eligible,false);
    await f.asUser(f.alice);
    assert.equal((await db.query<{s:{enabled:boolean}}>('select get_cloud_schedule_status() s')).rows[0].s.enabled,true);
  } finally { await f.db.close(); }
});

test('scheduled eligibility intersects runtime and stored invitations and rejects unverified, legacy, disabled, ownerless and past rules',async()=>{
  const f=await database();
  try {
    const good=await f.rule(f.alice,{dateOffset:0});
    await f.rule(f.bob); await f.rule(f.unverified); await f.rule(null);
    await f.rule(f.alice,{provider:'tigerair'}); await f.rule(f.alice,{enabled:false}); await f.rule(f.alice,{dateOffset:-1});
    await f.service();
    assert.equal((await f.scheduled()).status,'disabled');
    await f.enable([emails[0],'unverified@example.com'],true);
    assert.equal((await f.scheduled([])).status,'disabled');
    assert.equal((await f.scheduled([emails[1]])).status,'no-eligible-rule');
    assert.equal(await f.count(),0);
    const first=await f.scheduled(['  UNCLE@EXAMPLE.COM ']);
    assert.equal(first.status,'reserved'); assert.equal(await f.selected(first),good);
    await f.finish(first.jobId!);
    assert.equal((await f.scheduled([...emails,'unverified@example.com'])).status,'no-eligible-rule');
    assert.equal(await f.count(),1);
  } finally {await f.db.close();}
});

test('scheduled selection serves never-attempted then least recently attempted rules and does not retry any same-day source or outcome',async()=>{
  const f=await database();
  try {
    const oldest=await f.rule(f.alice,{id:'00000000-0000-4000-8000-000000000001'});
    const recent=await f.rule(f.alice,{id:'00000000-0000-4000-8000-000000000002'});
    const never1=await f.rule(f.alice,{id:'00000000-0000-4000-8000-000000000003'});
    const never2=await f.rule(f.alice,{id:'00000000-0000-4000-8000-000000000004'});
    const manualToday=await f.rule(); const expiredToday=await f.rule();
    await f.seed('scheduled',1,'3 days',oldest); await f.seed('manual',1,'1 day',recent);
    await f.seed('manual',1,'5 minutes',manualToday); await f.seed('scheduled',1,'5 minutes',expiredToday,'expired');
    await f.service(); await f.enable();
    for (const id of [never1,never2,oldest,recent]) {
      const job=await f.scheduled(); assert.equal(await f.selected(job),id);
      assert.equal((await f.scheduled()).status,'busy');
      await f.finish(job.jobId!,'failed');
    }
    assert.equal((await f.scheduled()).status,'no-eligible-rule');
    // Editing a failed rule must not turn that already-consumed attempt into a retry.
    await f.db.query('update watch_rules set target_price=20000 where id=$1',[oldest]);
    assert.equal((await f.scheduled()).status,'no-eligible-rule');
    assert.equal(await f.count(),8);
  } finally {await f.db.close();}
});

test('five eligible rules each get one morning and one evening attempt, with the ten-attempt daily cap unchanged',async()=>{
  const f=await database();
  try {
    const ids=[];
    for(let i=1;i<=5;i++) ids.push(await f.rule(f.alice,{id:`00000000-0000-4000-8000-00000000000${i}`}));
    await f.service(); await f.enable();
    await f.db.query("select set_config('test.clock','2026-11-02T01:00:00Z',false)");
    for(const id of ids) {
      const job=await f.scheduled(); assert.equal(await f.selected(job),id);
      await f.finish(job.jobId!,'succeeded');
    }
    assert.equal((await f.scheduled()).status,'no-eligible-rule');
    await f.db.query("select set_config('test.clock','2026-11-02T13:00:00Z',false)");
    for(const id of ids) {
      const job=await f.scheduled(); assert.equal(await f.selected(job),id);
      await f.finish(job.jobId!,'succeeded');
    }
    assert.equal((await f.scheduled()).status,'daily-limit');
    const counts=(await f.db.query<{watch_rule_id:string;n:number}>(
      'select watch_rule_id,count(*)::integer n from cloud_check_jobs group by watch_rule_id order by watch_rule_id')).rows;
    assert.deepEqual(counts,ids.map(watch_rule_id=>({watch_rule_id,n:2})));
  } finally {await f.db.close();}
});

test('a manual attempt consumes its current round, including failure, and 18:00 Taipei opens the next round',async()=>{
  const f=await database();
  try {
    const id=await f.rule(); await f.service(); await f.enable();
    await f.db.query("select set_config('test.clock','2026-11-02T09:59:59Z',false)"); // 17:59:59 Taipei.
    const manual=await f.manual(id); await f.finish(manual.jobId!,'failed');
    assert.equal((await f.scheduled()).status,'no-eligible-rule');
    await f.db.query("select set_config('test.clock','2026-11-02T10:00:00Z',false)");
    const evening=await f.scheduled(); assert.equal(await f.selected(evening),id); await f.finish(evening.jobId!,'failed');
    assert.equal((await f.scheduled()).status,'no-eligible-rule');
    assert.equal(await f.count(),2);
    await f.db.query("select set_config('test.clock','2026-11-02T16:00:00Z',false)"); // Next Taipei day.
    assert.equal((await f.scheduled()).status,'reserved');
  } finally {await f.db.close();}
});

test('six globally invited eligible rules receive only one daily attempt even when this worker sees five',async()=>{
  const f=await database();
  try {
    const ids=[];
    for(let i=1;i<=5;i++) ids.push(await f.rule(f.alice,{id:`00000000-0000-4000-8000-00000000000${i}`}));
    const sixth=await f.rule(f.bob,{id:'00000000-0000-4000-8000-000000000006'});
    await f.service(); await f.enable();
    const manual=await f.manual(ids[0]); await f.finish(manual.jobId!,'failed');
    for(const id of ids.slice(1)) {
      const job=await f.scheduled([emails[0]]); assert.equal(await f.selected(job),id); await f.finish(job.jobId!,'succeeded');
    }
    await f.asUser(f.alice);
    assert.equal((await f.db.query<{s:{checksPerRulePerDay:number}}>('select get_cloud_schedule_status() s')).rows[0].s.checksPerRulePerDay,1);
    await f.service();
    await f.db.query("select set_config('test.clock','2026-11-02T13:00:00Z',false)");
    assert.equal((await f.scheduled([emails[0]])).status,'no-eligible-rule');
    const last=await f.scheduled(); assert.equal(await f.selected(last),sixth); await f.finish(last.jobId!,'failed');
    assert.equal((await f.scheduled()).status,'no-eligible-rule');
    // Disabled/legacy/past/unverified/uninvited rules must not keep the five-rule tier at one.
    await f.db.query('update watch_rules set enabled=false where id=$1',[sixth]);
    await f.rule(f.alice,{provider:'tigerair'}); await f.rule(f.alice,{dateOffset:-1});
    await f.rule(f.unverified); await f.rule(null);
    const outsider=randomUUID();
    await f.db.exec('reset role');
    await f.db.query('insert into auth.users values($1,$2,now())',[outsider,'outside@example.com']); await f.rule(outsider);
    await f.asUser(f.alice);
    assert.equal((await f.db.query<{s:{checksPerRulePerDay:number}}>('select get_cloud_schedule_status() s')).rows[0].s.checksPerRulePerDay,2);
    await f.service();
    const secondRound=await f.scheduled(); assert.equal(await f.selected(secondRound),ids[0]);
  } finally {await f.db.close();}
});

test('two earlier automatic attempts forbid a third even if retained records predate the current round',async()=>{
  const f=await database();
  try {
    const id=await f.rule(); await f.service(); await f.enable();
    await f.db.query("select set_config('test.clock','2026-11-02T13:00:00Z',false)");
    await f.seed('scheduled',2,'12 hours',id);
    assert.equal((await f.scheduled()).status,'no-eligible-rule');
    assert.equal(await f.count(),2);
  } finally {await f.db.close();}
});

test('an uncertain pending email blocks automatic evening retry for 23 hours while manual reservations remain available',async()=>{
  const f=await database();
  try {
    const id=await f.rule(); await f.service(); await f.enable();
    await f.db.query("select set_config('test.clock','2026-11-02T01:00:00Z',false)");
    const morning=await f.scheduled(); await f.finish(morning.jobId!,'failed');
    await f.db.query("insert into alerts(watch_rule_id,price,type,status,created_at) values($1,16088,'below_target','pending',now())",[id]);
    await f.db.query("select set_config('test.clock','2026-11-02T13:00:00Z',false)");
    assert.equal((await f.scheduled()).status,'no-eligible-rule');
    const manual=await f.manual(id); assert.equal(manual.status,'reserved'); await f.finish(manual.jobId!,'failed');
    // Isolate the pending guard from the consumed manual round on the next morning.
    await f.db.query("select set_config('test.clock','2026-11-03T00:00:00Z',false)"); // Exactly 23 h since the uncertain email.
    const resumed=await f.scheduled(); assert.equal(await f.selected(resumed),id);
  } finally {await f.db.close();}
});

test('only recent pending email suppresses automatic work; sent and expired pending records do not',async()=>{
  const f=await database();
  try {
    const id=await f.rule(); await f.service(); await f.enable();
    await f.db.query("insert into alerts(watch_rule_id,price,type,status,created_at) values($1,16088,'below_target','pending',now()-interval '22 hours 59 minutes 59 seconds')",[id]);
    assert.equal((await f.scheduled()).status,'no-eligible-rule');
    await f.db.query("update alerts set created_at=now()-interval '23 hours'");
    const expired=await f.scheduled(); assert.equal(expired.status,'reserved'); await f.finish(expired.jobId!);
    await f.db.query("select set_config('test.clock','2026-11-02T13:00:00Z',false)");
    await f.db.query("update alerts set status='sent',created_at=now()");
    assert.equal((await f.scheduled()).status,'reserved');
  } finally {await f.db.close();}
});

test('manual and scheduled jobs may overlap on different rules while a same-rule or same-source active reservation is blocked',async()=>{
  const f=await database();
  try {
    const one=await f.rule(f.alice,{id:'00000000-0000-4000-8000-000000000001'});
    const two=await f.rule(f.alice,{id:'00000000-0000-4000-8000-000000000002'});
    await f.service(); await f.enable();
    const automatic=await f.scheduled(); assert.equal(await f.selected(automatic),one);
    await assert.rejects(f.manual(one),/cloud_check_busy/);
    const manual=await f.manual(two); assert.equal(manual.status,'reserved');
    await assert.rejects(f.manual(two),/cloud_check_busy/);
    assert.equal((await f.scheduled()).status,'busy');
    await f.finish(automatic.jobId!);
    assert.equal((await f.scheduled()).status,'no-eligible-rule');
    await f.finish(manual.jobId!);
    await assert.rejects(f.manual(one),/cooldown/);
    await f.db.exec("update cloud_check_jobs set created_at=now()-interval '3 minutes' where trigger_source='manual'");
    assert.equal((await f.manual(one)).status,'reserved');
  } finally {await f.db.close();}
});

test('daily quotas reserve ten automatic and two manual attempts without borrowing or refunding failures/deletions',async()=>{
  const f=await database();
  try {
    const id=await f.rule(); await f.service(); await f.enable();
    await f.seed('scheduled',10,'5 minutes');
    assert.equal((await f.scheduled()).status,'daily-limit');
    const one=await f.manual(id); assert.equal(one.remainingToday,1);
    await f.finish(one.jobId!);
    await f.db.query("update cloud_check_jobs set created_at=now()-interval '3 minutes' where id=$1",[one.jobId]);
    const two=await f.manual(id); assert.equal(two.remainingToday,0); await f.finish(two.jobId!);
    await f.db.exec("update cloud_check_jobs set created_at=now()-interval '3 minutes' where trigger_source='manual'");
    await assert.rejects(f.manual(id),/daily_limit/);
    await f.db.query('delete from watch_rules where id=$1',[id]);
    assert.equal(await f.count(),12);
    assert.equal((await f.scheduled()).status,'daily-limit');
    // Source quota also works in reverse: consuming manual allowance leaves automatic slots.
    await f.db.exec('delete from cloud_check_jobs');
    const next=await f.rule(); await f.seed('manual',2,'3 minutes'); await f.seed('scheduled',9,'3 minutes');
    const tenth=await f.scheduled(); assert.equal(await f.selected(tenth),next); assert.equal(tenth.remainingToday,0);
    await f.finish(tenth.jobId!);
    assert.equal((await f.scheduled()).status,'daily-limit');
  } finally {await f.db.close();}
});

test('account-wide caps fail closed even when retained legacy records exceed a source allowance',async()=>{
  const f=await database();
  try {
    const id=await f.rule(); await f.service(); await f.enable();
    await f.seed('manual',12,'3 minutes');
    assert.equal((await f.scheduled()).status,'daily-limit');
    await f.db.exec('delete from cloud_check_jobs');
    await f.seed('scheduled',12,'3 minutes');
    await assert.rejects(f.manual(id),/daily_limit/);
    await f.db.exec('delete from cloud_check_jobs');
    await f.seed('manual',372,'30 days');
    assert.equal((await f.scheduled()).status,'monthly-limit');
    await f.db.exec('delete from cloud_check_jobs');
    await f.seed('scheduled',372,'30 days');
    await assert.rejects(f.manual(id),/monthly_limit/);
  } finally {await f.db.close();}
});

test('expired uncertain starts retain their daily attempt and are not retried by a later schedule slot',async()=>{
  const f=await database();
  try {
    const one=await f.rule(f.alice,{id:'00000000-0000-4000-8000-000000000001'});
    const two=await f.rule(f.alice,{id:'00000000-0000-4000-8000-000000000002'});
    await f.service(); await f.enable();
    const lost=await f.scheduled(); assert.equal(await f.selected(lost),one);
    await f.db.query("select set_config('test.clock','2026-11-02T04:11:00Z',false)");
    const next=await f.scheduled(); assert.equal(await f.selected(next),two); assert.equal(next.remainingToday,8);
    assert.equal((await f.db.query<{status:string}>('select status from cloud_check_jobs where id=$1',[lost.jobId])).rows[0].status,'expired');
    await assert.rejects(f.db.query('select claim_cloud_check_job($1,$2)',[lost.jobId,'lateActor']),/not_claimable/);
    await f.finish(next.jobId!);
    assert.equal((await f.scheduled()).status,'no-eligible-rule');
    assert.equal(await f.count(),2);
  } finally {await f.db.close();}
});

test('31 Taipei calendar-day caps survive a calendar-month change and retain attempts exactly at the midnight boundary',async()=>{
  const f=await database();
  try {
    const id=await f.rule(); await f.service(); await f.enable();
    await f.seed('scheduled',310,'30 days 12 hours');
    assert.equal((await f.scheduled()).status,'monthly-limit');
    const manual=await f.manual(id); assert.equal(manual.remainingMonth,61); await f.finish(manual.jobId!);
    await f.db.exec("update cloud_check_jobs set created_at=now()-interval '30 days 12 hours 1 second' where trigger_source='scheduled'");
    // The manual attempt today makes this rule ineligible even though automatic budget is restored.
    assert.equal((await f.scheduled()).status,'no-eligible-rule');
    await f.db.exec('delete from cloud_check_jobs');
    await f.seed('manual',62,'30 days'); await f.seed('scheduled',309,'30 days');
    await assert.rejects(f.manual(id),/monthly_limit/);
    const automatic=await f.scheduled(); assert.equal(automatic.remainingMonth,0); await f.finish(automatic.jobId!);
    assert.equal((await f.scheduled()).status,'monthly-limit');
    await f.db.exec("update cloud_check_jobs set created_at=now()-interval '31 days 1 second'");
    const restored=await f.scheduled(); assert.equal(restored.remainingMonth,309);
  } finally {await f.db.close();}
});

test('a few seconds of schedule jitter cannot carry a 32nd Taipei day into the 31-day allowance',async()=>{
  const f=await database();
  try {
    await f.rule(); await f.service(); await f.enable();
    await f.db.query("select set_config('test.clock','2026-11-02T01:00:20Z',false)");
    // 31 days ago at 09:00:30 is outside the 31 Taipei dates although younger than 31*24 hours.
    await f.seed('scheduled',10,'30 days 23 hours 59 minutes 50 seconds');
    await f.seed('scheduled',300,'1 day');
    const today=await f.scheduled(); assert.equal(today.status,'reserved'); assert.equal(today.remainingMonth,9);
  } finally {await f.db.close();}
});

test('31 Taipei dates use the same midnight cutoff even when the database session crosses a New York DST change',async()=>{
  const f=await database();
  try {
    const manualRule=await f.rule(); await f.rule(); await f.service(); await f.enable();
    await f.seed('manual',62,'30 days 12 hours'); await f.seed('scheduled',310,'30 days 12 hours');
    // Taipei Nov 2 -> Oct 3 midnight is Oct 2 16:00 UTC, independent of the server session's DST.
    await f.db.exec("set time zone 'America/New_York'");
    await assert.rejects(f.manual(manualRule),/monthly_limit/);
    assert.equal((await f.scheduled()).status,'monthly-limit');
    await f.db.exec("update cloud_check_jobs set created_at='2026-10-02T15:59:59Z'::timestamptz");
    const manual=await f.manual(manualRule); assert.equal(manual.remainingMonth,61); await f.finish(manual.jobId!);
    assert.equal((await f.scheduled()).status,'reserved');
  } finally {await f.db.close();}
});

test('Taipei midnight boundary includes the new local day and resets daily allowance without clearing rolling usage',async()=>{
  const f=await database();
  try {
    const id=await f.rule(); await f.service(); await f.enable();
    await f.db.query("select set_config('test.clock','2026-11-01T16:03:00Z',false)");
    await f.seed('manual',2,'3 minutes'); // Exactly 00:00 Taipei on Nov 2.
    await assert.rejects(f.manual(id),/daily_limit/);
    await f.db.exec("update cloud_check_jobs set created_at=created_at-interval '1 second'");
    const after=await f.manual(id); assert.equal(after.remainingToday,1); assert.equal(after.remainingMonth,59);
    await f.finish(after.jobId!);
    await f.db.query("select set_config('test.clock','2026-11-02T16:03:00Z',false)");
    const tomorrow=await f.scheduled(); assert.equal(tomorrow.status,'reserved'); assert.equal(tomorrow.remainingToday,9);
  } finally {await f.db.close();}
});

test('per-rule leases isolate owner/rule, exclude legacy global runs in both directions, and recover only after expiry',async()=>{
  const f=await database();
  try {
    const id=await f.rule(); const other=await f.rule(f.bob); const legacy=await f.rule(f.alice,{provider:'tigerair'});
    const disabled=await f.rule(f.alice,{enabled:false}); const unverified=await f.rule(f.unverified);
    const owner=randomUUID(),competitor=randomUUID(); await f.service();
    const acquire=async(rule:string,user:string,worker=owner)=>(await f.db.query<{ok:boolean}>(
      'select acquire_rule_monitor_lock($1,$2,$3) ok',[rule,user,worker])).rows[0].ok;
    const global=async(worker=owner)=>(await f.db.query<{ok:boolean}>('select acquire_monitor_lock($1) ok',[worker])).rows[0].ok;
    const release=(rule:string,user:string,worker=owner)=>f.db.query('select release_rule_monitor_lock($1,$2,$3)',[rule,user,worker]);
    assert.equal(await acquire(id,f.bob),false); assert.equal(await acquire(legacy,f.alice),false);
    assert.equal(await acquire(disabled,f.alice),false); assert.equal(await acquire(unverified,f.unverified),false);
    assert.equal(await acquire(id,f.alice),true); assert.equal(await acquire(id,f.alice,competitor),false);
    assert.equal(await acquire(other,f.bob,competitor),true); assert.equal(await global(),false);
    await release(id,f.bob); await release(id,f.alice,competitor);
    assert.equal(await acquire(id,f.alice,competitor),false);
    await release(id,f.alice); await release(other,f.bob,competitor);
    assert.equal(await global(),true); assert.equal(await acquire(id,f.alice,competitor),false);
    const globalLease=(await f.db.query<{seconds:number}>("select extract(epoch from expires_at-now())::integer seconds from monitor_locks where name='monitor'")).rows[0].seconds;
    assert.equal(globalLease,1200);
    await f.db.query('select release_monitor_lock($1)',[competitor]); assert.equal(await acquire(id,f.alice),false);
    await f.db.query('select release_monitor_lock($1)',[owner]); assert.equal(await acquire(id,f.alice),true);
    assert.equal((await f.db.query<{seconds:number}>("select extract(epoch from expires_at-now())::integer seconds from monitor_locks where name=$1",['rule:'+id])).rows[0].seconds,300);
    await f.db.query("update monitor_locks set expires_at=now()-interval '1 second' where name=$1",['rule:'+id]);
    assert.equal(await acquire(id,f.alice,competitor),true);
    await release(id,f.alice); assert.equal(await global(),false);
    await release(id,f.alice,competitor); assert.equal(await global(),true);
  } finally {await f.db.close();}
});
