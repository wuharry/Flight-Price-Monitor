import { createClient } from '@supabase/supabase-js';

const client = createClient(__SUPABASE_URL__, __SUPABASE_KEY__);
const $ = s => document.querySelector(s);
const form = $('#rule-form');
let user = null, rules = [], recovery = false, generation = 0, currentFilterRuleId = null;
let noticeTimer = null;
let historyRequest = 0;
const redirect = new URL('./', location.href).href;

function todayTaipei() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
}

function syncDateLimits() {
  const departure = form.elements.departure_date;
  const returning = form.elements.return_date;
  departure.min = todayTaipei();
  returning.min = departure.value || departure.min;
}

const AIRPORTS = {
  'TPE': { city: '台北', name: '桃園國際機場', short: '台北/桃園' },
  'TSA': { city: '台北', name: '松山機場', short: '台北/松山' },
  'KHH': { city: '高雄', name: '小港國際機場', short: '高雄' },
  'RMQ': { city: '台中', name: '清泉崗機場', short: '台中' },
  'NRT': { city: '東京', name: '成田國際機場', short: '東京/成田' },
  'HND': { city: '東京', name: '羽田機場', short: '東京/羽田' },
  'KIX': { city: '大阪', name: '關西國際機場', short: '大阪/關西' },
  'OKA': { city: '沖繩', name: '那霸機場', short: '沖繩/那霸' },
  'FUK': { city: '福岡', name: '福岡機場', short: '福岡' },
  'NGO': { city: '名古屋', name: '中部國際機場', short: '名古屋' },
  'CTS': { city: '札幌', name: '新千歲機場', short: '札幌/新千歲' },
  'SDJ': { city: '仙台', name: '仙台機場', short: '仙台' },
  'HKD': { city: '函館', name: '函館機場', short: '函館' },
  'OKJ': { city: '岡山', name: '岡山機場', short: '岡山' },
  'IBR': { city: '茨城', name: '茨城機場', short: '茨城' },
  'AKJ': { city: '旭川', name: '旭川機場', short: '旭川' },
  'KCZ': { city: '高知', name: '高知龍馬機場', short: '高知' },
  'KIJ': { city: '新潟', name: '新潟機場', short: '新潟' },
  'AXT': { city: '秋田', name: '秋田機場', short: '秋田' },
  'KMQ': { city: '小松', name: '小松機場', short: '小松' },
  'HSG': { city: '佐賀', name: '佐賀機場', short: '佐賀' },
  'HNA': { city: '花卷', name: '花卷機場', short: '花卷' },
  'KMI': { city: '宮崎', name: '宮崎機場', short: '宮崎' },
  'FKS': { city: '福島', name: '福島機場', short: '福島' },
  'ICN': { city: '首爾', name: '仁川國際機場', short: '首爾/仁川' },
  'GMP': { city: '首爾', name: '金浦國際機場', short: '首爾/金浦' },
  'PUS': { city: '釜山', name: '金海國際機場', short: '釜山' },
  'TAE': { city: '大邱', name: '大邱國際機場', short: '大邱' },
  'CJU': { city: '濟州', name: '濟州國際機場', short: '濟州' },
  'DMK': { city: '曼谷', name: '廊曼國際機場', short: '曼谷/廊曼' },
  'BKK': { city: '曼谷', name: '蘇凡納布機場', short: '曼谷/素萬那普' },
  'HKT': { city: '普吉島', name: '普吉國際機場', short: '普吉島' },
  'DAD': { city: '峴港', name: '峴港國際機場', short: '峴港' },
  'PQC': { city: '富國島', name: '富國國際機場', short: '富國島' },
  'MFM': { city: '澳門', name: '澳門國際機場', short: '澳門' }
};

function getAirportLabel(code) {
  const upper = (code || '').toUpperCase();
  const item = AIRPORTS[upper];
  return item ? `${item.short} (${upper})` : upper;
}

function notice(message, error = false) {
  const el = $('#status');
  el.textContent = message;
  el.className = error ? 'error' : '';
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    if (el.textContent === message) {
      el.textContent = '';
      el.className = '';
    }
  }, error ? 6000 : 4500);
}

