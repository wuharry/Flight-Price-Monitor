import { setTimeout as delay } from 'node:timers/promises';
import { config } from './config.js';
import { LocalRepository } from './db/local.repository.js';
import { PriceRepository } from './db/price.repository.js';
import { EmailService, renderEmail, type NotificationSender } from './services/email.service.js';
import { notifyDesktop, openUrl } from './services/desktop-notify.js';
import { startAdmin } from './admin/server.js';
import { PriceService } from './services/price.service.js';
import { TigerairProvider } from './providers/tigerair.js';
import { getSupabaseClient } from './db/supabase.js';

async function main() {
  console.log('[Startup] Node monitor started', JSON.stringify({ storage: config.STORAGE, emailMode: config.EMAIL_MODE, browser: config.BROWSER_CHANNEL }));
  const flags = new Set(process.argv.slice(2));
  for (const flag of flags) if (!['--run-once', '--once', '--setup'].includes(flag)) throw new Error('Unknown argument: ' + flag);
  if (flags.has('--setup')) {
    const { url } = await startAdmin(process.cwd());
    console.log(`設定介面已啟動（只有這台電腦連得到）：\n${url}\n設定完成後回到這個視窗按 Ctrl+C 結束。`);
    await openUrl(url);
    await new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
    return;
  }
  const once = flags.has('--run-once') || flags.has('--once');
  const repository = config.STORAGE === 'supabase' ? new PriceRepository() :
    new LocalRepository(config.DATA_DIR, config.WATCH_RULES_FILE);
  const email = new EmailService(config, fetch, async alert => {
    const { data, error } = await getSupabaseClient().rpc('monitor_recipient', { p_rule: alert.watchRuleId, p_owner: alert.payload.rule.userId });
    if (error || typeof data !== 'string') throw new Error('Cannot resolve verified rule owner email');
    return data;
  });
  // The toast wraps the mail sender rather than replacing it, so a machine with no desktop session
  // still checks prices and mails; only the toast is skipped.
  const notifier: NotificationSender = config.DESKTOP_NOTIFY !== 'true' ? email : {
    async send(alert) {
      const outcome = await email.send(alert);
      await notifyDesktop(renderEmail(alert).subject, alert.payload.trigger.reason);
      return outcome;
    },
  };
  const service = new PriceService(repository, notifier, [new TigerairProvider()], config.EMAIL_MODE === 'send');
  const stop = new AbortController();
  const signal = () => stop.abort();
  process.once('SIGINT', signal);
  process.once('SIGTERM', signal);
  try {
    do {
      const started = Date.now();
      try {
        const result = await service.runAllActiveRules();
        console.log('[Monitor]', JSON.stringify(result));
        if (once) process.exitCode = result.failed ? 1 : 0;
      } catch (error) {
        console.error('[Monitor failed]', (error as Error).message);
        if (once) process.exitCode = 1;
      }
      if (once || stop.signal.aborted) break;
      const remaining = Math.max(1000, config.MONITOR_INTERVAL_MINUTES * 60000 - (Date.now() - started));
      try { await delay(remaining, undefined, { signal: stop.signal }); } catch { break; }
    } while (!stop.signal.aborted);
  } finally {
    process.removeListener('SIGINT', signal);
    process.removeListener('SIGTERM', signal);
  }
}
main().catch(error => { console.error('[Fatal]', (error as Error).message); process.exitCode = 1; });
