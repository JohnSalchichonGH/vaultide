'use client';

import { useId, useState } from 'react';
import { moneyString } from '@vaultide/validation';
import { Input } from '@/components/ui/input';
import { normalizeMoneyInput } from '@/lib/money-input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * `MoneyInput` (blueprint 16.5, 16.6, 20.1).
 *
 * Money is typed and held as an exact **string**. The component accepts both
 * `,` and `.` as the decimal separator, offers a numeric keyboard on phones,
 * and validates the scale against the currency's minor units with the same Zod
 * schema the server uses — so a EUR field rejects three decimals and a CLF
 * field accepts four. The value never passes through `Number`.
 */
export interface MoneyInputProps {
  readonly label: string;
  readonly name: string;
  readonly currency: string;
  /** The currency's minor units, from the `currencies` table. */
  readonly minorUnits: number;
  readonly defaultValue?: string;
  readonly hint?: string;
  readonly required?: boolean;
  readonly onValueChange?: (value: string, valid: boolean) => void;
}

export function MoneyInput({
  label,
  name,
  currency,
  minorUnits,
  defaultValue = '',
  hint,
  required = false,
  onValueChange,
}: MoneyInputProps) {
  const inputId = useId();
  const messageId = `${inputId}-message`;
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);

  const schema = moneyString({ minorUnits });

  const handleChange = (raw: string) => {
    setValue(raw);
    const canonical = normalizeMoneyInput(raw);

    if (canonical === '') {
      setError(required ? 'Enter an amount.' : null);
      onValueChange?.('', !required);
      return;
    }

    const parsed = schema.safeParse(canonical);
    const message = parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Invalid amount.');
    setError(message);
    onValueChange?.(canonical, parsed.success);
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId}>
        {label} <span className="font-normal">({currency})</span>
      </Label>
      <Input
        id={inputId}
        name={name}
        value={value}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        required={required}
        aria-invalid={error !== null}
        aria-describedby={error !== null || hint !== undefined ? messageId : undefined}
        className={cn('tabular text-right')}
        onChange={(event) => {
          handleChange(event.target.value);
        }}
      />
      <p
        id={messageId}
        className={cn(
          'text-[length:var(--text-meta)]',
          error === null ? 'text-[var(--color-muted-foreground)]' : 'text-[var(--color-negative)]',
        )}
        role={error === null ? undefined : 'alert'}
      >
        {error ??
          hint ??
          (minorUnits === 0
            ? 'This currency has no decimals.'
            : `Up to ${String(minorUnits)} decimals.`)}
      </p>
    </div>
  );
}
