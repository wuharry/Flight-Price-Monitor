import { setTimeout as delay } from 'node:timers/promises';
import { config } from './config.js';
import { LocalRepository } from './db/local.repository.js';
import { PriceRepository } from './db/price.repository.js';
import { EmailService } from './services/email.service.js';
import { PriceService } from './services/price.service.js';
import { TigerairProvider } from './providers/tigerair.js';

async function main() {
  const flags = new Set(process.argv.slice(2));
  for (const flag of flags) if (!['--run-once', '--once'].includes(flag)) throw new Error('Unknown argument: ' + flag);
  const once = flags.has('--run-once') || flags.has('--once');
  const repository = config.STORAGE === 'supabase' ? new PriceRepository() :
    new LocalRepository(config.DATA_DIR, config.WATCH_RULES_FILE);
  const service = new PriceService(repository, new EmailService(), [new TigerairProvider()], config.EMAIL_MODE === 'send');
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
