import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createCloudCheckHandler, type CloudCheckDependencies } from '../supabase/functions/cloud-check/handler.js';

async function database() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
  // Freeze the database clock, not the implementation, so Taipei midnight/month boundaries cannot skip assertions.
  await db.exec(`create or replace function pg_catalog.now() returns timestamptz language sql stable
    as $$ select '2026-11-02T04:00:00Z'::timestamptz $$;`);
  for (const path of ['src/db/schema.sql', 'src/db/multi-user.sql', 'src/db/cloud-check.sql', 'src/db/cloud-check.sql']) await db.exec(await readFile(path, 'utf8'));
  const alice = randomUUID(), bob = randomUUID(), unverified = randomUUID();
  await db.query('insert into auth.users values ($1,$2,now()),($3,$4,now()),($5,$6,null)',
    [alice, 'uncle@example.com', bob, 'owner@example.com', unverified, 'other@example.com']);
  const rules = [randomUUID(), randomUUID(), randomUUID()];
  for (const [i, owner] of [alice, bob, unverified].entries()) await db.query(
    "insert into watch_rules(id,user_id,provider,origin,destination,departure_date) values ($1,$2,'google-flights','TPE','NRT',now()::date+30)", [rules[i],owner]);
  const service = () => db.exec('reset role; set role service_role');
  const asUser = async (id: string) => { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]); await db.exec('set role authenticated'); };
  const reserve = async (rule: string, owner: string) => (await db.query<{job: {jobId: string; remainingToday: number; remainingMonth: number}}>(
    'select reserve_cloud_check_job($1,$2,$3::text[]) job', [rule,owner,['uncle@example.com','owner@example.com']])).rows[0].job;
  return { db, alice, bob, unverified, rules, service, asUser, reserve };
}

test('cloud-check jobs keep ownership, run claims, expiry and quota data private from browser writes', async () => {
  const { db,alice,bob,unverified,rules,service,asUser,reserve } = await database();
  try {
    await asUser(alice);
    await assert.rejects(reserve(rules[0],alice), /permission denied/);
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select * from cloud_check_jobs'), /permission denied/);
    await service();
    await assert.rejects(db.query('select reserve_cloud_check_job($1,$2)',[rules[0],alice]), /cloud_check_not_allowed/);
    await assert.rejects(db.query('select reserve_cloud_check_job($1,$2,null)',[rules[0],alice]), /cloud_check_not_allowed/);
    await assert.rejects(db.query('select reserve_cloud_check_job($1,$2,$3::text[])',[rules[0],alice,[]]), /cloud_check_not_allowed/);
    await assert.rejects(reserve(rules[1],alice), /cloud_check_not_allowed/);
    await assert.rejects(reserve(rules[2],unverified), /cloud_check_not_allowed/);
    const job = await reserve(rules[0],alice);
    assert.equal(job.remainingToday,1); assert.equal(job.remainingMonth,61);
    await assert.rejects(reserve(rules[1],bob), /cloud_check_busy/);
    await asUser(bob);
    assert.equal((await db.query('select * from cloud_check_jobs')).rows.length,0);
    await asUser(alice);
    assert.equal((await db.query('select * from cloud_check_jobs')).rows.length,1);
    await assert.rejects(db.query("update cloud_check_jobs set status='succeeded' where id=$1",[job.jobId]),/permission denied/);
    await assert.rejects(db.query('select claim_cloud_check_job($1,$2)',[job.jobId,'runA']),/permission denied/);
    await service();
    const claim = (await db.query<{job: {watch_rule: {id: string; userId: string}; expires_at: string}}>(
      'select claim_cloud_check_job($1,$2) job',[job.jobId,'runA'])).rows[0].job;
    assert.equal(claim.watch_rule.id,rules[0]); assert.equal(claim.watch_rule.userId,alice);
    await assert.rejects(db.query('select claim_cloud_check_job($1,$2)',[job.jobId,'runA']),/not_claimable/);
    await assert.rejects(db.query("select finish_cloud_check_job($1,$2,'succeeded',16088,'TWD',null,'accepted')",[job.jobId,'runB']),/not_running/);
    await db.query("select finish_cloud_check_job($1,$2,'succeeded',16088,'TWD',null,'accepted')",[job.jobId,'runA']);
    await assert.rejects(reserve(rules[1],bob), /cloud_check_cooldown/);
    await db.query("update cloud_check_jobs set created_at=now()-interval '3 minutes' where id=$1",[job.jobId]);
    const next = await reserve(rules[1],bob);
    await db.query("update cloud_check_jobs set expires_at=now()-interval '1 second',created_at=now()-interval '3 minutes' where id=$1",[next.jobId]);
    await assert.rejects(db.query('select claim_cloud_check_job($1,$2)',[next.jobId,'lateRun']),/not_claimable/);
    await assert.rejects(reserve(rules[0],alice),/daily_limit/);
    await db.query("update cloud_check_jobs set created_at=now()-interval '1 day' where id=$1",[job.jobId]);
    const third = await reserve(rules[0],alice);
    assert.notEqual(third.jobId,next.jobId);
    assert.equal((await db.query<{status: string}>('select status from cloud_check_jobs where id=$1',[next.jobId])).rows[0].status,'expired');
    // Deleting the rule does not erase its consumed quota or let a stale actor claim it.
    await db.query('delete from watch_rules where id=$1',[rules[0]]);
    assert.equal((await db.query('select * from cloud_check_jobs')).rows.length,3);
    await assert.rejects(db.query('select claim_cloud_check_job($1,$2)',[third.jobId,'deletedRule']),/not_allowed/);
  } finally { await db.close(); }
});

