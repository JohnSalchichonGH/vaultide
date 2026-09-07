import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { POSITION_KINDS } from '@vaultide/finance';
import { positionKinds } from '@vaultide/validation';
import {
  actionLogRecord,
  AuthRequiredError,
  buildRequestContext,
  createLogger,
  deployedVersion,
  defineAction,
  ImpossibleOperationError,
  InvalidTestClockError,
  isTestClockEnabled,
  LOG_LEVEL_BY_CODE,
  NotFoundError,
  resolveClock,
  scrubEvent,
  testContext,
  TEST_CLOCK_HEADER,
  ValidationError,
  type RequestContext,
} from '../../src/index';

function headers(map: Record<string, string>) {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      callback();
    },
  });
  return { logger: createLogger({ level: 'info', destination }), lines };
}

describe('cross-package enum consistency', () => {
  it('keeps finance and validation position kinds identical', () => {
    // finance is pure and cannot import validation (section 19), so this is the
    // test that stops the two lists from drifting apart.
    expect([...POSITION_KINDS]).toEqual([...positionKinds]);
  });
});

describe('request context', () => {
  it('computes today in the user timezone', () => {
    const ctx = buildRequestContext({
      requestId: 'r1',
      userId: '11111111-1111-4111-8111-111111111111',
      sessionId: 's1',
      timezone: 'Europe/Madrid',
      locale: 'en-GB',
      reportingCurrency: 'EUR',
      headers: headers({ [TEST_CLOCK_HEADER]: '2026-09-06T23:30:00Z' }),
      env: { NODE_ENV: 'test' },
    });
    // 23:30 UTC is already the 7th in Madrid.
    expect(ctx.today).toBe('2026-09-07');
    expect(ctx.timezone).toBe('Europe/Madrid');
  });

  it('falls back to UTC for an unknown timezone rather than failing the request', () => {
    const ctx = buildRequestContext({
      requestId: 'r1',
      userId: '11111111-1111-4111-8111-111111111111',
      sessionId: 's1',
      timezone: 'Mars/Olympus',
      locale: 'en-GB',
      reportingCurrency: 'EUR',
      env: { NODE_ENV: 'test' },
    });
    expect(ctx.timezone).toBe('UTC');
  });
});

