import { createServer } from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { watchRuleSchema } from '../validation.js';

const keys = ['PROJECT_ID', 'REGION', 'STORAGE', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'NOTIFICATION_FROM_EMAIL', 'NOTIFICATION_TO_EMAIL', 'EMAIL_MODE'] as const;
const hidden = new Set(['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'RESEND_API_KEY']);
const settingsSchema = z.object({
  PROJECT_ID: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/),
  REGION: z.string().regex(/^[a-z]+-[a-z]+\d$/),
  STORAGE: z.enum(['local', 'supabase']),
  SUPABASE_URL: z.string().url().refine(v => /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(v), '請使用 https://專案.supabase.co API 網址'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1), RESEND_API_KEY: z.string().default(''),
  NOTIFICATION_FROM_EMAIL: z.string().min(1), NOTIFICATION_TO_EMAIL: z.string().email(),
  EMAIL_MODE: z.enum(['preview', 'send']),
});
export async function startAdmin(root = process.cwd(), port = 4317) {
  const token = randomBytes(32).toString('hex');
  const envFile = resolve(root, '.env');
  const readEnv = async () => {
    let env: Record<string, string> = {};
    try { env = parse(await readFile(envFile)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    env.SUPABASE_SERVICE_ROLE_KEY ||= env.SUPABASE_SECRET_KEY || '';
    return env;
  };
  const client = (env: Record<string, string>) => {
    settingsSchema.pick({ SUPABASE_URL: true, SUPABASE_SERVICE_ROLE_KEY: true }).parse(env);
    return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false }, global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30000) }) } });
  };
  const rulesPath = (env: Record<string, string>) => resolve(root, env.WATCH_RULES_FILE || 'watch-rules.json');
  async function localRules(env: Record<string, string>) {
    try { return z.array(watchRuleSchema).parse(JSON.parse(await readFile(rulesPath(env), 'utf8'))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  }
  let busy = false;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
    const reply = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    if (req.headers.host !== host) return reply(403, { error: 'Host rejected' });
    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(await readFile(new URL('./ui.html', import.meta.url), 'utf8')); return;
    }
    if (req.headers.authorization !== `Bearer ${token}` || (req.headers.origin && req.headers.origin !== `http://${host}`)) return reply(403, { error: '請使用啟動時顯示的完整網址開啟管理頁' });
    const mutation = req.method === 'POST';
    if (mutation && busy) return reply(409, { error: '另一筆儲存尚未完成，請稍後重試' });
    if (mutation) busy = true;
    try {
      const env = await readEnv();
      let body: any = {};
      if (mutation) {
        if (!req.headers['content-type']?.startsWith('application/json')) return reply(415, { error: 'JSON required' });
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 65536) return reply(413, { error: 'Request too large' }); }
        body = JSON.parse(raw);
      }
      if (req.url === '/api/settings' && req.method === 'GET') {
        return reply(200, { values: Object.fromEntries(keys.filter(k => !hidden.has(k)).map(k => [k, env[k] || ''])), secrets: { supabase: !!env.SUPABASE_SERVICE_ROLE_KEY, resend: !!env.RESEND_API_KEY } });
      }
      if (req.url === '/api/settings' && mutation) {
        const input = Object.fromEntries(keys.map(k => [k, hidden.has(k) && !body[k] ? env[k] || '' : body[k]]));
        const valid = settingsSchema.parse(input);
        for (const value of Object.values(valid)) if (/[\r\n"`]/.test(value)) throw new Error('設定值不可包含換行、雙引號或反引號');
        const merged: Record<string, string> = { ...env, ...valid };
        delete merged.SUPABASE_SECRET_KEY;
        const tmp = envFile + '.' + randomUUID() + '.tmp';
        await writeFile(tmp, Object.entries(merged).map(([k, v]) => `${k}=${v.includes('"') ? "'" + v + "'" : '"' + v + '"'}`).join('\n') + '\n', { mode: 0o600 });
        await rename(tmp, envFile);
        return reply(200, { message: '已儲存到本機 .env。雲端密鑰請在 Secret Manager 更新；部署設定需執行下方指令才生效。' });
      }
      if (req.url === '/api/rules' && req.method === 'GET') {
        if (env.STORAGE !== 'supabase') return reply(200, { storage: 'local', rules: await localRules(env) });
        const { data, error } = await client(env).from('watch_rules').select('*').order('created_at', { ascending: false }).limit(500);
        if (error) throw new Error('Supabase 讀取失敗，請確認網址、key 與 schema.sql');
        return reply(200, { storage: 'supabase', rules: (data || []).map(r => ({ id: r.id, provider: r.provider, origin: r.origin, destination: r.destination, departureDate: r.departure_date, returnDate: r.return_date, adults: r.adults, targetPrice: r.target_price, notifyNewLow: r.notify_new_low, newLowDays: r.new_low_days, dropAmount: r.drop_amount, dropPercent: r.drop_percent, enabled: r.enabled, currency: r.currency })) });
      }
      if (req.url === '/api/rules' && mutation) {
        const rule = watchRuleSchema.parse({ ...body, id: body.id || randomUUID(), provider: 'tigerair', currency: 'TWD' });
        z.string().uuid().parse(rule.id);
        if (env.STORAGE === 'supabase') {
          const { error } = await client(env).from('watch_rules').upsert({ id: rule.id, provider: rule.provider, origin: rule.origin, destination: rule.destination, departure_date: rule.departureDate, return_date: rule.returnDate || null, adults: rule.adults, currency: rule.currency, target_price: rule.targetPrice ?? null, notify_new_low: rule.notifyNewLow, new_low_days: rule.newLowDays, drop_amount: rule.dropAmount ?? null, drop_percent: rule.dropPercent ?? null, enabled: rule.enabled, updated_at: new Date().toISOString() });
          if (error) throw new Error('Supabase 儲存失敗，請確認 key 權限與資料表');
        } else {
          const rules = await localRules(env);
          const next = [...rules.filter(r => r.id !== rule.id), rule];
          const path = rulesPath(env), tmp = path + '.' + randomUUID() + '.tmp';
          await writeFile(tmp, JSON.stringify(next, null, 2)); await rename(tmp, path);
        }
        return reply(200, { message: env.STORAGE === 'supabase' ? '已更新 Supabase，下一次雲端查價會使用此規則' : '已儲存本機監控規則', id: rule.id });
      }
      return reply(404, { error: 'Not found' });
    } catch (e) {
      return reply(400, { error: e instanceof z.ZodError ? e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；') : e instanceof SyntaxError ? '資料格式錯誤' : (e as Error).message });
    } finally { if (mutation) busy = false; }
  });
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); });
  return { server, token, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/#${token}` };
}
if (process.argv[1] && /(?:^|[\\/])server\.(?:ts|js)$/.test(process.argv[1])) {
  startAdmin(process.env.ADMIN_WORKSPACE || process.cwd()).then(({ url }) => console.log(`Flight Monitor 管理介面（僅本機）：${url}`)).catch(e => { console.error(e.message); process.exitCode = 1; });
}
