import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';
let client: SupabaseClient | undefined;
export function getSupabaseClient(): SupabaseClient {
  if (config.STORAGE !== 'supabase') throw new Error('Supabase storage not enabled');
  return client ??= createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30000) }) },
  });
}
