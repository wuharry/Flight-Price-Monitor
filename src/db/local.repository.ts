import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AlertRecord, MonitorRepository, PriceHistory } from '../types/index.js';
import { watchRuleSchema } from '../validation.js';

interface Store { version: 1; history: PriceHistory[]; alerts: AlertRecord[] }
export class LocalRepository implements MonitorRepository {
  private state?: Store;
  private owner?: string;
  constructor(private directory: string, private rulesFile: string) { this.directory = resolve(directory); }
  async acquireLock(owner: string): Promise<boolean> {
    await mkdir(this.directory, { recursive: true });
    try {
      const handle = await open(join(this.directory, 'monitor.lock'), 'wx');
      try { await handle.writeFile(JSON.stringify({ owner, pid: process.pid, createdAt: new Date().toISOString() })); }
      finally { await handle.close(); }
      this.owner = owner;
      this.state = undefined;
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  }
  async releaseLock(owner: string): Promise<void> {
    if (this.owner !== owner) return;
    await unlink(join(this.directory, 'monitor.lock'));
    this.owner = undefined;
  }
  async getActiveRules() {
    const rules = z.array(watchRuleSchema).parse(JSON.parse(await readFile(this.rulesFile, 'utf8')));
    if (new Set(rules.map(rule => rule.id)).size !== rules.length) throw new Error('Duplicate watch rule IDs');
    return rules.filter(rule => rule.enabled);
  }
  private async load(): Promise<Store> {
    if (this.state) return this.state;
    try {
      const value = JSON.parse(await readFile(join(this.directory, 'monitor.json'), 'utf8')) as Store;
      if (value.version !== 1 || !Array.isArray(value.history) || !Array.isArray(value.alerts)) throw new Error('Invalid local database');
      this.state = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = { version: 1, history: [], alerts: [] };
    }
    return this.state;
  }
  private async save(value: Store): Promise<void> {
    if (!this.owner) throw new Error('Local database writes require the monitor lock');
    const path = join(this.directory, 'monitor.json');
    const temporary = path + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
    await rename(temporary, path);
    this.state = value;
  }
  async getHistory(ruleId: string, key: string, since: string, before: string) {
    return (await this.load()).history.filter(row =>
      row.watchRuleId === ruleId && row.searchKey === key && row.checkedAt >= since && row.checkedAt < before
    ).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
  }
  async recordCheck(history: PriceHistory, alert?: AlertRecord) {
    const state = await this.load();
    const cutoff = new Date(new Date(history.checkedAt).getTime() - 86400000).toISOString();
    const duplicate = alert && state.alerts.some(row => row.watchRuleId === alert.watchRuleId &&
      row.searchKey === alert.searchKey && row.price === alert.price &&
      (row.status === 'pending' || (row.status === 'sent' && row.sentAt! >= cutoff)));
    await this.save({ ...state, history: [...state.history, history],
      alerts: alert && !duplicate ? [...state.alerts, alert] : state.alerts });
  }
  async getPendingAlerts() { return (await this.load()).alerts.filter(row => row.status === 'pending'); }
  async markAlert(id: string, status: 'sent' | 'expired') {
    const state = await this.load();
    await this.save({ ...state, alerts: state.alerts.map(row => row.id === id ?
      { ...row, status, sentAt: status === 'sent' ? new Date().toISOString() : undefined } : row) });
  }
}
