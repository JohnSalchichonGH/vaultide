import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CLOSING, EXAMPLE_MONTH, FOOTER_LINE, HERO, ROADMAP } from '@/features/home/content';
import { formatMoney } from '@/lib/format';

// Next's `redirect()` ends a render by throwing; the stand-in throws too, so a
// page that redirects cannot go on to render the homepage.
vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT;${to}`);
  }),
}));

// The session comes from the request; here it is whatever a test says it is.
vi.mock('@/server/context', () => ({ currentSession: vi.fn() }));

const { currentSession } = await import('@/server/context');
const { default: LandingPage, dynamic } = await import('@/app/page');

type Session = Awaited<ReturnType<typeof currentSession>>;

function sessionWith(onboardingCompleted: boolean): Session {
  return { settings: { onboardingCompleted } } as unknown as Session;
}

/** The few entities React writes into static markup, undone for matching. */
function text(markup: string): string {
  return markup
    .replaceAll('&amp;', '&')
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"');
}

/**
 * The public homepage at `/` (blueprint 16.1, 16.6).
 *
 * The end-to-end suite looks at the page in a browser; these tests pin the
 * server's markup — the redirect for a signed-in visitor, the public shell
 * around the content, and the absence of anything internal — without a
 * server. The copy itself is data in `content.ts` and is asserted here only
 * where a wrong value would mislead somebody.
 */
describe('the homepage', () => {
  it('is rendered per request, so the redirect reads the request', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  it('sends a signed-in visitor who finished onboarding to the dashboard', async () => {
    vi.mocked(currentSession).mockResolvedValueOnce(sessionWith(true));
    await expect(LandingPage()).rejects.toThrow('NEXT_REDIRECT;/dashboard');
  });

  it('sends a signed-in visitor who has not finished onboarding into the wizard', async () => {
    vi.mocked(currentSession).mockResolvedValueOnce(sessionWith(false));
    await expect(LandingPage()).rejects.toThrow('NEXT_REDIRECT;/onboarding/1');
  });

  describe('for a visitor who is not signed in', () => {
    async function render(): Promise<string> {
      vi.mocked(currentSession).mockResolvedValueOnce(undefined);
      return text(renderToStaticMarkup(await LandingPage()));
    }

    it('puts the skip link first, then a public header, main#main and a footer', async () => {
      const markup = await render();

      // The first anchor in the document is the skip link (16.6).
      const firstAnchor = /<a\b[^>]*>/u.exec(markup)?.[0] ?? '';
      expect(firstAnchor).toContain('href="#main"');
      expect(markup).toContain('<main id="main"');

      // The header: wordmark home, the way in, the theme control — and nothing
      // of the signed-in shell.
      const header = /<header\b[\s\S]*?<\/header>/u.exec(markup)?.[0] ?? '';
      expect(header).toContain('href="/"');
      expect(header).toContain('href="/sign-in"');
      expect(header).toContain('data-testid="theme-toggle"');
      expect(header).not.toContain('Create account');
      expect(markup).not.toContain('reporting-currency');
      expect(markup).not.toContain('<nav');

      const footer = /<footer\b[\s\S]*?<\/footer>/u.exec(markup)?.[0] ?? '';
      expect(footer).toContain(FOOTER_LINE);
    });

    it('has one H1 and the locked hero, with the primary call to action to sign-up', async () => {
      const markup = await render();

      expect(markup.match(/<h1\b/gu)).toHaveLength(1);
      expect(markup).toContain(`>${HERO.title}<`);
      expect(markup).toContain(`>${HERO.kicker}<`);
      expect(markup).toContain(`href="${HERO.primary.href}"`);
      expect(markup).toContain(`href="${HERO.secondary.href}"`);
      expect(markup).toContain('id="roadmap"');
      expect(HERO.primary.href).toBe('/sign-up');
      expect(CLOSING.primary.href).toBe('/sign-up');
      expect(CLOSING.secondary.href).toBe('/sign-in');
    });

    it('shows the example month from its one source of truth', async () => {
      const markup = await render();
      const shown = (amount: string): string =>
        formatMoney({
          amount,
          currency: EXAMPLE_MONTH.currency,
          locale: EXAMPLE_MONTH.locale,
          minorUnits: EXAMPLE_MONTH.minorUnits,
        });

      for (const amount of Object.values(EXAMPLE_MONTH.figures)) {
        expect(markup).toContain(shown(amount));
      }
      expect(markup).toContain(EXAMPLE_MONTH.status);
      expect(markup).toContain(EXAMPLE_MONTH.missing.status);
      expect(markup).toContain(EXAMPLE_MONTH.missing.reason);
      // The example is a description list, never a table with a minimum width.
      expect(markup).not.toContain('<table');
      expect(markup).not.toMatch(/min-w-/u);
    });

    it('names the roadmap groups in words, in order, with every entry on the page', async () => {
      const markup = await render();

      const labels = ROADMAP.groups.map((group) => group.label);
      expect(labels).toEqual(['Available now', 'Next up', 'Planned']);
      const positions = labels.map((label) => markup.indexOf(`${label}</h3>`));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);

      for (const group of ROADMAP.groups) {
        for (const entry of group.entries) {
          expect(markup).toContain(`>${entry.title}<`);
          expect(markup).toContain(`>${entry.text}<`);
        }
      }
    });

    it('carries nothing internal: no phase, version, fixture or test language', async () => {
      const markup = await render();

      expect(markup).not.toMatch(/\bPhase \d/u);
      expect(markup).not.toMatch(/\bP\d\b/u);
      expect(markup).not.toMatch(/[Bb]lueprint/u);
      expect(markup).not.toMatch(/\bv\d+\.\d+\.\d+\b/u);
      expect(markup).not.toContain('/test/foundations');
      expect(markup).not.toContain('self-test');
      expect(markup).not.toContain('In progress');
    });
  });
});
