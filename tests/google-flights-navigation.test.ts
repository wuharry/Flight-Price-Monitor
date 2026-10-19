import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { googleFlightsHasNoMatchingItinerary, googleFlightsLegHeading, readGoogleFlightsBody, waitForGoogleFlightsLeg } from '../src/providers/google-flights.js';
import { ProviderAccessDeniedError } from '../src/providers/access-denied.js';
import { NoMatchingItineraryError } from '../src/providers/no-matching-itinerary.js';

type ObservablePage = Parameters<typeof readGoogleFlightsBody>[0];
const publicUrl = 'https://www.google.com/travel/flights/search?tfs=public-selected-permalink';

test('only a one-way outbound stage accepts the observed 所有航班 heading', () => {
  assert.match('所有航班', googleFlightsLegHeading('outbound', false));
  for (const heading of ['去程航班', '出發航班']) {
    assert.match(heading, googleFlightsLegHeading('outbound', false));
    assert.match(heading, googleFlightsLegHeading('outbound', true));
    assert.doesNotMatch(heading, googleFlightsLegHeading('inbound', true));
  }
  assert.doesNotMatch('所有航班', googleFlightsLegHeading('outbound', true));
  assert.doesNotMatch('所有航班', googleFlightsLegHeading('inbound', true));
  assert.doesNotMatch('所有航班', googleFlightsLegHeading('inbound', false));
  assert.match('回程航班', googleFlightsLegHeading('inbound', true));
  assert.doesNotMatch('回程航班', googleFlightsLegHeading('outbound', false));
  assert.doesNotMatch('所有航班優惠', googleFlightsLegHeading('outbound', false));
});

test('selected URL observation waits for its existing replacement document instead of failing a transient missing body', async () => {
  const calls: string[] = [];
  let documentReady = false;
  const page = {
    url: () => publicUrl,
    waitForLoadState: async (state: string, options: { timeout: number }) => {
      calls.push('navigation-ready'); assert.equal(state, 'domcontentloaded');
      assert.equal(options.timeout, 10000); documentReady = true;
    },
    locator: (selector: string) => ({ innerText: async (options: { timeout: number }) => {
      calls.push('body'); assert.equal(selector, 'body'); assert.equal(documentReady, true);
      // Model an existing navigation/DOM attachment taking 4.5 seconds, exceeding
      // the previous 3-second limit. No browser or wall-clock wait is necessary.
      if (options.timeout < 4500) throw new Error('transient body timeout');
      return '回程航班';
    } }),
    goto: () => { throw new Error('An observation must not navigate'); },
    reload: () => { throw new Error('An observation must not reload'); },
  } as unknown as ObservablePage;
  assert.equal(await readGoogleFlightsBody(page, maximum => maximum!), '回程航班');
  assert.deepEqual(calls, ['navigation-ready', 'body']);
});

test('verification and consent redirects stop before DOM waits or page requests', async () => {
  for (const [url, status] of [['https://www.google.com/sorry/index', 429], ['https://consent.google.com/m', 403]] as const) {
    const page = { url: () => url, waitForLoadState: () => { throw new Error('Must not wait'); },
      locator: () => { throw new Error('Must not read a blocked body'); } } as unknown as ObservablePage;
    await assert.rejects(readGoogleFlightsBody(page, () => 10000), (error: unknown) =>
      error instanceof ProviderAccessDeniedError && error.status === status);
  }
});

test('a redirect discovered during navigation readiness is rejected before body observation', async () => {
  let url = publicUrl, bodyReads = 0;
  const page = { url: () => url, waitForLoadState: async () => { url = 'https://consent.google.com/m'; },
    locator: () => { bodyReads++; throw new Error('Must not inspect consent'); } } as unknown as ObservablePage;
  await assert.rejects(readGoogleFlightsBody(page, () => 10000), ProviderAccessDeniedError);
  assert.equal(bodyReads, 0);
});

test('visible CAPTCHA/consent text still stops a public-looking selected permalink', async () => {
  for (const text of ['verify you are human', 'Before you continue to Google']) {
    const page = { url: () => publicUrl, waitForLoadState: async () => {},
      locator: () => ({ innerText: async () => text }) } as unknown as ObservablePage;
    await assert.rejects(readGoogleFlightsBody(page, () => 10000), ProviderAccessDeniedError);
  }
});

