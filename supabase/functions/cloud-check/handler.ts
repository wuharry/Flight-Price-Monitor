// This handler never accepts Actor input or an email address from the browser.
// All credentials and quota decisions stay in the server-side function/database.
interface User { id: string; email?: string; email_confirmed_at?: string }
interface RpcResult { data: unknown; error: { message: string } | null }
export interface CloudCheckDependencies {
  getUser(token: string): Promise<{ data: { user: User | null }; error: unknown }>;
  rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcResult>;
  fetch: typeof fetch;
  actorId: string;
  actorToken: string;
  actorBuild: string;
  allowedEmails: string[];
  allowedOrigins: string[];
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reservationErrors: Record<string, number> = {
  cloud_check_not_allowed: 403, cloud_check_busy: 409, cloud_check_cooldown: 429,
  cloud_check_daily_limit: 429, cloud_check_monthly_limit: 429,
};

export function createCloudCheckHandler(deps: CloudCheckDependencies) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin');
    const allowedOrigin = origin !== null && deps.allowedOrigins.includes(origin);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
    if (allowedOrigin) {
      headers['Access-Control-Allow-Origin'] = origin!;
      headers['Access-Control-Allow-Headers'] = 'authorization, apikey, content-type, x-client-info';
      headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    }
    const response = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers });
    if (origin && !allowedOrigin) return response(403, { error: 'origin_not_allowed' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return response(405, { error: 'method_not_allowed' });
    if (!deps.actorToken || !/^[A-Za-z0-9_-]{1,80}$/.test(deps.actorId) || !/^[A-Za-z0-9._-]{1,32}$/.test(deps.actorBuild) || !deps.allowedEmails.length) {
      return response(503, { error: 'cloud_check_not_configured' });
    }
    const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1];
    if (!token) return response(401, { error: 'sign_in_required' });
    try {
      // getUser validates the JWT with Supabase Auth; decoding JWT claims is insufficient.
      const auth = await deps.getUser(token);
      const user = auth.data.user;
      if (auth.error || !user) return response(401, { error: 'sign_in_required' });
      if (!user.email_confirmed_at || !user.email || !deps.allowedEmails.includes(user.email.toLowerCase())) {
        return response(403, { error: 'account_not_allowed' });
      }
      const rawBody = await request.text();
      if (rawBody.length > 512) return response(400, { error: 'invalid_request' });
      let body: unknown;
      try { body = JSON.parse(rawBody); } catch { return response(400, { error: 'invalid_request' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 ||
          !('ruleId' in body) || typeof body.ruleId !== 'string' || !uuidPattern.test(body.ruleId)) {
        return response(400, { error: 'invalid_request' });
      }
      // SQL independently verifies current ownership, confirmed email, enabled provider,
      // and the account-wide active/cooldown/day/month limits under an atomic lock.
      const reservation = await deps.rpc('reserve_cloud_check_job', {
        p_rule_id: body.ruleId, p_user_id: user.id, p_allowed_emails: deps.allowedEmails,
      });
      if (reservation.error) {
        const code = Object.keys(reservationErrors).find(value => reservation.error!.message === value);
        return response(code ? reservationErrors[code] : 503, { error: code ?? 'cloud_check_unavailable' });
      }
      const job = reservation.data as { jobId?: unknown; status?: unknown; expiresAt?: unknown; remainingToday?: unknown; remainingMonth?: unknown } | null;
      if (!job || typeof job.jobId !== 'string' || !uuidPattern.test(job.jobId)) return response(503, { error: 'cloud_check_unavailable' });
      const accepted = { jobId: job.jobId, status: 'reserved', expiresAt: job.expiresAt,
        remainingToday: job.remainingToday, remainingMonth: job.remainingMonth };
      // Exactly one dispatch attempt. The reservation is never refunded, even on uncertainty.
      let started: Response;
      try {
        const url = new URL(`https://api.apify.com/v2/acts/${encodeURIComponent(deps.actorId)}/runs`);
        url.searchParams.set('build', deps.actorBuild);
        url.searchParams.set('memory', '1024');
        url.searchParams.set('timeout', '180');
        started = await deps.fetch(url, { method: 'POST', signal: AbortSignal.timeout(15000),
          headers: { Authorization: `Bearer ${deps.actorToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'website-check', provider: 'google-flights', jobId: job.jobId }) });
      } catch {
        return response(202, { ...accepted, dispatch: 'unconfirmed' });
      }
      if (!started.ok) {
        // Only a definite client rejection is terminal. 5xx/429 remain uncertain; never retry.
        if ([400, 401, 403, 404, 422].includes(started.status)) {
          await deps.rpc('reject_cloud_check_job', { p_job_id: job.jobId });
          return response(202, { ...accepted, status: 'failed', dispatch: 'rejected' });
        }
        return response(202, { ...accepted, dispatch: 'unconfirmed' });
      }
      let result: unknown;
      try { result = await started.json(); } catch { return response(202, { ...accepted, dispatch: 'unconfirmed' }); }
      const runId = (result as { data?: { id?: unknown } } | null)?.data?.id;
      if (typeof runId !== 'string' || !/^[A-Za-z0-9]{1,80}$/.test(runId)) return response(202, { ...accepted, dispatch: 'unconfirmed' });
      // The worker may already have claimed/finished before this response. SQL only accepts its matching run.
      await deps.rpc('set_cloud_check_run', { p_job_id: job.jobId, p_run_id: runId });
      return response(202, { ...accepted, dispatch: 'started' });
    } catch {
      return response(503, { error: 'cloud_check_unavailable' });
    }
  };
}
