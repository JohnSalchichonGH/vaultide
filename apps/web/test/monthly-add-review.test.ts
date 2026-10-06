import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CorrectionDraft, CorrectionPreview, ExpenseCategoryDto } from '@vaultide/application';
import type * as UseCorrection from '@/features/corrections/use-correction';
import type { CorrectionFlow } from '@/features/corrections/use-correction';

// The one ordinary action the expense form sends, observed.
const createExpenseEntryAction = vi.fn();
vi.mock('@/server/actions/flows', () => ({
  createExpenseEntryAction,
  createIncomeEntryAction: vi.fn(),
  deleteExpenseEntryAction: vi.fn(),
  deleteIncomeEntryAction: vi.fn(),
  updateExpenseEntryAction: vi.fn(),
  updateIncomeEntryAction: vi.fn(),
}));
vi.mock('@/server/actions/recurring', () => ({
  acceptSuggestionAction: vi.fn(),
  createTemplateAction: vi.fn(),
  setTemplateTermAction: vi.fn(),
  skipSuggestionAction: vi.fn(),
  unskipSuggestionAction: vi.fn(),
  updateTemplateAction: vi.fn(),
}));
vi.mock('@/server/actions/corrections', () => ({
  previewHistoricalCorrectionAction: vi.fn(),
  confirmHistoricalCorrectionAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));
// The flow a mount's `useCorrection()` hands out, set per test: static markup
// cannot click Save, so a test sets the flow to the state a save would leave.
const mounted = vi.hoisted(() => ({ flow: null as CorrectionFlow | null }));
vi.mock('@/features/corrections/use-correction', async (importOriginal) => {
  const actual = await importOriginal<typeof UseCorrection>();
  return {
    ...actual,
    useCorrection: (): CorrectionFlow => mounted.flow ?? actual.useCorrection(),
  };
});

const { attemptCorrection, prepareReviewWith } = await import('@/features/corrections/use-correction');
const { AddExpenseWithReview, saveNewExpense } = await import('@/features/monthly/expenses-editor');
const { AddIncomeWithReview } = await import('@/features/monthly/income-editor');

/**
 * Monthly's Add income and Add expense open the review a new record may need,
 * instead of dead-ending on the guard's refusal (ADR 0010 §1; ADR 0012, "Known
 * gap", closed).
 *
 * A single new record is a first assertion and saves through the ordinary
 * create. The server still reviews a dormancy transition whose dated episode
 * reaches completed history, including one a new record causes, so every save
 * asks first. What is pinned here: the expense save path's protocol, as the
 * income one is pinned beside the Income page; that each mount hosts the review
 * for the flow it gives its form; and that every mount in the app is one of
 * those.
 */

const PREVIEW = { fingerprint: 'hc-v1:test' } as unknown as CorrectionPreview;
const NOT_REQUIRED = { ok: true, data: { status: 'not_required' } } as const;
const REVIEW_REQUIRED = { ok: true, data: { status: 'review_required', preview: PREVIEW } } as const;
const GUARD = {
  ok: false,
  error: { code: 'HISTORICAL_REVIEW_REQUIRED', message: 'This has to be reviewed before it is saved. Nothing was saved.' },
} as const;

/** A flow running the real protocol against a server that answers in turn. */
function flowAnswering(...answers: (typeof NOT_REQUIRED | typeof REVIEW_REQUIRED)[]) {
  const asked: CorrectionDraft[] = [];
  const opened: CorrectionDraft[] = [];
  const ports = {
    ask: (draft: CorrectionDraft) => {
      asked.push(draft);
      return Promise.resolve(answers[Math.min(asked.length - 1, answers.length - 1)] as typeof NOT_REQUIRED);
    },
    open: (draft: CorrectionDraft) => {
      opened.push(draft);
    },
    forget: () => undefined,
  };
  const flow: CorrectionFlow = {
    pending: null,
    paused: false,
    pause: () => undefined,
    resume: () => undefined,
    clear: () => undefined,
    attempt: (draft, save) => attemptCorrection(ports, draft, save),
    prepareReview: (draft) => prepareReviewWith(ports, draft),
  };
  return { flow, asked, opened };
}

const INPUT = {
  categoryId: 'cat-groceries',
  incurredOn: '2026-10-02',
  amount: '12.00',
  currency: 'EUR',
  settlement: 'tracked_cash',
  cashPositionId: 'pos-savings',
  isOneOff: false,
} as const;

describe('Add known expense asks the server first', () => {
  it('opens the review when the server requires it, and sends no ordinary save', async () => {
    createExpenseEntryAction.mockReset();
    const { flow, asked, opened } = flowAnswering(REVIEW_REQUIRED);
    expect(await saveNewExpense(INPUT, flow)).toEqual({ kind: 'review' });
    expect(createExpenseEntryAction).not.toHaveBeenCalled();
    expect(asked).toEqual([
      {
        kind: 'expense_create',
        categoryId: 'cat-groceries',
        incurredOn: '2026-10-02',
        amount: '12.00',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: 'pos-savings',
        isOneOff: false,
      },
    ]);
    expect(opened).toHaveLength(1);
  });

  it('saves directly, exactly as before, when no review is needed', async () => {
    createExpenseEntryAction.mockReset().mockResolvedValue({ ok: true, data: { id: 'e' } });
    const { flow, opened } = flowAnswering(NOT_REQUIRED);
    expect(await saveNewExpense({ ...INPUT, description: 'Market' }, flow)).toEqual({ kind: 'saved' });
    expect(createExpenseEntryAction).toHaveBeenCalledWith({ ...INPUT, description: 'Market' });
    expect(opened).toEqual([]);
  });

  it('asks once more when the save meets the guard after a race, and opens the review', async () => {
    createExpenseEntryAction.mockReset().mockResolvedValue(GUARD);
    const { flow, asked, opened } = flowAnswering(NOT_REQUIRED, REVIEW_REQUIRED);
    expect(await saveNewExpense(INPUT, flow)).toEqual({ kind: 'review' });
    expect(createExpenseEntryAction).toHaveBeenCalledTimes(1);
    expect(asked).toHaveLength(2);
    expect(opened).toHaveLength(1);
  });

  it('shows a refusal as the server worded it', async () => {
    createExpenseEntryAction
      .mockReset()
      .mockResolvedValue({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Nope.' } });
    const { flow } = flowAnswering(NOT_REQUIRED);
    expect(await saveNewExpense(INPUT, flow)).toEqual({ kind: 'error', message: 'Nope.' });
  });
});

/* -------------------------------------------------------------------------- */
/* The mounts                                                                  */
/* -------------------------------------------------------------------------- */

const FORMATTING = { locale: 'en-GB', minorUnitsByCurrency: { EUR: 2 } };
const GROCERIES: ExpenseCategoryDto = {
  categoryId: 'cat-groceries',
  name: 'Groceries',
  kind: 'food',
  use: 'spending',
  archived: false,
  selectable: true,
};

/** A correction the user stepped Back from: what the host shows is its way back in. */
function pausedFlow(): CorrectionFlow {
  return { ...flowAnswering(REVIEW_REQUIRED).flow, pending: { draft: { kind: 'income_delete', entryId: 'e', expectedVersion: 1 }, preview: PREVIEW }, paused: true };
}

describe('each Monthly mount hosts the review for the flow it gives its form', () => {
  it('Add income: the review the form’s save opened can be reached again from the mount', () => {
    mounted.flow = pausedFlow();
    const html = renderToStaticMarkup(
      createElement(AddIncomeWithReview, {
        accounts: [{ positionId: 'pos-savings', name: 'Old savings', currency: 'EUR' }],
        currencies: ['EUR'],
        minorUnitsByCurrency: { EUR: 2 },
        bounds: { min: '2026-10-01', max: '2026-10-06' },
        today: '2026-10-06',
        defaultCurrency: 'EUR',
        locale: 'en-GB',
      }),
    );
    mounted.flow = null;
    expect(html).toContain('data-testid="add-income"');
    expect(html).toContain('data-testid="correction-reopen"');
  });

  it('Add expense: the same', () => {
    mounted.flow = pausedFlow();
    const html = renderToStaticMarkup(
      createElement(AddExpenseWithReview, {
        accounts: [{ positionId: 'pos-savings', name: 'Old savings', currency: 'EUR', openedOn: null, closedOn: null }],
        eligibleCategories: [GROCERIES],
        currencies: ['EUR'],
        bounds: { min: '2026-10-01', max: '2026-10-06' },
        today: '2026-10-06',
        defaultCurrency: 'EUR',
        formatting: FORMATTING,
      }),
    );
    mounted.flow = null;
    expect(html).toContain('data-testid="add-expense"');
    expect(html).toContain('data-testid="correction-reopen"');
  });

  it('renders no review at all until a save asks for one', () => {
    const html = renderToStaticMarkup(
      createElement(AddIncomeWithReview, {
        accounts: [],
        currencies: ['EUR'],
        minorUnitsByCurrency: { EUR: 2 },
        bounds: { min: '2026-10-01', max: '2026-10-06' },
        defaultCurrency: 'EUR',
        locale: 'en-GB',
      }),
    );
    expect(html).not.toContain('correction-');
    expect(html).not.toContain('add-income-confirmed');
  });
});

/*
 * The sections' Disclosures and the issue dialog are closed in static markup,
 * so where each form is mounted is checked where it is written.
 */
const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

/** Every `<Name … />` element in the app, by the file that renders it. */
function elements(name: string): { file: string; tag: string }[] {
  const pattern = new RegExp(`<${name}\\b[\\s\\S]*?/>`, 'gu');
  return sourceFiles(src).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(pattern)].map((match) => ({
      file: path.relative(src, file).replaceAll('\\', '/'),
      tag: match[0],
    })),
  );
}

describe('every mount of the two forms brings the review', () => {
  it('mounts Add income only through a host of its review: Monthly’s Income section, the issue dialog, and the Income page', () => {
    expect(elements('AddIncomeWithReview').map((element) => element.file).sort()).toEqual([
      'features/monthly/income-editor.tsx',
      'features/monthly/issue-action-host.tsx',
    ]);
    // The bare form, inside the two hosts that own a flow and a review dialog.
    expect(elements('AddIncomeForm').map((element) => element.file).sort()).toEqual([
      'features/income/add-payment.tsx',
      'features/monthly/income-editor.tsx',
    ]);
    for (const element of elements('AddIncomeForm')) expect(element.tag, element.file).toContain('correction={correction}');
  });

  it('mounts Add expense only through a host of its review: Monthly’s Known expenses, the issue dialog, and Spending', () => {
    expect(elements('AddExpenseWithReview').map((element) => element.file).sort()).toEqual([
      'app/(app)/expenses/page.tsx',
      'features/monthly/expenses-editor.tsx',
      'features/monthly/issue-action-host.tsx',
    ]);
    expect(elements('AddExpenseForm').map((element) => element.file)).toEqual(['features/monthly/expenses-editor.tsx']);
    for (const element of elements('AddExpenseForm')) expect(element.tag, element.file).toContain('correction={correction}');
  });

  it('closes the issue dialog after a confirmed correction, as after a save', () => {
    const host = elements('AddIncomeWithReview')
      .concat(elements('AddExpenseWithReview'))
      .filter((element) => element.file === 'features/monthly/issue-action-host.tsx');
    expect(host).toHaveLength(2);
    for (const element of host) {
      expect(element.tag).toContain('onSaved={close}');
      expect(element.tag).toContain('onCommitted={close}');
    }
  });
});
