import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTigerairResponse } from '../src/providers/tigerair-parser.js';
import { getBookingUrl } from '../src/providers/tigerair-url.js';
import { parseConfig } from '../src/config.js';
import { searchKey, watchRuleSchema } from '../src/validation.js';

const fixture = () => JSON.parse(readFileSync('tests/fixtures/tigerair-search.json', 'utf8'));
const input = { origin: 'TPE', destination: 'NRT', departureDate: '2027-02-10',
  returnDate: '2027-02-16', adults: 1, currency: 'TWD' as const };
test('observed API: cheapest direct round trip is 16557 including 2759 tax', () => {
  const result = parseTigerairResponse(fixture(), input);
  assert.equal(result.outboundPrice, 7399);
  assert.equal(result.inboundPrice, 6399);
  assert.equal(result.totalPrice, 16557);
  assert.equal(result.taxAndFees, 2759);
  assert.deepEqual(result.legs.map(leg => leg.flightNumber), ['IT202', 'IT201']);
});
test('two adults: sums fares and tax for every traveler exactly once', () => {
  const result = parseTigerairResponse(fixture(), { ...input, adults: 2 });
  assert.equal(result.totalPrice, 33114);
  assert.equal(result.taxAndFees, 5518);
});
test('one-way: no invented inbound price', () => {
  const body = fixture();
  body.data.appFlightSearchResult.flightType = 'oneWay';
  body.data.appFlightSearchResult.journeys.pop();
  const result = parseTigerairResponse(body, { ...input, returnDate: undefined });
  assert.equal(result.totalPrice, 8599);
  assert.equal(result.inboundPrice, undefined);
});
test('insufficient seats selects next sellable fare', () => {
  const body = fixture();
  body.data.appFlightSearchResult.journeys[0].legs[0].availabilityLegs[1].fares[0].availableCount = 1;
  const result = parseTigerairResponse(body, { ...input, adults: 2 });
  assert.equal(result.legs[0].flightNumber, 'IT200');
  assert.equal(result.totalPrice, (9599 + 7958) * 2);
});
for (const [name, edit] of [
  ['missing inbound', (b: any) => b.data.appFlightSearchResult.journeys.pop()],
  ['wrong date', (b: any) => { b.data.appFlightSearchResult.journeys[0].legs[0].departureDate = '2027-02-11'; }],
  ['GraphQL error with partial data', (b: any) => { b.errors = [{ message: 'error' }]; }],
  ['currency mismatch', (b: any) => { b.data.appFlightSearchResult.journeys[0].legs[0].availabilityLegs[0].fares[0].paxFares[0].ticketPrice.userCurrency = 'JPY'; }],
  ['missing tax', (b: any) => { delete b.data.appFlightSearchResult.journeys[0].legs[0].availabilityLegs[0].fares[0].paxFares[0].ticketPrice.taxAmount; }],
  ['inconsistent tax total', (b: any) => { b.data.appFlightSearchResult.journeys[0].legs[0].availabilityLegs[0].fares[0].paxFares[0].ticketPrice.taxAmount = 1; }],
  ['sold out', (b: any) => { for (const leg of b.data.appFlightSearchResult.journeys[0].legs[0].availabilityLegs) for (const fare of leg.fares) fare.sellable = false; }],
] as const) {
  test('rejects ' + name + ' without fabricating a price', () => {
    const body = fixture(); edit(body);
    assert.throws(() => parseTigerairResponse(body, input));
  });
}
test('URL carries route, return, passengers and currency', () => {
  const url = new URL(getBookingUrl({ ...input, adults: 2 }));
  assert.equal(url.searchParams.get('adult'), '2');
  assert.equal(url.searchParams.get('returnDate'), '2027-02-16');
  assert.equal(url.searchParams.get('currencyCode'), 'TWD');
  const one = new URL(getBookingUrl({ ...input, returnDate: undefined }));
  assert.equal(one.searchParams.get('type'), 'oneWay');
  assert.equal(one.searchParams.has('inbound'), false);
});
test('invalid dates and traveler counts fail before browsing', () => {
  for (const bad of [{ departureDate: '2027-02-30' }, { returnDate: '2027-02-01' }, { adults: 0 }, { adults: 10 }]) {
    assert.throws(() => getBookingUrl({ ...input, ...bad }));
  }
});
test('history key changes when search conditions change', () => {
  const rule = watchRuleSchema.parse({ ...input, id: 'test' });
  assert.notEqual(searchKey(rule), searchKey({ ...rule, adults: 2 }));
  assert.notEqual(searchKey(rule), searchKey({ ...rule, departureDate: '2027-02-11' }));
});
test('invalid scheduler and incomplete production config fail early', () => {
  assert.throws(() => parseConfig({ MONITOR_INTERVAL_MINUTES: 'abc' }));
  assert.throws(() => parseConfig({ MONITOR_INTERVAL_MINUTES: '0' }));
  assert.throws(() => parseConfig({ STORAGE: 'supabase' }));
  assert.throws(() => parseConfig({ EMAIL_MODE: 'send' }));
});