test('cloud-check manual reservations count failures against two Taipei daily and 62 rolling-31-day attempts', async () => {
  const { db,alice,rules,service,reserve } = await database();
  try {
    await service();
    await db.query(`insert into cloud_check_jobs(watch_rule_id,user_id,status,created_at,expires_at)
      select $1,$2,'failed',now()-interval '3 minutes',now()-interval '1 hour'
      from generate_series(1,2)`,[rules[0],alice]);
    await assert.rejects(reserve(rules[0],alice),/daily_limit/);
    await db.exec('delete from cloud_check_jobs');
    await db.query(`insert into cloud_check_jobs(watch_rule_id,user_id,status,created_at,expires_at)
      select $1,$2,'failed',now()-interval '30 days',now()-interval '1 hour'
      from generate_series(1,62)`,[rules[0],alice]);
    // These are in October while the clock is in November: a calendar-month reset must not bypass the cap.
    await assert.rejects(reserve(rules[0],alice),/monthly_limit/);
    await db.exec("update cloud_check_jobs set created_at=now()-interval '31 days 1 second'");
    assert.equal((await reserve(rules[0],alice)).remainingMonth,61);
  } finally { await db.close(); }
});

function fixture(overrides: Partial<CloudCheckDependencies> = {}) {
  const calls: Array<{name:string;args:Record<string,unknown>}> = [];
  const posts: Array<{url:string;init?:RequestInit}> = [];
  const jobId = randomUUID(), ruleId = randomUUID(), userId = randomUUID();
  const deps: CloudCheckDependencies = {
    getUser: async () => ({ data:{user:{id:userId,email:'uncle@example.com',email_confirmed_at:new Date().toISOString()}},error:null }),
    rpc: async (name,args) => { calls.push({name,args}); return {data:name==='reserve_cloud_check_job'?{jobId,status:'reserved',remainingToday:7,remainingMonth:239}:null,error:null}; },
    fetch: async (url,init) => { posts.push({url:String(url),init}); return Response.json({data:{id:'run123'}}); },
    actorId:'privateActor',actorToken:'private-token',actorBuild:'0.0.12',
    allowedEmails:['uncle@example.com'],allowedOrigins:['https://wuharry.github.io'],...overrides,
  };
  const request = (body: unknown = {ruleId}, headers: Record<string,string> = {}) => new Request('https://example.supabase.co/functions/v1/cloud-check',{
    method:'POST',headers:{Origin:'https://wuharry.github.io',Authorization:'Bearer valid-user-jwt','Content-Type':'application/json',...headers},body:JSON.stringify(body),
  });
  return {handler:createCloudCheckHandler(deps),calls,posts,jobId,ruleId,userId,request};
}

