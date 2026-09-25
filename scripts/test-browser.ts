import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { TigerairProvider } from '../src/providers/tigerair.js';

const { values } = parseArgs({ options: {
  channel: { type: 'string', default: 'msedge' },
  headed: { type: 'boolean', default: false },
  adults: { type: 'string', default: '1' },
  'one-way': { type: 'boolean', default: false },
  interact: { type: 'boolean', default: false },
} });
const directory = `artifacts/browser-${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(directory, { recursive: true });
const provider = new TigerairProvider({
  channel: values.channel, headless: !values.headed,
  onError: async (page, error) => {
    await page.screenshot({ path: `${directory}/failure.png`, fullPage: true });
    await writeFile(`${directory}/failure.txt`, error.message + '\n' + await page.locator('body').innerText());
  },
  onResult: async (page, result) => {
    await page.getByText('選擇航班', { exact: true }).first().waitFor({ timeout: 15000 });
    const accept = page.getByRole('button', { name: '接受', exact: true });
    if (await accept.isVisible()) await accept.click();
    // Capture the rendered flight list before any optional fare-card interaction.
    await page.screenshot({ path: `${directory}/flights.png`, fullPage: true });
    const text = await page.locator('body').innerText();
    await writeFile(`${directory}/page.txt`, text);
    await writeFile(`${directory}/result.json`, JSON.stringify(result, null, 2));
    if (!text.includes(result.outboundPrice / result.adults >= 1000
        ? (result.outboundPrice / result.adults).toLocaleString('en-US') : String(result.outboundPrice / result.adults))) {
      throw new Error('Rendered outbound fare does not match API amount');
    }
    if (values.interact) {
      // Open the selected outbound fare card without continuing to passenger/payment steps.
      const flightLabel = result.legs[0].flightNumber.replace(/^([A-Z]+)(\d+)$/, '$1 $2');
      const card = page.locator('[data-e2e-test-id^="journey-0-itinerary-"]').filter({ hasText: flightLabel });
      await card.first().getByRole('button').click({ timeout: 10000 });
      await page.locator('[data-e2e-test-id="class-tigerLight"]').first().waitFor({ timeout: 10000 });
      await page.screenshot({ path: `${directory}/fare-options.png`, fullPage: true });
      await writeFile(`${directory}/fare-options.txt`, await page.locator('body').innerText());
    }
  },
});
try {
  const result = await provider.search({
    origin: 'TPE', destination: 'NRT', departureDate: '2027-02-10',
    returnDate: values['one-way'] ? undefined : '2027-02-16', adults: Number(values.adults), currency: 'TWD',
  });
  console.log(JSON.stringify({ status: 'PASS', total: result.totalPrice, tax: result.taxAndFees,
    adults: result.adults, flights: result.legs.map(leg => leg.flightNumber), artifacts: directory }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', error: (error as Error).message, artifacts: directory }, null, 2));
  process.exitCode = 1;
}
