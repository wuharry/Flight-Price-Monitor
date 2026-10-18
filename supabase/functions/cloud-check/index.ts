import { createClient } from 'npm:@supabase/supabase-js@2.117.1';
import { createCloudCheckHandler } from './handler.ts';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const publicKey = Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const authClient = createClient(url, publicKey, { auth: { persistSession: false, autoRefreshToken: false } });
const serviceClient = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const list = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);

// Keep platform JWT verification enabled. Publishable keys belong in apikey;
// Authorization contains the signed-in user's JWT, rechecked here with auth.getUser.
Deno.serve(createCloudCheckHandler({
  getUser: token => authClient.auth.getUser(token),
  rpc: (name, args) => serviceClient.rpc(name, args),
  fetch,
  actorId: Deno.env.get('APIFY_CLOUD_CHECK_ACTOR_ID') ?? '',
  actorToken: Deno.env.get('APIFY_CLOUD_CHECK_TOKEN') ?? '',
  actorBuild: Deno.env.get('APIFY_CLOUD_CHECK_BUILD') ?? 'latest',
  allowedEmails: list(Deno.env.get('CLOUD_CHECK_ALLOWED_EMAILS') ?? '').map(value => value.toLowerCase()),
  allowedOrigins: list(Deno.env.get('CLOUD_CHECK_ALLOWED_ORIGINS') ?? 'https://wuharry.github.io'),
}));
