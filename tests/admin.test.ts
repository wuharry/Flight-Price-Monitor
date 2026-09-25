import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAdmin } from '../src/admin/server.js';

test('admin authenticates, protects secrets, validates and persists editable rules', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flight-admin-'));
  const { server, token, url } = await startAdmin(dir, 0);
  const base = url.split('/#')[0];
  const call = (path: string, body?: unknown, extra = {}) => fetch(base + '/api/' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await fetch(base + '/api/settings')).status, 403);
    assert.equal((await call('settings', {}, { Origin: 'https://evil.example' })).status, 403);
    const settings = { PROJECT_ID: 'flight-test-123', REGION: 'asia-east1', STORAGE: 'local', SUPABASE_URL: 'https://testproject.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-secret-only', RESEND_API_KEY: 'test-resend-only', NOTIFICATION_FROM_EMAIL: 'Flight <onboarding@resend.dev>', NOTIFICATION_TO_EMAIL: 'test@example.com', EMAIL_MODE: 'preview' };
    assert.equal((await call('settings', settings)).status, 200);
    const read = await (await call('settings')).text();
    assert.ok(!read.includes('test-secret-only') && !read.includes('test-resend-only'));
    assert.equal((await call('settings', { ...settings, SUPABASE_SERVICE_ROLE_KEY: '', RESEND_API_KEY: '' })).status, 200);
    assert.match(await readFile(join(dir, '.env'), 'utf8'), /test-secret-only/);
    assert.equal((await call('settings', { ...settings, SUPABASE_URL: 'https://supabase.com/dashboard/project/foo' })).status, 400);
    const rule = { origin: 'TPE', destination: 'NRT', departureDate: '2027-02-10', adults: 1, targetPrice: 6500, enabled: true };
    assert.equal((await call('rules', { ...rule, returnDate: '2027-02-09' })).status, 400);
    const response = await call('rules', rule);
    assert.equal(response.status, 200);
    const created = await response.json() as { id: string };
    assert.equal((await call('rules', { ...rule, id: created.id, enabled: false })).status, 200);
    const list = await (await call('rules')).json() as { rules: { enabled: boolean }[] };
    assert.equal(list.rules.length, 1);
    assert.equal(list.rules[0].enabled, false);
  } finally { await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); }
});