describe('TEST_CLOCK is a test-only capability', () => {
  it('is enabled only when NODE_ENV is test', () => {
    expect(isTestClockEnabled({ NODE_ENV: 'test' })).toBe(true);
    expect(isTestClockEnabled({ NODE_ENV: 'development' })).toBe(false);
    expect(isTestClockEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(isTestClockEnabled({})).toBe(false);

    // A Next standalone server sets `NODE_ENV=production` on itself, so the
    // end-to-end suite — which 21.5 runs against the build — opens the same
    // capabilities with an explicit flag instead.
    expect(
      isTestClockEnabled({ NODE_ENV: 'production', VAULTIDE_TEST_ENDPOINTS: 'enabled' }),
    ).toBe(true);
    expect(isTestClockEnabled({ NODE_ENV: 'production', VAULTIDE_TEST_ENDPOINTS: 'yes' })).toBe(
      false,
    );

    // And a production deployment cannot open them, flag or no flag. This is
    // the property that makes the second door safe: the mailbox hands out
    // single-use verification tokens.
    expect(
      isTestClockEnabled({
        NODE_ENV: 'test',
        VAULTIDE_TEST_ENDPOINTS: 'enabled',
        VERCEL_ENV: 'production',
      }),
    ).toBe(false);
  });

  it('honors the header in test builds', () => {
    const clock = resolveClock(headers({ [TEST_CLOCK_HEADER]: '2026-10-01T09:00:00Z' }), {
      NODE_ENV: 'test',
    });
    expect(clock.now().toISOString()).toBe('2026-10-01T09:00:00.000Z');
  });

  it('ignores the header in development and production, whoever sends it', () => {
    for (const NODE_ENV of ['development', 'production', undefined]) {
      const before = Date.now();
      const clock = resolveClock(headers({ [TEST_CLOCK_HEADER]: '2000-01-01T00:00:00Z' }), {
        ...(NODE_ENV === undefined ? {} : { NODE_ENV }),
      });
      const now = clock.now().getTime();
      expect(now).toBeGreaterThanOrEqual(before);
      expect(clock.now().getUTCFullYear()).toBeGreaterThan(2000);
    }
  });

  it('rejects a malformed instant instead of silently using the system clock', () => {
    expect(() =>
      resolveClock(headers({ [TEST_CLOCK_HEADER]: 'yesterday' }), { NODE_ENV: 'test' }),
    ).toThrow(InvalidTestClockError);
  });
});

describe('error taxonomy (20.2)', () => {
  it('assigns every code a logging level', () => {
    expect(new ValidationError().code).toBe('VALIDATION_ERROR');
    expect(new ValidationError().logLevel).toBe('count');
    expect(new NotFoundError().logLevel).toBe('none');
    expect(new AuthRequiredError().logLevel).toBe('none');
    expect(LOG_LEVEL_BY_CODE['INTERNAL']).toBe('error');
  });

  it('never puts a user value in a message it did not receive', () => {
    const error = new ImpossibleOperationError('A withdrawal cannot exceed the current value.');
    expect(error.message).not.toMatch(/\d/u);
  });
});

describe('defineAction', () => {
  const ctx: RequestContext = testContext();

  it('parses input, strips unknown keys and returns a typed result', async () => {
    const { logger, lines } = captureLogger();
    const action = defineAction(
      { getContext: () => Promise.resolve(ctx), logger },
      {
        name: 'currencies.echo',
        input: z.object({ currency: z.string() }),
        handler: ({ input, ctx: context }) =>
          Promise.resolve({ currency: input.currency, today: context.today }),
      },
    );

    const result = await action({ currency: 'EUR', userId: 'someone-else' });
    expect(result).toEqual({ ok: true, data: { currency: 'EUR', today: '2026-09-06' } });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ action: 'currencies.echo', user_id: ctx.userId });
    // The payload never reaches the log.
    expect(JSON.stringify(lines[0])).not.toContain('EUR');
  });

  it('maps a schema failure to field errors', async () => {
    const { logger } = captureLogger();
    const action = defineAction(
      { getContext: () => Promise.resolve(ctx), logger },
      {
        name: 'valuations.create',
        input: z.object({ valuedOn: z.string().min(1, 'Enter a date.') }),
        handler: () => Promise.resolve(null),
      },
    );

    const result = await action({ valuedOn: '' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.fieldErrors).toEqual({ valuedOn: ['Enter a date.'] });
  });

  it('maps a domain error to its code and message', async () => {
    const { logger } = captureLogger();
    const action = defineAction(
      { getContext: () => Promise.resolve(ctx), logger },
      {
        name: 'positions.close',
        input: z.object({}),
        handler: () => Promise.reject(new ImpossibleOperationError('Close the balance first.')),
      },
    );

    const result = await action({});
    if (result.ok) throw new Error('expected a failure');
    expect(result.error).toEqual({
      code: 'IMPOSSIBLE_OPERATION',
      message: 'Close the balance first.',
    });
  });

  it('turns an unexpected error into INTERNAL with a reference id and no details', async () => {
    const { logger, lines } = captureLogger();
    const action = defineAction(
      { getContext: () => Promise.resolve(ctx), logger },
      {
        name: 'positions.list',
        input: z.object({}),
        handler: () => Promise.reject(new Error('connection string postgres://user:secret@host')),
      },
    );

    const result = await action({});
    if (result.ok) throw new Error('expected a failure');
    expect(result.error.code).toBe('INTERNAL');
    expect(result.error.referenceId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.error.message).not.toContain('postgres://');
    expect(JSON.stringify(lines)).not.toContain('secret');
  });

  it('fails closed when there is no session', async () => {
    const { logger } = captureLogger();
    const action = defineAction(
      { getContext: () => Promise.reject(new AuthRequiredError()), logger },
      { name: 'positions.list', input: z.object({}), handler: () => Promise.resolve([]) },
    );

    const result = await action({});
    if (result.ok) throw new Error('expected a failure');
    expect(result.error.code).toBe('AUTH_REQUIRED');
  });
});

