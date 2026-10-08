import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

const { MoneyText } = await import('@/components/finance/money-text');
const { RateFigure } = await import('@/features/spending/figure');

/**
 * An amount that cannot be stated (blueprint 16.2, 16.6).
 *
 * The dash is what the eye reads; a screen reader reads the reason. A label on
 * a plain `<span>` gives it no accessible name, so many screen readers skipped
 * it and read only the dash. The reason is now text, hidden from the eye, and
 * the dash is hidden from the screen reader. The tooltip stays.
 */

const unavailable = (reason?: string): string =>
  renderToStaticMarkup(createElement(MoneyText, { amount: null, unavailableReason: reason }));

describe('an unavailable amount', () => {
  const html = unavailable('No exchange rate for this date yet.');

  it('hides its dash from a screen reader, and carries the reason as text in its place', () => {
    expect(html).toContain('<span aria-hidden="true">—</span>');
    expect(html).toContain('<span class="sr-only">No exchange rate for this date yet.</span>');
    expect(html).not.toContain('aria-label');
  });

  it('keeps the reason as the tooltip a mouse shows', () => {
    expect(html).toContain('title="No exchange rate for this date yet."');
  });

  it('holds the hidden reason inside itself, so no scroll box it sits in can be widened by it', () => {
    // `sr-only` positions the text absolutely; its own positioned element is
    // what it is measured against, not some ancestor outside the scroll box.
    expect(html).toMatch(/^<span class="[^"]*\brelative\b[^"]*"/u);
  });

  it('says it is not available when it is given no reason', () => {
    const plain = unavailable();
    expect(plain).toContain('<span class="sr-only">Not available</span>');
    expect(plain).toContain('title="Not available"');
  });

  it('never states a zero', () => {
    expect(html).not.toMatch(/\d/u);
  });
});

describe('an unavailable rate', () => {
  it('hides its dash from a screen reader, which reads the badge and the reason beside it', () => {
    const html = renderToStaticMarkup(
      createElement(RateFigure, {
        label: 'Savings rate',
        display: { kind: 'none', reason: 'Personal savings could not be stated in full.' },
        locale: 'en-GB',
        testId: 'figure',
      }),
    );
    expect(html).toMatch(/<span class="[^"]*" aria-hidden="true">—<\/span>/u);
    expect(html).not.toContain('aria-label');
    expect(html).toContain('Not available');
    expect(html).toContain('Personal savings could not be stated in full.');
  });
});
