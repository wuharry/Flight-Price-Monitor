import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const directory = new URL('../artifacts/supabase-deploy/', import.meta.url);
await mkdir(directory, { recursive: true });
const output = new URL('index.ts', directory);
// Bundle only local modules; Supabase resolves the pinned npm import in its runtime.
await build({ entryPoints: [fileURLToPath(new URL('../supabase/functions/cloud-check/index.ts', import.meta.url))],
  outfile: fileURLToPath(output), bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  external: ['npm:*'], banner: { js: '// Flight Monitor cloud-check: local source bundled for the Supabase Dashboard editor.' } });
const bytes = await readFile(output);
const manifest = { file: 'index.ts', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
await writeFile(new URL('manifest.json', directory), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest));
