import test from 'node:test';
import assert from 'node:assert/strict';
import type { RequestQueue } from 'apify';
import { ApifyRepository, RequestQueueMutex, type MonitorMutex, type PersistentStore } from '../src/apify/repository.js';
import { actorInputSchema, runActorInput, type ActorDependencies, type ActorEmail } from '../src/apify/runner.js';
import { PriceService } from '../src/services/price.service.js';
import { googleFlightsPriceBasis, searchKey, watchRuleSchema } from '../src/validation.js';
import type { GoogleFlightsPriceResult, PriceHistory } from '../src/types/index.js';

const search = { origin: 'TPE', destination: 'NRT', departureDate: '2099-02-10', returnDate: '2099-02-16', adults: 1, currency: 'TWD' as const };
const rule = watchRuleSchema.parse({ ...search, id: 'uncle', provider: 'google-flights', targetPrice: 20000 });
function quote(): GoogleFlightsPriceResult {
  return { ...search, provider: 'google-flights', priceBasis: googleFlightsPriceBasis,
    outboundPrice: null, inboundPrice: null, taxAndFees: null, totalPrice: 16088,
    checkedAt: new Date().toISOString(), bookingUrl: 'https://www.google.com/travel/flights',
    legs: [], reference: { source: 'google-flights', seller: 'Tigerair Taiwan', taxInclusive: true, fareFamily: null,
      yearVerifiedFromDom: false, sourceDataMaxAgeHours: 24, selectedItineraryOnly: true } };
}
class MemoryStore implements PersistentStore {
  values = new Map<string, unknown>();
  writes = 0;
  async getValue<T>(key: string): Promise<T | null> { return structuredClone(this.values.get(key) ?? null) as T | null; }
  async setValue(key: string, value: unknown): Promise<void> { this.writes++; this.values.set(key, structuredClone(value)); }
}
class SharedMutex implements MonitorMutex {
  held = false;
  async tryAcquire() { if (this.held) return false; this.held = true; return true; }
  async release() { this.held = false; }
}
function email(): ActorEmail {
  return { send: async () => { throw new Error('Unexpected notification'); },
    sendPriceTest: async () => { throw new Error('Unexpected test mail'); } };
}
function dependencies(overrides: Partial<ActorDependencies> = {}): ActorDependencies {
  return { provider: { name: 'google-flights', search: async () => quote() }, env: {}, createEmail: () => email(),
    openRepository: async () => { throw new Error('Unexpected state access'); }, ...overrides };
}
const mailEnv = { EMAIL_PROVIDER: 'gmail', GMAIL_USER: 'sender@example.com', GMAIL_APP_PASSWORD: 'abcdefghijklmnop', NOTIFICATION_TO_EMAIL: 'recipient@example.com' };

test('Actor accepts supported arbitrary search, rejects mixed actions and multi-rule or non-Google inputs', () => {
  assert.equal(actorInputSchema.parse({ search: { ...search, origin: 'KHH', destination: 'KIX', adults: 3 } }).action, 'check');
  assert.throws(() => actorInputSchema.parse({ action: 'check' }));
  assert.throws(() => actorInputSchema.parse({ action: 'check', search, watchRules: [rule] }));
  assert.throws(() => actorInputSchema.parse({ action: 'monitor', watchRules: [rule, { ...rule, id: 'second' }] }));
  assert.throws(() => actorInputSchema.parse({ action: 'monitor', watchRules: [{ ...rule, provider: 'tigerair' }] }));
  assert.throws(() => actorInputSchema.parse({ search, GMAIL_APP_PASSWORD: 'must-not-be-input' }));
});

test('check ignores EMAIL_MODE=send, returns real quote, never creates sender or storage', async () => {
  const output = await runActorInput({ action: 'check', search }, dependencies({ env: { EMAIL_MODE: 'send' },
    createEmail: () => { throw new Error('check must not instantiate sender'); } }));
  assert.equal(output.quote?.totalPrice, 16088);
  assert.equal(output.email.status, 'not-requested');
});

test('test-email validates credentials before spending a query and never mails an unsuccessful query', async () => {
  let queries = 0, senders = 0;
  const provider = { name: 'google-flights', search: async (): Promise<GoogleFlightsPriceResult> => { queries++; throw new Error('No quote'); } };
  const deps = dependencies({ provider, createEmail: () => { senders++; return email(); } });
  await assert.rejects(runActorInput({ action: 'test-email', search }, deps));
  assert.equal(queries, 0);
  await assert.rejects(runActorInput({ action: 'test-email', search }, { ...deps, env: mailEnv }), /No quote/);
  assert.equal(queries, 1);
  assert.equal(senders, 0);
});

