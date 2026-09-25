import type { AlertRecord, MonitorRepository, PriceHistory } from '../types/index.js';
import { watchRuleSchema } from '../validation.js';
import { getSupabaseClient } from './supabase.js';

export class PriceRepository implements MonitorRepository {
  private client = getSupabaseClient();
  async acquireLock(owner: string): Promise<boolean> {
    const { data, error } = await this.client.rpc('acquire_monitor_lock', { p_owner: owner });
    if (error) throw new Error('Acquire monitor lock: ' + error.message);
    return data === true;
  }
  async releaseLock(owner: string) {
    const { error } = await this.client.rpc('release_monitor_lock', { p_owner: owner });
    if (error) throw new Error('Release monitor lock: ' + error.message);
  }
  async getActiveRules() {
    const { data, error } = await this.client.from('watch_rules').select('*').eq('enabled', true).order('id');
    if (error) throw new Error('Read watch rules: ' + error.message);
    return (data ?? []).map(row => watchRuleSchema.parse({
      id: row.id, provider: row.provider, origin: row.origin, destination: row.destination,
      departureDate: row.departure_date, returnDate: row.return_date ?? undefined, adults: row.adults,
      currency: row.currency, targetPrice: row.target_price == null ? undefined : Number(row.target_price),
      notifyNewLow: row.notify_new_low, newLowDays: row.new_low_days,
      dropAmount: row.drop_amount == null ? undefined : Number(row.drop_amount),
      dropPercent: row.drop_percent == null ? undefined : Number(row.drop_percent), enabled: row.enabled,
    }));
  }
  async getHistory(ruleId: string, key: string, since: string, before: string): Promise<PriceHistory[]> {
    // PostgREST defaults to 1,000 rows; page so 365-day windows remain correct.
    const records: PriceHistory[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await this.client.from('price_history').select('*')
        .eq('watch_rule_id', ruleId).eq('search_key', key).gte('checked_at', since).lt('checked_at', before)
        .order('checked_at', { ascending: false }).order('id').range(offset, offset + 999);
      if (error) throw new Error('Read price history: ' + error.message);
      records.push(...(data ?? []).map(row => ({
        id: row.id, watchRuleId: row.watch_rule_id, searchKey: row.search_key, price: Number(row.price),
        currency: row.currency as 'TWD', checkedAt: new Date(row.checked_at).toISOString(), result: row.result,
      })));
      if (!data || data.length < 1000) return records;
    }
  }
  async recordCheck(history: PriceHistory, alert?: AlertRecord) {
    const { error } = await this.client.rpc('record_price_check', { p_history: history, p_alert: alert ?? null });
    if (error) throw new Error('Record price check: ' + error.message);
  }
  async getPendingAlerts(): Promise<AlertRecord[]> {
    const { data, error } = await this.client.from('alerts').select('*').eq('status', 'pending').order('created_at');
    if (error) throw new Error('Read notification outbox: ' + error.message);
    return (data ?? []).map(row => ({
      id: row.id, watchRuleId: row.watch_rule_id, searchKey: row.search_key, price: Number(row.price),
      type: row.type, status: row.status, createdAt: new Date(row.created_at).toISOString(),
      sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : undefined, payload: row.payload,
    }));
  }
  async markAlert(id: string, status: 'sent' | 'expired') {
    const { error } = await this.client.from('alerts').update({
      status, sent_at: status === 'sent' ? new Date().toISOString() : null,
    }).eq('id', id);
    if (error) throw new Error('Update notification outbox: ' + error.message);
  }
}
