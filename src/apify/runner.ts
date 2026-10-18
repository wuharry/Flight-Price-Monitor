import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseConfig } from '../config.js';
import type { FlightProvider } from '../providers/base.js';
import type { AlertRecord, FlightPriceResult, FlightSearch, MonitorRepository, WatchRule } from '../types/index.js';
import type { EmailReceipt, NotificationSender } from '../services/email.service.js';
import { PriceService } from '../services/price.service.js';
import { googleFlightsPriceBasis, searchKey, searchSchema, todayTaipei, watchRuleSchema } from '../validation.js';
import type { ScheduledNoopStatus, ScheduledWebsiteJobs, WebsiteJobs } from './website.js';

const googleRule = z.preprocess(value => value && typeof value === 'object' ?
  { provider: 'google-flights', ...value } : value, watchRuleSchema).refine(rule =>
  rule.provider === 'google-flights' && !rule.userId, 'Actor rules require google-flights and a single environment recipient');
export const actorInputSchema = z.object({
  action: z.enum(['check', 'test-email', 'monitor', 'website-check', 'scheduled-check']).default('check'),
  provider: z.literal('google-flights').default('google-flights'),
  search: searchSchema.optional(),
  watchRules: z.array(googleRule).min(1).max(1).optional(),
  jobId: z.string().uuid().optional(),
}).strict().superRefine((input, context) => {
  if (input.action === 'scheduled-check') {
    if (input.search || input.watchRules || input.jobId) context.addIssue({ code: 'custom', message: 'Scheduled search and ownership must come only from the server reservation' });
  } else if (input.action === 'website-check') {
    if (!input.jobId) context.addIssue({ code: 'custom', path: ['jobId'], message: 'website-check requires a queued job ID' });
    if (input.search || input.watchRules) context.addIssue({ code: 'custom', message: 'Website search and ownership must come from the queued database job' });
  } else if (input.action === 'monitor') {
    if (!input.watchRules) context.addIssue({ code: 'custom', path: ['watchRules'], message: 'monitor requires one watch rule' });
    if (input.search) context.addIssue({ code: 'custom', path: ['search'], message: 'Use watchRules for monitor' });
  } else {
    if (!input.search) context.addIssue({ code: 'custom', path: ['search'], message: 'check and test-email require search' });
    if (input.watchRules) context.addIssue({ code: 'custom', path: ['watchRules'], message: 'Use search for check or test-email' });
  }
  if (input.action !== 'website-check' && input.jobId) context.addIssue({ code: 'custom', path: ['jobId'], message: 'jobId is only supported for website-check' });
});
export type ActorInput = z.infer<typeof actorInputSchema>;
type MailConfig = ReturnType<typeof parseConfig>;
export interface ActorEmail extends NotificationSender {
  sendPriceTest(result: FlightPriceResult, id: string): Promise<'sent' | 'preview'>;
  readonly lastReceipt?: Readonly<EmailReceipt>;
}
export interface ActorDependencies {
  provider: FlightProvider;
  env: NodeJS.ProcessEnv;
  createEmail(options: MailConfig, recipient?: (alert: AlertRecord) => Promise<string>): ActorEmail;
  openRepository(rules: WatchRule[]): Promise<MonitorRepository>;
  openWebsiteJobs?(options: MailConfig): WebsiteJobs;
  openScheduledJobs?(options: MailConfig): ScheduledWebsiteJobs;
  runId?: string;
}
export interface ActorOutput {
  status: 'SUCCEEDED' | 'FAILED';
  action: ActorInput['action'];
  provider: 'google-flights';
  quote?: FlightPriceResult;
  job?: { id: string; status: 'succeeded' | 'failed' };
  scheduled?: { status: ScheduledNoopStatus | 'checked' | 'failed' };
  monitor?: { checked: number; failed: number; skipped: number };
  email: { status: 'not-requested' | 'preview' | 'accepted' | 'not-triggered'; receipt?: Readonly<EmailReceipt>; testId?: string };
}

function verifyQuote(quote: FlightPriceResult, search: FlightSearch): FlightPriceResult {
  if (quote.provider !== 'google-flights' || quote.priceBasis !== googleFlightsPriceBasis ||
      searchKey(quote) !== searchKey({ ...search, provider: 'google-flights' }) ||
      !Number.isFinite(quote.totalPrice) || quote.totalPrice <= 0 ||
      !Number.isFinite(Date.parse(quote.checkedAt)) || Math.abs(Date.now() - Date.parse(quote.checkedAt)) > 300000) {
    throw new Error('Google Flights returned a mismatched, invalid, or stale reference quote');
  }
  return quote;
}

