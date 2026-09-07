#!/usr/bin/env node
/**
 * Reconcile the seeded FX-supported currency set against the provider's own
 * list (blueprint 10.4, Phase 1: "reconcile the existing `is_fx_supported`
 * assumption against the provider-supported currency set").
 *
 *   node scripts/db/verify-currencies.mjs
 *
 * It reads the committed seed — not the database — so it answers the question
 * that matters for a release: does what we are about to ship still match what
 * the central banks publish? It exits non-zero on any divergence, so it can run
 * in CI, and it changes nothing: adding or removing a currency is a migration
 * and a decision, not a job's side effect.
 *
 * `FX_PROVIDER_URL` overrides the endpoint; the default is Frankfurter's.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseUrl = (process.env.FX_PROVIDER_URL ?? 'https://api.frankfurter.dev/v1').replace(
  /\/+$/,
  '',
);

/** The seed is TypeScript; Node's type stripping reads it without a build. */
function seededCodes() {
  // A `file://` URL, not a path: on Windows an absolute path is not a valid
  // ESM specifier, and `C:` reads as an unsupported URL scheme.
  const seedUrl = pathToFileURL(path.join(repoRoot, 'packages/db/src/seed/currencies.ts')).href;
  const script = `
    import { currencySeed } from ${JSON.stringify(seedUrl)};
    process.stdout.write(
      JSON.stringify(currencySeed.filter((row) => row.isFxSupported).map((row) => row.code)),
    );
  `;
  const output = execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      // The stripping notice is noise here; the script's own output is the report.
      '--no-warnings=ExperimentalWarning',
      '--input-type=module',
      '--eval',
      script,
    ],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return JSON.parse(output);
}

async function providerCodes() {
  const response = await fetch(`${baseUrl}/currencies`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`The rate provider answered ${response.status}.`);
  }
  return Object.keys(await response.json()).map((code) => code.toUpperCase());
}

const seeded = new Set(seededCodes());
const provider = new Set(await providerCodes());

const missingFromProvider = [...seeded].filter((code) => !provider.has(code)).sort();
const missingFromSeed = [...provider].filter((code) => !seeded.has(code)).sort();

console.log(`provider (${baseUrl}): ${String(provider.size)} currencies`);
console.log(`seed (is_fx_supported):  ${String(seeded.size)} currencies`);

if (missingFromProvider.length === 0 && missingFromSeed.length === 0) {
  console.log('In sync.');
  process.exit(0);
}

if (missingFromProvider.length > 0) {
  console.error(
    `\nFlagged FX-supported in the seed but not published by the provider: ${missingFromProvider.join(', ')}`,
  );
  console.error(
    'These cannot be converted. Set is_fx_supported = false in packages/db/src/seed/currencies.ts',
  );
  console.error('and re-run the seed, so they stop being offered as base or reporting currencies.');
}

if (missingFromSeed.length > 0) {
  console.error(
    `\nPublished by the provider but not flagged FX-supported in the seed: ${missingFromSeed.join(', ')}`,
  );
  console.error('Add them (with their real ISO 4217 minor units) to offer them to users.');
}

process.exit(1);
