import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, 'artifacts/apify-deploy');
await mkdir(resolve(output, 'src'), { recursive: true });
await mkdir(resolve(output, '.actor'), { recursive: true });
const notices = await readFile(resolve(root, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
// An explicit allowlist keeps .env, local databases, and unrelated project files out of deployment.
await build({ entryPoints: [resolve(root, 'src/apify/main.ts')], outfile: resolve(output, 'src/main.js'),
  bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node24',
  banner: { js: `/*\n${notices.replaceAll('*/', '* /')}\n*/` } });
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const locked = { '@supabase/supabase-js': '2.117.1', apify: '3.7.2', dotenv: '16.6.1', nodemailer: '10.0.10', 'playwright-core': '1.63.0', zod: '3.25.76' };
for (const name of Object.keys(locked)) if (!pkg.dependencies[name]) throw new Error(`Missing runtime dependency ${name}`);
await writeFile(resolve(output, 'package.json'), JSON.stringify({ name: 'flight-monitor-google-flights', version: '1.0.0',
  private: true, type: 'module', scripts: { start: 'node src/main.js' }, dependencies: locked }, null, 2) + '\n');
await writeFile(resolve(output, 'Dockerfile'), `FROM apify/actor-node-playwright-chrome:24-1.63.0-slim@sha256:cbbf90af87e417e1f5da0a53cfa57e5d9a3073458308b9722009ee924c7d345c
WORKDIR /home/myuser
ENV NODE_OPTIONS="--max-old-space-size=512 --max-http-header-size=80000"
COPY --chown=myuser:myuser package.json ./
RUN npm install --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund
COPY --chown=myuser:myuser src/main.js ./src/main.js
CMD ["node", "src/main.js"]
`);
const actor = JSON.parse(await readFile(resolve(root, '.actor/actor.json'), 'utf8'));
actor.dockerfile = '../Dockerfile';
actor.readme = '../README.md';
await writeFile(resolve(output, '.actor/actor.json'), JSON.stringify(actor, null, 2) + '\n');
await writeFile(resolve(output, '.actor/input_schema.json'), await readFile(resolve(root, '.actor/input_schema.json')));
await writeFile(resolve(output, 'README.md'), await readFile(resolve(root, 'docs/APIFY.md')));
const files = ['src/main.js', 'package.json', 'Dockerfile', '.actor/actor.json', '.actor/input_schema.json', 'README.md'];
const manifest = [];
for (const path of files) {
  const bytes = await readFile(resolve(output, path));
  manifest.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ output, files: manifest }, null, 2));