function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined && text !== '') el.textContent = text;
  if (className) el.className = className;
  return el;
}

async function action(button, fn) {
  if (button) button.disabled = true;
  try {
    await fn();
  } catch (e) {
    notice(e.message || '操作失敗，請稍後再試', true);
  } finally {
    if (button) button.disabled = false;
  }
}

function check(result) {
  if (result.error) throw result.error;
  return result.data;
}

function initDatalists() {
  const origins = $('#origins-datalist');
  const dests = $('#destinations-datalist');
  if (origins && dests) {
    origins.replaceChildren();
    dests.replaceChildren();
    for (const [code, info] of Object.entries(AIRPORTS)) {
      const opt = document.createElement('option');
      opt.value = code;
      opt.label = `${info.short} (${info.name})`;
      if (['TPE', 'KHH', 'RMQ', 'TSA'].includes(code)) origins.append(opt);
      else dests.append(opt);
    }
  }
}

function updateAirportBadges() {
  const originVal = (form.elements.origin.value || '').toUpperCase();
  const destVal = (form.elements.destination.value || '').toUpperCase();
  const origEl = $('#origin-resolved');
  const destEl = $('#dest-resolved');
  if (origEl) origEl.textContent = getAirportLabel(originVal);
  if (destEl) destEl.textContent = getAirportLabel(destVal);
}

function updatePriceHint() {
  const price = Number(form.elements.target_price.value);
  const adults = Number(form.elements.adults.value) || 1;
  const calcEl = $('#target-price-calc');
  if (!calcEl) return;
  if (price > 0 && adults > 1) {
    calcEl.textContent = `💡 全部 ${adults} 位成人含稅總額（平均每位成人約 NT$ ${Math.round(price / adults).toLocaleString('zh-TW')}）`;
  } else if (price > 0) {
    calcEl.textContent = `💡 排程查得含稅總價不超過 NT$ ${price.toLocaleString('zh-TW')} 時符合通知條件`;
  } else {
    calcEl.textContent = '選填；未設預算時，依下方勾選的新低或降價條件通知';
  }
}

function setTripType(type) {
  form.elements.return_date.required = type !== 'oneway';
  $('#btn-trip-round')?.setAttribute('aria-pressed', String(type !== 'oneway'));
  $('#btn-trip-oneway')?.setAttribute('aria-pressed', String(type === 'oneway'));
  const roundBtn = $('#btn-trip-round');
  const onewayBtn = $('#btn-trip-oneway');
  const returnWrap = $('#return-date-wrap');
  const durationWrap = $('#duration-chips-wrap');
  if (type === 'oneway') {
    if (onewayBtn) onewayBtn.classList.add('active');
    if (roundBtn) roundBtn.classList.remove('active');
    if (returnWrap) returnWrap.hidden = true;
    if (durationWrap) durationWrap.hidden = true;
    form.elements.return_date.value = '';
    form.elements.return_date.required = false;
  } else {
    if (roundBtn) roundBtn.classList.add('active');
    if (onewayBtn) onewayBtn.classList.remove('active');
    if (returnWrap) returnWrap.hidden = false;
    if (durationWrap) durationWrap.hidden = false;
  }
}

function getBookingUrl(r) {
  const params = new URLSearchParams({
    adult: String(r.adults || 1),
    children: '0',
    infant: '0',
    currencyCode: r.currency || 'TWD',
    languageCode: 'zh-tw',
    type: r.return_date ? 'roundTrip' : 'oneWay',
    outbound: `${r.origin}-${r.destination}`,
    departureDate: r.departure_date,
  });
  if (r.return_date) {
    params.set('inbound', `${r.destination}-${r.origin}`);
    params.set('returnDate', r.return_date);
  }
  return `https://booking.tigerairtw.com/?${params}`;
}

function resetRule() {
  form.reset();
  form.elements.id.value = '';
  form.elements.origin.value = 'TPE';
  form.elements.destination.value = 'NRT';
  form.elements.adults.value = '1';
  form.elements.new_low_days.value = '30';
  form.elements.notify_new_low.checked = true;
  form.elements.enabled.checked = true;
  $('#editor-title').textContent = '新增監控';
  const cancelBtn = $('#cancel-edit-btn');
  if (cancelBtn) cancelBtn.hidden = true;
  $('#reset-rule').textContent = '新增另一條';
  setTripType('round');
  syncDateLimits();
  updateAirportBadges();
  updatePriceHint();
  document.querySelectorAll('.watch.editing-watch').forEach(el => el.classList.remove('editing-watch'));
}

