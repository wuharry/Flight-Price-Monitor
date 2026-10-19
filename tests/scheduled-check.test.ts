import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PGlite } from '@electric-sql/pglite';
import { actorInputSchema, runActorInput, type ActorDependencies, type ActorEmail } from '../src/apify/runner.js';
import { SupabaseWebsiteJobs, type ScheduledReservation, type ScheduledWebsiteJobs, type WebsiteClaim, type WebsiteCompletion } from '../src/apify/website.js';
import { PriceRepository } from '../src/db/price.repository.js';
import type { AlertRecord, GoogleFlightsPriceResult, MonitorRepository, PriceHistory } from '../src/types/index.js';
import { googleFlightsPriceBasis, watchRuleSchema } from '../src/validation.js';
import { NoMatchingItineraryError } from '../src/providers/no-matching-itinerary.js';

const input = { action: 'scheduled-check', provider: 'google-flights' };
const userId = '11111111-1111-4111-8111-111111111111';
const ruleId = '22222222-2222-4222-8222-222222222222';
const jobId = '33333333-3333-4333-8333-333333333333';
const runId = 'DailyCloudRunFixture1';
const search = { origin: 'TPE', destination: 'NRT', departureDate: '2099-02-10', returnDate: '2099-02-16', adults: 1, currency: 'TWD' as const };
const rule = watchRuleSchema.parse({ ...search, id: ruleId, userId, provider: 'google-flights', targetPrice: 20000 });
const claim: WebsiteClaim = { id: jobId, runId, rule };
const env = { SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-fixture',
  EMAIL_PROVIDER: 'gmail', EMAIL_MODE: 'send', GMAIL_USER: 'sender@example.com', GMAIL_APP_PASSWORD: 'abcdefghijklmnop',
  SCHEDULE_ALLOWED_EMAILS: ' Verified-owner@example.com,verified-owner@example.com ',
  NOTIFICATION_TO_EMAIL: 'global-must-not-receive@example.com' };
const quote = (): GoogleFlightsPriceResult => ({ ...search, provider: 'google-flights', priceBasis: googleFlightsPriceBasis,
  outboundPrice: null, inboundPrice: null, taxAndFees: null, totalPrice: 16088, checkedAt: new Date().toISOString(),
  bookingUrl: 'https://www.google.com/travel/flights', legs: [], reference: { source: 'google-flights', seller: 'Tigerair Taiwan',
    taxInclusive: true, fareFamily: null, yearVerifiedFromDom: false, sourceDataMaxAgeHours: 24, selectedItineraryOnly: true } });

function fixture(reservation: ScheduledReservation = { status: 'reserved', jobId }) {
  const history: PriceHistory[] = [], alerts: AlertRecord[] = [], completions: WebsiteCompletion[] = [];
  const counts = { reservations: 0, claims: 0, queries: 0, mailConstructors: 0, sends: 0, finishes: 0 };
  const repository: MonitorRepository = {
    acquireLock: async () => true, releaseLock: async () => {}, getActiveRules: async () => [rule], getHistory: async () => [],
    recordCheck: async (record, alert) => { history.push(record); if (alert) alerts.push(alert); },
    getPendingAlerts: async () => alerts.filter(alert => alert.status === 'pending'),
    markAlert: async (id, status) => { alerts.find(alert => alert.id === id)!.status = status; },
  };
  const jobs: ScheduledWebsiteJobs = {
    reserveScheduled: async emails => { counts.reservations++; assert.deepEqual(emails, ['verified-owner@example.com']); return reservation; },
    claim: async (id, actualRunId) => { counts.claims++; assert.equal(id, jobId); assert.equal(actualRunId, runId); return claim; },
    repository: actual => { assert.equal(actual, claim); return repository; },
    recipient: async (actual, alert) => { assert.equal(actual, claim); assert.equal(alert.payload.rule.userId, userId); return 'verified-owner@example.com'; },
    finish: async (actual, completion) => { counts.finishes++; assert.equal(actual, claim); completions.push(completion); },
  };
  const deps: ActorDependencies = { env, runId, openScheduledJobs: options => { assert.equal(options.STORAGE, 'supabase'); return jobs; },
    openWebsiteJobs: () => { throw new Error('Scheduled action must not use the manual entry'); },
    openRepository: async () => { throw new Error('Must not use a global actor repository'); },
    provider: { name: 'google-flights', search: async actual => { counts.queries++; assert.deepEqual(actual, rule); return quote(); } },
    createEmail: (options, recipient) => {
      counts.mailConstructors++; assert.equal(options.NOTIFICATION_TO_EMAIL, ''); assert.equal(options.DESKTOP_NOTIFY, 'false');
      let receipt: ActorEmail['lastReceipt'];
      return { get lastReceipt() { return receipt; }, sendPriceTest: async () => { throw new Error('No test mail'); },
        send: async alert => { assert.equal(await recipient!(alert), 'verified-owner@example.com'); counts.sends++;
          receipt = { provider: 'gmail', accepted: true, messageId: '<private-receipt@example.com>' }; return 'sent'; } };
    },
  };
  return { deps, jobs, counts, history, alerts, completions, repository };
}

