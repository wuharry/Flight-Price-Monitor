import { chromium, type Browser, type Page } from 'playwright-core';
import type { FlightProvider } from './base.js';
import type { FlightSearch, GoogleFlightsPriceResult } from '../types/index.js';
import { searchSchema, todayTaipei } from '../validation.js';
import { getGoogleFlightsUrl, validateGoogleFlightsUrl } from './google-flights-url.js';
import { googleFlightsPageBarrier, parseGoogleFlightsObservation } from './google-flights-parser.js';
import { ProviderAccessDeniedError } from './access-denied.js';

export type GoogleFlightsStage = 'navigation' | 'outbound' | 'inbound' | 'booking' | 'seller' | 'parse';
export interface GoogleFlightsBrowserOptions {
  channel?: 'chromium' | 'chrome' | 'msedge';
  headless?: boolean;
  timeoutMs?: number;
  onResult?: (page: Page, result: GoogleFlightsPriceResult) => Promise<void>;
  onError?: (page: Page, stage: GoogleFlightsStage) => Promise<void>;
}

export function googleFlightsLegHeading(stage: 'outbound' | 'inbound', roundTrip: boolean): RegExp {
  if (stage === 'inbound') return /^回程航班$/;
  // Observed single-trip UI labels its initial result set "所有航班".
  // Round trips must still prove the outbound/inbound stage before selecting.
  return roundTrip ? /^(?:去程|出發)航班$/ : /^(?:(?:去程|出發)航班|所有航班)$/;
}

/** Observe the current document once; waiting for its navigation never makes another request. */
export async function readGoogleFlightsBody(page: Pick<Page, 'url' | 'waitForLoadState' | 'locator'>,
  remaining: (maximum?: number) => number): Promise<string> {
  const checkBarrier = (text = '') => {
    const blocked = googleFlightsPageBarrier(text, page.url());
    if (blocked) throw new ProviderAccessDeniedError('google-flights', new URL(page.url()).hostname, blocked === 'captcha' ? 429 : 403);
  };
  checkBarrier(); // A redirected verification/consent URL must not wait for a body or be reloaded.
  // A selected permalink can appear before its replacement document has a body.
  // Wait for that existing navigation and let the locator span a late navigation,
  // instead of treating a transient missing body as a failed 3-second observation.
  await page.waitForLoadState('domcontentloaded', { timeout: remaining(10000) });
  checkBarrier();
  const text = await page.locator('body').innerText({ timeout: remaining(10000) });
  checkBarrier(text);
  return text;
}

/** Public, signed-out Google Flights UI; one selected direct Tigerair itinerary. */
export class GoogleFlightsProvider implements FlightProvider {
  readonly name = 'google-flights';
  constructor(private options: GoogleFlightsBrowserOptions = {}) {}
  getBookingUrl = getGoogleFlightsUrl;

