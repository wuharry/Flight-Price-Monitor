const ACTIVE_STATUSES = new Set(['reserved', 'running']);

export function isActiveJob(job, now = Date.now()) {
  return !!job && ACTIVE_STATUSES.has(job.status) && Date.parse(job.expires_at) > now;
}

export function checkUnavailableReason(rule, today) {
  if (rule.provider !== 'google-flights') return '這是舊版行程，請複製為新行程後儲存，再使用雲端查價。';
  if (!rule.enabled) return '此行程已暫停，請先啟用。';
  if (rule.departure_date < today) return '出發日期已過，請先修改日期。';
  return '';
}

export function cloudErrorMessage(code) {
  const messages = {
    'unauthorized': '登入已過期，請重新登入後再查價。',
    'sign-in-required': '請先登入帳號，再使用雲端查價。',
    'account-not-allowed': '這個帳號尚未開通雲端查價，請聯絡管理員。',
    'origin-not-allowed': '目前的網站網址無法使用雲端查價，請由原本的網站連結重新開啟。',
    'not-allowed': '這個帳號尚未開通雲端查價，或行程已停用。請聯絡管理員。',
    'busy': '目前有一筆查價正在進行，請等完成後再試。',
    'cooldown': '請稍候 2 分鐘再查價，避免重複消耗免費額度。',
    'daily-limit': '今天的免費查價次數已用完，明天再來查價。',
    'monthly-limit': '本月的免費查價次數已用完，請等下個月再試。',
    'not-configured': '雲端查價尚未開通，請稍後再試或聯絡管理員。',
    'invalid-request': '查價要求無法使用，請重新整理行程後再試。',
    'unavailable': '雲端查價暫時無法使用，請稍後再試。',
    'cloud-start-rejected': '這次查價未能啟動，請稍後再試。',
    'dispatch-uncertain': '已送出查價要求，正在確認啟動狀態。請勿重複點擊。',
    'worker-failed': '這次查價未完成，請稍後再試。',
    'query-or-notification-failed': '查價或通知未完成，請查看票價紀錄，稍後再試。',
    'invalid-rule': '此行程無法查價，請確認日期與機場後重新儲存。',
    'expired': '這次查價等候逾時，尚未確認完成。請重新整理查看。',
  };
  const normalized = String(code || '').replace(/^cloud_check_/, '').replaceAll('_', '-');
  return messages[normalized] || '暫時無法啟動雲端查價。請稍後重新整理；若問題持續，請聯絡管理員。';
}

export function jobPresentation(job, now = Date.now()) {
  if (!job) return { tone: 'idle', title: '尚未查價', detail: '儲存行程後，按「立即查價」取得一次參考票價。' };
  if (ACTIVE_STATUSES.has(job.status)) {
    if (!isActiveJob(job, now)) return { tone: 'error', title: '查價等候逾時', detail: cloudErrorMessage('expired') };
    return { tone: 'pending', title: job.status === 'reserved' ? '已送出，等候查價' : '雲端查價中…', detail: '這一筆會在雲端繼續執行，關閉網頁也可以；稍後回來查看結果。' };
  }
  if (job.status !== 'succeeded') return { tone: 'error', title: '這次查價未完成', detail: cloudErrorMessage(job.error_code || job.status) };
  const price = Number(job.total_price);
  const title = Number.isFinite(price) && price > 0 ? `參考含稅總價 NT$ ${price.toLocaleString('zh-TW')}` : '查價完成';
  const detail = job.email_status === 'accepted'
    ? '通知已交給寄信服務。請查看收件匣與垃圾郵件；此狀態不代表已送達。'
    : job.email_status === 'preview'
      ? '查價完成；通知目前是預覽模式，沒有寄出郵件。'
      : job.email_status === 'not-triggered'
        ? '未觸發這次通知條件，沒有寄出郵件。'
        : '請查看票價紀錄與通知狀態。';
  return { tone: 'success', title, detail };
}

export function trustedGoogleBookingUrl(quote) {
  if (quote?.provider !== 'google-flights' || typeof quote.bookingUrl !== 'string') return null;
  try {
    const url = new URL(quote.bookingUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'www.google.com' || url.port || url.username || url.password ||
        !/^\/travel\/flights(?:\/|$)/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}