async function history(ruleId) {
  const version = generation;
  const request = ++historyRequest;
  currentFilterRuleId = ruleId || null;
  let query = client.from('price_history').select('id,watch_rule_id,price,currency,checked_at,result').order('checked_at', { ascending: false }).limit(100);
  if (ruleId) query = query.eq('watch_rule_id', ruleId);
  const result = await query;
  if (version !== generation || request !== historyRequest || !user) return;
  const data = check(result);

  const targetRule = ruleId ? rules.find(r => r.id === ruleId) : null;
  const historyTitle = $('#history-title');
  const clearBtn = $('#clear-history-filter');
  if (targetRule) {
    historyTitle.textContent = `${getAirportLabel(targetRule.origin)} ➔ ${getAirportLabel(targetRule.destination)} 票價紀錄`;
    if (clearBtn) clearBtn.hidden = false;
  } else {
    historyTitle.textContent = '最近票價';
    if (clearBtn) clearBtn.hidden = true;
  }

  // Highlight selected card
  document.querySelectorAll('.watch').forEach(el => {
    if (ruleId && el.dataset.id === ruleId) el.classList.add('selected-watch');
    else el.classList.remove('selected-watch');
  });

  $('#history').replaceChildren();
  if (!data.length) {
    const tr = node('tr', '');
    const td = node('td', '還沒有票價紀錄。背景排程查價完成後，請按重新整理查看。', 'empty');
    td.colSpan = 3;
    tr.append(td);
    $('#history').append(tr);
    return;
  }

  for (const row of data) {
    const rule = row.result || rules.find(r => r.id === row.watch_rule_id);
    const tr = node('tr', '');
    const routeText = rule ? `${getAirportLabel(rule.origin)} ➔ ${getAirportLabel(rule.destination)}` : '航班';
    const dateText = new Date(row.checked_at).toLocaleString('zh-TW', { hour12: false });
    const priceText = `NT$ ${Number(row.price).toLocaleString('zh-TW')}`;

    const tdRoute = node('td', routeText);
    const tdTime = node('td', dateText);
    const tdPrice = node('td', priceText, 'price-cell');
    tr.append(tdRoute, tdTime, tdPrice);
    $('#history').append(tr);
  }
}