test('cloud-check Edge rejects unauthenticated, unverified, unapproved and arbitrary Actor input without dispatch', async () => {
  const unconfigured = fixture({allowedEmails:[]});
  assert.equal((await unconfigured.handler(unconfigured.request())).status,503);
  assert.equal(unconfigured.calls.length,0); assert.equal(unconfigured.posts.length,0);
  const missing = fixture();
  assert.equal((await missing.handler(missing.request(undefined,{Authorization:''}))).status,401);
  assert.equal(missing.calls.length,0); assert.equal(missing.posts.length,0);
  for (const user of [{id:randomUUID(),email:'uncle@example.com'}, {id:randomUUID(),email:'stranger@example.com',email_confirmed_at:'2026-01-01'}]) {
    const f = fixture({getUser:async()=>({data:{user},error:null})});
    assert.equal((await f.handler(f.request())).status,403);
    assert.equal(f.calls.length,0); assert.equal(f.posts.length,0);
  }
  const f = fixture();
  assert.equal((await f.handler(f.request({ruleId:f.ruleId,action:'test-email'}))).status,400);
  assert.equal((await f.handler(f.request(undefined,{Origin:'https://evil.example'}))).status,403);
  assert.equal(f.calls.length,0); assert.equal(f.posts.length,0);
});

test('cloud-check Edge starts exactly a bounded jobId action after reservation and keeps token server side', async () => {
  const f = fixture();
  const response = await f.handler(f.request());
  assert.equal(response.status,202);
  assert.equal(f.posts.length,1);
  const sent = JSON.parse(String(f.posts[0].init!.body));
  assert.deepEqual(sent,{action:'website-check',provider:'google-flights',jobId:f.jobId});
  const schema = JSON.parse(await readFile('.actor/input_schema.json','utf8'));
  for (const name of schema.required) assert.ok(name in sent, `API input includes Actor-required ${name}`);
  assert.equal(new URL(f.posts[0].url).searchParams.get('timeout'),'180');
  assert.equal(new URL(f.posts[0].url).searchParams.get('memory'),'1024');
  assert.deepEqual(f.calls.map(call=>call.name),['reserve_cloud_check_job','set_cloud_check_run']);
  assert.equal(f.calls[0].args.p_user_id,f.userId);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),'https://wuharry.github.io');
  assert.doesNotMatch(await response.text(),/private-token|valid-user-jwt|run123/);
});

test('cloud-check Edge never dispatches rejected reservations or retries uncertain starts', async () => {
  for (const code of ['cloud_check_not_allowed','cloud_check_busy','cloud_check_cooldown','cloud_check_daily_limit','cloud_check_monthly_limit']) {
    const f=fixture({rpc:async()=>({data:null,error:{message:code}})});
    const response=await f.handler(f.request());
    assert.ok([403,409,429].includes(response.status)); assert.equal(f.posts.length,0);
  }
  let dispatches=0;
  const f=fixture({fetch:async()=>{dispatches++;throw new Error('sensitive request details');}});
  const response=await f.handler(f.request());
  assert.equal(response.status,202); assert.equal(dispatches,1);
  assert.deepEqual(f.calls.map(call=>call.name),['reserve_cloud_check_job']);
  assert.equal((await response.json() as {dispatch:string}).dispatch,'unconfirmed');
});
