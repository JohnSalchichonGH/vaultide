import { describe, expect, it } from 'vitest';
import { correctionInput } from '../src/index';

/**
 * A month confirmation as a correction draft (blueprint 30.22; ADR 0010 §1).
 *
 * The draft is the ordinary request and nothing more: the account or accounts
 * and the month, under the ordinary actions' own rules. The figure, the dormant
 * state and the source are the server's to derive, so a browser that sends
 * them has sent nothing.
 */

const TODAY = '2026-11-05';
const BBVA = '62626262-6262-4262-8262-626262626262';
const SAVINGS = '64646464-6464-4464-8464-646464646464';

const draft = (value: unknown) => correctionInput.previewCorrectionInput(TODAY).safeParse({ draft: value });

describe('a month confirmation as a draft', () => {
  it('keeps the intent and drops a figure, a state or a source it was handed', () => {
    const single = draft({
      kind: 'confirm_unchanged',
      positionId: BBVA,
      month: '2026-09',
      amount: '1.00',
      source: 'entered',
      isDormant: false,
    });
    expect(single.success && single.data.draft).toEqual({
      kind: 'confirm_unchanged',
      positionId: BBVA,
      month: '2026-09',
    });

    const batch = draft({
      kind: 'confirm_unchanged_batch',
      month: '2026-09',
      positionIds: [BBVA, SAVINGS],
      amounts: ['1.00', '2.00'],
      dormantFrom: null,
    });
    expect(batch.success && batch.data.draft).toEqual({
      kind: 'confirm_unchanged_batch',
      month: '2026-09',
      positionIds: [BBVA, SAVINGS],
    });
  });

  it('refuses what the ordinary actions refuse', () => {
    expect(draft({ kind: 'confirm_unchanged', positionId: BBVA, month: '2026-9' }).success).toBe(false);
    expect(draft({ kind: 'confirm_unchanged', positionId: 'bbva', month: '2026-09' }).success).toBe(false);
    expect(draft({ kind: 'confirm_unchanged_batch', month: '2026-09', positionIds: [] }).success).toBe(false);
    expect(
      draft({ kind: 'confirm_unchanged_batch', month: '2026-09', positionIds: Array(101).fill(BBVA) }).success,
    ).toBe(false);
  });

  it('refuses an account named twice instead of de-duplicating it', () => {
    const parsed = draft({ kind: 'confirm_unchanged_batch', month: '2026-09', positionIds: [BBVA, BBVA] });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toContain('Each account may appear only once.');
  });
});
