import { randomUUID } from 'node:crypto';
import type { FlightProvider } from '../providers/base.js';
import type { AlertRecord, MonitorRepository, PriceHistory, WatchRule } from '../types/index.js';
import { searchKey, todayTaipei, watchRuleSchema } from '../validation.js';
import { checkTriggerConditions } from './alert.service.js';
import type { NotificationSender } from './email.service.js';
import { ProviderAccessDeniedError } from '../providers/access-denied.js';

export class PriceService {
  private providers = new Map<string, FlightProvider>();
  constructor(private repository: MonitorRepository, private email: NotificationSender,
    providers: FlightProvider[], private sendMode: boolean) {
    for (const provider of providers) this.providers.set(provider.name, provider);
  }
  async runRule(rule: WatchRule) {
    rule = watchRuleSchema.parse(rule);
    const provider = this.providers.get(rule.provider);
    if (!provider) throw new Error('Unknown provider: ' + rule.provider);
    console.log(`[Progress] Rule ${rule.id}: querying ${rule.origin}-${rule.destination}`);
    const result = await provider.search(rule);
    const key = searchKey(rule);
    if (searchKey(result) !== key || !Number.isFinite(result.totalPrice) || result.totalPrice <= 0) throw new Error('Provider returned mismatched or invalid quote');
    const now = new Date(result.checkedAt);
    if (!Number.isFinite(now.getTime()) || Math.abs(Date.now() - now.getTime()) > 300000) throw new Error('Provider quote is stale');
    const history = await this.repository.getHistory(rule.id, key,
      new Date(now.getTime() - Math.max(rule.newLowDays, 2) * 86400000).toISOString(), now.toISOString());
    const trigger = checkTriggerConditions(rule, result.totalPrice, history, now);
    const alert: AlertRecord | undefined = trigger ? {
      id: randomUUID(), watchRuleId: rule.id, searchKey: key, price: result.totalPrice, type: trigger.type,
      createdAt: now.toISOString(), status: 'pending', payload: { rule, result, trigger },
    } : undefined;
    const record: PriceHistory = { id: randomUUID(), watchRuleId: rule.id, searchKey: key,
      price: result.totalPrice, currency: result.currency, checkedAt: result.checkedAt, result };
    // Persist the quote and notification together before any external side effect.
    await this.repository.recordCheck(record, this.sendMode ? alert : undefined);
    if (alert && !this.sendMode) await this.email.send(alert);
    console.log(`[Price] ${rule.id}: TWD ${result.totalPrice}; source ${result.provider}; tax/fees ${result.taxAndFees ?? 'not itemized'}; ${result.legs.map(leg => leg.flightNumber ?? `${leg.origin}-${leg.destination}`).join(' / ')}`);
    return result;
  }
  private async flushAlerts(rules: WatchRule[], attempts: Map<string, 'attempted' | 'accepted'>) {
    if (!this.sendMode) return 0;
    let failed = 0;
    for (const alert of await this.repository.getPendingAlerts()) {
      try {
        const rule = rules.find(value => value.id === alert.watchRuleId);
        // Resend retains idempotency keys for 24 hours. Never retry beyond 23 hours.
        if (Date.now() - Date.parse(alert.createdAt) >= 23 * 3600000 || !rule ||
            searchKey(rule) !== alert.searchKey || rule.departureDate < todayTaipei()) {
          await this.repository.markAlert(alert.id, 'expired');
          console.warn(`[Alert expired] ${alert.id}: too old, disabled, or search conditions changed`);
          continue;
        }
        // A submission failure can mean the server accepted the message but its response was lost.
        // Never retry that external side effect during the second flush of the same run.
        const attempt = attempts.get(alert.id);
        if (attempt) {
          if (attempt === 'accepted') await this.repository.markAlert(alert.id, 'sent');
          continue;
        }
        attempts.set(alert.id, 'attempted');
        // Resolve recipient from the current rule, never stale ownership in an outbox payload.
        if (await this.email.send({ ...alert, payload: { ...alert.payload, rule } }) === 'sent') {
          attempts.set(alert.id, 'accepted');
          await this.repository.markAlert(alert.id, 'sent');
        }
      } catch (error) { failed++; console.error('[Alert failed]', (error as Error).message); }
    }
    return failed;
  }
  async runAllActiveRules() {
    const owner = randomUUID();
    console.log('[Progress] Acquiring monitor lock');
    if (!await this.repository.acquireLock(owner)) throw new Error('Another monitor is running (or a stale local lock exists)');
    // Must end before the database lock's 20-minute lease can expire.
    const deadline = setTimeout(() => {
      console.error('[Fatal] Monitor exceeded 15 minutes');
      process.exit(1);
    }, 15 * 60000);
    deadline.unref();
    const summary = { checked: 0, skipped: 0, failed: 0 };
    const attempts = new Map<string, 'attempted' | 'accepted'>();
    try {
      console.log('[Progress] Lock acquired; reading enabled rules');
      const rules = await this.repository.getActiveRules();
      console.log(`[Progress] Loaded ${rules.length} enabled rules`);
      if (!rules.length) console.log('[Monitor] No enabled watch rules');
      summary.failed += await this.flushAlerts(rules, attempts);
      const blockedProviders = new Set<string>();
      for (const rule of rules) {
        if (blockedProviders.has(rule.provider)) {
          summary.skipped++;
          console.warn(`[Rule ${rule.id} skipped] Provider access was rejected earlier in this run`);
          continue;
        }
        if (rule.departureDate < todayTaipei()) { summary.skipped++; continue; }
        try { await this.runRule(rule); summary.checked++; }
        catch (error) {
          summary.failed++;
          console.error(`[Rule ${rule.id} failed]`, (error as Error).message);
          if (error instanceof ProviderAccessDeniedError) blockedProviders.add(rule.provider);
        }
      }
      summary.failed += await this.flushAlerts(rules, attempts);
      return summary;
    } finally {
      clearTimeout(deadline);
      await this.repository.releaseLock(owner);
    }
  }
}
