import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BulkHistoryPageDto, CorrectionDraft, CorrectionPreview } from '@vaultide/application';

vi.mock('@/server/actions/corrections', () => ({
  confirmHistoricalCorrectionAction: vi.fn(),
  previewHistoricalCorrectionAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { BulkHistoryGrid } = await import('@/features/history/grid');
const { CorrectionReview } = await import('@/features/corrections/review-dialog');

/**
 * What the grid and its review put on screen (blueprint 15.2, 15.3; ADR 0011
 * D5, D8, D10). Markup, rendered statically: every state shown here is the
 * server's, and these tests prove the grid shows each one as what it is.
 */

const page: BulkHistoryPageDto = {
  startMonth: '2026-01',
  lastCompletedMonth: '2026-04',
  currentMonth: '2026-05',
  today: '2026-05-10',
  minorUnitsByCurrency: { EUR: 2, USD: 2 },
  maxOperations: 500,
  columns: [
    {
      kind: 'position',
      positionId: 'pos-bbva',
      positionKind: 'cash',
      name: 'BBVA',
      currency: 'EUR',
      status: 'active',
      segments: [
        {
          from: '2026-01',
          through: '2026-01',
          cell: { kind: 'stored', valuationId: 'val-1', version: 1, amount: '1000', source: 'bulk_entered', clearable: true },
        },
        { from: '2026-02', through: '2026-02', cell: { kind: 'carried', amount: '1000', since: '2026-01-31' } },
        { from: '2026-03', through: '2026-03', cell: { kind: 'snapshot', valuationId: 'val-2', amount: '950' } },
        { from: '2026-04', through: '2026-04', cell: { kind: 'derived_zero', reason: 'dormant' } },
      ],
    },
    {
      kind: 'position',
      positionId: 'pos-usd',
      positionKind: 'cash',
      name: 'Dollars',
      currency: 'USD',
      status: 'closed',
      segments: [
        { from: '2026-01', through: '2026-02', cell: { kind: 'empty' } },
        { from: '2026-03', through: '2026-03', cell: { kind: 'derived_zero', reason: 'closed' } },
        { from: '2026-04', through: '2026-04', cell: { kind: 'unavailable', reason: 'closed' } },
      ],
    },
    {
      kind: 'income',
      templateId: 'tpl-1',
      name: 'Salary',
      currency: 'EUR',
      archived: false,
      segments: [
        {
          from: '2026-01',
          through: '2026-01',
          cell: {
            kind: 'materialized',
            occurrenceDate: '2026-02-01',
            entryId: 'inc-1',
            version: 1,
            netAmount: '2100',
            receivedOn: '2026-01-30',
          },
        },
        { from: '2026-02', through: '2026-02', cell: { kind: 'skipped', occurrenceDate: '2026-02-01' } },
        { from: '2026-03', through: '2026-03', cell: { kind: 'none' } },
        { from: '2026-04', through: '2026-04', cell: { kind: 'open', occurrenceDate: '2026-04-01' } },
      ],
    },
  ],
};

const render = () => renderToStaticMarkup(createElement(BulkHistoryGrid, { page, locale: 'en-GB' }));

function cell(markup: string, month: string, index: number): string {
  const row = new RegExp(`<tr[^>]*data-month="${month}"[^>]*>([\\s\\S]*?)</tr>`, 'u').exec(markup)?.[1] ?? '';
  return row.split('data-testid="bulk-cell"')[index + 1] ?? '';
}

describe('the grid shows each cell as what the server says it is', () => {
  const markup = render();

  it('heads every column with its name, what it holds and its own currency', () => {
    expect(markup).toContain('Month-end balance · EUR');
    expect(markup).toContain('Month-end balance · USD');
    expect(markup).toContain('Income, net · EUR');
  });

  it('shows a stored figure editable, and a carried one muted and unrecorded', () => {
    expect(cell(markup, '2026-01', 0)).toContain('value="1000.00"');
    const carried = cell(markup, '2026-02', 0);
    expect(carried).toContain('data-state="carried"');
    expect(carried).toContain('placeholder="1000.00"');
    expect(carried).toContain('value=""');
  });

  it('hands a last-day snapshot to Monthly instead of editing it', () => {
    const snapshot = cell(markup, '2026-03', 0);
    expect(snapshot).toContain('Snapshot — confirm in Monthly');
    expect(snapshot).toContain('href="/monthly/2026-03#account-pos-bbva"');
    expect(snapshot).not.toContain('<input');
  });

  it('labels a derived zero by its reason: a dormant one takes a figure, a closed one never does', () => {
    const dormant = cell(markup, '2026-04', 0);
    expect(dormant).toContain('placeholder="0"');
    expect(dormant).toContain('dormant, carried at 0');
    expect(dormant).toContain('wakes the account');

    const closed = cell(markup, '2026-03', 1);
    expect(closed).toContain('0 · closed');
    expect(markup).toContain('title="Closed this month: its balance at the month end is zero by definition."');
    expect(closed).not.toContain('dormant');
    expect(closed).not.toContain('<input');
  });

  it('shows income by occurrence, with the day it arrived when that differs', () => {
    const paid = cell(markup, '2026-01', 2);
    expect(paid).toContain('value="2100.00"');
    expect(paid).toContain('received 30 Jan 2026');
    expect(cell(markup, '2026-02', 0)).toContain('carried, not recorded');
    expect(cell(markup, '2026-04', 0)).toContain('dormant, carried at 0');
    expect(cell(markup, '2026-02', 2)).toContain('Skipped');
    expect(cell(markup, '2026-03', 2)).toContain('data-state="none"');
    expect(cell(markup, '2026-04', 2)).toContain('data-state="open"');
  });

  it('disables the current month’s row entirely', () => {
    const current = /<tr[^>]*data-month="2026-05"[^>]*>([\s\S]*?)<\/tr>/u.exec(markup)?.[1] ?? '';
    expect(current).toContain('In progress');
    expect(current).not.toContain('<input');
  });

  it('starts with nothing unsaved and nothing to review', () => {
    expect(markup).toContain('No unsaved changes');
    expect(markup).toMatch(/data-testid="bulk-review"[^>]*disabled/u);
  });

  it('offers a way in when there is nothing to fill in', () => {
    const empty = renderToStaticMarkup(
      createElement(BulkHistoryGrid, { page: { ...page, columns: [] }, locale: 'en-GB' }),
    );
    expect(empty).toContain('data-testid="bulk-empty"');
    expect(empty).toContain('href="/accounts"');
    expect(empty).toContain('href="/monthly/2026-05"');
  });
});

describe('the review of a Bulk History save', () => {
  const draft: CorrectionDraft = {
    kind: 'bulk_history',
    startMonth: '2026-01',
    operations: [{ kind: 'valuation_create', positionId: 'pos-bbva', month: '2026-02', amount: '5' }],
  };
  const preview = {
    fingerprint: `hc-v1:${'0'.repeat(64)}`,
    sourceScope: [],
    sourcePeriods: ['2026-02'],
    periods: [
      {
        kind: 'completed',
        month: '2026-02',
        before: { status: 'unavailable', buckets: [], completeness: null },
        after: { status: 'reliable', buckets: [], completeness: null },
        tags: ['reconciliation'],
      },
    ],
    sourceChanges: [
      {
        identity: { scope: 'prospective', kind: 'valuation', role: 'valuation', owner: 'pos-bbva#2026-02-28' },
        operation: 'create',
        before: null,
        after: {
          kind: 'valuation',
          positionId: 'pos-bbva',
          valuedOn: '2026-02-28',
          amount: '5',
          currency: 'EUR',
          datePrecision: 'month_end',
          note: null,
        },
      },
    ],
    structuralChanges: [{ kind: 'month_status', month: '2026-02', before: 'unavailable', after: 'reliable' }],
  } as unknown as CorrectionPreview;

  const markup = renderToStaticMarkup(
    createElement(CorrectionReview, {
      draft,
      preview,
      labels: { accounts: { 'pos-bbva': { name: 'BBVA', currency: 'EUR' } }, categories: {}, locale: 'en-GB' },
      onBack: () => undefined,
      onCommitted: () => undefined,
    }),
  );

  it('opens on the summary, in the same dialog every correction uses', () => {
    expect(markup).toContain('data-testid="correction-review"');
    expect(markup).toContain('Every Bulk history save is reviewed before anything is written.');
    expect(markup).toContain('data-testid="bulk-review-headline"');
    expect(markup).toContain('Balances: 1 added · February 2026');
  });

  it('folds the detail rather than listing a table per record', () => {
    expect(markup).toContain('data-testid="bulk-review-group"');
    expect(markup).not.toContain('data-testid="correction-field"');
    expect(markup).toContain('Months Vaultide will recalculate (1)');
    expect(markup).toContain('Other consequences (1)');
  });
});

describe('the review of an income-only save that wakes an account', () => {
  const draft: CorrectionDraft = {
    kind: 'bulk_history',
    startMonth: '2026-01',
    operations: [{ kind: 'income_create', templateId: 'tpl-1', occurrenceDate: '2026-02-01', netAmount: '2100' }],
  };
  const preview = {
    fingerprint: `hc-v1:${'0'.repeat(64)}`,
    sourceScope: [],
    sourcePeriods: ['2026-02'],
    periods: [],
    sourceChanges: [
      {
        identity: { scope: 'prospective', kind: 'income', role: 'occurrence', owner: 'tpl-1#2026-02-01' },
        operation: 'create',
        before: null,
        after: {
          kind: 'income',
          incomeKind: 'employment',
          receivedOn: '2026-02-01',
          netAmount: '2100',
          grossAmount: null,
          currency: 'EUR',
          settlement: 'tracked_cash',
          cashPositionId: 'pos-savings',
          description: null,
          templateId: 'tpl-1',
          occurrenceDate: '2026-02-01',
        },
      },
    ],
    structuralChanges: [{ kind: 'dormancy_episode', positionId: 'pos-savings', before: '2025-12-31', after: null }],
  } as unknown as CorrectionPreview;

  const markup = renderToStaticMarkup(
    createElement(CorrectionReview, {
      draft,
      preview,
      labels: {
        accounts: { 'pos-savings': { name: 'Savings', currency: 'EUR' } },
        categories: {},
        templates: { 'tpl-1': 'Salary' },
        locale: 'en-GB',
      },
      onBack: () => undefined,
      onCommitted: () => undefined,
    }),
  );

  it('says the account is no longer dormant on its own line, outside any fold', () => {
    const summaries = [...markup.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/gu)].map((match) => match[1] ?? '');
    expect(summaries.some((text) => text.includes('Savings') && text.includes('no longer dormant'))).toBe(true);
    expect(markup).not.toContain('Other consequences');
  });
});
