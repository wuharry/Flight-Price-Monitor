import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  STORAGE: z.enum(['local', 'supabase']).default('local'),
  DATA_DIR: z.string().default('.data'),
  WATCH_RULES_FILE: z.string().default('watch-rules.json'),
  SUPABASE_URL: z.string().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(''),
  EMAIL_MODE: z.enum(['preview', 'send']).default('preview'),
  EMAIL_PROVIDER: z.enum(['resend', 'gmail']).default('resend'),
  GMAIL_USER: z.string().default(''),
  GMAIL_APP_PASSWORD: z.string().default(''),
  RESEND_API_KEY: z.string().default(''),
  NOTIFICATION_FROM_EMAIL: z.string().default('Flight Monitor <alerts@example.com>'),
  NOTIFICATION_TO_EMAIL: z.string().default(''),
  MONITOR_INTERVAL_MINUTES: z.coerce.number().int().min(60).max(1440).default(180),
  BROWSER_CHANNEL: z.enum(['chromium', 'chrome', 'msedge']).default('chromium'),
  BROWSER_HEADLESS: z.enum(['true', 'false']).default('true'),
  BROWSER_TIMEOUT_MS: z.coerce.number().int().min(5000).max(120000).default(90000),
});
export function parseConfig(env: NodeJS.ProcessEnv) {
  const value = envSchema.parse({ ...env, SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY });
  if (value.STORAGE === 'supabase') {
    z.string().url().parse(value.SUPABASE_URL);
    if (!value.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
  }
  if (value.EMAIL_MODE === 'send') {
    if (value.EMAIL_PROVIDER === 'gmail') {
      z.string().email().parse(value.GMAIL_USER);
      if (!/^[a-z]{16}$/i.test(value.GMAIL_APP_PASSWORD.replace(/\s/g, ''))) throw new Error('GMAIL_APP_PASSWORD must be a 16-letter Google app password');
    } else {
      if (!value.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required for EMAIL_MODE=send');
      if (value.NOTIFICATION_FROM_EMAIL.includes('example.com')) throw new Error('Configure a verified sender domain');
    }
    if (value.NOTIFICATION_TO_EMAIL || value.STORAGE === 'local') z.string().email().parse(value.NOTIFICATION_TO_EMAIL);
  }
  return value;
}
export const config = parseConfig(process.env);
