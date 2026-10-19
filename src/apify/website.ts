import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { parseConfig } from '../config.js';
import { PriceRepository } from '../db/price.repository.js';
import type { AlertRecord, MonitorRepository, WatchRule } from '../types/index.js';
import { todayTaipei, watchRuleSchema } from '../validation.js';

export interface WebsiteClaim { id: string; runId: string; rule: WatchRule }
export interface WebsiteCompletion {
  status: 'succeeded' | 'failed';
  totalPrice?: number;
  currency?: 'TWD';
  emailStatus: 'accepted' | 'preview' | 'not-triggered';
  errorCode?: 'worker-failed' | 'query-or-notification-failed' | 'invalid-rule' | 'no-matching-itinerary';
}
export interface WebsiteJobs {
  claim(jobId: string, runId: string): Promise<WebsiteClaim>;
  repository(claim: WebsiteClaim): MonitorRepository;
  recipient(claim: WebsiteClaim, alert: AlertRecord): Promise<string>;
  finish(claim: WebsiteClaim, completion: WebsiteCompletion): Promise<void>;
}
export type ScheduledNoopStatus = 'disabled' | 'no-eligible-rule' | 'daily-limit' | 'monthly-limit' | 'busy';
export type ScheduledReservation = { status: 'reserved'; jobId: string } | { status: ScheduledNoopStatus };
export interface ScheduledWebsiteJobs extends WebsiteJobs {
  reserveScheduled(allowedEmails: string[]): Promise<ScheduledReservation>;
}

const scheduledReservationSchema = z.union([
  z.object({ status: z.literal('reserved'), jobId: z.string().uuid() }),
  z.object({ status: z.enum(['disabled', 'no-eligible-rule', 'daily-limit', 'monthly-limit', 'busy']) }),
]);

const claimSchema = z.object({
  id: z.string().uuid(), watch_rule_id: z.string().uuid(), user_id: z.string().uuid(),
  status: z.literal('running'), expires_at: z.string(), watch_rule: watchRuleSchema,
});

/** The public website supplies only a queued job ID. All search/ownership comes from SQL. */
export class SupabaseWebsiteJobs implements ScheduledWebsiteJobs {
  constructor(private client: SupabaseClient) {}
  async reserveScheduled(allowedEmails: string[]): Promise<ScheduledReservation> {
    // Do not make an ambiguous reservation request a second time. SQL consumes the
    // slot atomically; a lost response is a failed run, never a second selection.
    if (!allowedEmails.length) return { status: 'disabled' };
    const emails = z.array(z.string().email()).min(1).parse(allowedEmails);
    const { data, error } = await this.client.rpc('reserve_scheduled_cloud_check_job', { p_allowed_emails: emails });
    if (error || !data) throw new Error('Scheduled reservation could not be confirmed; it will not be retried');
    const result = scheduledReservationSchema.safeParse(data);
    if (!result.success) throw new Error('Scheduled reservation returned an invalid result; it will not be retried');
    return result.data;
  }
  async claim(jobId: string, runId: string): Promise<WebsiteClaim> {
    z.string().uuid().parse(jobId);
    if (!/^[a-zA-Z0-9]{1,80}$/.test(runId)) throw new Error('Website job requires a cloud run ID');
    const { data, error } = await this.client.rpc('claim_cloud_check_job', { p_job_id: jobId, p_run_id: runId });
    if (error || !data) throw new Error('Website job is unavailable, expired, or already claimed');
    try {
      const job = claimSchema.parse(data);
      const rule = job.watch_rule;
      if (job.id !== jobId || rule.id !== job.watch_rule_id || rule.userId !== job.user_id ||
          rule.provider !== 'google-flights' || !rule.enabled || rule.departureDate < todayTaipei() ||
          !Number.isFinite(Date.parse(job.expires_at)) || Date.parse(job.expires_at) <= Date.now()) {
        throw new Error('Invalid claimed rule');
      }
      return { id: job.id, runId, rule };
    } catch {
      // The SQL claim is already consumed. Fail it once; never retry a browser query or mail.
      await this.client.rpc('finish_cloud_check_job', { p_job_id: jobId, p_run_id: runId,
        p_status: 'failed', p_total_price: null, p_currency: null, p_error_code: 'invalid-rule', p_email_status: null });
      throw new Error('Website job contains an invalid or unavailable monitoring rule');
    }
  }
  repository(claim: WebsiteClaim): MonitorRepository {
    if (!claim.rule.userId) throw new Error('Website rule requires an owner');
    return new PriceRepository(this.client, { ruleId: claim.rule.id, userId: claim.rule.userId });
  }
  async recipient(claim: WebsiteClaim, alert: AlertRecord): Promise<string> {
    if (alert.watchRuleId !== claim.rule.id || alert.payload.rule.id !== claim.rule.id ||
        alert.payload.rule.userId !== claim.rule.userId || !claim.rule.userId) {
      throw new Error('Website notification ownership does not match its job');
    }
    const { data, error } = await this.client.rpc('monitor_recipient', {
      p_rule: claim.rule.id, p_owner: claim.rule.userId,
    });
    if (error || !z.string().email().safeParse(data).success) throw new Error('No verified recipient for this website rule');
    return data as string;
  }
  async finish(claim: WebsiteClaim, completion: WebsiteCompletion): Promise<void> {
    const { error } = await this.client.rpc('finish_cloud_check_job', {
      p_job_id: claim.id, p_run_id: claim.runId, p_status: completion.status,
      p_total_price: completion.totalPrice ?? null, p_currency: completion.currency ?? null,
      p_error_code: completion.errorCode ?? null, p_email_status: completion.emailStatus,
    });
    if (error) throw new Error('Website job completion could not be saved');
  }
}

export function createWebsiteJobs(options: ReturnType<typeof parseConfig>): ScheduledWebsiteJobs {
  if (options.STORAGE !== 'supabase') throw new Error('Website worker requires Supabase storage');
  const url = new URL(options.SUPABASE_URL);
  if (url.protocol !== 'https:') throw new Error('Website worker requires HTTPS Supabase');
  return new SupabaseWebsiteJobs(createClient(options.SUPABASE_URL, options.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10000) }) },
  }));
}
