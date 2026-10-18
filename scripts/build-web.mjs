import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
const bundle = await build({ entryPoints: ['web/app.js'], bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, define: { __SUPABASE_URL__: JSON.stringify(url), __SUPABASE_KEY__: JSON.stringify(key) } });
const content = bundle.outputFiles[0].contents;
const digest = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const scriptName = `app.${digest(content)}.js`;
await writeFile(`web-dist/${scriptName}`, content);
await writeFile('web-dist/app.js', content);
const guideVersion = digest(await readFile('web/flight-monitor-guide.pdf'));
const html = (await readFile('web/index.html', 'utf8'))
  .replace('src="./app.js"', `src="./${scriptName}"`)
  .replace('href="./flight-monitor-guide.pdf"', `href="./flight-monitor-guide.pdf?v=${guideVersion}"`);
await writeFile('web-dist/index.html', html);
await copyFile('web/style.css', 'web-dist/style.css');
await copyFile('web/flight-monitor-guide.pdf', 'web-dist/flight-monitor-guide.pdf');
await writeFile('web-dist/.nojekyll', '');
console.log('Website built in web-dist (public credentials only).');
