import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PGlite } from '@electric-sql/pglite';
import { PriceRepository } from '../src/db/price.repository.js';
import { actorInputSchema, runActorInput, type ActorDependencies, type ActorEmail } from '../src/apify/runner.js';
import { SupabaseWebsiteJobs, type WebsiteClaim, type WebsiteCompletion, type WebsiteJobs } from '../src/apify/website.js';
import type { AlertRecord, GoogleFlightsPriceResult, MonitorRepository, PriceHistory } from '../src/types/index.js';
import { googleFlightsPriceBasis, searchKey, watchRuleSchema } from '../src/validation.js';

const userId = '11111111-1111-4111-8111-111111111111';
const ruleId = '22222222-2222-4222-8222-222222222222';
const jobId = '33333333-3333-4333-8333-333333333333';
const otherId = '44444444-4444-4444-8444-444444444444';
const search = { origin: 'TPE', destination: 'NRT', departureDate: '2099-02-10', returnDate: '2099-02-16', adults: 1, currency: 'TWD' as const };
const rule = watchRuleSchema.parse({ ...search, id: ruleId, userId, provider: 'google-flights', targetPrice: 20000 });
const claim: WebsiteClaim = { id: jobId, runId: 'CloudRunFixture123', rule };
const env = { SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-fixture',
  EMAIL_PROVIDER: 'gmail', EMAIL_MODE: 'send', GMAIL_USER: 'sender@example.com', GMAIL_APP_PASSWORD: 'abcdefghijklmnop',
  NOTIFICATION_TO_EMAIL: 'global-must-not-receive@example.com' };
function quote(): GoogleFlightsPriceResult {
  return { ...search, provider: 'google-flights', priceBasis: googleFlightsPriceBasis,
    outboundPrice: null, inboundPrice: null, taxAndFees: null, totalPrice: 16088,
    checkedAt: new Date().toISOString(), bookingUrl: 'https://www.google.com/travel/flights', legs: [],
    reference: { source: 'google-flights', seller: 'Tigerair Taiwan', taxInclusive: true, fareFamily: null,
      yearVerifiedFromDom: false, sourceDataMaxAgeHours: 24, selectedItineraryOnly: true } };
}
class MemoryRepository implements MonitorRepository {
  alerts: AlertRecord[] = [];
  history: PriceHistory[] = [];
  async acquireLock() { return true; }
  async releaseLock() {}
  async getActiveRules() { return [rule]; }
  async getHistory() { return []; }
  async recordCheck(history: PriceHistory, alert?: AlertRecord) { this.history.push(history); if (alert) this.alerts.push(alert); }
  async getPendingAlerts() { return this.alerts.filter(row => row.status === 'pending'); }
  async markAlert(id: string, status: 'sent' | 'expired') { this.alerts.find(row => row.id === id)!.status = status; }
}
function fixture() {
  const repository = new MemoryRepository();
  const completions: WebsiteCompletion[] = [];
  let claimed = false, queries = 0, sends = 0;
  const jobs: WebsiteJobs = {
    async claim(id, runId) { assert.equal(id, jobId); assert.equal(runId, claim.runId); if (claimed) throw new Error('already claimed'); claimed = true; return claim; },
    repository: actual => { assert.equal(actual, claim); return repository; },
    recipient: async (actual, alert) => { assert.equal(actual, claim); assert.equal(alert.payload.rule.userId, userId); return 'verified-owner@example.com'; },
    finish: async (actual, completion) => { assert.equal(actual, claim); completions.push(completion); },
  };
  const deps: ActorDependencies = { env, runId: claim.runId, openWebsiteJobs: () => jobs,
    provider: { name: 'google-flights', search: async () => { queries++; return quote(); } },
    openRepository: async () => { throw new Error('Must not use global actor repository'); },
    createEmail: (options, recipient) => {
      assert.equal(options.STORAGE, 'supabase'); assert.equal(options.NOTIFICATION_TO_EMAIL, '');
      assert.equal(options.DESKTOP_NOTIFY, 'false');
      let receipt: ActorEmail['lastReceipt'];
      return { get lastReceipt() { return receipt; }, sendPriceTest: async () => { throw new Error('No test mail'); },
        send: async alert => {
          assert.equal(await recipient!(alert), 'verified-owner@example.com'); sends++;
          receipt = { provider: 'gmail', messageId: '<fixture@example.com>', accepted: true }; return 'sent';
        } };
    } };
  return { deps, jobs, repository, completions, counts: () => ({ queries, sends }) };
}

