import { config } from '../config.js';
import type { AlertRecord } from '../types/index.js';
import { sendGmail, type GmailFactory } from './gmail.js';
export interface NotificationSender { send(alert: AlertRecord): Promise<'sent' | 'preview'> }
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function renderEmail(alert: AlertRecord) {
  const { rule, result, trigger } = alert.payload;
  const subject = `✈ ${rule.provider} ${rule.origin} → ${rule.destination} NT$${result.totalPrice.toLocaleString('zh-TW')}`;
  const text = [
    trigger.reason, '',
    `航線：${rule.origin} → ${rule.destination}`,
    `日期：${rule.departureDate}${rule.returnDate ? ' ～ ' + rule.returnDate : '（單程）'}`,
    `旅客：${rule.adults} 位成人，以下為所有旅客合計`,
    `去程未稅：NT$${result.outboundPrice}`,
    ...(result.inboundPrice !== undefined ? [`回程未稅：NT$${result.inboundPrice}`] : []),
    `稅費：NT$${result.taxAndFees}`, `含稅總價：NT$${result.totalPrice}`,
    ...result.legs.map(leg => `${leg.flightNumber} ${leg.departureTime} ${leg.origin} → ${leg.destination}`),
    '票價方案：tigerLight；未含付款手續費、加購行李、餐點與選位。',
    `查詢時間：${result.checkedAt}；價格與座位以航空公司結帳頁為準。`,
    '', `查看航班：${result.bookingUrl}`,
  ].join('\n');
  return { subject, text, html: `<div style="font:16px/1.7 sans-serif;max-width:620px;margin:auto"><h2>${escapeHtml(subject)}</h2><p style="white-space:pre-line">${escapeHtml(text)}</p><a href="${escapeHtml(result.bookingUrl)}">前往航空公司查詢</a></div>` };
}
export class EmailService implements NotificationSender {
  constructor(private options = config, private request: typeof fetch = fetch,
    private recipient?: (alert: AlertRecord) => Promise<string>, private gmailFactory?: GmailFactory) {}
  async send(alert: AlertRecord): Promise<'sent' | 'preview'> {
    const message = renderEmail(alert);
    if (this.options.EMAIL_MODE === 'preview') {
      console.log('[Email preview — not sent]\n' + message.subject + '\n' + message.text);
      return 'preview';
    }
    const to = alert.payload.rule.userId ? await this.recipient?.(alert) : this.options.NOTIFICATION_TO_EMAIL;
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('No verified recipient for this monitoring rule');
    if (this.options.EMAIL_PROVIDER === 'gmail') {
      await sendGmail(this.options.GMAIL_USER, this.options.GMAIL_APP_PASSWORD, to, message, alert.id, this.gmailFactory);
      console.log('[Email] Gmail accepted alert ' + alert.id);
      return 'sent';
    }
    const response = await this.request('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${this.options.RESEND_API_KEY}`, 'Content-Type': 'application/json',
        'Idempotency-Key': `flight-alert/${alert.id}` },
      body: JSON.stringify({ from: this.options.NOTIFICATION_FROM_EMAIL, to: [to], ...message }),
    });
    const body = await response.json() as { id?: string; message?: string; error?: unknown };
    if (!response.ok || body.error || !body.id) throw new Error(`Resend delivery failed (HTTP ${response.status})`);
    console.log('[Email] Delivered alert ' + alert.id);
    return 'sent';
  }
}