describe('logging schema (18.2)', () => {
  it('emits only the fixed fields', () => {
    const record = actionLogRecord({
      requestId: 'r1',
      userId: 'u1',
      action: 'a',
      durationMs: 12,
      errorCode: 'NOT_FOUND',
      entityTable: 'currencies',
      entityId: 'EUR',
    });
    expect(Object.keys(record).sort()).toEqual([
      'action',
      'duration_ms',
      'entity_id',
      'entity_table',
      'error_code',
      'request_id',
      'user_id',
    ]);
  });

  it('redacts money-shaped keys that slip through', () => {
    const { logger, lines } = captureLogger();
    logger.info({ amount: '12345.67', nested: { balance: '8055.00' }, request_id: 'r1' }, 'probe');

    // Assert on the record rather than on substrings of the serialized line.
    // This previously logged a balance of '99' and asserted the line did not
    // contain '99' — which also matches the milliseconds in the timestamp, so
    // the test failed on roughly one run in fifty with the redaction working
    // perfectly. Both probe values now carry a decimal point, which a pino
    // timestamp cannot produce.
    expect(lines[0]).toMatchObject({
      amount: '[redacted]',
      nested: { balance: '[redacted]' },
      request_id: 'r1',
    });

    const line = JSON.stringify(lines[0]);
    expect(line).not.toContain('12345.67');
    expect(line).not.toContain('8055.00');
  });
});

describe('Sentry scrubbing (18.2)', () => {
  it('drops request payloads, query strings, extras and network breadcrumbs', () => {
    const event = scrubEvent({
      request: {
        data: { amount: '12345.67' },
        query_string: 'token=abc',
        cookies: { session: 'abc' },
        url: 'https://vaultide.app/monthly/2026-09?token=abc',
        headers: { Cookie: 'session=abc', 'X-Vaultide-Test-Clock': 'x', 'User-Agent': 'ua' },
      },
      extra: { balance: '8055.00' },
      contexts: { state: { store: { net_worth: '77234' } }, runtime: { name: 'node' } },
      breadcrumbs: [{ category: 'fetch' }, { category: 'navigation' }, { category: 'console' }],
      user: { id: 'u1', email: 'someone@example.com', ip_address: '1.2.3.4' },
    });

    expect(event).not.toBeNull();
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('12345.67');
    expect(serialized).not.toContain('8055.00');
    expect(serialized).not.toContain('77234');
    expect(serialized).not.toContain('token=abc');
    expect(serialized).not.toContain('someone@example.com');
    expect(serialized).not.toContain('1.2.3.4');
    expect(event?.request?.url).toBe('https://vaultide.app/monthly/2026-09');
    expect(event?.breadcrumbs).toEqual([{ category: 'navigation' }]);
    expect(event?.user).toEqual({ id: 'u1' });
    expect(event?.contexts).toEqual({ runtime: { name: 'node' } });
  });

  it('does not report expected domain outcomes', () => {
    expect(
      scrubEvent({ exception: { values: [{ type: 'ValidationError', value: 'VALIDATION_ERROR' }] } }),
    ).toBeNull();
    expect(scrubEvent({ exception: { values: [{ type: 'NotFoundError', value: 'NOT_FOUND' }] } })).toBeNull();
    expect(
      scrubEvent({ exception: { values: [{ type: 'TypeError', value: 'x is not a function' }] } }),
    ).not.toBeNull();
  });
});

describe('deployed version (22.6)', () => {
  it('prefers an explicit version, then the host commit, then a placeholder', () => {
    expect(deployedVersion({ VAULTIDE_VERSION: 'v1.2.3' })).toBe('v1.2.3');
    expect(deployedVersion({ VERCEL_GIT_COMMIT_SHA: '8b72653abcdef0123456789' })).toBe('8b72653');
    expect(deployedVersion({ VAULTIDE_VERSION: '', VERCEL_GIT_COMMIT_SHA: 'abcdef1234567' })).toBe(
      'abcdef1',
    );
    expect(deployedVersion({})).toBe('dev');
  });
});
