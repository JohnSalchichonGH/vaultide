import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Next's `notFound()` ends a render by throwing. The stand-in throws as well, so
// a page that reaches it cannot go on to render anything.
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  }),
}));

const { notFound } = await import('next/navigation');
const { default: FoundationsFixturePage, dynamic } = await import('@/app/test/foundations/page');

/**
 * `/test/foundations` is test-only (blueprint 21.5).
 *
 * The page carries the Phase 0 browser evidence for the end-to-end suite, behind
 * the gate the captured mailbox uses. `areTestEndpointsEnabled` has unit tests of
 * its own in the application package; these prove the page consults it — the
 * real gate, reading the real environment, not a mocked answer.
 */
describe('the /test/foundations fixture page', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(notFound).mockClear();
  });

  it('is rendered per request, so the gate is read when the page is requested', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  it('is a 404 on a Vercel production deployment, even with the test override on', () => {
    // Vitest runs with NODE_ENV=test, which opens the gate on its own, and the
    // override opens it a second way. A production deployment refuses both.
    expect(process.env.NODE_ENV).toBe('test');
    vi.stubEnv('VAULTIDE_TEST_ENDPOINTS', 'enabled');
    vi.stubEnv('VERCEL_ENV', 'production');

    expect(() => FoundationsFixturePage()).toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(notFound).toHaveBeenCalledOnce();
  });

  it('is a 404 on a server that has not enabled the test capabilities', () => {
    // A Next standalone server runs as NODE_ENV=production.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VAULTIDE_TEST_ENDPOINTS', undefined);
    vi.stubEnv('VERCEL_ENV', undefined);

    expect(() => FoundationsFixturePage()).toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(notFound).toHaveBeenCalledOnce();
  });

  it('renders the fixture, formatter pending, where the test capabilities are enabled', () => {
    // The end-to-end server: a production build with the explicit override.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VAULTIDE_TEST_ENDPOINTS', 'enabled');
    vi.stubEnv('VERCEL_ENV', undefined);

    const markup = renderToStaticMarkup(FoundationsFixturePage());

    expect(notFound).not.toHaveBeenCalled();
    expect(markup).toContain('data-testid="foundations-browser-pending"');
    expect(markup).not.toContain('foundations-browser-ready');
    expect(markup).toContain('Balance date');
  });
});
