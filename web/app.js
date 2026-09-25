import { createClient } from '@supabase/supabase-js';
const client = createClient(__SUPABASE_URL__, __SUPABASE_KEY__);
const $ = s => document.querySelector(s);
const form = $('#rule-form');
let user = null, rules = [], recovery = false, generation = 0;
const redirect = new URL('./', location.href).href;
function notice(message, error = false) { $('#status').textContent = message; $('#status').className = error ? 'error' : ''; }
function node(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
async function action(button, fn) { button.disabled = true; try { await fn(); } catch (e) { notice(e.message || '操作失敗，請稍後再試', true); } finally { button.disabled = false; } }
function check(result) { if (result.error) throw result.error; return result.data; }
function resetRule() { form.reset(); form.elements.id.value = ''; $('#editor-title').textContent = '新增監控'; }
async function history(ruleId) {
  const version = generation;
  let query = client.from('price_history').select('id,watch_rule_id,price,currency,checked_at,result').order('checked_at', { ascending: false }).limit(100);
  if (ruleId) query = query.eq('watch_rule_id', ruleId);
  const data = check(await query);
  if (version !== generation || !user) return;
  $('#history').replaceChildren();
  if (!data.length) { const tr = node('tr', ''); const td = node('td', '還沒有票價紀錄。背景查價完成後會顯示在這裡。', 'empty'); td.colSpan = 3; tr.append(td); $('#history').append(tr); }
  for (const row of data) { const rule = row.result || rules.find(r => r.id === row.watch_rule_id); const tr = node('tr', ''); tr.append(node('td', rule ? `${rule.origin} → ${rule.destination}` : '航班'), node('td', new Date(row.checked_at).toLocaleString('zh-TW')), node('td', `NT$${Number(row.price).toLocaleString('zh-TW')}`)); $('#history').append(tr); }
}
async function load() {
  if (!user) return;
  const version = generation;
  const data = check(await client.from('watch_rules').select('*').order('created_at', { ascending: false }).limit(10));
  if (version !== generation || !user) return;
  rules = data; $('#total').textContent = rules.length; $('#active').textContent = rules.filter(r => r.enabled).length;
  $('#rules').replaceChildren();
  if (!rules.length) $('#rules').append(node('p', '還沒有監控航線。\n填寫旁邊的表單，開始追蹤第一段旅程。', 'empty'));
  for (const r of rules) {
    const card = node('article', '', 'watch'), title = node('h3', `${r.origin} → ${r.destination}`);
    title.append(node('span', r.enabled ? '啟用中' : '已停用', 'badge'));
    card.append(title, node('p', `${r.departure_date}${r.return_date ? ' ～ ' + r.return_date : ' · 單程'} · ${r.adults} 位成人`), node('p', r.target_price == null ? '未設定目標價' : `目標 NT$${Number(r.target_price).toLocaleString('zh-TW')}`));
    const buttons = node('div', '', 'actions');
    const edit = node('button', '編輯', 'secondary'); edit.onclick = () => { resetRule(); for (const [k, v] of Object.entries(r)) { const input = form.elements.namedItem(k); if (input) { if (input.type === 'checkbox') input.checked = !!v; else input.value = v ?? ''; } } $('#editor-title').textContent = '編輯監控'; form.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    const view = node('button', '票價紀錄', 'secondary'); view.onclick = () => action(view, () => history(r.id));
    const toggle = node('button', r.enabled ? '停用' : '啟用', 'secondary'); toggle.onclick = () => action(toggle, async () => { const changed = check(await client.from('watch_rules').update({ enabled: !r.enabled }).eq('id', r.id).select('id').single()); if (changed) await load(); });
    const remove = node('button', '刪除', 'secondary'); remove.onclick = () => { if (!confirm('刪除此監控及其票價紀錄？')) return; action(remove, async () => { check(await client.from('watch_rules').delete().eq('id', r.id).select('id').single()); if (form.elements.id.value === r.id) resetRule(); await load(); notice('監控已刪除'); }); };
    buttons.append(edit, view, toggle, remove); card.append(buttons); $('#rules').append(card);
  }
  await history();
}
async function showSession(session, event) {
  generation++; user = session?.user || null;
  if (event === 'PASSWORD_RECOVERY') recovery = true;
  if (!user) recovery = false;
  $('#auth').hidden = !!user; $('#dashboard').hidden = !user || recovery; $('#recovery').hidden = !recovery; $('#account').hidden = !user;
  $('#email').textContent = user?.email || ''; $('#recipient').textContent = user?.email || '';
  rules = []; $('#rules').replaceChildren(); $('#history').replaceChildren(); resetRule();
  if (user && !recovery) { try { await load(); } catch (e) { notice('無法讀取監控：' + e.message + '。若剛完成部署，請確認管理員已執行 multi-user.sql。', true); } }
}
client.auth.onAuthStateChange((event, session) => { if (event !== 'TOKEN_REFRESHED') setTimeout(() => showSession(session, event), 0); });
$('#auth-form').onsubmit = e => { e.preventDefault(); action($('#login'), async () => { check(await client.auth.signInWithPassword({ email: $('#login-email').value.trim(), password: $('#login-password').value })); $('#login-password').value = ''; notice('登入成功'); }); };
$('#signup').onclick = () => { if (!$('#auth-form').reportValidity()) return; action($('#signup'), async () => { const data = check(await client.auth.signUp({ email: $('#login-email').value.trim(), password: $('#login-password').value, options: { emailRedirectTo: redirect } })); $('#login-password').value = ''; notice(data.session ? '註冊成功' : '請到信箱點選驗證連結，完成後再登入。若已註冊，可直接登入或重設密碼。'); }); };
$('#forgot').onclick = () => { if (!$('#login-email').reportValidity()) return; action($('#forgot'), async () => { check(await client.auth.resetPasswordForEmail($('#login-email').value.trim(), { redirectTo: redirect })); notice('若此信箱已註冊，請查收重設密碼信件。'); }); };
$('#password-form').onsubmit = e => { e.preventDefault(); action(e.submitter, async () => { check(await client.auth.updateUser({ password: $('#new-password').value })); $('#new-password').value = ''; recovery = false; await showSession((await client.auth.getSession()).data.session); notice('密碼已更新'); }); };
$('#logout').onclick = () => action($('#logout'), async () => { check(await client.auth.signOut()); notice('已登出'); });
$('#refresh').onclick = () => action($('#refresh'), async () => { await load(); notice('已更新清單'); });
$('#reset-rule').onclick = resetRule;
form.onsubmit = e => { e.preventDefault(); action(e.submitter, async () => {
  if (!user) throw Error('請先登入');
  const values = Object.fromEntries(new FormData(form)); const id = values.id; delete values.id;
  for (const k of ['adults', 'target_price', 'new_low_days', 'drop_amount', 'drop_percent']) values[k] = values[k] === '' ? null : Number(values[k]);
  values.origin = values.origin.toUpperCase(); values.destination = values.destination.toUpperCase();
  values.return_date ||= null; values.enabled = form.elements.enabled.checked; values.notify_new_low = form.elements.notify_new_low.checked;
  if (values.origin === values.destination) throw Error('出發與抵達機場不能相同');
  if (values.return_date && values.return_date < values.departure_date) throw Error('回程日期不能早於出發日期');
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
  if (values.departure_date < today && values.enabled) throw Error('請選擇未來的出發日期');
  const result = id ? await client.from('watch_rules').update(values).eq('id', id).select('id').single() : await client.from('watch_rules').insert({ ...values, user_id: user.id, provider: 'tigerair', currency: 'TWD' }).select('id').single();
  const data = check(result); form.elements.id.value = data.id; $('#editor-title').textContent = '編輯監控'; await load(); notice('已儲存。下一次背景查價會使用這條規則。');
}); };
client.auth.getSession().then(({ data, error }) => { if (error) notice(error.message, true); else if (!location.hash.includes('type=recovery')) showSession(data.session); });