test('test-email rejects wrong-source or stale results before creating sender', async () => {
  for (const invalid of [{ ...quote(), destination: 'KIX' }, { ...quote(), checkedAt: '2000-01-01T00:00:00Z' }, { ...quote(), totalPrice: 0 }]) {
    await assert.rejects(runActorInput({ action: 'test-email', search }, dependencies({ env: mailEnv,
      provider: { name: 'google-flights', search: async () => invalid },
      createEmail: () => { throw new Error('must not create sender'); } })), /invalid|stale/);
  }
});

test('test-email sends exactly the verified price and returns submission receipt without claiming delivery', async () => {
  const result = quote();
  let sends = 0;
  const sender: ActorEmail = { send: async () => { throw new Error('No threshold alert'); },
    lastReceipt: { provider: 'gmail', messageId: '<fixture@example.com>', accepted: true },
    sendPriceTest: async (actual, id) => { assert.deepEqual(actual, result); assert.match(id, /^[a-f0-9-]{36}$/); sends++; return 'sent'; } };
  const output = await runActorInput({ action: 'test-email', search }, dependencies({ env: mailEnv,
    provider: { name: 'google-flights', search: async () => result }, createEmail: options => {
      assert.equal(options.EMAIL_MODE, 'send'); assert.equal(options.DESKTOP_NOTIFY, 'false'); return sender;
    } }));
  assert.equal(sends, 1);
  assert.equal(output.email.status, 'accepted');
  assert.equal(output.email.receipt?.messageId, '<fixture@example.com>');
  assert.equal('delivered' in output.email, false);
});

test('named state survives a failed delivery and later run retries the same outbox item without duplicating it', async () => {
  const store = new MemoryStore(), mutex = new SharedMutex();
  const provider = { name: 'google-flights', search: async () => quote() };
  const firstRepo = new ApifyRepository(store, mutex, [rule]);
  const failed = await new PriceService(firstRepo, { send: async () => {
    assert.equal((await firstRepo.getPendingAlerts()).length, 1, 'persist the outbox before external mail');
    throw new Error('injected delivery outage');
  } }, [provider], true).runAllActiveRules();
  assert.equal(failed.failed, 1);
  const pendingId = (await firstRepo.getPendingAlerts())[0].id;
  let sentId: string | undefined, sends = 0;
  const secondRepo = new ApifyRepository(store, mutex, [rule]);
  const success = await new PriceService(secondRepo, { send: async alert => { sentId = alert.id; sends++; return 'sent'; } }, [provider], true).runAllActiveRules();
  assert.equal(success.failed, 0);
  assert.equal(sentId, pendingId);
  assert.equal(sends, 1);
  assert.equal((await secondRepo.getPendingAlerts()).length, 0);
  assert.equal((await secondRepo.getHistory(rule.id, searchKey(rule), '2000-01-01', '9999-01-01')).length, 2);
});

test('competing repositories cannot write without owning the same distributed lease', async () => {
  const store = new MemoryStore(), mutex = new SharedMutex();
  const first = new ApifyRepository(store, mutex, [rule]), second = new ApifyRepository(store, mutex, [rule]);
  assert.equal(await first.acquireLock('first'), true);
  assert.equal(await second.acquireLock('second'), false);
  const result = quote();
  const history: PriceHistory = { id: 'history', watchRuleId: rule.id, searchKey: searchKey(rule), price: result.totalPrice,
    currency: 'TWD', checkedAt: result.checkedAt, result };
  await assert.rejects(second.recordCheck(history), /lease/);
  await first.releaseLock('wrong-owner');
  assert.equal(await second.acquireLock('second'), false);
  await first.recordCheck(history);
  await first.releaseLock('first');
  assert.equal(await second.acquireLock('second'), true);
  await second.releaseLock('second');
  assert.equal(store.writes, 1);
});

test('queue lease uses one stable request, never handles or fetches its virtual URL', async () => {
  let locked = false, reclaim = 0;
  const uniqueKey = 'flight-monitor-exclusive-lock-v1';
  const fake = {
    requestLockSecs: 1,
    addRequest: async (request: { url: string; uniqueKey: string }) => {
      assert.equal(request.url, 'https://flight-monitor.invalid/lock'); assert.equal(request.uniqueKey, uniqueKey);
    },
    fetchNextRequest: async () => { if (locked) return null; locked = true; return { id: 'lock', uniqueKey }; },
    reclaimRequest: async () => { reclaim++; locked = false; },
  };
  const first = new RequestQueueMutex(fake as unknown as RequestQueue), second = new RequestQueueMutex(fake as unknown as RequestQueue);
  assert.equal(fake.requestLockSecs, 600);
  assert.equal(await first.tryAcquire(), true);
  assert.equal(await second.tryAcquire(), false);
  await first.release();
  assert.equal(reclaim, 1);
  assert.equal(await second.tryAcquire(), true);
  await second.release();
});
