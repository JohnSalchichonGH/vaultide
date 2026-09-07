#!/usr/bin/env node
/**
 * Proves the Sentry integration end to end (blueprint 18.2).
 *
 *   SENTRY_DSN=… node --import tsx scripts/ops/verify-sentry.mjs
 *
 * Builds an event carrying exactly what must never leave the process — a
 * request body with balances, a query string with a token, cookies, network
 * breadcrumbs, extra context, and a user's email and IP — runs it through the
 * **real** `scrubEvent` the application uses, asserts none of it survived, and
 * posts the result to Sentry's ingest endpoint.
 *
 * The envelope is sent directly rather than through the SDK: this script runs
 * outside Next.js, and what matters is the rule and the endpoint, not the
 * transport. The unit tests cover the rule in isolation; this shows what a live
 * project actually receives.
 */
import { randomUUID } from 'node:crypto';
import { scrubEvent } from '@vaultide/application/observability';

const dsn = process.env.SENTRY_DSN;
if (!dsn) {
  console.error('SENTRY_DSN is required (the DSN is public; it ships in the client bundle).');
  process.exit(1);
}

/** `https://<key>@<host>/<projectId>` */
const parsed = new URL(dsn);
const publicKey = parsed.username;
const projectId = parsed.pathname.replace(/^\//u, '');
const ingestUrl = `${parsed.origin}/api/${projectId}/envelope/`;

/** Values that must never reach Sentry. If any appears, the check fails. */
const FORBIDDEN = {
  balance: '8055.00',
  netWorth: '12345678901234567.89',
  email: 'someone@example.com',
  ip: '203.0.113.44',
  token: 'super-secret-token',
  cookie: 'session=abc123',
};

const eventId = randomUUID().replace(/-/gu, '');
const event = {
  event_id: eventId,
  timestamp: Date.now() / 1000,
  platform: 'node',
  level: 'error',
  environment: 'verification',
  release: process.env.GITHUB_SHA ?? 'local',
  exception: {
    values: [
      {
        type: 'VaultideVerification',
        value: 'Sentry verification — expected, safe to resolve',
      },
    ],
  },
  user: { id: 'user-1', email: FORBIDDEN.email, ip_address: FORBIDDEN.ip },
  extra: { balance: FORBIDDEN.balance, netWorth: FORBIDDEN.netWorth },
  contexts: { state: { store: { balance: FORBIDDEN.balance } }, runtime: { name: 'node' } },
  breadcrumbs: [
    { category: 'fetch', message: `GET /api/positions?token=${FORBIDDEN.token}` },
    { category: 'console', message: `balance ${FORBIDDEN.balance}` },
    { category: 'navigation', message: '/monthly/2026-09' },
  ],
  request: {
    url: `https://vaultide.vercel.app/monthly/2026-09?token=${FORBIDDEN.token}`,
    data: { amount: FORBIDDEN.balance },
    query_string: `token=${FORBIDDEN.token}`,
    cookies: FORBIDDEN.cookie,
    headers: { Cookie: FORBIDDEN.cookie, 'User-Agent': 'verify-sentry' },
  },
};

const scrubbed = scrubEvent(event);
if (scrubbed === null) {
  console.error('The event was dropped entirely — unexpected for a non-domain error.');
  process.exit(1);
}

const serialized = JSON.stringify(scrubbed);

console.log('Scrubbing:');
let failures = 0;
const check = (name, ok) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) failures += 1;
};

for (const [name, value] of Object.entries(FORBIDDEN)) {
  check(`${name} removed`, !serialized.includes(value));
}
check('request body removed', scrubbed.request?.data === undefined);
check('query string removed', scrubbed.request?.query_string === undefined);
check('cookies removed', scrubbed.request?.cookies === undefined);
check('url keeps only its path', scrubbed.request?.url?.includes('?') !== true);
check('extra context removed', scrubbed.extra === undefined);
check('UI state context removed', scrubbed.contexts?.state === undefined);
check(
  'network and console breadcrumbs removed',
  (scrubbed.breadcrumbs ?? []).every((crumb) => !['fetch', 'console'].includes(crumb.category)),
);
check('user reduced to an id', JSON.stringify(scrubbed.user) === JSON.stringify({ id: 'user-1' }));

if (failures > 0) {
  console.error('');
  console.error(`${failures} scrubbing check(s) failed — nothing was sent.`);
  process.exit(1);
}

const envelope = [
  JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn }),
  JSON.stringify({ type: 'event' }),
  serialized,
].join('\n');

const response = await fetch(ingestUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-sentry-envelope',
    'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${publicKey}, sentry_client=vaultide-verify/1.0`,
  },
  body: envelope,
});

console.log('');
console.log('Delivery:');
console.log(`  endpoint ${ingestUrl}`);
console.log(`  status   ${response.status} ${response.statusText}`);

if (!response.ok) {
  console.error(await response.text());
  process.exit(1);
}

console.log(`  event id ${eventId}`);
console.log('');
console.log('Sentry receives events, and receives nothing it should not.');
