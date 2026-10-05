import { describe, expect, it } from 'vitest';
import { returnPath } from '@/features/auth/return-path';

/**
 * Where a successful sign-in lands: `?next=` when it names a page of this
 * site, `/` otherwise.
 *
 * Every value is written as `searchParams.get` returns it, already decoded:
 * `?next=/%5Cevil.invalid` arrives as `/\evil.invalid`.
 */

const ORIGIN = 'https://vaultide.test';

const REFUSED: readonly (string | null)[] = [
  '/\\evil.invalid',
  '/\t/evil.invalid',
  '/\n/evil.invalid',
  '//evil.invalid',
  '\\\\evil.invalid',
  'https://evil.invalid/',
  'javascript:alert(1)',
  '',
  null,
];

const KEPT: readonly string[] = [
  '/monthly/2026-09',
  '/accounts?tab=cash',
  '/income/sources/6f9c1a52-8d3e-4b7a-9c21-5e0d4a7b3c18?year=2026',
  '/monthly/2026-09#reconciliation',
];

describe('returnPath', () => {
  it.each(REFUSED)('lands on / for %j', (next) => {
    expect(returnPath(next, ORIGIN)).toBe('/');
  });

  it('refuses the values that start with a single / and still name another host', () => {
    for (const next of ['/\\evil.invalid', '/\t/evil.invalid', '/\n/evil.invalid']) {
      // The check this replaced accepted each of them...
      expect(next.startsWith('/') && !next.startsWith('//')).toBe(true);
      // ...and the browser resolves each to another host.
      expect(new URL(next, ORIGIN).host).toBe('evil.invalid');
      expect(returnPath(next, ORIGIN)).toBe('/');
    }
  });

  it('refuses a value that resolves on this site to a path pushed as another host', () => {
    for (const next of ['/.//evil.invalid', '/a/..//evil.invalid']) {
      // Resolved, it stays here, at the path `//evil.invalid`...
      const resolved = new URL(next, ORIGIN);
      expect(resolved.origin).toBe(ORIGIN);
      expect(resolved.pathname).toBe('//evil.invalid');
      // ...which, pushed on its own, is a protocol-relative URL.
      expect(new URL(resolved.pathname, ORIGIN).host).toBe('evil.invalid');
      expect(returnPath(next, ORIGIN)).toBe('/');
    }
  });

  it.each(KEPT)('keeps %s exactly', (next) => {
    expect(returnPath(next, ORIGIN)).toBe(next);
  });
});
