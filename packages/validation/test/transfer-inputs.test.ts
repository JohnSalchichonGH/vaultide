import { describe, expect, it } from 'vitest';
import { flowInput } from '../src/index';

const TODAY = '2026-09-15';
const FEE_ID = '73737373-7373-4373-8373-737373737373';

const correction = (expectedFee: unknown) => ({
  transferId: '51515151-5151-4151-8151-515151515151',
  expectedVersion: 3,
  occurredOn: '2026-09-05',
  fromPositionId: '62626262-6262-4262-8262-626262626262',
  toPositionId: '64646464-6464-4464-8464-646464646464',
  fromAmount: '200.00',
  toAmount: '200.00',
  description: null,
  fee: null,
  expectedFee,
});

describe('the fee a transfer correction saw', () => {
  it('keeps the id and the version of the fee it names', () => {
    const parsed = flowInput
      .updateTransferInput(TODAY)
      .parse(correction({ state: 'version', feeId: FEE_ID, version: 1 }));
    expect(parsed.expectedFee).toEqual({ state: 'version', feeId: FEE_ID, version: 1 });
  });

  it('refuses a version that does not say which fee it counts', () => {
    // A removed fee and the one added after it can share a version (20.3).
    const schema = flowInput.updateTransferInput(TODAY);
    expect(schema.safeParse(correction({ state: 'version', version: 1 })).success).toBe(false);
    expect(schema.safeParse(correction({ state: 'version', feeId: 'fee-1', version: 1 })).success).toBe(false);
  });

  it('says there was no fee with the state alone', () => {
    const parsed = flowInput.updateTransferInput(TODAY).parse(correction({ state: 'absent' }));
    expect(parsed.expectedFee).toEqual({ state: 'absent' });
  });
});