test('scheduled input rejects all injected selection, owner, recipient and job fields', () => {
  assert.deepEqual(actorInputSchema.parse(input), input);
  for (const injected of [{ search }, { watchRules: [rule] }, { jobId }, { userId }, { email: 'other@example.com' },
    { recipient: 'other@example.com' }, { runId }, { allowedEmails: ['other@example.com'] }]) {
    assert.throws(() => actorInputSchema.parse({ ...input, ...injected }));
  }
});

test('empty schedule allowlist is disabled without storage, browser or mail configuration', async () => {
  const f = fixture(); f.deps.env = {};
  f.deps.openScheduledJobs = () => { throw new Error('Must not open database'); };
  const output = await runActorInput(input, f.deps);
  assert.equal(output.status, 'SUCCEEDED'); assert.deepEqual(output.scheduled, { status: 'disabled' });
  assert.equal(output.email.status, 'not-requested');
  assert.deepEqual(f.counts, { reservations: 0, claims: 0, queries: 0, mailConstructors: 0, sends: 0, finishes: 0 });
  f.deps.env = { ...env, SCHEDULE_ALLOWED_EMAILS: 'not-an-email' };
  await assert.rejects(runActorInput(input, f.deps));
  assert.equal(f.counts.reservations, 0);
});

test('each schedule no-op is successful without claiming, querying or instantiating mail', async () => {
  for (const status of ['disabled', 'no-eligible-rule', 'daily-limit', 'monthly-limit', 'busy'] as const) {
    const f = fixture({ status });
    const output = await runActorInput(input, f.deps);
    assert.equal(output.status, 'SUCCEEDED'); assert.deepEqual(output.scheduled, { status });
    assert.equal(output.quote, undefined); assert.equal(output.email.status, 'not-requested');
    assert.deepEqual(f.counts, { reservations: 1, claims: 0, queries: 0, mailConstructors: 0, sends: 0, finishes: 0 });
  }
});

test('schedule reserves one owned job and shares scoped history and verified-owner notification flow', async () => {
  const f = fixture(); const output = await runActorInput(input, f.deps);
  assert.equal(output.status, 'SUCCEEDED'); assert.deepEqual(output.scheduled, { status: 'checked' });
  assert.equal(output.email.status, 'accepted'); assert.deepEqual(output.job, { id: jobId, status: 'succeeded' });
  assert.equal(f.history.length, 1); assert.equal(f.history[0].watchRuleId, ruleId);
  assert.deepEqual(f.counts, { reservations: 1, claims: 1, queries: 1, mailConstructors: 1, sends: 1, finishes: 1 });
  assert.deepEqual(f.completions, [{ status: 'succeeded', totalPrice: 16088, currency: 'TWD', emailStatus: 'accepted' }]);
  assert.doesNotMatch(JSON.stringify(output), /verified-owner|global-must-not-receive|service-role-fixture|11111111|abcdefghijklmnop|private-receipt/);
});

test('failed scheduled quote does not select a second rule or claim a successful notification', async () => {
  const f = fixture(); f.deps.provider.search = async () => { f.counts.queries++; throw new Error('provider access rejected'); };
  const output = await runActorInput(input, f.deps);
  assert.equal(output.status, 'FAILED'); assert.deepEqual(output.scheduled, { status: 'failed' });
  assert.equal(output.quote, undefined); assert.equal(output.email.status, 'not-triggered');
  assert.deepEqual(f.counts, { reservations: 1, claims: 1, queries: 1, mailConstructors: 1, sends: 0, finishes: 1 });
  assert.deepEqual(f.completions, [{ status: 'failed', emailStatus: 'not-triggered', errorCode: 'query-or-notification-failed' }]);
});