test('website Actor accepts only a queued job ID; browser cannot inject rules, owners, recipients, or run IDs', () => {
  assert.equal(actorInputSchema.parse({ action: 'website-check', jobId }).jobId, jobId);
  for (const value of [{ action: 'website-check' }, { action: 'website-check', jobId, search },
    { action: 'website-check', jobId, watchRules: [rule] }, { action: 'website-check', jobId, userId },
    { action: 'website-check', jobId, recipient: 'other@example.com' },
    { action: 'website-check', jobId, runId: 'forged' }, { action: 'check', search, jobId }]) {
    assert.throws(() => actorInputSchema.parse(value));
  }
});

test('website job queries once, records site history, uses verified owner, and repeated job never queries or sends', async () => {
  const f = fixture();
  const output = await runActorInput({ action: 'website-check', jobId }, f.deps);
  assert.equal(output.status, 'SUCCEEDED'); assert.equal(output.email.status, 'accepted');
  assert.equal(f.repository.history.length, 1); assert.equal(f.repository.history[0].watchRuleId, ruleId);
  assert.deepEqual(f.counts(), { queries: 1, sends: 1 });
  assert.deepEqual(f.completions, [{ status: 'succeeded', totalPrice: 16088, currency: 'TWD', emailStatus: 'accepted' }]);
  assert.doesNotMatch(JSON.stringify(output), /verified-owner|global-must-not-receive|service-role-fixture|11111111|abcdefghijklmnop|fixture@example/);
  await assert.rejects(runActorInput({ action: 'website-check', jobId }, f.deps), /already claimed/);
  assert.deepEqual(f.counts(), { queries: 1, sends: 1 });
});

test('failed website query records a sanitized failed job without a false quote or notification', async () => {
  const f = fixture();
  f.deps.provider = { name: 'google-flights', search: async () => { throw new Error('access rejected'); } };
  const output = await runActorInput({ action: 'website-check', jobId }, f.deps);
  assert.equal(output.status, 'FAILED'); assert.equal(output.quote, undefined);
  assert.equal(f.counts().sends, 0); assert.equal(f.repository.history.length, 0);
  assert.deepEqual(f.completions, [{ status: 'failed', emailStatus: 'not-triggered', errorCode: 'query-or-notification-failed' }]);
});

test('lost completion response never repeats a website query, mail, or finish', async () => {
  const f = fixture(); let finishes = 0;
  f.jobs.finish = async () => { finishes++; throw new Error('response lost'); };
  await assert.rejects(runActorInput({ action: 'website-check', jobId }, f.deps), /will not be retried/);
  assert.equal(finishes, 1); assert.deepEqual(f.counts(), { queries: 1, sends: 1 });
});

test('invalid website claim consumes job with a sanitized failure and rejects owner/source changes', async () => {
  for (const invalid of [{ ...rule, userId: otherId }, { ...rule, provider: 'tigerair' }, { ...rule, enabled: false }]) {
    const calls: Array<{ name: string; params: unknown }> = [];
    const client = { rpc: async (name: string, params: unknown) => {
      calls.push({ name, params }); return name === 'claim_cloud_check_job' ? { data: {
        id: jobId, watch_rule_id: ruleId, user_id: userId, status: 'running',
        expires_at: new Date(Date.now() + 600000).toISOString(), watch_rule: invalid }, error: null } : { error: null };
    } } as unknown as SupabaseClient;
    await assert.rejects(new SupabaseWebsiteJobs(client).claim(jobId, claim.runId), /invalid or unavailable/);
    assert.equal(calls.length, 2); assert.equal(calls[1].name, 'finish_cloud_check_job');
    assert.equal((calls[1].params as { p_error_code: string }).p_error_code, 'invalid-rule');
  }
});

