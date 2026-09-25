import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

// Only inspect the public booking flow. Never log headers/cookies or solve challenges.
const { values } = parseArgs({ options: {
  origin: { type: 'string', default: 'TPE' },
  destination: { type: 'string', default: 'NRT' },
  departure: { type: 'string', default: '2027-02-10' },
  return: { type: 'string', default: '2027-02-16' },
  adults: { type: 'string', default: '1' },
  headed: { type: 'boolean', default: false },
  channel: { type: 'string' },
  seconds: { type: 'string', default: '25' },
  assets: { type: 'boolean', default: false },
} });

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key,
      /token|signature|password|authorization|cookie|email|phone|address|session|customer|contact|account/i.test(key)
        ? '[REDACTED]' : redact(item)]),
  );
  if (typeof value === 'string' && /^(Bearer |eyJ)/.test(value)) return '[REDACTED]';
  return value;
}

async function inspect() {
  const seconds = Number(values.seconds);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120) throw new Error('--seconds must be 1–120');
  const params = new URLSearchParams({ adult: values.adults!, children: '0', infant: '0',
    currencyCode: 'TWD', languageCode: 'zh-tw', type: values.return ? 'roundTrip' : 'oneWay',
    outbound: `${values.origin}-${values.destination}`, departureDate: values.departure! });
  if (values.return) { params.set('inbound', `${values.destination}-${values.origin}`); params.set('returnDate', values.return); }
  const directory = `artifacts/inspection-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await mkdir(directory, { recursive: true });
  const browser = await chromium.launch({ headless: !values.headed, channel: values.channel });
  const pending = new Set<Promise<void>>();
  let count = 0;
  try {
    const page = await browser.newPage();
    page.on('response', response => {
      const request = response.request();
      const url = new URL(response.url());
      if (!url.hostname.endsWith('.tigerairtw.com')) return;
      const json = ['xhr', 'fetch'].includes(request.resourceType()) && (response.headers()['content-type'] || '').includes('json');
      const asset = values.assets && request.resourceType() === 'script' && url.hostname === 'booking.tigerairtw.com' && !url.pathname.includes('vendor');
      if (!json && !asset) return;
      const job = (async () => {
        const id = String(++count).padStart(3, '0');
        console.log(`${response.status()} ${request.method()} ${url.origin}${url.pathname}`);
        if (asset) {
          await writeFile(`${directory}/${id}.js`, await response.body());
        } else {
          let payload: unknown;
          try { payload = request.postDataJSON(); } catch { payload = '(non-JSON omitted)'; }
          const body = await response.json();
          await writeFile(`${directory}/${id}.json`, JSON.stringify({ url: url.origin + url.pathname,
            method: request.method(), status: response.status(), request: redact(payload), response: redact(body) }, null, 2));
        }
      })().catch(error => console.warn('Response capture failed:', (error as Error).message));
      pending.add(job);
      void job.finally(() => pending.delete(job));
    });
    await page.goto(`https://booking.tigerairtw.com/?${params}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(seconds * 1000);
    await Promise.all(pending);
    await writeFile(`${directory}/page.txt`, await page.locator('body').innerText());
    await page.screenshot({ path: `${directory}/page.png`, fullPage: true });
    console.log(`Inspection saved to ${directory}`);
  } finally { await browser.close(); }
}

inspect().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
