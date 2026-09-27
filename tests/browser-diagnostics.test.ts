import test from 'node:test';
import assert from 'node:assert/strict';
import { isFareEndpoint, pageSignal } from '../src/providers/tigerair-diagnostics.js';

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