async function load() {
  if (!user) return;
  const version = generation;
  const data = check(await client.from('watch_rules').select('*').order('created_at', { ascending: false }).limit(10));
  if (version !== generation || !user) return;
  rules = data;

  $('#total').textContent = rules.length;
  $('#active').textContent = rules.filter(r => r.enabled).length;
  const countBadge = $('#list-count-badge');
  if (countBadge) countBadge.textContent = `已監控 ${rules.length} / 10 組`;

  $('#rules').replaceChildren();
  if (!rules.length) {
    $('#rules').append(node('p', '還沒有監控航線。\n請填寫右側表單，立即開始追蹤您的第一段旅程！', 'empty'));
  }

  for (const r of rules) {
    const card = node('article', '', `watch ${r.enabled ? 'is-active' : 'is-paused'}`);
    card.dataset.id = r.id;
    if (currentFilterRuleId === r.id) card.classList.add('selected-watch');

    // Header
    const header = node('div', '', 'watch-header');
    const titleGroup = node('div', '', 'watch-title-group');
    const routeSpan = node('span', '', 'watch-route');
    routeSpan.append(
      node('span', getAirportLabel(r.origin)),
      node('span', '✈', 'watch-route-arrow'),
      node('span', getAirportLabel(r.destination))
    );
    titleGroup.append(routeSpan);

    const badge = node('span', r.enabled ? '● 監控中' : '○ 已暫停', `badge ${r.enabled ? 'badge-active' : 'badge-paused'}`);
    header.append(titleGroup, badge);

    // Details List
    const details = node('div', '', 'watch-details-list');

    // Date row
    const dateRow = node('div', '', 'watch-detail-row');
    const dateIcon = node('span', '🗓', 'watch-detail-icon');
    let dateStr = r.departure_date;
    if (r.return_date) {
      dateStr += ` ～ ${r.return_date}`;
      const d1 = new Date(r.departure_date + 'T00:00:00Z');
      const d2 = new Date(r.return_date + 'T00:00:00Z');
      const diffDays = Math.round((d2 - d1) / (1000 * 60 * 60 * 24)) + 1;
      dateStr += ` (${diffDays}天)`;
    } else {
      dateStr += ' (單程)';
    }
    dateRow.append(dateIcon, node('span', dateStr));

    // Passenger & Budget row
    const paxRow = node('div', '', 'watch-detail-row');
    const paxIcon = node('span', '👤', 'watch-detail-icon');
    let paxText = `${r.adults} 位成人`;
    paxRow.append(paxIcon, node('span', paxText));

    const priceRow = node('div', '', 'watch-detail-row');
    const priceIcon = node('span', '🎯', 'watch-detail-icon');
    let priceText = r.target_price == null ? '未設預算目標' : `目標 NT$ ${Number(r.target_price).toLocaleString('zh-TW')}`;
    if (r.target_price && r.adults > 1) {
      priceText += ` (平均每人約 NT$ ${Math.round(r.target_price / r.adults).toLocaleString('zh-TW')})`;
    }
    priceRow.append(priceIcon, node('span', priceText, r.target_price ? 'watch-target-tag' : ''));

    details.append(dateRow, paxRow, priceRow);

    // Conditions row
    const conditionsRow = node('div', '', 'watch-conditions-row');
    if (r.notify_new_low) {
      conditionsRow.append(node('span', `📉 ${r.new_low_days || 30} 天新低通知`, 'condition-pill'));
    }
    if (r.drop_amount) {
      conditionsRow.append(node('span', `降價達 NT$ ${Number(r.drop_amount).toLocaleString('zh-TW')} 通知`, 'condition-pill'));
    }
    if (r.drop_percent) {
      conditionsRow.append(node('span', `降幅達 ${r.drop_percent}% 通知`, 'condition-pill'));
    }

    // Actions
    const buttons = node('div', '', 'actions');
    const edit = node('button', '編輯', 'secondary');
    edit.type = 'button';
    edit.onclick = () => {
      resetRule();
      card.classList.add('editing-watch');
      for (const [k, v] of Object.entries(r)) {
        const input = form.elements.namedItem(k);
        if (input) {
          if (input.type === 'checkbox') input.checked = !!v;
          else input.value = v ?? '';
        }
      }
      setTripType(r.return_date ? 'round' : 'oneway');
      syncDateLimits();
      $('#editor-title').textContent = `編輯監控：${r.origin} ➔ ${r.destination}`;
      const cancelBtn = $('#cancel-edit-btn');
      if (cancelBtn) cancelBtn.hidden = false;
      $('#reset-rule').textContent = '取消編輯';
      updateAirportBadges();
      updatePriceHint();
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    const view = node('button', '票價紀錄', 'secondary');
    view.type = 'button';
    view.onclick = () => action(view, () => history(r.id));

    const toggle = node('button', r.enabled ? '停用' : '啟用', 'secondary');
    toggle.type = 'button';
    toggle.onclick = () => action(toggle, async () => {
      const changed = check(await client.from('watch_rules').update({ enabled: !r.enabled }).eq('id', r.id).select('id').single());
      if (changed) {
        if (form.elements.id.value === r.id) form.elements.enabled.checked = !r.enabled;
        await load();
        notice(r.enabled ? '已暫停該航線監控' : '已啟用該航線監控');
      }
    });

    const remove = node('button', '刪除', 'danger');
    remove.type = 'button';
    remove.onclick = () => {
      if (!confirm(`確定要刪除「${getAirportLabel(r.origin)} ➔ ${getAirportLabel(r.destination)}」的監控規則及其所有歷史紀錄？`)) return;
      action(remove, async () => {
        check(await client.from('watch_rules').delete().eq('id', r.id).select('id').single());
        if (form.elements.id.value === r.id) resetRule();
        if (currentFilterRuleId === r.id) currentFilterRuleId = null;
        await load();
        notice('已成功刪除監控規則');
      });
    };

    // Tigerair Official Booking Link
    const bookLink = node('a', '官網查價 ↗', 'airline-link-btn');
    bookLink.href = getBookingUrl(r);
    bookLink.target = '_blank';
    bookLink.rel = 'noopener noreferrer';
    bookLink.title = '直接前往台灣虎航官網查看此航班即時票價';

    buttons.append(edit, view, toggle, remove, bookLink);
    card.append(header, details);
    if (conditionsRow.children.length) card.append(conditionsRow);
    card.append(buttons);
    $('#rules').append(card);
  }

  await history(currentFilterRuleId);
}

async function showSession(session, event) {
  generation++;
  historyRequest++;
  currentFilterRuleId = null;
  user = session?.user || null;
  if (event === 'PASSWORD_RECOVERY') recovery = true;
  if (!user) recovery = false;

  $('#auth').hidden = !!user;
  $('#dashboard').hidden = !user || recovery;
  $('#recovery').hidden = !recovery;
  $('#account').hidden = !user;

  $('#email').textContent = user?.email || '';
  $('#recipient').textContent = user?.email || '';

  rules = [];
  $('#rules').replaceChildren();
  $('#history').replaceChildren();
  resetRule();

  if (user && !recovery) {
    try {
      await load();
    } catch (e) {
      notice('無法讀取監控：' + e.message + '。若剛完成部署，請確認管理員已執行 multi-user.sql。', true);
    }
  }
}

// Authentication Listeners
client.auth.onAuthStateChange((event, session) => {
  if (event !== 'TOKEN_REFRESHED') setTimeout(() => showSession(session, event), 0);
});

$('#auth-form').onsubmit = e => {
  e.preventDefault();
  action($('#login'), async () => {
    check(await client.auth.signInWithPassword({
      email: $('#login-email').value.trim(),
      password: $('#login-password').value
    }));
    $('#login-password').value = '';
    notice('歡迎回來！登入成功');
  });
};

$('#signup').onclick = () => {
  if (!$('#auth-form').reportValidity()) return;
  action($('#signup'), async () => {
    const data = check(await client.auth.signUp({
      email: $('#login-email').value.trim(),
      password: $('#login-password').value,
      options: { emailRedirectTo: redirect }
    }));
    $('#login-password').value = '';
    notice(data.session ? '註冊成功！已自動登入' : '註冊成功！請至信箱收取驗證連結，驗證後即可登入開始監控。');
  });
};

$('#forgot').onclick = () => {
  if (!$('#login-email').reportValidity()) return;
  action($('#forgot'), async () => {
    check(await client.auth.resetPasswordForEmail($('#login-email').value.trim(), { redirectTo: redirect }));
    notice('重設密碼信件已寄出，請查收您的 Email 信箱。');
  });
};

$('#password-form').onsubmit = e => {
  e.preventDefault();
  action(e.submitter, async () => {
    check(await client.auth.updateUser({ password: $('#new-password').value }));
    $('#new-password').value = '';
    recovery = false;
    await showSession((await client.auth.getSession()).data.session);
    notice('密碼已成功更新！');
  });
};

$('#logout').onclick = () => action($('#logout'), async () => {
  check(await client.auth.signOut());
  notice('已成功登出');
});

$('#refresh').onclick = () => action($('#refresh'), async () => {
  await load();
  notice('已更新最新監控與票價資料');
});

$('#reset-rule').onclick = resetRule;

const cancelEditBtn = $('#cancel-edit-btn');
if (cancelEditBtn) cancelEditBtn.onclick = resetRule;

const clearHistoryBtn = $('#clear-history-filter');
if (clearHistoryBtn) {
  clearHistoryBtn.onclick = () => action(clearHistoryBtn, () => history(null));
}

// UI Interactive Helpers
initDatalists();
updateAirportBadges();

form.elements.origin.oninput = updateAirportBadges;
form.elements.destination.oninput = updateAirportBadges;

const swapBtn = $('#swap-airports');
if (swapBtn) {
  swapBtn.onclick = () => {
    const orig = form.elements.origin.value;
    form.elements.origin.value = form.elements.destination.value;
    form.elements.destination.value = orig;
    updateAirportBadges();
  };
}

document.querySelectorAll('.airport-chip-btn').forEach(btn => {
  btn.onclick = () => {
    const target = btn.dataset.target;
    const code = btn.dataset.code;
    if (form.elements[target]) {
      form.elements[target].value = code;
      updateAirportBadges();
    }
  };
});

// Trip type toggle
const btnTripRound = $('#btn-trip-round');
const btnTripOneway = $('#btn-trip-oneway');
if (btnTripRound) btnTripRound.onclick = () => setTripType('round');
if (btnTripOneway) btnTripOneway.onclick = () => setTripType('oneway');

// Dates setup
syncDateLimits();
form.elements.departure_date.onchange = () => {
  syncDateLimits();
  const dep = form.elements.departure_date.value;
  if (dep) {
    form.elements.return_date.min = dep;
    if (form.elements.return_date.value && form.elements.return_date.value < dep) {
      form.elements.return_date.value = dep;
    }
  }
};

form.elements.return_date.oninput = () => {
  if (form.elements.return_date.value) {
    setTripType('round');
  }
};

document.querySelectorAll('.duration-chip-btn').forEach(btn => {
  btn.onclick = () => {
    const days = Number(btn.dataset.days);
    let dep = form.elements.departure_date.value;
    if (!dep) {
      const d = new Date(todayTaipei() + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 14);
      dep = d.toISOString().slice(0, 10);
      form.elements.departure_date.value = dep;
      form.elements.return_date.min = dep;
    }
    const depDate = new Date(dep + 'T00:00:00Z');
    depDate.setUTCDate(depDate.getUTCDate() + days);
    form.elements.return_date.value = depDate.toISOString().slice(0, 10);
    setTripType('round');
  };
});

form.elements.target_price.oninput = updatePriceHint;
form.elements.adults.oninput = updatePriceHint;

// Save Rule Form Submit
form.onsubmit = e => {
  e.preventDefault();
  action(e.submitter, async () => {
    if (!user) throw Error('請先登入帳號');
    const values = Object.fromEntries(new FormData(form));
    const id = values.id;
    delete values.id;

    for (const k of ['adults', 'target_price', 'new_low_days', 'drop_amount', 'drop_percent']) {
      values[k] = values[k] === '' ? null : Number(values[k]);
    }
    values.origin = (values.origin || '').trim().toUpperCase();
    values.destination = (values.destination || '').trim().toUpperCase();
    values.return_date ||= null;
    values.enabled = form.elements.enabled.checked;
    values.notify_new_low = form.elements.notify_new_low.checked;

    if (!values.origin || values.origin.length !== 3) throw Error('請輸入 3 碼出發機場代碼 (如 TPE)');
    if (!values.destination || values.destination.length !== 3) throw Error('請輸入 3 碼抵達機場代碼 (如 NRT)');
    if (values.origin === values.destination) throw Error('出發地與目的地不能為同一個機場');
    if (values.return_date && values.return_date < values.departure_date) throw Error('回程日期不能早於出發日期');
    if (values.departure_date < todayTaipei() && values.enabled) throw Error('出發日期不能早於今天');

    const result = id
      ? await client.from('watch_rules').update(values).eq('id', id).select('id').single()
      : await client.from('watch_rules').insert({ ...values, user_id: user.id, provider: 'tigerair', currency: 'TWD' }).select('id').single();

    const data = check(result);
    form.elements.id.value = data.id;
    $('#editor-title').textContent = `編輯監控：${values.origin} ➔ ${values.destination}`;
    const cancelBtn = $('#cancel-edit-btn');
    if (cancelBtn) cancelBtn.hidden = false;
    $('#reset-rule').textContent = '取消編輯';
    await load();
    notice('監控規則已成功儲存！背景排程將定時為您查價。');
  });
};

client.auth.getSession().then(({ data, error }) => {
  if (error) notice(error.message, true);
  else if (!location.hash.includes('type=recovery')) showSession(data.session);
});