test('scheduled no-matching-itinerary consumes one attempt and reports the specific failure without recording price or a new alert', async () => {
  const f = fixture();
  f.deps.provider.search = async actual => { f.counts.queries++; assert.equal(actual.departureDate, search.departureDate);
    assert.equal(actual.returnDate, search.returnDate); throw new NoMatchingItineraryError('google-flights'); };
  const output = await runActorInput(input, f.deps);
  assert.equal(output.status, 'FAILED'); assert.deepEqual(output.scheduled, { status: 'failed' });
  assert.equal(output.quote, undefined); assert.equal(output.email.status, 'not-triggered');
  assert.deepEqual(f.counts, { reservations: 1, claims: 1, queries: 1, mailConstructors: 1, sends: 0, finishes: 1 });
  assert.equal(f.history.length, 0); assert.equal(f.alerts.length, 0);
  assert.deepEqual(f.completions, [{ status: 'failed', emailStatus: 'not-triggered', errorCode: 'no-matching-itinerary' }]);
});

test('lost scheduled reservation, claim or finish response never repeats selection, quote or SMTP', async () => {
  const f = fixture();
  f.jobs.reserveScheduled = async () => { f.counts.reservations++; throw new Error('response lost'); };
  await assert.rejects(runActorInput(input, f.deps), /response lost/);
  assert.deepEqual(f.counts, { reservations: 1, claims: 0, queries: 0, mailConstructors: 0, sends: 0, finishes: 0 });
  const g = fixture(); g.jobs.claim = async () => { g.counts.claims++; throw new Error('already claimed'); };
  await assert.rejects(runActorInput(input, g.deps), /already claimed/);
  assert.equal(g.counts.reservations, 1); assert.equal(g.counts.queries, 0); assert.equal(g.counts.mailConstructors, 0);
  const h = fixture(); h.jobs.finish = async () => { h.counts.finishes++; throw new Error('response lost'); };
  await assert.rejects(runActorInput(input, h.deps), /will not be retried/);
  assert.deepEqual(h.counts, { reservations: 1, claims: 1, queries: 1, mailConstructors: 1, sends: 1, finishes: 1 });
});

test('scheduled RPC uses its service-only allowlist input once and rejects ambiguous or malformed results', async () => {
  for (const response of [{ data: null, error: { message: 'private detail' } }, { data: { status: 'reserved' }, error: null },
    { data: { status: 'unknown-status' }, error: null }, { data: { status: 'reserved', jobId }, error: null }]) {
    const calls: unknown[] = [];
    const jobs = new SupabaseWebsiteJobs({ rpc: async (name: string, args: unknown) => { calls.push({ name, args }); return response; } } as unknown as SupabaseClient);
    const operation = jobs.reserveScheduled(['verified-owner@example.com']);
    if (response.data && 'jobId' in response.data) assert.deepEqual(await operation, { status: 'reserved', jobId });
    else await assert.rejects(operation, /will not be retried/);
    assert.deepEqual(calls, [{ name: 'reserve_scheduled_cloud_check_job', args: { p_allowed_emails: ['verified-owner@example.com'] } }]);
  }
  let calls = 0;
  const jobs = new SupabaseWebsiteJobs({ rpc: async () => { calls++; throw new Error('unexpected request'); } } as unknown as SupabaseClient);
  assert.deepEqual(await jobs.reserveScheduled([]), { status: 'disabled' }); assert.equal(calls, 0);
});

test('website and scheduled scoped repositories use rule-owner locks while legacy monitors retain their global lock', async () => {
  const calls: unknown[] = [];
  const client = { rpc: async (name: string, args: unknown) => { calls.push({ name, args }); return { data: true, error: null }; } } as unknown as SupabaseClient;
  const scoped = new PriceRepository(client, { ruleId, userId });
  assert.equal(await scoped.acquireLock('lease-owner'), true); await scoped.releaseLock('lease-owner');
  const legacy = new PriceRepository(client);
  assert.equal(await legacy.acquireLock('legacy-owner'), true); await legacy.releaseLock('legacy-owner');
  assert.deepEqual(calls, [
    { name: 'acquire_rule_monitor_lock', args: { p_owner: 'lease-owner', p_rule_id: ruleId, p_user_id: userId } },
    { name: 'release_rule_monitor_lock', args: { p_owner: 'lease-owner', p_rule_id: ruleId, p_user_id: userId } },
    { name: 'acquire_monitor_lock', args: { p_owner: 'legacy-owner' } },
    { name: 'release_monitor_lock', args: { p_owner: 'legacy-owner' } },
  ]);
});

