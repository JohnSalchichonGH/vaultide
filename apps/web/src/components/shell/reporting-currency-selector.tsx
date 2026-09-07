'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setReportingCurrencyAction } from '@/server/actions/settings';

/**
 * The reporting-currency selector (blueprint 15.1 "Global shell: reporting
 * currency selector (`EUR ▾`)", T8, M10).
 *
 * Changing it changes only how totals are **displayed**. No stored record is
 * touched and no converted value is persisted: conversion happens at read time
 * (T8), and the schema has nowhere to put a converted amount (M10). Property
 * test 5 in 21.2 states the same thing about the engines.
 *
 * The list is the FX-supported set, so a currency here can always be converted
 * — or honestly reported as `Unavailable` when a rate is missing (10.5).
 */
export function ReportingCurrencySelector({
  value,
  version,
  currencies,
}: {
  value: string;
  version: number;
  currencies: readonly { code: string; name: string }[];
}) {
  const id = useId();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="sr-only">
        Reporting currency
      </label>
      <select
        id={id}
        name="reportingCurrency"
        defaultValue={value}
        disabled={pending}
        data-testid="reporting-currency"
        title="Reporting currency — totals are displayed in this currency"
        className="tabular rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-2 py-1 text-[length:var(--text-meta)]"
        onChange={(event) => {
          const next = event.target.value;
          setError(null);
          startTransition(async () => {
            const result = await setReportingCurrencyAction({
              reportingCurrency: next,
              expectedVersion: version,
            });
            if (!result.ok) {
              setError(result.error.message);
              return;
            }
            router.refresh();
          });
        }}
      >
        {currencies.map((currency) => (
          <option key={currency.code} value={currency.code}>
            {currency.code}
          </option>
        ))}
      </select>
      {error === null ? null : (
        <span role="alert" className="text-[length:var(--text-meta)] text-[var(--color-negative)]">
          {error}
        </span>
      )}
    </div>
  );
}
