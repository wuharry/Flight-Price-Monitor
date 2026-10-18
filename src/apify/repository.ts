import type { RequestQueue } from 'apify';
import type { AlertRecord, MonitorRepository, PriceHistory, WatchRule } from '../types/index.js';

export interface PersistentStore {
  getValue<T>(key: string): Promise<T | null>;
  setValue(key: string, value: unknown): Promise<void>;
}
export interface MonitorMutex {
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
}
interface State { version: 1; history: PriceHistory[]; alerts: AlertRecord[] }
const stateKey = 'MONITOR-STATE-V1';
const lockKey = 'flight-monitor-exclusive-lock-v1';

/** A single queue request is an atomic distributed lease, never a URL to crawl. */
export class RequestQueueMutex implements MonitorMutex {
  private request: Awaited<ReturnType<RequestQueue['fetchNextRequest']>> = null;
  constructor(private queue: RequestQueue) {
    // Every Actor run is limited to 180 seconds. A crashed run must die before this lease expires.
    this.queue.requestLockSecs = 600;
  }
  async tryAcquire(): Promise<boolean> {
    if (this.request) return false;
    await this.queue.addRequest({ url: 'https://flight-monitor.invalid/lock', uniqueKey: lockKey });
    const request = await this.queue.fetchNextRequest();
    if (!request) return false;
    if (request.uniqueKey !== lockKey) {
      await this.queue.reclaimRequest(request, { forefront: true });
      throw new Error('Unexpected item in dedicated monitor lock queue');
    }
    this.request = request;
    return true;
  }
  async release(): Promise<void> {
    if (!this.request) return;
    const request = this.request;
    // Leave the same unique request pending so a later run can acquire it again.
    await this.queue.reclaimRequest(request, { forefront: true });
    this.request = null;
  }
}

/** Persist a quote and its outbox item in one record, under the queue lease. */
export class ApifyRepository implements MonitorRepository {
  private state?: State;
  private owner?: string;
  constructor(private store: PersistentStore, private mutex: MonitorMutex, private rules: WatchRule[]) {}
  async acquireLock(owner: string): Promise<boolean> {
    if (this.owner || !await this.mutex.tryAcquire()) return false;
    this.owner = owner;
    this.state = undefined;
    return true;
  }
  async releaseLock(owner: string): Promise<void> {
    if (this.owner !== owner) return;
    await this.mutex.release();
    this.owner = undefined;
    this.state = undefined;
  }
  async getActiveRules(): Promise<WatchRule[]> { return this.rules.filter(rule => rule.enabled); }
  private async load(): Promise<State> {
    if (this.state) return this.state;
    const value = await this.store.getValue<State>(stateKey);
    if (value && (value.version !== 1 || !Array.isArray(value.history) || !Array.isArray(value.alerts))) {
      throw new Error('Invalid persisted monitor state');
    }
    return this.state = value ?? { version: 1, history: [], alerts: [] };
  }
  private async save(value: State): Promise<void> {
    if (!this.owner) throw new Error('Apify monitor writes require the queue lease');
    await this.store.setValue(stateKey, value);
    this.state = value;
  }
  async getHistory(ruleId: string, key: string, since: string, before: string): Promise<PriceHistory[]> {
    return (await this.load()).history.filter(row => row.watchRuleId === ruleId && row.searchKey === key &&
      row.checkedAt >= since && row.checkedAt < before).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
  }
  async recordCheck(history: PriceHistory, alert?: AlertRecord): Promise<void> {
    const state = await this.load();
    const cutoff = new Date(Date.parse(history.checkedAt) - 86400000).toISOString();
    const duplicate = alert && state.alerts.some(row => row.watchRuleId === alert.watchRuleId &&
      row.searchKey === alert.searchKey && row.price === alert.price &&
      (row.status === 'pending' || (row.status === 'sent' && row.sentAt! >= cutoff)));
    // Retain enough history for the maximum supported 365-day low window.
    const retainedSince = new Date(Date.parse(history.checkedAt) - 366 * 86400000).toISOString();
    await this.save({ version: 1,
      history: [...state.history.filter(row => row.checkedAt >= retainedSince), history],
      alerts: [...state.alerts.filter(row => row.status === 'pending' || row.createdAt >= retainedSince),
        ...(alert && !duplicate ? [alert] : [])] });
  }
  async getPendingAlerts(): Promise<AlertRecord[]> { return (await this.load()).alerts.filter(row => row.status === 'pending'); }
  async markAlert(id: string, status: 'sent' | 'expired'): Promise<void> {
    const state = await this.load();
    await this.save({ ...state, alerts: state.alerts.map(row => row.id === id ?
      { ...row, status, sentAt: status === 'sent' ? new Date().toISOString() : undefined } : row) });
  }
}
