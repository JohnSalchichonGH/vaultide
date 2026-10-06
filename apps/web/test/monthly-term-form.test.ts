import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OccurrenceTermDto } from '@vaultide/application';
import {
  TermProblemText,
  adoptsNewerTerm,
  termExpectation,
  termProblemOf,
} from '@/features/monthly/term-form';

/**
 * "Change future amount", Income's and Known expenses' (the Income source
 * page's "Change the amount from…" is Income's), claims the term it opened
 * with (§30.9 item 4, 20.3).
 *
 * A server action's response can bring a fresh page while the form is open.
 * The forms used to build their expectation from the page's term when Save was
 * clicked, so such a refresh moved the expectation and a save could overwrite a
 * change made elsewhere. What is pinned: the expectation comes from the form's
 * own copy of the term; that copy moves to a newer term only while nothing
 * holds the form; a conflict says what the server said and offers Reload; and
 * both forms are built on exactly that.
 */

type Exact = OccurrenceTermDto['exact'];

const ABSENT: Exact = { state: 'absent' };
const OPENED: Exact = { state: 'version', termId: 'term-nov', version: 3, note: null };
const NEWER: Exact = { ...OPENED, version: 4 };
const CREATED_ELSEWHERE: Exact = { state: 'version', termId: 'term-other', version: 1, note: null };

const free = { edited: false, refused: false, saving: false };

describe('a term form’s save claims the term it opened with', () => {
  it('keeps claiming it after the term changes underneath, once something is typed', () => {
    // Opened on version 3; the user types; a refresh brings version 4.
    expect(adoptsNewerTerm({ base: OPENED, latest: NEWER, ...free, edited: true })).toBe(false);
    // So the save still claims version 3, and the server answers with a conflict.
    expect(termExpectation(OPENED)).toEqual({ state: 'version', version: 3 });

    // Opened where no term starts; another tab creates one there.
    expect(adoptsNewerTerm({ base: ABSENT, latest: CREATED_ELSEWHERE, ...free, edited: true })).toBe(false);
    expect(termExpectation(ABSENT)).toEqual({ state: 'absent' });
  });

  it('takes a newer term in only while nothing holds the form', () => {
    expect(adoptsNewerTerm({ base: OPENED, latest: NEWER, ...free })).toBe(true);
    expect(adoptsNewerTerm({ base: ABSENT, latest: CREATED_ELSEWHERE, ...free })).toBe(true);
    expect(adoptsNewerTerm({ base: OPENED, latest: NEWER, ...free, refused: true })).toBe(false);
    expect(adoptsNewerTerm({ base: OPENED, latest: NEWER, ...free, saving: true })).toBe(false);
    // The same term again is nothing to take in.
    expect(adoptsNewerTerm({ base: OPENED, latest: { ...OPENED }, ...free })).toBe(false);
    expect(adoptsNewerTerm({ base: ABSENT, latest: ABSENT, ...free })).toBe(false);
  });
});

describe('a refused term save', () => {
  const failure = (code: string, message: string) => ({ ok: false, error: { code, message } }) as const;

  it('is a conflict exactly when the server holds a newer term, worded as the server worded it', () => {
    expect(termProblemOf(failure('CONFLICT_VERSION', 'This amount changed while you were editing it.'))).toEqual({
      kind: 'conflict',
      message: 'This amount changed while you were editing it.',
    });
    expect(termProblemOf(failure('CONFLICT_DUPLICATE', 'An amount already starts on that date.'))).toEqual({
      kind: 'conflict',
      message: 'An amount already starts on that date.',
    });
    expect(termProblemOf(failure('VALIDATION_ERROR', 'Nope.'))).toEqual({ kind: 'refused', message: 'Nope.' });
  });

  it('offers Reload on a conflict, and only on a conflict', () => {
    for (const testId of ['term-problem', 'expense-term-problem']) {
      const conflict = renderToStaticMarkup(
        createElement(TermProblemText, {
          problem: { kind: 'conflict', message: 'An amount already starts on that date.' },
          testId,
          onReload: () => undefined,
        }),
      );
      expect(conflict).toContain(`data-testid="${testId}"`);
      expect(conflict).toContain('data-kind="conflict"');
      expect(conflict).toContain('An amount already starts on that date.');
      expect(conflict).toContain(`data-testid="${testId}-reload"`);

      const refused = renderToStaticMarkup(
        createElement(TermProblemText, { problem: { kind: 'refused', message: 'Nope.' }, testId, onReload: () => undefined }),
      );
      expect(refused).toContain('Nope.');
      expect(refused).not.toContain('reload');

      expect(
        renderToStaticMarkup(createElement(TermProblemText, { problem: null, testId, onReload: () => undefined })),
      ).toBe('');
    }
  });
});

/*
 * The two forms are panels that open on a click, so static markup never shows
 * them saving; what each sends is checked where it is written.
 */
const monthly = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'features', 'monthly');

/** One form's source, from its declaration to the next top-level function. */
function formSource(file: string, declaration: string): string {
  const text = readFileSync(path.join(monthly, file), 'utf8');
  const start = text.indexOf(declaration);
  expect(start, `${file}: ${declaration}`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\nfunction ', start + declaration.length);
  return text.slice(start, end === -1 ? undefined : end);
}

describe('both term forms are built on it', () => {
  const forms = [
    { name: 'Income', source: formSource('income-editor.tsx', 'export function ChangeFutureAmount('), testId: 'term-problem' },
    { name: 'Known expenses', source: formSource('expenses-editor.tsx', 'function ChangeFutureAmount('), testId: 'expense-term-problem' },
  ];

  it.each(forms)('$name: the save claims the base, never the page’s live term', ({ source }) => {
    expect(source).toContain('const [base, setBase] = useState(term);');
    expect(source).toContain('expected: termExpectation(base.exact)');
    expect(source).not.toContain('term.exact.version');
    // A newer term is taken in through the one rule above, with the form's own flags.
    expect(source).toMatch(/adoptsNewerTerm\(\{\s*base: base\.exact,\s*latest: term\.exact,\s*edited,\s*refused: problem !== null,\s*saving: pending,\s*\}\)/u);
  });

  it.each(forms)('$name: a conflict shows the server’s message and Reload, which rebases on the newest term', ({ source, testId }) => {
    expect(source).toContain('setProblem(termProblemOf(result));');
    expect(source).toContain(`testId="${testId}"`);
    expect(source).toMatch(/onReload=\{\(\) => \{[\s\S]*?rebase\(term\);\s*router\.refresh\(\);\s*\}\}/u);
    // Until Reload, a conflict leaves nothing to save.
    expect(source).toContain('disabled={!hydrated || pending || conflict}');
  });
});
