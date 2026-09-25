import { chromium } from 'playwright';
console.log('[Container smoke] Xvfb ready; launching headed Chromium');
const browser = await chromium.launch({ headless: false, timeout: 20000 });
try {
  const page = await browser.newPage();
  await page.setContent('<title>Flight Monitor smoke</title><p>ready</p>');
  if (await page.title() !== 'Flight Monitor smoke') throw new Error('Browser smoke failed');
  console.log('[Container smoke] PASS: headed Chromium rendered a page');
} finally { await browser.close(); }