test('both local observations respect the existing overall deadline without extending it', async () => {
  const budgets = [421, 37], observed: number[] = [];
  const page = { url: () => publicUrl,
    waitForLoadState: async (_: string, options: { timeout: number }) => { observed.push(options.timeout); },
    locator: () => ({ innerText: async (options: { timeout: number }) => { observed.push(options.timeout); return '公開航班'; } }),
  } as unknown as ObservablePage;
  assert.equal(await readGoogleFlightsBody(page, maximum => { assert.equal(maximum, 10000); return budgets.shift()!; }), '公開航班');
  assert.deepEqual(observed, [421, 37]);
});

test('navigation or body timeout is terminal for this observation, without a DOM retry or reload', async () => {
  for (const failAt of ['navigation', 'body']) {
    const calls: string[] = [];
    const page = { url: () => publicUrl,
      waitForLoadState: async () => { calls.push('navigation'); if (failAt === 'navigation') throw new Error('navigation timeout'); },
      locator: () => ({ innerText: async () => { calls.push('body'); throw new Error('body timeout'); } }),
    } as unknown as Pick<Page, 'url' | 'waitForLoadState' | 'locator'>;
    await assert.rejects(readGoogleFlightsBody(page, () => 10000), new RegExp(failAt + ' timeout'));
    assert.deepEqual(calls, failAt === 'navigation' ? ['navigation'] : ['navigation', 'body']);
  }
});

test('only explicit observed no-result messages classify a missing itinerary, not loading or alternative dates', () => {
  for (const text of ['找不到任何結果，但找到替代的建議。', '找不到符合篩選條件的選項',
    '搜尋航班\n找不到任何結果，但找到替代的建議。\n試試看其他日期\n10月25日\n10月27日']) {
    assert.equal(googleFlightsHasNoMatchingItinerary(text), true);
  }
  for (const text of ['', '載入中', '正在搜尋航班', '試試看其他日期', '10月25日\n10月27日',
    '所有航班\n直達\n台灣虎航', '去程航班\n回程航班']) {
    assert.equal(googleFlightsHasNoMatchingItinerary(text), false);
  }
});

test('explicit no-result DOM observation produces a typed failure instead of a substitute quote', async () => {
  let bodyReads = 0;
  const page = { url: () => publicUrl, waitForLoadState: async () => {},
    locator: () => ({ innerText: async () => { bodyReads++; return '找不到符合篩選條件的選項\n試試看其他日期\n10月25日'; } }),
  } as unknown as ObservablePage;
  await assert.rejects(readGoogleFlightsBody(page, () => 10000), NoMatchingItineraryError);
  assert.equal(bodyReads, 1);
});

test('visible no-result state ends the heading wait without navigation, selection or waiting for its timeout', async () => {
  const calls: string[] = [];
  const pending = () => new Promise<void>(() => {});
  const page = { url: () => publicUrl, waitForLoadState: async () => { calls.push('ready'); },
    getByRole: () => ({ waitFor: pending }), waitForURL: pending,
    getByText: (message: RegExp) => ({ first: () => ({ waitFor: async () => {
      calls.push('visible-no-results'); assert.match('找不到符合篩選條件的選項', message);
    } }) }),
    locator: () => ({ innerText: async () => { calls.push('body'); return '找不到任何結果，但找到替代的建議。\n10月25日'; } }),
    goto: () => { throw new Error('Must not navigate to suggestions'); },
    reload: () => { throw new Error('Must not retry the query'); },
  } as unknown as Parameters<typeof waitForGoogleFlightsLeg>[0];
  await assert.rejects(waitForGoogleFlightsLeg(page, 'outbound', true, maximum => maximum!), NoMatchingItineraryError);
  assert.deepEqual(calls, ['visible-no-results', 'ready', 'body']);
});

test('CAPTCHA content takes precedence over a no-result classification', async () => {
  const page = { url: () => publicUrl, waitForLoadState: async () => {},
    locator: () => ({ innerText: async () => '找不到符合篩選條件的選項\nverify you are human' }),
  } as unknown as ObservablePage;
  await assert.rejects(readGoogleFlightsBody(page, () => 10000), ProviderAccessDeniedError);
});
