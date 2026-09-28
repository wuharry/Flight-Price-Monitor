import test from 'node:test';
import assert from 'node:assert/strict';
import { isFareEndpoint, isWaitingRoomDenied, pageSignal, networkSummary } from '../src/providers/tigerair-diagnostics.js';

test('only waiting-room 403 rejects access, not membership or analytics errors', () => {
  assert.equal(isWaitingRoomDenied('https://api-wr.tigerairtw.com/assign_queue_num', 403), true);
  assert.equal(isWaitingRoomDenied('https://api-wr.tigerairtw.com/queue_num', 200), false);
  assert.equal(isWaitingRoomDenied('https://api-membership.tigerairtw.com/api/app/me/profiles', 401), false);
  assert.equal(isWaitingRoomDenied('https://analytics.google.com/', 403), false);
  assert.equal(isWaitingRoomDenied('https://api-wr.tigerairtw.com.evil.example/', 403), false);
  assert.equal(pageSignal('目前同時訂位人數較多，請稍候…'), 'waiting-room');
});

test('network diagnostics preserve error codes without leaking URLs or credentials', () => {
  const result = networkSummary('https://user:secret@cdn.example/private-token.js?token=secret#secret', 'script', 'net::ERR_CONNECTION_RESET https://secret.example/token');
  assert.deepEqual(result, { host: 'cdn.example', resource: 'script', error: 'net::ERR_CONNECTION_RESET' });
  assert.deepEqual(networkSummary('bad secret', 'fetch', 'secret failure'), { host: 'invalid-url', resource: 'fetch', error: 'NETWORK_FAILURE' });
  assert.deepEqual(networkSummary('https://api.example/secret', 'xhr', undefined, 403), { host: 'api.example', resource: 'xhr', status: 403 });
});

test('fare endpoint accepts query parameters but never another host or route', () => {
  assert.equal(isFareEndpoint('https://api-book.tigerairtw.com/graphql?version=2'), true);
  assert.equal(isFareEndpoint('https://api-book.tigerairtw.com/graphql/'), true);
  assert.equal(isFareEndpoint('https://api-book.tigerairtw.com.evil.example/graphql'), false);
  assert.equal(isFareEndpoint('https://api-book.tigerairtw.com/other'), false);
  assert.equal(isFareEndpoint('invalid'), false);
});

test('page diagnosis distinguishes visible evidence from an unknown timeout', () => {
  assert.equal(pageSignal('Access Denied'), 'access-denied');
  assert.equal(pageSignal('Please verify you are human'), 'verification-required');
  assert.equal(pageSignal('您目前正在排隊中'), 'waiting-room');
  assert.equal(pageSignal('選擇航班'), 'unknown');
  assert.equal(pageSignal(''), 'unknown');
});
