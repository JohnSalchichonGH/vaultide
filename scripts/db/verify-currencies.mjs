#!/usr/bin/env node
/**
 * Reconcile the seeded FX-supported currency set against Vaultide's **approved
 * FX source chain** (blueprint 10.1, 10.4, Phase 1: "reconcile the existing
 * `is_fx_supported` assumption against the provider-supported currency set").
 *
 *   node scripts/db/verify-currencies.mjs
 *
 * ## What is being verified, and against what
 *
 * The committed seed — not the database — so it answers the question that
 * matters for a release: does what we are about to ship still match what our
 * approved sources publish? It exits non-zero on any divergence, so it can run
 * in CI, and it changes nothing: adding or removing a currency is a migration
 * and a decision, not a job's side effect.
 *
 * The comparison is against the **policy**, which for Phase 1 is the chain
 * `ECB -> BDI`, and **not** against everything Frankfurter v2 can serve. v2
 * aggregates 84 central banks and covers codes the approved chain does not
 * (RUB and BYN among them, via the CBR and the NBRB); those are outside the
 * policy by choice, and a divergence reported here always means the seed and
 * the approved chain disagree — never that the API lacks a currency.
 *
 * The provider side is not reimplemented here. The script drives the same
 * adapter the runtime uses, so "the universe" means exactly what
 * `FxService.reconcileSupportedCurrencies()` means: the currencies the approved
 * chain actually publishes a current rate for, restricted to ISO 4217 money.
 *
 * `FX_PROVIDER_URL` overrides the endpoint; the default is Frankfurter v2's.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Read a value out of the TypeScript sources.
 *
 * Both the seed and the provider adapter are TypeScript, and the packages use
 * extensionless relative imports (ADR 0001: they are consumed by bundlers, not
 * by bare Node), so this runs through `tsx` — the same loader
 * `pnpm db:migrate` uses. A child process keeps the loader flag out of this one.
 */
function fromSource(script) {
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return JSON.parse(output);
}

// `file://` URLs, not paths: on Windows an absolute path is not a valid ESM
// specifier, and `C:` reads as an unsupported URL scheme.
const url = (relative) => pathToFileURL(path.join(repoRoot, relative)).href;

function seededCodes() {
  return fromSource(`
    import { currencySeed } from ${JSON.stringify(url('packages/db/src/seed/currencies.ts'))};
    process.stdout.write(
      JSON.stringify(currencySeed.filter((row) => row.isFxSupported).map((row) => row.code)),
    );
  `);
}

function providerCodes() {
  const override = process.env.FX_PROVIDER_URL;
  return fromSource(`
    import { createFrankfurterProvider } from ${JSON.stringify(
      url('packages/application/src/fx/frankfurter.ts'),
    )};
    const provider = createFrankfurterProvider(${
      override === undefined || override === '' ? '{}' : `{ baseUrl: ${JSON.stringify(override)} }`
    });
    process.stdout.write(JSON.stringify(await provider.supportedCurrencies()));
  `);
}

const seeded = new Set(seededCodes());
const provider = new Set(providerCodes());

const missingFromProvider = [...seeded].filter((code) => !provider.has(code)).sort();
const missingFromSeed = [...provider].filter((code) => !seeded.has(code)).sort();

console.log(`approved chain (ECB -> BDI, via Frankfurter v2): ${String(provider.size)} currencies`);
console.log(`seed (is_fx_supported):                        ${String(seeded.size)} currencies`);

if (missingFromProvider.length === 0 && missingFromSeed.length === 0) {
  console.log('In sync.');
  process.exit(0);
}

if (missingFromProvider.length > 0) {
  console.error(
    `\nFlagged FX-supported in the seed but not published by the chain: ${missingFromProvider.join(', ')}`,
  );
  console.error(
    'These cannot be converted. Set isFxSupported = false in packages/db/src/seed/currencies.ts',
  );
  console.error('and re-run the seed, so they stop being offered as base or reporting currencies.');
}

if (missingFromSeed.length > 0) {
  console.error(
    `\nPublished by the chain but not flagged FX-supported in the seed: ${missingFromSeed.join(', ')}`,
  );
  console.error('Add them (with their real ISO 4217 minor units) to offer them to users.');
}

process.exit(1);
