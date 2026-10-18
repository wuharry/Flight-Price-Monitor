import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getGoogleFlightsUrl, validateGoogleFlightsUrl } from '../src/providers/google-flights-url.js';
import { parseGoogleFlightsObservation, googleFlightsPageBarrier } from '../src/providers/google-flights-parser.js';
import { searchKey } from '../src/validation.js';
const input = { origin: 'TPE', destination: 'NRT', departureDate: '2027-02-10', returnDate: '2027-02-16', adults: 1, currency: 'TWD' as const };
const fixture = (): { url: string; text: string; checkedAt: string; navigationStatus: number } => ({
  ...JSON.parse(readFileSync('tests/fixtures/google-flights-booking.json', 'utf8').replace(/^\uFEFF/, '')),
  checkedAt: new Date().toISOString(), navigationStatus: 200,
});

test('Google URL serializes arbitrary airports, full dates, adult counts and trip kind', () => {
  for (const search of [input, { origin: 'KHH', destination: 'KIX', departureDate: '2027-06-11', adults: 3, currency: 'TWD' as const },
    { ...input, origin: 'CTS', destination: 'TPE', departureDate: '2028-12-30', returnDate: '2029-01-03', adults: 9 }]) {
    const url = getGoogleFlightsUrl(search);
    validateGoogleFlightsUrl(url, search);
    assert.equal(new URL(url).pathname, '/travel/flights/search');
    assert.throws(() => validateGoogleFlightsUrl(url, { ...search, adults: search.adults === 9 ? 8 : 9 }));
    assert.throws(() => validateGoogleFlightsUrl(url, { ...search, departureDate: '2030-01-01', returnDate: undefined }));
    assert.throws(() => validateGoogleFlightsUrl(url, { ...search, origin: 'LAX' }));
  }
  assert.throws(() => getGoogleFlightsUrl({ ...input, adults: 0 }));
  assert.throws(() => getGoogleFlightsUrl({ ...input, departureDate: '2027-02-30' }));
  assert.throws(() => validateGoogleFlightsUrl('https://evil.example/travel/flights/booking?tfs=abc&curr=TWD', input));
  const truncated = new URL(getGoogleFlightsUrl(input)); truncated.searchParams.set('tfs', 'Gh0');
  assert.throws(() => validateGoogleFlightsUrl(truncated.href, input));
});
test('recorded public booking DOM validates airline seller reference without fabricated breakdowns', () => {
  const result = parseGoogleFlightsObservation(fixture(), input);
  assert.equal(result.totalPrice, 16088);
  assert.equal(result.taxAndFees, null);
  assert.equal(result.outboundPrice, null);
  assert.equal(result.inboundPrice, null);
  assert.equal(result.reference.fareFamily, null);
  assert.equal(result.reference.yearVerifiedFromDom, false);
  assert.equal(result.legs[0].flightNumber, null);
  assert.equal(result.legs[0].departureTime, null);
  assert.equal(result.legs[1].departureTimeLabel, '上午11:25');
  assert.notEqual(searchKey(result), searchKey({ ...input, provider: 'tigerair' }));
});
test('seller block price is used even when unrelated prices are cheaper', () => {
  const observation = fixture();
  observation.text = observation.text.replace('預訂選項\n', '預訂選項\n透過Cheap OTA預訂線上旅行社\n$99\n繼續\n');
  assert.equal(parseGoogleFlightsObservation(observation, input).totalPrice, 16088);
});
test('adult total is not multiplied again and one-way results invent no inbound breakdown', () => {
  const observation = fixture(), two = { ...input, adults: 2 };
  observation.url = getGoogleFlightsUrl(two).replace('/search?', '/booking?');
  observation.text = observation.text.replace('1 位乘客', '2 位乘客').replace('1 位成人的價格', '2 位成人的價格');
  assert.equal(parseGoogleFlightsObservation(observation, two).totalPrice, 16088);
  const oneWay = { ...input, returnDate: undefined }, one = fixture();
  one.url = getGoogleFlightsUrl(oneWay).replace('/search?', '/booking?');
  one.text = one.text.replace('來回經濟艙', '單程經濟艙').replace(/2月16日週二[\s\S]*?(?=免費攜帶)/, '');
  const result = parseGoogleFlightsObservation(one, oneWay);
  assert.equal(result.legs.length, 1);
  assert.equal(result.inboundPrice, undefined);
});
test('optional Google price analysis is not required to validate the seller booking block', () => {
  const observation = fixture(); observation.text = observation.text.replace('價格分析', '');
  assert.equal(parseGoogleFlightsObservation(observation, input).totalPrice, 16088);
});
for (const [name, edit] of [
  ['wrong month/day', (value: ReturnType<typeof fixture>) => { value.text = value.text.replace('2月10日週三', '2月11日週四'); }],
  ['wrong return airport', (value: ReturnType<typeof fixture>) => { value.text = value.text.replace('NRT–TPE', 'NRT–KHH'); }],
  ['wrong carrier', (value: ReturnType<typeof fixture>) => { value.text = value.text.replace('台灣虎航', '其他航空'); }],
  ['one missing direct label', (value: ReturnType<typeof fixture>) => { value.text = value.text.replace('直達', '轉機 1 次'); }],
  ['wrong currency', (value: ReturnType<typeof fixture>) => { value.text = value.text.replace('幣別TWD', '幣別JPY'); }],
  ['ambiguous currency', (value: ReturnType<typeof fixture>) => { value.text += '\n幣別TWD'; }],
  ['missing adult total label', (value: ReturnType<typeof fixture>) => { value.text = value.text.replace('1 位成人的價格', '2 位成人的價格'); }],
  ['no airline seller', (value: ReturnType<typeof fixture>) => { value.text = value.text.replace('透過Tigerair Taiwan預訂航空公司', '透過OTA預訂'); }],
  ['duplicate airline seller', (value: ReturnType<typeof fixture>) => { value.text = value.text.replace('預訂選項\n', '預訂選項\n透過Tigerair Taiwan預訂航空公司\n$10\n繼續\n'); }],
  ['price analysis only', (value: ReturnType<typeof fixture>) => { value.text = value.text.replace('透過Tigerair Taiwan預訂航空公司\n$16,088\n繼續', '沒有賣家'); }],
  ['no freshness disclosure', (value: ReturnType<typeof fixture>) => { value.text = value.text.replace('搜尋結果顯示的是 24 小時內的資訊', '資料時間不明'); }],
  ['captcha', (value: ReturnType<typeof fixture>) => { value.text += '\nverify you are human'; }],
  ['consent', (value: ReturnType<typeof fixture>) => { value.text += '\nBefore you continue to Google'; }],
  ['HTTP failure', (value: ReturnType<typeof fixture>) => { value.navigationStatus = 403; }],
  ['stale observation', (value: ReturnType<typeof fixture>) => { value.checkedAt = '2020-01-01T00:00:00Z'; }],
] as const) test('Google reference rejects ' + name, () => { const observation = fixture(); edit(observation); assert.throws(() => parseGoogleFlightsObservation(observation, input)); });
test('visible dates cannot override a different request year or adult count in URL', () => {
  assert.throws(() => parseGoogleFlightsObservation(fixture(), { ...input, departureDate: '2028-02-10', returnDate: '2028-02-16' }));
  assert.throws(() => parseGoogleFlightsObservation(fixture(), { ...input, adults: 2 }));
  assert.equal(googleFlightsPageBarrier('', 'https://www.google.com/sorry/index'), 'captcha');
  assert.equal(googleFlightsPageBarrier('', 'https://consent.google.com/m'), 'consent');
});
test('matching parent airports cannot hide mismatched selected-flight date, route or airline', () => {
  // These protobuf field markers address the selected flight, leaving its
  // parent leg's requested airports/date and all visible DOM evidence intact.
  for (const [original, replacement] of [
    [Buffer.from('\x12\x0a2027-02-10'), Buffer.from('\x12\x0a2028-02-10')],
    [Buffer.from('\x0a\x03TPE'), Buffer.from('\x0a\x03KHH')],
    [Buffer.from('\x1a\x03NRT'), Buffer.from('\x1a\x03KIX')],
    [Buffer.from('\x2a\x02IT'), Buffer.from('\x2a\x02BR')],
  ]) {
    const observation = fixture(), url = new URL(observation.url);
    const data = Buffer.from(url.searchParams.get('tfs')!, 'base64url');
    // The full-date field occurs in both parent and selected flight; mutate
    // its second occurrence so that the parent remains the original request.
    const first = data.indexOf(original);
    const position = original.equals(Buffer.from('\x12\x0a2027-02-10')) ? data.indexOf(original, first + 1) : first;
    assert.ok(position >= 0, 'selected flight field exists in the recorded public URL');
    replacement.copy(data, position);
    url.searchParams.set('tfs', data.toString('base64url'));
    observation.url = url.href;
    assert.throws(() => parseGoogleFlightsObservation(observation, input), /selected flight mismatch/);
  }
});
