import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import { sendGmail } from '../src/services/gmail.js';
import { z } from 'zod';
const to = z.string().email().parse(process.env.TEST_EMAIL_TO);
if (config.EMAIL_PROVIDER !== 'gmail' || config.EMAIL_MODE !== 'send') throw new Error('Set EMAIL_PROVIDER=gmail and EMAIL_MODE=send to explicitly enable this test');
await sendGmail(config.GMAIL_USER, config.GMAIL_APP_PASSWORD, to, {
  subject: 'Flight Monitor 測試通知：可以訂機票',
  text: '可以訂機票！\n\n這是寄信功能測試，不代表已查到優惠票價，也未代你訂票。\nhttps://wuharry.github.io/Flight-Price-Monitor/',
  html: '<p>可以訂機票！</p><p>這是寄信功能測試，不代表已查到優惠票價，也未代你訂票。</p>',
}, randomUUID());
console.log('Gmail 已接受測試信；請收件人確認收件匣及垃圾郵件。');
