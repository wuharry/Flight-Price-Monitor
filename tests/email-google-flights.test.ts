import test from 'node:test';
import assert from 'node:assert/strict';
import type { SendMailOptions } from 'nodemailer';
import { parseConfig } from '../src/config.js';
import { EmailService, renderEmail } from '../src/services/email.service.js';
import { sendGmail } from '../src/services/gmail.js';
import type { AlertRecord, GoogleFlightsPriceResult } from '../src/types/index.js';

const quote: GoogleFlightsPriceResult = {
  provider: 'google-flights', origin: 'TPE', destination: 'NRT',
  departureDate: '2027-02-10', returnDate: '2027-02-16', adults: 1, currency: 'TWD',
  outboundPrice: null, inboundPrice: null, taxAndFees: null, totalPrice: 16088,
  checkedAt: '2026-10-18T04:00:00.000Z',
  bookingUrl: 'https://www.google.com/travel/flights?tfs=example&curr=TWD',
  priceBasis: 'google-flights-tigerair-reference-including-tax-v1',
  reference: { source: 'google-flights', seller: 'Tigerair Taiwan', taxInclusive: true,
    fareFamily: null, yearVerifiedFromDom: false, sourceDataMaxAgeHours: 24, selectedItineraryOnly: true },
  legs: [
    { origin: 'TPE', destination: 'NRT', requestedDate: '2027-02-10', displayedDate: 'Feb 10',
      departureTimeLabel: '1:30 PM', arrivalTimeLabel: '5:30 PM', departureTime: null, arrivalTime: null,
      flightNumber: null, fare: null, tax: null, total: null },
    { origin: 'NRT', destination: 'TPE', requestedDate: '2027-02-16', displayedDate: 'Feb 16',
      departureTimeLabel: '11:25 AM', arrivalTimeLabel: '2:45 PM', departureTime: null, arrivalTime: null,
      flightNumber: 'IT 201', fare: null, tax: null, total: null },
  ],
};
const alert = (): AlertRecord => ({
  id: 'alert-google', watchRuleId: 'rule-google', searchKey: 'google-search', price: quote.totalPrice,
  type: 'below_target', createdAt: quote.checkedAt, status: 'pending',
  payload: { result: quote, rule: { ...quote, id: 'rule-google', notifyNewLow: false, newLowDays: 30, enabled: true },
    trigger: { type: 'below_target', currentPrice: quote.totalPrice, reason: '<script>unsafe</script>' } },
});
const options = () => parseConfig({ STORAGE: 'local', EMAIL_MODE: 'send', EMAIL_PROVIDER: 'gmail',
  GMAIL_USER: 'sender@gmail.com', GMAIL_APP_PASSWORD: 'abcdefghijklmnop', NOTIFICATION_TO_EMAIL: 'recipient@example.com' });

test('Google email identifies the reference price without inventing tax or fare-family data', () => {
  const message = renderEmail(alert());
  assert.match(message.subject, /Google Flights 虎航參考價/);
  assert.match(message.text, /含稅參考總價：NT\$16,088/);
  assert.match(message.text, /seller.*Tigerair Taiwan/);
  assert.match(message.text, /未提供未稅票價與稅費拆分/);
  assert.match(message.text, /未驗證 tigerLight/);
  assert.match(message.text, /24 小時延遲/);
  assert.match(message.text, /以航空公司結帳頁為準/);
  assert.doesNotMatch(message.text, /去程未稅：|回程未稅：|稅費：NT\$|NT\$null|NT\$0\b|票價方案：tigerLight/);
  assert.doesNotMatch(message.html, /<script>/);
  assert.match(message.html, /查看 Google Flights 參考報價/);
  assert.doesNotMatch(message.html, />前往航空公司查詢</);
});

test('Google email uses requested dates and displayed clock labels without fake timestamps or flight numbers', () => {
  const { text } = renderEmail(alert());
  assert.match(text, /2027-02-10 TPE → NRT；出發 1:30 PM／抵達 5:30 PM/);
  assert.match(text, /2027-02-16 NRT → TPE IT 201；出發 11:25 AM／抵達 2:45 PM/);
  assert.doesNotMatch(text, /null|undefined|Unknown|00:00:00/);
  assert.match(text, /未獨立驗證行程年份/);
});

