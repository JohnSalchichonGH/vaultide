'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { IncomeFormsDto } from '@vaultide/application';
import { CorrectionHost } from '@/features/corrections/host';
import { accountLabelsOf } from '@/features/corrections/presentation';
import { useCorrection } from '@/features/corrections/use-correction';
import { AddIncomeForm } from '@/features/monthly/income-editor';

/**
 * The Income page's Add a payment (ADR 0012 D5).
 *
 * Monthly's own form, shared, with three things the page decides: the kinds
 * it counts, any day up to today, and a save that asks the server first. A
 * payment whose dormancy consequence reaches completed history therefore opens
 * Review changes → Confirm correction through the one `CorrectionHost` here,
 * instead of stopping at the guard's refusal — which is what Monthly's own Add
 * income still does (ADR 0012, "Known gap").
 *
 * After a confirmed correction the form starts again empty, and the page is
 * read again from the server.
 */
export function AddPayment({
  forms,
  currencies,
  minorUnitsByCurrency,
  defaultCurrency,
  bounds,
  today,
  locale,
}: {
  readonly forms: IncomeFormsDto;
  readonly currencies: readonly string[];
  readonly minorUnitsByCurrency: Readonly<Record<string, number>>;
  readonly defaultCurrency: string;
  readonly bounds: { readonly min: string; readonly max: string };
  readonly today: string;
  readonly locale: string;
}) {
  const router = useRouter();
  const correction = useCorrection();
  // A new form after a confirmed correction: the typed values were saved.
  const [generation, setGeneration] = useState(0);
  const [confirmed, setConfirmed] = useState(false);

  return (
    <div className="space-y-3">
      <AddIncomeForm
        key={generation}
        accounts={forms.cashAccounts}
        currencies={currencies}
        minorUnitsByCurrency={minorUnitsByCurrency}
        bounds={bounds}
        today={today}
        defaultCurrency={defaultCurrency}
        kinds={forms.paymentKinds}
        correction={correction}
        onSaved={() => {
          setConfirmed(false);
        }}
      />
      {confirmed ? (
        <p
          role="status"
          aria-live="polite"
          data-testid="income-payment-confirmed"
          className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]"
        >
          Income added, and the months it changed were worked out again.
        </p>
      ) : null}
      <CorrectionHost
        flow={correction}
        labels={{ accounts: accountLabelsOf(forms.cashAccounts), categories: {}, locale }}
        onCommitted={() => {
          setGeneration((current) => current + 1);
          setConfirmed(true);
          router.refresh();
        }}
      />
    </div>
  );
}
