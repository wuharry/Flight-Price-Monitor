import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApifyRepository, type PersistentStore } from '../src/apify/repository.js';
import { parseGoogleFlightsObservation } from '../src/providers/google-flights-parser.js';
import { PriceService } from '../src/services/price.service.js';
import { searchKey, watchRuleSchema } from '../src/validation.js';
import type { AlertRecord, PriceHistory } from '../src/types/index.js';

function setup() {
  const search = { origin: 'TPE', destination: 'NRT', departureDate: '2027-02-10',
    returnDate: '2027-02-16', adults: 1, currency: 'TWD' as const };
  const observation = JSON.parse(readFileSync('tests/fixtures/google-flights-booking.json', 'utf8').replace(/^\uFEFF/, ''));
  const quote = parseGoogleFlightsObservation({ ...observation, checkedAt: new Date().toISOString(), navigationStatus: 200 }, search);
  const rule = watchRuleSchema.parse({ ...search, id: 'retry-rule', provider: 'google-flights', targetPrice: 20000 });
  const pending: AlertRecord = { id: 'existing-pending', watchRuleId: rule.id, searchKey: searchKey(rule),
    price: quote.totalPrice, type: 'below_target', createdAt: quote.checkedAt, status: 'pending',
    payload: { rule, result: quote, trigger: { type: 'below_target', currentPrice: quote.totalPrice, reason: 'threshold' } } };
  let state: { version: 1; history: PriceHistory[]; alerts: AlertRecord[] } = { version: 1, history: [], alerts: [pending] };
  let failSentWrite = false, writeFailures = 0;
  const store: PersistentStore = {
    getValue: async <T>() => structuredClone(state) as T,
    setValue: async (_key, value) => {
      const next = value as typeof state;
      if (failSentWrite && next.alerts.some(alert => alert.status === 'sent')) {
        failSentWrite = false; writeFailures++;
        throw new Error('Injected KVS failure after SMTP acceptance');
      }
      state = structuredClone(next);
    },
  };
  const repository = () => new ApifyRepository(store, { tryAcquire: async () => true, release: async () => {} }, [rule]);
  return { quote, repository, provider: { name: 'google-flights', search: async () => quote },
    state: () => state, failNextSentWrite: () => { failSentWrite = true; }, writeFailures: () => writeFailures };
}

test('SMTP acceptance followed by a KVS marking failure retries only persistence in the same run', async () => {
  const fixture = setup();
  fixture.failNextSentWrite();
  const sentIds: string[] = [];
  const summary = await new PriceService(fixture.repository(), { send: async alert => {
    sentIds.push(alert.id); return 'sent';
  } }, [fixture.provider], true).runAllActiveRules();
  assert.deepEqual(sentIds, ['existing-pending']);
  assert.equal(fixture.writeFailures(), 1);
  assert.equal(summary.checked, 1);
  assert.equal(summary.failed, 1, 'the persistence failure must remain visible even after recovery');
  assert.equal(fixture.state().alerts.length, 1);
  assert.equal(fixture.state().alerts[0].status, 'sent', 'second flush may retry marking but must not resend');
  assert.equal(fixture.state().history.length, 1);
});

test('unknown SMTP acceptance is not retried within one run, but the next run may retry the outbox', async () => {
  const fixture = setup();
  const sentIds: string[] = [];
  const first = await new PriceService(fixture.repository(), { send: async alert => {
    sentIds.push(alert.id); throw new Error('Injected SMTP response lost');
  } }, [fixture.provider], true).runAllActiveRules();
  assert.deepEqual(sentIds, ['existing-pending']);
  assert.equal(first.failed, 1);
  assert.equal(fixture.state().alerts[0].status, 'pending');
  const second = await new PriceService(fixture.repository(), { send: async alert => {
    sentIds.push(alert.id); return 'sent';
  } }, [fixture.provider], true).runAllActiveRules();
  assert.deepEqual(sentIds, ['existing-pending', 'existing-pending']);
  assert.equal(second.failed, 0);
  assert.equal(fixture.state().alerts.length, 1);
  assert.equal(fixture.state().alerts[0].status, 'sent');
});
