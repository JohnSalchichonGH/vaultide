'use client';

import { useId, useState } from 'react';
import { isCalendarDate } from '@vaultide/validation';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * `DateInput`, capped at today (blueprint 15.3, M5, R17).
 *
 * No actual financial record may be dated after today in the user's timezone.
 * The picker enforces it with `max`, and the component re-checks it, but the
 * authority is the server: the same rule is applied again in the action schema,
 * so bypassing this control changes nothing.
 *
 * `today` is passed in from the request context — the component never reads the
 * browser clock, which is what makes month boundaries testable.
 */
export interface DateInputProps {
  readonly label: string;
  readonly name: string;
  /** Today in the user's timezone, `YYYY-MM-DD`. */
  readonly today: string;
  readonly defaultValue?: string;
  readonly hint?: string;
  readonly required?: boolean;
  readonly onValueChange?: (value: string, valid: boolean) => void;
}

export function DateInput({
  label,
  name,
  today,
  defaultValue,
  hint,
  required = false,
  onValueChange,
}: DateInputProps) {
  const inputId = useId();
  const messageId = `${inputId}-message`;
  const [value, setValue] = useState(defaultValue ?? today);
  const [error, setError] = useState<string | null>(null);

  const validate = (candidate: string): string | null => {
    if (candidate === '') return required ? 'Enter a date.' : null;
    if (!isCalendarDate(candidate)) return 'Enter a real calendar date.';
    if (candidate > today) return 'This date is in the future. Records can only be dated up to today.';
    return null;
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      <Input
        id={inputId}
        name={name}
        type="date"
        value={value}
        max={today}
        required={required}
        aria-invalid={error !== null}
        aria-describedby={messageId}
        className="tabular"
        onChange={(event) => {
          const next = event.target.value;
          setValue(next);
          const message = validate(next);
          setError(message);
          onValueChange?.(next, message === null);
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
        {error ?? hint ?? `Today is ${today}. Later dates are not accepted.`}
      </p>
    </div>
  );
}
