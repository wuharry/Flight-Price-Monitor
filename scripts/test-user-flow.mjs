import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const email = process.env.TEST_USER_EMAIL || 'wmh6227@gmail.com';
const password = process.env.TEST_USER_PASSWORD || 'V9!rK4#mT8@qN2$xP7';
const siteUrl = process.env.SITE_URL || 'https://wuharry.github.io/Flight-Price-Monitor/';
const artifactDir = resolve('artifacts/user-test');

await mkdir(artifactDir, { recursive: true });

console.log('啟動瀏覽器中 (Microsoft Edge)...');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const logs = [];
page.on('console', msg => logs.push(`[CONSOLE ${msg.type()}] ${msg.text()}`));
page.on('pageerror', err => logs.push(`[PAGEERROR] ${err.message}`));

try {
  console.log(`前往網站: ${siteUrl}...`);
  await page.goto(siteUrl, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${artifactDir}/01-landing.png`, fullPage: true });

  console.log(`嘗試登入帳號: ${email}...`);
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  await page.locator('#login').click();

  // 等待登入成功及 Dashboard 出現
  await page.waitForSelector('#dashboard:not([hidden])', { timeout: 15000 });
  const statusText = await page.locator('#status').textContent();
  console.log('登入結果狀態:', statusText?.trim());
  console.log('已登入信箱:', (await page.locator('#email').textContent())?.trim());
  await page.screenshot({ path: `${artifactDir}/02-dashboard.png`, fullPage: true });

  // 取得現有監控清單
  await page.waitForTimeout(1000);
  const ruleCards = page.locator('#rules .watch');
  const existingRulesCount = await ruleCards.count();
  console.log(`目前已有監控規則數量: ${existingRulesCount} 組`);

  // 測試情境：設定最容易過門檻的規則以利測試 Email 寄送功能
  // 目標含稅價設為 NT$ 50,000，確保爬蟲查到票價時必定符合條件 (實際價格 <= 目標價)
  if (existingRulesCount > 0) {
    console.log('點選第一筆既有規則進行編輯，將預算門檻調高為 50,000 元（極易達標）...');
    const firstEditBtn = ruleCards.first().locator('button:has-text("編輯")');
    await firstEditBtn.click();
    await page.waitForTimeout(500);

    // 修改目標含稅總價為 50000
    await page.locator('[name=target_price]').fill('50000');
    // 確保啟用中
    const enabledCheckbox = page.locator('[name=enabled]');
    if (!await enabledCheckbox.isChecked()) {
      await enabledCheckbox.check();
    }

    await page.screenshot({ path: `${artifactDir}/03-editing-threshold.png`, fullPage: true });
    console.log('點擊儲存監控規則...');
    await page.locator('#save-rule-btn').click();
    await page.waitForTimeout(2000);
    console.log('更新規則狀態:', (await page.locator('#status').textContent())?.trim());
    await page.screenshot({ path: `${artifactDir}/04-threshold-updated.png`, fullPage: true });
  }

  // 若規則少於 10 組，示範透過瀏覽器建立一組全新的極易過門檻測試規則 (單程或來回)
  if (existingRulesCount < 10) {
    console.log('建立一組容易過門檻的新監控航線 (TPE -> OKA 沖繩，目標價 NT$ 50,000)...');
    await page.locator('#reset-rule').click();
    await page.waitForTimeout(300);

    // 切換為單程機票更加簡化
    await page.locator('#btn-trip-oneway').click();
    await page.locator('[name=origin]').fill('TPE');
    await page.locator('[name=destination]').fill('OKA');
    await page.locator('[name=departure_date]').fill('2026-11-10');
    await page.locator('[name=adults]').fill('1');
    await page.locator('[name=target_price]').fill('50000');

    // 展開進階選項面板填寫新低天數
    const details = page.locator('details.advanced-panel');
    if (!await page.locator('[name=new_low_days]').isVisible()) {
      await details.locator('summary').click();
      await page.waitForTimeout(200);
    }
    await page.locator('[name=new_low_days]').fill('30');

    await page.screenshot({ path: `${artifactDir}/05-new-easy-rule.png`, fullPage: true });
    await page.locator('#save-rule-btn').click();
    await page.waitForTimeout(2000);
    console.log('新增規則狀態:', (await page.locator('#status').textContent())?.trim());
    await page.screenshot({ path: `${artifactDir}/06-new-rule-saved.png`, fullPage: true });
  }

  // 檢視最終 Dashboard 狀態
  const finalRulesCount = await page.locator('#rules .watch').count();
  console.log(`操作完成！最終監控規則總數: ${finalRulesCount} 組`);
  await page.screenshot({ path: `${artifactDir}/07-final-dashboard.png`, fullPage: true });

  console.log('✅ 瀏覽器操作測試全部完成！截圖已存至 ' + artifactDir);

} catch (err) {
  console.error('執行過程中發生錯誤:', err);
  await page.screenshot({ path: `${artifactDir}/error.png`, fullPage: true });
} finally {
  await browser.close();
}