export async function runActorInput(raw: unknown, dependencies: ActorDependencies): Promise<ActorOutput> {
  const input = actorInputSchema.parse(raw);
  if (dependencies.provider.name !== 'google-flights') throw new Error('Actor only supports Google Flights');
  const base = { action: input.action, provider: 'google-flights' as const };
  const scheduled = input.action === 'scheduled-check';
  const allowedEmails = scheduled ? [...new Set((dependencies.env.SCHEDULE_ALLOWED_EMAILS ?? '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean))] : [];
  // A disabled schedule must not need credentials, open a DB connection, launch a
  // browser, or instantiate a mail sender. A malformed nonempty list fails closed.
  if (scheduled && !allowedEmails.length) return { ...base, status: 'SUCCEEDED',
    scheduled: { status: 'disabled' }, email: { status: 'not-requested' } };
  if (scheduled) z.array(z.string().email()).min(1).parse(allowedEmails);
  // check is always a read-only operation, even if the deployment enables mail.
  const mode = input.action === 'test-email' ? 'send' : input.action === 'check' ? 'preview' : dependencies.env.EMAIL_MODE;
  const website = input.action === 'website-check' || scheduled;
  const options = parseConfig({ ...dependencies.env, STORAGE: website ? 'supabase' : 'local', DESKTOP_NOTIFY: 'false',
    ...(website ? { NOTIFICATION_TO_EMAIL: '' } : {}),
    EMAIL_MODE: mode, BROWSER_CHANNEL: 'chromium', BROWSER_HEADLESS: 'true', BROWSER_TIMEOUT_MS: '80000' });
  if (website) {
    if (!dependencies.runId || (scheduled ? !dependencies.openScheduledJobs : !dependencies.openWebsiteJobs)) throw new Error('Website worker is not configured');
    const jobs = scheduled ? dependencies.openScheduledJobs!(options) : dependencies.openWebsiteJobs!(options);
    let jobId = input.jobId;
    if (scheduled) {
      const reservation = await (jobs as ScheduledWebsiteJobs).reserveScheduled(allowedEmails);
      if (reservation.status !== 'reserved') return { ...base, status: 'SUCCEEDED',
        scheduled: { status: reservation.status }, email: { status: 'not-requested' } };
      jobId = reservation.jobId;
    }
    const claim = await jobs.claim(jobId!, dependencies.runId);
    let finished = false;
    let quote: FlightPriceResult | undefined;
    let email: ActorEmail | undefined;
    try {
      email = dependencies.createEmail(options, alert => jobs.recipient(claim, alert));
      const provider: FlightProvider = { name: dependencies.provider.name,
        search: async search => quote = verifyQuote(await dependencies.provider.search(search), search) };
      const summary = await new PriceService(jobs.repository(claim), email, [provider], options.EMAIL_MODE === 'send').runAllActiveRules();
      const emailStatus = email.lastReceipt ? 'accepted' : options.EMAIL_MODE === 'send' ? 'not-triggered' : 'preview';
      const succeeded = summary.checked === 1 && summary.failed === 0 && summary.skipped === 0;
      // Mark this attempt before awaiting storage: a lost response must not trigger another finish/mail.
      finished = true;
      await jobs.finish(claim, { status: succeeded ? 'succeeded' : 'failed',
        ...(quote ? { totalPrice: quote.totalPrice, currency: quote.currency } : {}), emailStatus,
        ...(!succeeded ? { errorCode: 'query-or-notification-failed' as const } : {}) });
      return { ...base, status: succeeded ? 'SUCCEEDED' : 'FAILED', quote,
        job: { id: claim.id, status: succeeded ? 'succeeded' : 'failed' }, monitor: summary,
        ...(scheduled ? { scheduled: { status: succeeded ? 'checked' as const : 'failed' as const } } : {}),
        email: { status: emailStatus } };
    } catch {
      if (!finished) await jobs.finish(claim, { status: 'failed', errorCode: 'worker-failed',
        emailStatus: email?.lastReceipt ? 'accepted' : options.EMAIL_MODE === 'send' ? 'not-triggered' : 'preview' });
      throw new Error('Website query or notification failed; this job will not be retried');
    }
  }
  if (input.action === 'monitor') {
    const email = dependencies.createEmail(options);
    const repository = await dependencies.openRepository(input.watchRules!);
    const summary = await new PriceService(repository, email, [dependencies.provider], options.EMAIL_MODE === 'send').runAllActiveRules();
    return { ...base, status: summary.failed ? 'FAILED' : 'SUCCEEDED', monitor: summary,
      email: email.lastReceipt ? { status: 'accepted', receipt: email.lastReceipt } :
        { status: options.EMAIL_MODE === 'send' ? 'not-triggered' : 'preview' } };
  }
  if (input.search!.departureDate < todayTaipei()) throw new Error('Departure date is in the past');
  const quote = verifyQuote(await dependencies.provider.search(input.search!), input.search!);
  if (input.action === 'check') return { ...base, status: 'SUCCEEDED', quote, email: { status: 'not-requested' } };
  const email = dependencies.createEmail(options);
  const testId = randomUUID();
  if (await email.sendPriceTest(quote, testId) !== 'sent' || !email.lastReceipt?.accepted) {
    throw new Error('Test mail was not confirmed as accepted');
  }
  return { ...base, status: 'SUCCEEDED', quote, email: { status: 'accepted', receipt: email.lastReceipt, testId } };
}
