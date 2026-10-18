import { config } from '../config.js';
import type { AlertRecord, FlightPriceResult } from '../types/index.js';
import { sendGmail, type GmailFactory } from './gmail.js';
export interface NotificationSender { send(alert: AlertRecord): Promise<'sent' | 'preview'> }
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export interface EmailReceipt {
  provider: 'gmail' | 'resend';
  messageId: string;
  /** The submission service accepted the message; inbox delivery is not confirmed. */
  accepted: true;
}
function renderPriceMessage(result: FlightPriceResult, reason: string, subject: string) {
  const google = result.priceBasis === 'google-flights-tigerair-reference-including-tax-v1';
  const pricing = google ? [
    'Google Flights 虎航參考價',
    '售票方（seller）：Tigerair Taiwan',
    `含稅參考總價：NT$${result.totalPrice.toLocaleString('zh-TW')}`,
    'Google Flights 未提供未稅票價與稅費拆分；未驗證 tigerLight 票價方案。',
    ...result.legs.map(leg => `${leg.requestedDate} ${leg.origin} → ${leg.destination}${leg.flightNumber ? ' ' + leg.flightNumber : ''}；出發 ${leg.departureTimeLabel}／抵達 ${leg.arrivalTimeLabel}`),
    '此為 Google Flights 所選行程的航空公司參考報價；合作夥伴資訊可能有最多 24 小時延遲。',
    'Google 頁面未獨立驗證行程年份；請在訂票頁確認完整日期、行李與付款條件。',
  ] : [
    `去程未稅：NT$${result.outboundPrice}`,
    ...(result.inboundPrice !== undefined ? [`回程未稅：NT$${result.inboundPrice}`] : []),
    `稅費：NT$${result.taxAndFees}`, `含稅總價：NT$${result.totalPrice}`,
    ...result.legs.map(leg => `${leg.flightNumber} ${leg.departureTime} ${leg.origin} → ${leg.destination}`),
    '票價方案：tigerLight；未含付款手續費、加購行李、餐點與選位。',
  ];
  const text = [
    reason, '',
    `航線：${result.origin} → ${result.destination}`,
    `日期：${result.departureDate}${result.returnDate ? ' ～ ' + result.returnDate : '（單程）'}`,
    `旅客：${result.adults} 位成人，以下為所有旅客合計`,
    ...pricing,
    `查詢時間：${result.checkedAt}；價格與座位以航空公司結帳頁為準。`,
    '', `查看航班：${result.bookingUrl}`,
  ].join('\n');
  return { subject, text, html: `<div style="font:16px/1.7 sans-serif;max-width:620px;margin:auto"><h2>${escapeHtml(subject)}</h2><p style="white-space:pre-line">${escapeHtml(text)}</p><a href="${escapeHtml(result.bookingUrl)}">${google ? '查看 Google Flights 參考報價' : '前往航空公司查詢'}</a></div>` };
}
export function renderEmail(alert: AlertRecord) {
  const { rule, result, trigger } = alert.payload;
  const provider = result.priceBasis === 'google-flights-tigerair-reference-including-tax-v1' ? 'Google Flights 虎航參考價' : rule.provider;
  const subject = `✈ ${provider} ${rule.origin} → ${rule.destination} NT$${result.totalPrice.toLocaleString('zh-TW')}`;
  return renderPriceMessage(result, trigger.reason, subject);
}
export class EmailService implements NotificationSender {
  private receipt: Readonly<EmailReceipt> | undefined;
  get lastReceipt(): Readonly<EmailReceipt> | undefined { return this.receipt; }
  constructor(private options = config, private request: typeof fetch = fetch,
    private recipient?: (alert: AlertRecord) => Promise<string>, private gmailFactory?: GmailFactory) {}
  async send(alert: AlertRecord): Promise<'sent' | 'preview'> {
    this.receipt = undefined;
    const message = renderEmail(alert);
    const to = this.options.EMAIL_MODE === 'preview' ? undefined :
      alert.payload.rule.userId ? await this.recipient?.(alert) : this.options.NOTIFICATION_TO_EMAIL;
    return this.sendMessage(message, alert.id, to);
  }
  async sendPriceTest(result: FlightPriceResult, id: string): Promise<'sent' | 'preview'> {
    this.receipt = undefined;
    const shortId = id.replace(/[^a-z0-9]/gi, '').slice(0, 8);
    if (shortId.length !== 8) throw new Error('Price test requires a unique ID of at least eight letters or digits');
    const provider = result.priceBasis === 'google-flights-tigerair-reference-including-tax-v1' ? 'Google Flights 虎航參考價' : result.provider;
    const subject = `Flight Monitor 查價與寄信測試 ${shortId}：${provider} ${result.origin} → ${result.destination} NT$${result.totalPrice.toLocaleString('zh-TW')}`;
    const message = renderPriceMessage(result,
      '這是實際查價與寄信測試，不代表符合監控門檻或已訂票。寄信服務接受郵件後，仍需由收件人確認收件匣及垃圾郵件。', subject);
    return this.sendMessage(message, id, this.options.NOTIFICATION_TO_EMAIL);
  }
  private async sendMessage(message: ReturnType<typeof renderPriceMessage>, id: string, to?: string): Promise<'sent' | 'preview'> {
    if (this.options.EMAIL_MODE === 'preview') {
      console.log('[Email preview — not sent]\n' + message.subject + '\n' + message.text);
      return 'preview';
    }
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('No verified recipient for this monitoring rule');
    if (this.options.EMAIL_PROVIDER === 'gmail') {
      const messageId = await sendGmail(this.options.GMAIL_USER, this.options.GMAIL_APP_PASSWORD, to, message, id,
        { fromName: this.options.EMAIL_FROM_NAME, replyTo: this.options.EMAIL_REPLY_TO || undefined, factory: this.gmailFactory });
      // Acceptance by the submission server is not delivery; the ID is what a recipient's mail
      // admin needs to find the message in a quarantine.
      this.receipt = Object.freeze({ provider: 'gmail', messageId, accepted: true });
      console.log('[Email] Gmail accepted message ' + id + ' as ' + messageId);
      return 'sent';
    }
    let response: Response;
    try { response = await this.request('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${this.options.RESEND_API_KEY}`, 'Content-Type': 'application/json',
        'Idempotency-Key': `flight-alert/${id}` },
      body: JSON.stringify({ from: this.options.NOTIFICATION_FROM_EMAIL, to: [to], ...message,
        ...(this.options.EMAIL_REPLY_TO ? { reply_to: this.options.EMAIL_REPLY_TO } : {}) }),
    }); } catch { throw new Error('Resend request failed before acceptance was confirmed'); }
    let body: { id?: string; error?: unknown };
    try { body = await response.json() as typeof body; }
    catch { throw new Error(`Resend returned an invalid response (HTTP ${response.status})`); }
    if (!response.ok || !body || typeof body !== 'object' || body.error || !body.id) throw new Error(`Resend delivery failed (HTTP ${response.status})`);
    const messageId = typeof body.id === 'string' && /^[a-z0-9_-]{1,128}$/i.test(body.id) ? body.id : '[unavailable]';
    this.receipt = Object.freeze({ provider: 'resend', messageId, accepted: true });
    console.log('[Email] Resend accepted message ' + id);
    return 'sent';
  }
}
