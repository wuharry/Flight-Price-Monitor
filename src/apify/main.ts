import { Actor } from 'apify';
import { GoogleFlightsProvider } from '../providers/google-flights.js';
import { EmailService } from '../services/email.service.js';
import { ApifyRepository, RequestQueueMutex } from './repository.js';
import { runActorInput } from './runner.js';
import { createWebsiteJobs } from './website.js';

// No timer repeats work. This watchdog only terminates a stalled, single invocation.
await Actor.main(async () => {
  let outputWritten = false;
  const deadline = setTimeout(() => {
    console.error('[Actor] Single-run deadline exceeded; stopping before the monitor lease expires');
    process.exit(1);
  }, 165000);
  deadline.unref();
  try {
    const input = await Actor.getInput();
    const output = await runActorInput(input, {
      provider: new GoogleFlightsProvider({ channel: 'chromium', headless: true, timeoutMs: 80000,
        onError: async (page, stage) => {
          // This is a fresh signed-out context. Record only the public flight UI, never network bodies,
          // environment variables, browser storage, or the mail sender's credentials.
          const url = new URL(page.url());
          const safeUrl = new URL(url.origin + url.pathname);
          if (url.hostname === 'www.google.com') for (const key of ['tfs', 'tfu', 'curr', 'hl', 'gl']) {
            const value = url.searchParams.get(key); if (value) safeUrl.searchParams.set(key, value);
          }
          const text = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
          await Actor.setValue('PROVIDER-DIAGNOSTICS', { stage, url: safeUrl.href, text: text.slice(0, 16000) });
          const screenshot = await page.screenshot({ timeout: 1000 }).catch(() => undefined);
          if (screenshot) await Actor.setValue('PROVIDER-DIAGNOSTICS.png', screenshot, { contentType: 'image/png' });
        } }),
      env: process.env,
      createEmail: (options, recipient) => new EmailService(options, fetch, recipient),
      runId: Actor.getEnv().actorRunId ?? undefined,
      openWebsiteJobs: createWebsiteJobs,
      openRepository: async rules => {
        const suffix = (process.env.APIFY_ACTOR_ID ?? 'local').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 30);
        const name = `flight-monitor-google-flights-v1-${suffix}`;
        const store = await Actor.openKeyValueStore({ name });
        const queue = await Actor.openRequestQueue({ name: `${name}-lock` });
        return new ApifyRepository(store, new RequestQueueMutex(queue), rules);
      },
    });
    await Actor.setValue('OUTPUT', output);
    outputWritten = true;
    await Actor.pushData({ status: output.status, action: output.action, provider: output.provider,
      origin: output.quote?.origin, destination: output.quote?.destination,
      departureDate: output.quote?.departureDate, returnDate: output.quote?.returnDate,
      adults: output.quote?.adults, totalPrice: output.quote?.totalPrice, currency: output.quote?.currency,
      priceBasis: output.quote?.priceBasis, emailStatus: output.email.status,
      testId: output.email.testId, monitor: output.monitor, job: output.job })
      .catch(() => console.warn('[Actor] Summary table unavailable; complete result remains in OUTPUT'));
    console.log('[Actor result]', JSON.stringify({ status: output.status, action: output.action, provider: output.provider,
      totalPrice: output.quote?.totalPrice, priceBasis: output.quote?.priceBasis,
      monitor: output.monitor, emailStatus: output.email.status, testId: output.email.testId,
      messageId: output.email.receipt?.messageId, accepted: output.email.receipt?.accepted }));
    if (output.status !== 'SUCCEEDED') throw new Error('A monitoring query or notification failed; see OUTPUT');
  } catch {
    // Browser, SMTP and SDK errors may contain URLs or credentials. Keep cloud output generic.
    const failure = { status: 'FAILED', message: 'Input validation, cloud access, quote verification, storage, or notification failed. No success is claimed.' };
    if (!outputWritten) await Actor.setValue('OUTPUT', failure);
    await Actor.setValue('FAILURE', failure);
    throw new Error('Single-run action failed. Review input, Secret configuration, provider access, and OUTPUT/FAILURE.');
  } finally { clearTimeout(deadline); }
});
