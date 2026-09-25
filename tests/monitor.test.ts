import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { checkTriggerConditions } from '../src/services/alert.service.js';
import { EmailService, renderEmail } from '../src/services/email.service.js';
import { PriceService } from '../src/services/price.service.js';
import { LocalRepository } from '../src/db/local.repository.js';
import { parseTigerairResponse } from '../src/providers/tigerair-parser.js';
import { config } from '../src/config.js';
import { searchKey, watchRuleSchema } from '../src/validation.js';
import type { AlertRecord, PriceHistory, WatchRule } from '../src/types/index.js';

const input = { origin: 'TPE', destination: 'NRT', departureDate: '2027-02-10',
  returnDate: '2027-02-16', adults: 1, currency: 'TWD' as const };
const rule = watchRuleSchema.parse({ ...input, id: 'test', targetPrice: 20000 });
const fixture = JSON.parse(await readFile('tests/fixtures/tigerair-search.json', 'utf8'));
const quote = () => parseTigerairResponse(fixture, input);
const history = (price: number, checkedAt: string): PriceHistory => ({
  id: randomUUID(), watchRuleId: rule.id, searchKey: searchKey(rule), price, checkedAt, currency: 'TWD', result: quote(),
});
const alert = (): AlertRecord => ({
  id: randomUUID(), watchRuleId: rule.id, searchKey: searchKey(rule), price: 16557, type: 'below_target',
  createdAt: new Date().toISOString(), status: 'pending',
  payload: { rule, result: quote(), trigger: { type: 'below_target', currentPrice: 16557, reason: 'test' } },
});
const now = new Date('2026-09-25T04:00:00Z');
test('target is inclusive; first observation is not a new low', () => {
  assert.equal(checkTriggerConditions({ ...rule, targetPrice: 6500 }, 6500, [], now)?.type, 'below_target');
  assert.equal(checkTriggerConditions({ ...rule, targetPrice: undefined }, 6500, [], now), null);
});
test('30-day low excludes older history and ignores equal prices', () => {
  const r = { ...rule, targetPrice: undefined };
  const records = [history(100, '2026-08-01T00:00:00Z'), history(7000, '2026-09-24T04:00:00Z')];
  assert.equal(checkTriggerConditions(r, 6500, records, now)?.type, 'new_low');
  assert.equal(checkTriggerConditions(r, 7000, records, now), null);
});
test('drop uses approximately 24 hours ago, not the last 3-hour check', () => {
  const r = { ...rule, targetPrice: undefined, notifyNewLow: false, dropAmount: 1000 };
  const records = [history(6500, '2026-09-25T01:00:00Z'), history(8000, '2026-09-24T04:00:00Z')];
  assert.equal(checkTriggerConditions(r, 6500, records, now)?.type, 'drop_amount');
  assert.equal(checkTriggerConditions(r, 6500, [records[0]], now), null);
});
test('percent threshold and stale baseline', () => {
  const r = { ...rule, targetPrice: undefined, notifyNewLow: false, dropPercent: 15 };
  assert.equal(checkTriggerConditions(r, 6800, [history(8000, '2026-09-24T04:00:00Z')], now)?.type, 'drop_percent');
  assert.equal(checkTriggerConditions(r, 6800, [history(8000, '2026-09-20T04:00:00Z')], now), null);
});
async function local(r: WatchRule = rule) {
  const directory = await mkdtemp(join(tmpdir(), 'flight-monitor-test-'));
  const rules = join(directory, 'rules.json');
  await writeFile(rules, JSON.stringify([r]));
  return { directory, rules, repository: new LocalRepository(directory, rules) };
}
test('delivery failure preserves history and pending alert; restart retries without duplicate', async () => {
  const { directory, rules, repository } = await local();
  let failing = true;
  let sends = 0;
  const email = { send: async () => { if (failing) throw new Error('injected mail failure'); sends++; return 'sent' as const; } };
  const provider = { name: 'tigerair', search: async () => quote() };
  const first = await new PriceService(repository, email, [provider], true).runAllActiveRules();
  assert.equal(first.failed, 1);
  let saved = JSON.parse(await readFile(join(directory, 'monitor.json'), 'utf8'));
  assert.equal(saved.history.length, 1);
  assert.equal(saved.alerts[0].status, 'pending');
  failing = false;
  const second = await new PriceService(new LocalRepository(directory, rules), email, [provider], true).runAllActiveRules();
  assert.equal(second.failed, 0);
  saved = JSON.parse(await readFile(join(directory, 'monitor.json'), 'utf8'));
  assert.equal(saved.history.length, 2);
  assert.equal(saved.alerts.length, 1);
  assert.equal(saved.alerts[0].status, 'sent');
  assert.equal(sends, 1);
});
test('preview never records an alert as sent or queues a real email', async () => {
  const { directory, repository } = await local();
  const summary = await new PriceService(repository, { send: async () => 'preview' },
    [{ name: 'tigerair', search: async () => quote() }], false).runAllActiveRules();
  assert.equal(summary.failed, 0);
  assert.equal(JSON.parse(await readFile(join(directory, 'monitor.json'), 'utf8')).alerts.length, 0);
});
test('provider failure records nothing and returns a failed run', async () => {
  const { directory, repository } = await local();
  const summary = await new PriceService(repository, { send: async () => 'sent' },
    [{ name: 'tigerair', search: async () => { throw new Error('injected unavailable'); } }], true).runAllActiveRules();
  assert.equal(summary.failed, 1);
  await assert.rejects(readFile(join(directory, 'monitor.json')), { code: 'ENOENT' });
});
test('missing provider fails and past dates are skipped', async () => {
  const a = await local();
  assert.equal((await new PriceService(a.repository, { send: async () => 'sent' }, [], false).runAllActiveRules()).failed, 1);
  const b = await local({ ...rule, departureDate: '2020-01-01', returnDate: '2020-01-02' });
  assert.equal((await new PriceService(b.repository, { send: async () => 'sent' }, [], false).runAllActiveRules()).skipped, 1);
});
test('CLI reports provider failures with exit code 1', async () => {
  const { directory, rules } = await local({ ...rule, provider: 'unsupported' });
  const child = spawnSync(process.execPath, ['dist/src/index.js', '--run-once'], {
    env: { ...process.env, STORAGE: 'local', EMAIL_MODE: 'preview', DATA_DIR: directory, WATCH_RULES_FILE: rules },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.status, 1, child.error?.message);
  assert.match(child.stderr, /Unknown provider/);
  assert.match(child.stdout, /"failed":1/);
});
test('local lock blocks overlap and is released after errors', async () => {
  const { directory, rules, repository } = await local();
  assert.equal(await repository.acquireLock('first'), true);
  assert.equal(await new LocalRepository(directory, rules).acquireLock('second'), false);
  await repository.releaseLock('first');
  assert.equal(await repository.acquireLock('second'), true);
  await repository.releaseLock('second');
});
test('corrupt local database fails loudly instead of discarding history', async () => {
  const { directory, repository } = await local();
  await writeFile(join(directory, 'monitor.json'), 'broken');
  await assert.rejects(repository.getPendingAlerts());
});
test('Resend returned error fails; retry uses stable idempotency key', async () => {
  const item = alert();
  const keys: string[] = [];
  const request: typeof fetch = async (_url, init) => {
    keys.push((init!.headers as Record<string, string>)['Idempotency-Key']);
    return new Response(JSON.stringify({ message: 'rejected' }), { status: 422 });
  };
  const service = new EmailService({ ...config, EMAIL_MODE: 'send', NOTIFICATION_TO_EMAIL: 'operator@example.com' }, request);
  await assert.rejects(service.send(item), /422/);
  await assert.rejects(service.send(item), /422/);
  assert.equal(keys[0], keys[1]);
});
test('email preview is not sent; template escapes HTML and includes pricing exclusions', async () => {
  assert.equal(await new EmailService({ ...config, EMAIL_MODE: 'preview' }).send(alert()), 'preview');
  const item = alert();
  item.payload.trigger.reason = '<script>alert(1)</script>';
  const email = renderEmail(item);
  assert.ok(!email.html.includes('<script>'));
  assert.ok(email.text.includes('付款手續費'));
});

test('owned alerts only go to resolved owner and never fall back to operator email', async () => {
  const item = alert();
  item.payload.rule = { ...item.payload.rule, userId: randomUUID() };
  let recipient = '';
  const request: typeof fetch = async (_url, init) => {
    recipient = JSON.parse(String(init?.body)).to[0];
    return new Response(JSON.stringify({ id: 'test' }));
  };
  const options = { ...config, EMAIL_MODE: 'send' as const, NOTIFICATION_TO_EMAIL: 'operator@example.com' };
  await assert.rejects(new EmailService(options, request).send(item), /No verified recipient/);
  assert.equal(recipient, '');
  await new EmailService(options, request, async () => 'owner@example.com').send(item);
  assert.equal(recipient, 'owner@example.com');
});