test('price test sends one real quote with a unique subject and an acceptance-only receipt', async () => {
  const mails: SendMailOptions[] = [];
  const service = new EmailService(options(), fetch, undefined, () => ({
    close: () => {}, sendMail: async mail => {
      mails.push(mail); return { accepted: ['recipient@example.com'], rejected: [] };
    },
  }));
  assert.equal(Boolean(service.lastReceipt), false);
  assert.equal(await service.sendPriceTest(quote, '9742268a-0000-4000-8000-000000000000'), 'sent');
  assert.equal(mails.length, 1);
  assert.match(String(mails[0]!.subject), /查價與寄信測試 9742268a/);
  assert.match(String(mails[0]!.text), /16,088/);
  assert.match(String(mails[0]!.text), /不代表符合監控門檻或已訂票/);
  assert.doesNotMatch(String(mails[0]!.text), /桌面通知|低於目標|可以訂機票/);
  assert.deepEqual(Object.keys(service.lastReceipt!).sort(), ['accepted', 'messageId', 'provider']);
  assert.equal(service.lastReceipt?.provider, 'gmail');
  assert.equal(service.lastReceipt?.accepted, true);
  assert.match(service.lastReceipt!.messageId, /^<flight-alert-[a-f0-9]{64}@gmail\.com>$/);
  assert.doesNotMatch(JSON.stringify(service.lastReceipt), /recipient@example\.com|sender@gmail\.com|abcdefghijklmnop|delivered/);
});

test('a failed or preview price test cannot report a previous successful receipt', async () => {
  let fail = false;
  const service = new EmailService(options(), fetch, undefined, () => ({ close: () => {}, sendMail: async () => {
    if (fail) throw Object.assign(new Error('abcdefghijklmnop recipient@example.com'), { code: 'EAUTH' });
    return { accepted: ['recipient@example.com'], rejected: [] };
  } }));
  await service.sendPriceTest(quote, '11111111-0000-4000-8000-000000000000');
  assert.ok(service.lastReceipt);
  fail = true;
  await assert.rejects(service.sendPriceTest(quote, '22222222-0000-4000-8000-000000000000'), error => {
    assert.match(String(error), /authentication failed/);
    assert.doesNotMatch(String(error), /abcdefghijklmnop|recipient@example.com/);
    return true;
  });
  assert.equal(service.lastReceipt, undefined);
  const preview = new EmailService({ ...options(), EMAIL_MODE: 'preview' }, fetch, undefined,
    () => { throw new Error('Preview must not contact SMTP'); });
  assert.equal(await preview.sendPriceTest(quote, '33333333-0000-4000-8000-000000000000'), 'preview');
  assert.equal(preview.lastReceipt, undefined);
});

test('Resend receipts exclude unexpected response content and errors hide request credentials', async () => {
  let fail = false;
  const request: typeof fetch = async () => {
    if (fail) throw new Error('secret-api-key recipient@example.com');
    return new Response(JSON.stringify({ id: 'recipient@example.com' }));
  };
  const service = new EmailService({ ...options(), EMAIL_PROVIDER: 'resend' }, request);
  await service.sendPriceTest(quote, '44444444-0000-4000-8000-000000000000');
  assert.deepEqual(service.lastReceipt, { provider: 'resend', messageId: '[unavailable]', accepted: true });
  fail = true;
  await assert.rejects(service.sendPriceTest(quote, '55555555-0000-4000-8000-000000000000'), error => {
    assert.match(String(error), /before acceptance was confirmed/);
    assert.doesNotMatch(String(error), /secret-api-key|recipient@example.com/);
    return true;
  });
  assert.equal(service.lastReceipt, undefined);
});

test('SMTP setup failures are sanitized and close failures do not erase confirmed submission', async () => {
  const message = { subject: 'test', text: 'test', html: '<p>test</p>' };
  await assert.rejects(sendGmail('sender@gmail.com', 'abcdefghijklmnop', 'recipient@example.com', message, 'setup-test', {
    factory: () => { throw Object.assign(new Error('abcdefghijklmnop recipient@example.com'), {
      responseCode: 'abcdefghijklmnop', response: 123,
    }); },
  }), error => {
    assert.match(String(error), /not confirmed as accepted/);
    assert.doesNotMatch(String(error), /abcdefghijklmnop|recipient@example.com/);
    return true;
  });
  const id = await sendGmail('sender@gmail.com', 'abcdefghijklmnop', 'recipient@example.com', message, 'close-test', {
    factory: () => ({ sendMail: async () => ({ accepted: ['recipient@example.com'], rejected: [] }),
      close: () => { throw new Error('SMTP private response'); } }),
  });
  assert.match(id, /^<flight-alert-[a-f0-9]{64}@gmail\.com>$/);
});
