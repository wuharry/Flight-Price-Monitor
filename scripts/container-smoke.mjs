import { chromium } from 'playwright-core';
console.log('[Container smoke] Launching Chromium in headless=new mode, no display server');
const browser = await chromium.launch({ headless: false, args: ['--headless=new'], timeout: 20000 });
try {
  const page = await browser.newPage();
  await page.setContent('<title>Flight Monitor smoke</title><p>ready</p>');
  if (await page.title() !== 'Flight Monitor smoke') throw new Error('Browser smoke failed');
  console.log('[Container smoke] PASS: Chromium rendered a page without Xvfb');
} finally { await browser.close(); }
