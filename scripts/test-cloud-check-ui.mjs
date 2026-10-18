import assert from 'node:assert/strict';
import test from 'node:test';
import { checkUnavailableReason, cloudErrorMessage, isActiveJob, jobPresentation, trustedGoogleBookingUrl } from '../web/cloud-check-ui.js';

const now = Date.parse('2026-10-18T12:00:00Z');
const rule = { provider: 'google-flights', enabled: true, departure_date: '2027-02-10' };
const activeJob = { status: 'running', expires_at: '2026-10-18T12:10:00Z' };

test('only an enabled future Google Flights rule can request a cloud check', () => {
  assert.equal(checkUnavailableReason(rule, '2026-10-18'), '');
  assert.match(checkUnavailableReason({ ...rule, provider: 'tigerair' }, '2026-10-18'), /舊版/);
  assert.match(checkUnavailableReason({ ...rule, enabled: false }, '2026-10-18'), /暫停/);
  assert.match(checkUnavailableReason({ ...rule, departure_date: '2026-10-17' }, '2026-10-18'), /日期已過/);
});

test('active status requires an unexpired lease and expired jobs do not promise ongoing work', () => {
  assert.equal(isActiveJob(activeJob, now), true);
  assert.equal(isActiveJob({ ...activeJob, status: 'succeeded' }, now), false);
  assert.equal(isActiveJob({ ...activeJob, expires_at: 'bad-date' }, now), false);
  const expired = { ...activeJob, expires_at: '2026-10-18T12:00:00Z' };
  assert.equal(isActiveJob(expired, now), false);
  assert.equal(jobPresentation(expired, now).tone, 'error');
  assert.match(jobPresentation(activeJob, now).detail, /關閉網頁/);
});

test('preview never claims a message was sent and accepted never claims inbox delivery', () => {
  const done = { status: 'succeeded', total_price: 16088, currency: 'TWD' };
  assert.match(jobPresentation({ ...done, email_status: 'preview' }).detail, /沒有寄出/);
  assert.match(jobPresentation({ ...done, email_status: 'not-triggered' }).detail, /沒有寄出/);
  assert.match(jobPresentation({ ...done, email_status: 'accepted' }).detail, /不代表已送達/);
  assert.match(jobPresentation(done).title, /16,088/);
});

test('server error codes get useful messages while arbitrary text is never reflected', () => {
  assert.match(cloudErrorMessage('cloud_check_daily_limit'), /今天/);
  assert.match(cloudErrorMessage('cloud_check_busy'), /正在進行/);
  assert.match(cloudErrorMessage('unauthorized'), /重新登入/);
  assert.equal(cloudErrorMessage('secret password example'), cloudErrorMessage('unknown'));
  assert.equal(cloudErrorMessage('secret password example').includes('password'), false);
});

test('only a Google Flights quote can link to the exact public Google host and flights path', () => {
  const quote = { provider: 'google-flights', bookingUrl: 'https://www.google.com/travel/flights/search?tfs=public' };
  assert.equal(trustedGoogleBookingUrl(quote), quote.bookingUrl);
  for (const bookingUrl of ['javascript:alert(1)', 'http://www.google.com/travel/flights/search',
    'https://www.google.com.evil.test/travel/flights/search', 'https://www.google.com@evil.test/travel/flights/search',
    'https://user:pass@www.google.com/travel/flights/search', 'https://www.google.com:444/travel/flights/search',
    'https://www.google.com/travel/flights-evil', 'https://www.google.com/url?q=https://evil.test']) {
    assert.equal(trustedGoogleBookingUrl({ ...quote, bookingUrl }), null, bookingUrl);
  }
  assert.equal(trustedGoogleBookingUrl({ ...quote, provider: 'tigerair' }), null);
});
