import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { access, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const out = 'exe-dist';
// Rebuild in place. The folder holds the operator's .env, watch-rules.json and price history,
// so only the generated files are replaced.
await mkdir(out, { recursive: true });
await rm(join(out, 'node_modules/playwright-core'), { recursive: true, force: true });

// The executable is launched from wherever the scheduler happens to sit, so dotenv, WATCH_RULES_FILE
// and DATA_DIR would resolve against the wrong directory. Move to the executable's own folder first.
const banner = `const __p = require('node:path');
const __runner = __p.basename(process.execPath).replace(/\\.exe$/i, '').toLowerCase();
process.chdir(process.env.MONITOR_HOME || (__runner === 'node' || __runner === 'bun'
  ? __dirname : __p.dirname(process.execPath)));`;

await build({
  entryPoints: ['src/index.ts'],
  bundle: true, platform: 'node', target: 'node22', format: 'cjs',
  outfile: join(out, 'monitor.cjs'),
  // playwright-core reads driver and protocol files from its own package directory at run time;
  // bundling it rewrites those paths and the browser never launches. Ship the package as-is.
  external: ['playwright-core'],
  banner: { js: banner },
  logLevel: 'info',
});

const require_ = createRequire(import.meta.url);
let root = dirname(require_.resolve('playwright-core'));
while (!(await access(join(root, 'package.json')).then(() => true, () => false))) {
  const parent = dirname(root);
  if (parent === root) throw new Error('Cannot locate the playwright-core package root');
  root = parent;
}
await cp(root, join(out, 'node_modules/playwright-core'), { recursive: true, dereference: true });

for (const name of ['.env.example', 'watch-rules.example.json']) {
  await cp(name, join(out, name)).catch(() => console.warn(`[build:exe] ${name} not found; skipped`));
}
await writeFile(join(out, 'README.txt'), `Flight Price Monitor - portable build

Run it as-is:
  node monitor.cjs --run-once

Compile a Windows executable (needs Bun, cross-compiles from macOS):
  bun build --compile --target=bun-windows-x64 --external chromium-bidi monitor.cjs --outfile monitor.exe

--external chromium-bidi is required: playwright-core references that optional module on a code path
this monitor never takes, and the compiler fails on it otherwise. With it, playwright-core is compiled
into the executable and node_modules does not need to ship. Drop --external playwright-core in instead
if you would rather keep the package on disk beside a smaller executable.

Before the first run, copy .env.example to .env and watch-rules.example.json to watch-rules.json,
then set in .env:
  BROWSER_CHANNEL=msedge     uses the Edge already installed on Windows; no browser is bundled
  BROWSER_HEADLESS=true      start here, switch to false only if Tigerair answers Access Denied
  STORAGE=local              never ship SUPABASE_SERVICE_ROLE_KEY inside a distributed build

Schedule it with Task Scheduler calling monitor.exe --run-once, not the resident loop:
the scheduler catches up after sleep, a long-running process does not.
`);
console.log(`[build:exe] ${out} is ready (config files are read from the executable's folder).`);
