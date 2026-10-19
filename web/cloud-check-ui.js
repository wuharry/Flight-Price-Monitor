const ACTIVE_STATUSES = new Set(['reserved', 'running']);

export function normalizeScheduleStatus(value) {
  if (!value || Array.isArray(value) || typeof value.enabled !== 'boolean' || typeof value.eligible !== 'boolean' ||
      value.timeZone !== 'Asia/Taipei' || value.windowStart !== '09:00' || value.windowEnd !== '09:20' ||
      value.eveningWindowStart !== '21:00' || value.eveningWindowEnd !== '21:20' ||
      ![1, 2].includes(value.checksPerRulePerDay) || value.scheduledDailyLimit !== 10 || value.manualDailyLimit !== 2) return null;
  return { enabled: value.enabled, eligible: value.eligible, timeZone: value.timeZone,
    windowStart: value.windowStart, windowEnd: value.windowEnd,
    eveningWindowStart: value.eveningWindowStart, eveningWindowEnd: value.eveningWindowEnd,
    checksPerRulePerDay: value.checksPerRulePerDay,
    scheduledDailyLimit: value.scheduledDailyLimit, manualDailyLimit: value.manualDailyLimit };
}

export function schedulePresentation(value) {
  const status = normalizeScheduleStatus(value);
  if (!status) return { mode: 'unknown', title: '每日自動查價狀態未知',
    detail: '暫時無法確認排程狀態，請重新整理；這不代表已啟用。仍可嘗試按「立即查價」，每按一次只查一次。' };
  if (!status.eligible) return { mode: 'not-eligible', title: '這個帳號尚未開通雲端查價',
    detail: '請聯絡管理員開通。儲存行程不會立即查價或寄信。' };
  if (!status.enabled) return { mode: 'disabled', title: '每日自動查價尚未啟用',
    detail: '目前請按「立即查價」取得一次參考價。儲存行程不會立即查價或寄信，請等待管理員完成排程啟用。' };
  return { mode: 'enabled', checksPerRulePerDay: status.checksPerRulePerDay,
    title: '每日自動查價已啟用｜早晚各一輪',
    detail: `台灣時間 09:00～09:20、21:00～21:20，每 5 分鐘輪流查一筆。目前每條每天最多 ${status.checksPerRulePerDay} 次；啟用超過 5 條時改每條每天最多 1 次，公平輪流。啟用並儲存後從下一輪安排，21:20 後新增從隔天早輪開始；電腦可以關機。當輪已手動查過的行程會略過自動查價。共用自動每日最多 10 次、額外手動 2 次，近 31 天合計最多 372 次；免費額度用完就停止。` };
}

export function isRuleScheduled(rule, status, today) {
  return schedulePresentation(status).mode === 'enabled' && !!rule && !checkUnavailableReason(rule, today);
}

export function savedRuleMessage(rule, status, today) {
  if (!rule.enabled) return '行程已儲存並停用；不會開始新的每日查價，已執行中的查詢仍會繼續。';
  const unavailable = checkUnavailableReason(rule, today);
  if (unavailable) return `行程已儲存。${unavailable}`;
  if (isRuleScheduled(rule, status, today)) return '行程已儲存並啟用，從下一輪安排雲端查價；21:20 後新增從隔天早輪開始。儲存不會立即寄信，也可按「立即查價」。';
  return `行程已儲存。${schedulePresentation(status).title}；儲存不會立即查價或寄信。`;
}

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
    'daily-limit': '今天的手動查價額度已用完，明天再試；這不表示每日自動查價已停用。',
    'manual-daily-limit': '今天的手動查價額度已用完，明天再試；這不表示每日自動查價已停用。',
    'monthly-limit': '近 31 天的手動或共用查價額度已達上限，暫時無法手動查價；請等較早的紀錄離開計算期間後再試。',
    'rolling-limit': '近 31 天的共用查價額度已用完，請等較早的紀錄離開計算期間後再試。',
    'rolling-month-limit': '近 31 天的共用查價額度已用完，請等較早的紀錄離開計算期間後再試。',
    'not-configured': '雲端查價尚未開通，請稍後再試或聯絡管理員。',
    'invalid-request': '查價要求無法使用，請重新整理行程後再試。',
    'unavailable': '雲端查價暫時無法使用，請稍後再試。',
    'cloud-start-rejected': '這次查價未能啟動，請稍後再試。',
    'dispatch-uncertain': '已送出查價要求，正在確認啟動狀態。請勿重複點擊。',
    'worker-failed': '這次查價未完成，請稍後再試。',
    'query-or-notification-failed': '查價或通知未完成，請查看票價紀錄，稍後再試。',
    'no-matching-itinerary': 'Google Flights 目前找不到指定日期／條件的虎航直飛報價；可稍後再查或自行調整日期。本次未取得或記錄票價，也未依此次報價產生新的通知。',
    'invalid-rule': '此行程無法查價，請確認日期與機場後重新儲存。',
    'expired': '這次查價等候逾時，尚未確認完成。請重新整理查看。',
  };
  const normalized = String(code || '').replace(/^cloud_check_/, '').replaceAll('_', '-');
  return messages[normalized] || '暫時無法啟動雲端查價。請稍後重新整理；若問題持續，請聯絡管理員。';
}

export function jobPresentation(job, now = Date.now(), { rule, schedule } = {}) {
  if (!job) {
    if (rule && !rule.enabled) return { tone: 'idle', title: '行程已暫停', detail: '此行程不會開始新的每日查價。重新啟用後，請確認上方排程狀態；已開始的查詢仍會繼續。' };
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date(now));
    if (isRuleScheduled(rule, schedule, today)) return { tone: 'idle', title: '等待每日查價',
      detail: '早輪 09:00～09:20、晚輪 21:00～21:20（台灣時間）；啟用並儲存後從下一輪安排。21:20 後新增從隔天早輪開始，也可按「立即查價」。' };
    return { tone: 'idle', title: '尚未查價', detail: rule && checkUnavailableReason(rule, today) || '請先確認上方排程狀態；也可按「立即查價」取得一次參考票價。' };
  }
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