test('scoped Supabase repository filters outbox reads/updates and blocks cross-rule history and alert writes', async () => {
  const calls: Array<{ url: URL; method: string; body?: string }> = [];
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
      const url = new URL(String(input)); calls.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? '') });
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    } },
  });
  const repository = new PriceRepository(client, { ruleId, userId });
  await repository.getActiveRules(); await repository.getPendingAlerts(); await repository.markAlert('alert-fixture', 'expired');
  assert.equal(calls[0].url.searchParams.get('id'), 'eq.' + ruleId);
  assert.equal(calls[0].url.searchParams.get('user_id'), 'eq.' + userId);
  assert.equal(calls[1].url.searchParams.get('watch_rule_id'), 'eq.' + ruleId);
  assert.equal(calls[2].url.searchParams.get('watch_rule_id'), 'eq.' + ruleId);
  assert.equal(calls[2].method, 'PATCH');
  await assert.rejects(repository.getHistory(otherId, 'key', '2000', '9999'), /another rule/);
  const result = quote();
  const history: PriceHistory = { id: 'history', watchRuleId: otherId, searchKey: searchKey(rule), price: result.totalPrice,
    currency: 'TWD', checkedAt: result.checkedAt, result };
  await assert.rejects(repository.recordCheck(history), /another rule/);
  const alert: AlertRecord = { id: 'alert', watchRuleId: ruleId, searchKey: searchKey(rule), price: result.totalPrice,
    createdAt: result.checkedAt, status: 'pending', type: 'below_target', payload: {
      rule: { ...rule, userId: otherId }, result, trigger: { type: 'below_target', currentPrice: result.totalPrice, reason: 'fixture' } } };
  await assert.rejects(repository.recordCheck({ ...history, watchRuleId: ruleId }, alert), /another owner/);
  assert.equal(calls.length, 3, 'cross-owner operations must be rejected before any database request');
});

test('website recipient resolver rejects mismatched ownership before any auth-email lookup', async () => {
  let calls = 0;
  const jobs = new SupabaseWebsiteJobs({ rpc: async () => { calls++; return { data: 'verified-owner@example.com', error: null }; } } as unknown as SupabaseClient);
  const result = quote();
  const alert: AlertRecord = { id: 'alert', watchRuleId: otherId, searchKey: 'key', price: 16088,
    status: 'pending', createdAt: result.checkedAt, type: 'below_target', payload: {
      rule, result, trigger: { type: 'below_target', currentPrice: 16088, reason: 'fixture' } } };
  await assert.rejects(jobs.recipient(claim, alert), /ownership/); assert.equal(calls, 0);
  assert.equal(await jobs.recipient(claim, { ...alert, watchRuleId: ruleId }), 'verified-owner@example.com'); assert.equal(calls, 1);
});

test('worker claim/finish types match real SQL RPCs and a consumed job cannot be claimed again', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
    for (const file of ['src/db/schema.sql', 'src/db/multi-user.sql', 'src/db/cloud-check.sql']) await db.exec(await readFile(file, 'utf8'));
    await db.query('insert into auth.users values ($1,$2,now())', [userId, 'verified-owner@example.com']);
    await db.query(`insert into watch_rules(id,user_id,provider,origin,destination,departure_date,return_date,target_price)
      values ($1,$2,'google-flights','TPE','NRT','2099-02-10','2099-02-16',20000)`, [ruleId, userId]);
    await db.exec('set role service_role');
    const reservation = (await db.query<{ job: { jobId: string } }>('select reserve_cloud_check_job($1,$2,$3) job',
      [ruleId, userId, ['verified-owner@example.com']])).rows[0].job;
    const client = { rpc: async (name: string, args: Record<string, unknown>) => {
      try {
        const query = name === 'claim_cloud_check_job' ? 'select claim_cloud_check_job($1,$2) data' :
          name === 'finish_cloud_check_job' ? 'select finish_cloud_check_job($1,$2,$3,$4,$5,$6,$7) data' : '';
        if (!query) throw new Error('Unexpected RPC');
        const params = name === 'claim_cloud_check_job' ? [args.p_job_id, args.p_run_id] :
          [args.p_job_id, args.p_run_id, args.p_status, args.p_total_price, args.p_currency, args.p_error_code, args.p_email_status];
        return { data: (await db.query<{ data: unknown }>(query, params)).rows[0].data, error: null };
      } catch { return { data: null, error: { message: 'RPC rejected' } }; }
    } } as unknown as SupabaseClient;
    const jobs = new SupabaseWebsiteJobs(client);
    const actual = await jobs.claim(reservation.jobId, claim.runId);
    assert.equal(actual.rule.id, ruleId); assert.equal(actual.rule.userId, userId);
    assert.equal(actual.rule.targetPrice, 20000);
    await jobs.finish(actual, { status: 'succeeded', totalPrice: 16088, currency: 'TWD', emailStatus: 'accepted' });
    const stored = (await db.query<{ status: string; email_status: string }>('select status,email_status from cloud_check_jobs where id=$1', [reservation.jobId])).rows[0];
    assert.deepEqual(stored, { status: 'succeeded', email_status: 'accepted' });
    await assert.rejects(jobs.claim(reservation.jobId, claim.runId), /already claimed/);
  } finally { await db.close(); }
});
