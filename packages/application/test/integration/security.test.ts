import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withoutUser } from '@vaultide/db';
import { createAuthClient, tokenFromUrl } from '../helpers/auth-client';
import { createHarness, TEST_BASE_URL, type Harness } from '../helpers/harness';
import { AUTH_RATE_LIMITS, AUTH_RATE_LIMIT_DEFAULT } from '../../src/auth/config';
import { scrubEvent } from '../../src/observability';

/**
 * The Phase 1 security suite (blueprint 17.3, 18.2, 21.4).
 *
 * Rate limiting runs with `rateLimitEnabled: true`, because Better Auth
 * otherwise only enables it in production — a limit that is off wherever it
 * could be checked has not been checked.
 */

const PASSWORD = 'correct-horse-battery-staple-2026';

let harness: Harness;

function unique(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}@example.test`;
}

beforeAll(async () => {
  harness = await createHarness({ rateLimitEnabled: true });
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  // The counters are rows (17.1 `storage: 'database'`), so one case's attempts
  // would otherwise still be counted against the next. Cleared as the owner.
  await harness.asOwner('DELETE FROM rate_limit');
});

describe('authentication rate limits (17.1, 17.3)', () => {
  it('stops repeated sign-in attempts after five in a minute', async () => {
    const client = createAuthClient(harness.services.auth, TEST_BASE_URL);
    const email = unique('bruteforce');

    const statuses: number[] = [];
    for (let attempt = 0; attempt < AUTH_RATE_LIMITS['/sign-in/email'].max + 2; attempt += 1) {
      const response = await client.post('/sign-in/email', { email, password: 'wrong-password-1' });
      statuses.push(response.status);
    }

    // Wrong credentials all the way through, then the limiter takes over.
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    expect(statuses.slice(0, AUTH_RATE_LIMITS['/sign-in/email'].max)).not.toContain(429);
    expect(statuses.at(-1)).toBe(429);
  });

  it('limits sign-ups more tightly than sign-ins, over a longer window', async () => {
    const client = createAuthClient(harness.services.auth, TEST_BASE_URL);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < AUTH_RATE_LIMITS['/sign-up/email'].max + 1; attempt += 1) {
      const response = await client.post('/sign-up/email', {
        name: 'Test',
        email: unique('signup-limit'),
        password: PASSWORD,
      });
      statuses.push(response.status);
    }

    expect(statuses.at(-1)).toBe(429);
    expect(AUTH_RATE_LIMITS['/sign-up/email']).toEqual({ window: 600, max: 3 });
  });

  it('limits password-reset requests, which are the enumeration surface', async () => {
    const client = createAuthClient(harness.services.auth, TEST_BASE_URL);

    const statuses: number[] = [];
    for (
      let attempt = 0;
      attempt < AUTH_RATE_LIMITS['/request-password-reset'].max + 1;
      attempt += 1
    ) {
      const response = await client.post('/request-password-reset', {
        email: unique('reset-limit'),
        redirectTo: `${TEST_BASE_URL}/reset`,
      });
      statuses.push(response.status);
    }

    expect(statuses.at(-1)).toBe(429);
    expect(AUTH_RATE_LIMITS['/request-password-reset']).toEqual({ window: 900, max: 3 });
  });

  it('keeps the counters in the database, so they survive a cold start', async () => {
    const client = createAuthClient(harness.services.auth, TEST_BASE_URL);
    await client.post('/sign-in/email', { email: unique('stored'), password: 'wrong-password-1' });

    // 17.1 `storage: 'database'`. On a serverless host an in-memory counter
    // resets with every new instance and enforces nothing.
    const rows = await withoutUser(harness.db, async (tx) =>
      tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM rate_limit`),
    );
    expect(Number(rows.rows[0]?.n)).toBeGreaterThan(0);
  });

  it('carries the blueprint’s route-specific limits and default', () => {
    expect(AUTH_RATE_LIMIT_DEFAULT).toEqual({ window: 60, max: 30 });
    expect(AUTH_RATE_LIMITS['/sign-in/email']).toEqual({ window: 60, max: 5 });
    expect(AUTH_RATE_LIMITS['/two-factor/verify-totp']).toEqual({ window: 300, max: 5 });
  });
});

describe('logging never carries a secret (18.2)', () => {
  it('logs no password, token, email body or financial value during a full sign-up', async () => {
    const client = createAuthClient(harness.services.auth, TEST_BASE_URL);
    const email = unique('redaction');
    harness.logLines.length = 0;
    harness.mailer.clear();

    await client.post('/sign-up/email', { name: 'Redaction Test', email, password: PASSWORD });
    const verification = harness.mailer.latestFor(email, 'verification');
    const token = tokenFromUrl(verification?.text ?? '');
    await client.get(`/verify-email?token=${encodeURIComponent(token)}`);

    const logs = harness.logLines.join('\n');

    // The credential, the single-use token and the message body are the three
    // things that must never be recoverable from a log line.
    expect(logs).not.toContain(PASSWORD);
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(verification?.html ?? '<no html>');
    expect(logs).not.toContain('Confirm my email address');
  });

  it('drops request bodies, query strings and cookies before an event leaves the process', () => {
    const event = scrubEvent({
      request: {
        url: 'https://vaultide.app/settings/currencies?token=secret-value',
        data: { password: PASSWORD, amount: '16564.00' },
        query_string: 'token=secret-value',
        cookies: { session: 'a-session-token' },
        headers: { cookie: 'session=a-session-token', authorization: 'Bearer x', 'user-agent': 'x' },
      },
      extra: { balance: '8055.00' },
      breadcrumbs: [{ category: 'fetch' }, { category: 'navigation' }],
      user: { id: 'user-1', email: 'someone@example.test', ip_address: '203.0.113.4' },
    });

    expect(event).not.toBeNull();
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain('secret-value');
    expect(serialized).not.toContain('a-session-token');
    expect(serialized).not.toContain('16564.00');
    expect(serialized).not.toContain('8055.00');
    expect(serialized).not.toContain('someone@example.test');
    expect(serialized).not.toContain('203.0.113.4');
    // The tenant is still identifiable, which is what makes an error actionable.
    expect(serialized).toContain('user-1');
  });
});

describe('the runtime role cannot escalate (17.3, 17.4)', () => {
  it('cannot create, alter or drop a table', async () => {
    for (const statement of [
      'CREATE TABLE escalation (id int)',
      'ALTER TABLE user_settings ADD COLUMN backdoor text',
      'DROP TABLE tags',
      'ALTER TABLE categories DISABLE ROW LEVEL SECURITY',
      'CREATE POLICY escape ON categories FOR ALL TO app_user USING (true)',
    ]) {
      // `42501` is PostgreSQL's insufficient_privilege.
      await expect(harness.asUser(statement), statement).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('cannot grant itself anything or become another role', async () => {
    for (const statement of [
      'GRANT app_owner TO app_user',
      'ALTER ROLE app_user BYPASSRLS',
      'SET ROLE app_owner',
      'SET ROLE app_backup',
    ]) {
      await expect(harness.asUser(statement), statement).rejects.toBeInstanceOf(Error);
    }
  });
});
