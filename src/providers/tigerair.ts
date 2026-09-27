import { chromium, type Page, type Response } from 'playwright';
import { config } from '../config.js';
import type { FlightPriceResult, FlightSearch } from '../types/index.js';
import type { FlightProvider } from './base.js';
import { searchSchema, todayTaipei } from '../validation.js';
import { parseTigerairResponse } from './tigerair-parser.js';
import { getBookingUrl } from './tigerair-url.js';
import { isFareEndpoint, pageSignal } from './tigerair-diagnostics.js';

export interface BrowserOptions {
  channel?: string;
  headless?: boolean;
  timeoutMs?: number;
  onResult?: (page: Page, result: FlightPriceResult) => Promise<void>;
  onError?: (page: Page, error: Error) => Promise<void>;
}
export class TigerairProvider implements FlightProvider {
  name = 'tigerair';
  constructor(private options: BrowserOptions = {}) {}
  getBookingUrl = getBookingUrl;

  async search(search: FlightSearch): Promise<FlightPriceResult> {
    const input = searchSchema.parse(search);
    if (input.departureDate < todayTaipei()) throw new Error('Departure date is in the past');
    const timeout = this.options.timeoutMs ?? config.BROWSER_TIMEOUT_MS;
    const channel = this.options.channel ?? config.BROWSER_CHANNEL;
    console.log('[Browser] Launching browser');
    const browser = await chromium.launch({
      headless: this.options.headless ?? config.BROWSER_HEADLESS === 'true',
      channel: channel === 'chromium' ? undefined : channel,
      timeout,
    });
    let page: Page | undefined;
    console.log('[Browser] Browser launched');
    let quoteFound = false;
    const diagnostic = {
      navigationStatus: null as number | null, fareRequests: 0,
      fareStatuses: [] as number[], failedRequests: 0, pageErrors: 0,
      phase: 'navigation', signal: 'unknown',
    };
    try {
      const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
      page = await context.newPage();
      page.setDefaultTimeout(timeout);
      page.on('request', request => {
        if (isFareEndpoint(request.url())) diagnostic.fareRequests++;
      });
      page.on('response', response => {
        if (isFareEndpoint(response.url()) && diagnostic.fareStatuses.length < 20) diagnostic.fareStatuses.push(response.status());
      });
      page.on('requestfailed', () => { diagnostic.failedRequests++; });
      page.on('pageerror', () => { diagnostic.pageErrors++; });
      // Subscribe before navigation. Read the public site's own GraphQL response;
      // tokens stay in the isolated browser and are never persisted or replayed.
      const responsePromise = page.waitForResponse((response: Response) => {
        if (!isFareEndpoint(response.url())) return false;
        try { return response.request().postDataJSON()?.operationName === 'appFlightSearchResult'; }
        catch { return false; }
      }, { timeout });
      const [response] = await Promise.all([
        responsePromise,
        (async () => {
          console.log('[Browser] Opening booking page');
          const navigation = await page!.goto(getBookingUrl(input), { waitUntil: 'domcontentloaded', timeout });
          diagnostic.navigationStatus = navigation?.status() ?? null;
          diagnostic.phase = 'waiting-for-fare';
          if (navigation && !navigation.ok()) throw new Error(`Tigerair booking page rejected the request (HTTP ${navigation.status()}). No price recorded.`);
          // A slow body must not cancel an otherwise valid pending fare response.
          const text = await page!.locator('body').innerText({ timeout: 5000 }).catch(() => '');
          if (/Access Denied|You don't have permission to access/i.test(text)) {
            throw new Error('Tigerair booking page returned Access Denied. No price recorded.');
          }
        })(),
      ]);
      if (!response.ok()) throw new Error(`Tigerair fare HTTP ${response.status()}`);
      diagnostic.phase = 'parsing-fare';
      const result = parseTigerairResponse(await response.json(), input);
      quoteFound = true;
      await this.options.onResult?.(page, result);
      return result;
    } catch (error) {
      if (!quoteFound) {
        const text = page ? await page.locator('body').innerText({ timeout: 2000 }).catch(() => '') : '';
        diagnostic.signal = pageSignal(text);
        console.error('[Browser diagnostic]', JSON.stringify(diagnostic));
      }
      if (page) await this.options.onError?.(page, error as Error).catch(() => undefined);
      const message = (error as Error).message;
      if (!quoteFound && /Timeout|timeout/.test(message)) throw new Error(`Tigerair timed out during ${diagnostic.phase}; page signal=${diagnostic.signal}. See [Browser diagnostic]. No price recorded.`);
      throw error;
    } finally { await browser.close(); }
  }
}
