import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
const url = process.env.SUPABASE_URL || 'https://dejudisyuvkdkshnykog.supabase.co';
const key = process.env.SUPABASE_PUBLISHABLE_KEY || '';
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url)) throw new Error('Invalid SUPABASE_URL');
if (!key) throw new Error('Set SUPABASE_PUBLISHABLE_KEY in GitHub Actions repository Variables. Never use service_role/secret key.');
if (!key.startsWith('sb_publishable_')) {
  let role;
  try { role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role; } catch {}
  if (role !== 'anon') throw new Error('Only a publishable or anon key may be included in the website');
}
await mkdir('web-dist', { recursive: true });
await build({ entryPoints: ['web/app.js'], bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: 'web-dist/app.js', define: { __SUPABASE_URL__: JSON.stringify(url), __SUPABASE_KEY__: JSON.stringify(key) } });
await copyFile('web/index.html', 'web-dist/index.html');
await copyFile('web/style.css', 'web-dist/style.css');
await writeFile('web-dist/.nojekyll', '');
console.log('Website built in web-dist (public credentials only).');
