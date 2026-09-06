/**
 * `output: 'standalone'` emits a self-contained server but, by design, leaves
 * static assets out of it. Copying them in makes `.next/standalone` a complete,
 * runnable artifact — which is what the E2E suite starts and what a non-Vercel
 * host would run (blueprint 22.1 portability).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const standalone = path.join(webRoot, '.next', 'standalone', 'apps', 'web');

if (!fs.existsSync(standalone)) {
  console.error('No standalone output found. Run "next build" first.');
  process.exit(1);
}

for (const [from, to] of [
  [path.join(webRoot, '.next', 'static'), path.join(standalone, '.next', 'static')],
  [path.join(webRoot, 'public'), path.join(standalone, 'public')],
]) {
  if (!fs.existsSync(from)) continue;
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  console.log(`copied ${path.relative(webRoot, from)} → ${path.relative(webRoot, to)}`);
}