test('Actor schema cannot prefill search fields into a scheduled invocation', async () => {
  const schema = JSON.parse(await readFile('.actor/input_schema.json', 'utf8'));
  assert.ok(schema.properties.action.enum.includes('scheduled-check'));
  assert.equal(schema.properties.search.prefill, undefined); assert.equal(schema.properties.search.default, undefined);
  assert.equal(schema.properties.watchRules.prefill, undefined); assert.equal(schema.properties.jobId.default, undefined);
});

test('scheduled worker reserve/claim/recipient/finish matches real SQL and a repeated daily slot does no work', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
    for (const file of ['schema.sql', 'multi-user.sql', 'cloud-check.sql', 'daily-check.sql']) await db.exec(await readFile('src/db/' + file, 'utf8'));
    await db.query('insert into auth.users values ($1,$2,now())', [userId, 'verified-owner@example.com']);
    await db.query(`insert into watch_rules(id,user_id,provider,origin,destination,departure_date,return_date,target_price)
      values($1,$2,'google-flights','TPE','NRT','2099-02-10','2099-02-16',20000)`, [ruleId, userId]);
    await db.query('update cloud_monitor_settings set enabled=true,allowed_emails=$1', [['verified-owner@example.com']]);
    await db.exec('set role service_role');
    const calls: string[] = [];
    const client = { rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push(name);
      const statements: Record<string, [string, unknown[]]> = {
        reserve_scheduled_cloud_check_job: ['select reserve_scheduled_cloud_check_job($1) data', [args.p_allowed_emails]],
        claim_cloud_check_job: ['select claim_cloud_check_job($1,$2) data', [args.p_job_id, args.p_run_id]],
        monitor_recipient: ['select monitor_recipient($1,$2) data', [args.p_rule, args.p_owner]],
        finish_cloud_check_job: ['select finish_cloud_check_job($1,$2,$3,$4,$5,$6,$7) data',
          [args.p_job_id, args.p_run_id, args.p_status, args.p_total_price, args.p_currency, args.p_error_code, args.p_email_status]],
      };
      try {
        const [sql, params] = statements[name];
        return { data: (await db.query<{ data: unknown }>(sql, params)).rows[0].data, error: null };
      } catch { return { data: null, error: { message: 'RPC rejected' } }; }
    } } as unknown as SupabaseClient;
    const f = fixture(); const jobs = new SupabaseWebsiteJobs(client);
    jobs.repository = actual => { assert.equal(actual.rule.id, ruleId); assert.equal(actual.rule.userId, userId); return f.repository; };
    f.deps.openScheduledJobs = () => jobs;
    const output = await runActorInput(input, f.deps);
    assert.equal(output.status, 'SUCCEEDED'); assert.deepEqual(output.scheduled, { status: 'checked' });
    assert.equal(f.counts.queries, 1); assert.equal(f.counts.sends, 1);
    const stored = (await db.query<{ status: string; email_status: string; trigger_source: string; run_id: string }>(
      'select status,email_status,trigger_source,run_id from cloud_check_jobs where id=$1', [output.job!.id])).rows[0];
    assert.deepEqual(stored, { status: 'succeeded', email_status: 'accepted', trigger_source: 'scheduled', run_id: runId });
    assert.deepEqual(calls, ['reserve_scheduled_cloud_check_job', 'claim_cloud_check_job', 'monitor_recipient', 'finish_cloud_check_job']);
    const repeated = await runActorInput(input, f.deps);
    assert.equal(repeated.status, 'SUCCEEDED'); assert.deepEqual(repeated.scheduled, { status: 'no-eligible-rule' });
    assert.equal(f.counts.queries, 1); assert.equal(f.counts.sends, 1);
    assert.equal((await db.query<{ count: number }>('select count(*)::int count from cloud_check_jobs')).rows[0].count, 1);
  } finally { await db.close(); }
});