  async search(search: FlightSearch): Promise<GoogleFlightsPriceResult> {
    const input = searchSchema.parse(search);
    if (input.departureDate < todayTaipei()) throw new Error('Departure date is in the past');
    const timeout = Math.min(this.options.timeoutMs ?? 90000, 90000);
    if (!Number.isFinite(timeout) || timeout < 5000) throw new Error('Google Flights timeout must be at least 5000ms');
    const end = Date.now() + timeout;
    const remaining = (maximum = 8000) => {
      const value = end - Date.now();
      if (value <= 0) throw new Error('Google Flights observation deadline exceeded. No price recorded.');
      return Math.min(value, maximum);
    };
    let browser: Browser | undefined, observedPage: Page | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let stage: GoogleFlightsStage = 'navigation';
    const collect = async () => {
      console.log('[Google Flights] Opening a public search for a direct Tigerair itinerary');
      browser = await chromium.launch({ headless: false,
        args: this.options.headless === false ? [] : ['--headless=new'],
        channel: this.options.channel === 'chromium' ? undefined : this.options.channel,
        timeout: remaining(20000) });
      const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
      // This provider never visits Tigerair checkout or uses the original airline API.
      await context.route(/^https?:\/\/(?:[a-z0-9-]+\.)*tigerairtw\.com(?::\d+)?(?:\/|$)/i,
        route => route.abort('blockedbyclient'));
      const page = await context.newPage();
      observedPage = page;
      page.setDefaultTimeout(Math.min(8000, timeout));
      let documentStatus = 200;
      page.on('response', response => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) documentStatus = response.status();
      });
      const response = await page.goto(getGoogleFlightsUrl(input), { waitUntil: 'domcontentloaded', timeout: remaining(45000) });
      if (!response?.ok()) throw new ProviderAccessDeniedError(this.name, 'www.google.com', response?.status() ?? 0);
      const barrier = () => readGoogleFlightsBody(page, remaining);
      const loadSelectedPermalink = async (previousUrl: string) => {
        // Selecting a flight updates Google's public permalink before its SPA
        // result request finishes. Load that exact, validated public URL once
        // so the next stage does not depend on a failed SPA transition.
        try {
          await page.waitForURL(url => url.href !== previousUrl, { timeout: remaining(5000) });
        } catch (error) {
          if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
        }
        await barrier(); // Never reload a human-verification or consent page.
        const selectedUrl = page.url();
        validateGoogleFlightsUrl(selectedUrl, input);
        const options = { waitUntil: 'domcontentloaded' as const, timeout: remaining(30000) };
        const selectedResponse = selectedUrl === previousUrl ? await page.reload(options) : await page.goto(selectedUrl, options);
        if (!selectedResponse?.ok()) throw new ProviderAccessDeniedError(this.name, 'www.google.com', selectedResponse?.status() ?? 0);
        await barrier();
        validateGoogleFlightsUrl(page.url(), input);
      };
      await barrier();
      validateGoogleFlightsUrl(page.url(), input);
      const chooseLeg = async (stage: 'outbound' | 'inbound') => {
        // Observed public UI: each flight option is an accessible link without
        // an href. The stage heading prevents reusing an old outbound option.
        const heading = page.getByRole('heading', { name: googleFlightsLegHeading(stage, !!input.returnDate) });
        await Promise.race([
          heading.waitFor({ state: 'visible', timeout: remaining(30000) }),
          page.waitForURL(url => url.hostname.startsWith('consent.google.') || /\/sorry\b/.test(url.pathname), { timeout: remaining(30000) })
            .then(() => { throw new ProviderAccessDeniedError(this.name, new URL(page.url()).hostname, 429); }),
        ]);
        await barrier();
        const card = page.getByRole('link', { name: /搭乘(?:台灣|臺灣|台湾)虎航的直達航班.*選擇航班/ }).first();
        await card.waitFor({ state: 'visible', timeout: remaining(20000) });
        console.log('[Google Flights] Selecting ' + stage + ' direct Tigerair flight');
        const previousUrl = page.url();
        await card.press('Enter', { timeout: remaining() });
        // At most one normal public GET per selected leg: initial search,
        // outbound-selected search, and (for a return trip) selected booking.
        await loadSelectedPermalink(previousUrl);
      };
      stage = 'outbound';
      await chooseLeg('outbound');
      if (input.returnDate) { stage = 'inbound'; await chooseLeg('inbound'); }
      stage = 'booking';
      await page.waitForURL(url => url.pathname === '/travel/flights/booking'
        || url.hostname.startsWith('consent.google.') || /\/sorry\b/.test(url.pathname), { timeout: remaining(30000) });
      await barrier();
      stage = 'seller';
      await page.getByText('透過Tigerair Taiwan預訂航空公司', { exact: true }).waitFor({ state: 'visible', timeout: remaining(20000) });
      const text = await barrier();
      stage = 'parse';
      const result = parseGoogleFlightsObservation({ url: page.url(), text, checkedAt: new Date().toISOString(), navigationStatus: documentStatus }, input);
      await this.options.onResult?.(page, result);
      return result;
    };
    try {
      return await Promise.race([collect(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Google Flights observation deadline exceeded. No price recorded.')), timeout);
      })]);
    } catch (error) {
      let failure = error;
      if (observedPage && !(error instanceof ProviderAccessDeniedError)) {
        const text = await observedPage.locator('body').innerText({ timeout: 500 }).catch(() => '');
        const blocked = googleFlightsPageBarrier(text, observedPage.url());
        if (blocked) failure = new ProviderAccessDeniedError(this.name, new URL(observedPage.url()).hostname, blocked === 'captcha' ? 429 : 403);
      }
      if (observedPage && this.options.onError) {
        let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
        // The hook receives only a bounded stage and the still-open public page;
        // raw errors, environment credentials and request payloads are not passed.
        await Promise.race([
          Promise.resolve().then(() => this.options.onError!(observedPage!, stage)),
          new Promise<void>(resolve => { diagnosticTimer = setTimeout(resolve, 4000); }),
        ]).catch(() => undefined).finally(() => clearTimeout(diagnosticTimer));
      }
      throw failure;
    } finally {
      clearTimeout(timer);
      if (browser) {
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([browser.close(), new Promise<void>(resolve => { closeTimer = setTimeout(resolve, 5000); })])
          .finally(() => clearTimeout(closeTimer));
      }
    }
  }
}
