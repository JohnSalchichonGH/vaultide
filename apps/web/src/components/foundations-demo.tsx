'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { MoneyText } from '@/components/finance/money-text';
import { DateInput } from '@/components/forms/date-input';
import { MoneyInput } from '@/components/forms/money-input';

/**
 * The Phase 0 input primitives, live (blueprint Phase 0 frontend scope):
 * a money input that validates scale against the currency's minor units, and a
 * date input capped at today. Both are demonstrated with CLF, the four-decimal
 * currency whose exact round-trip is a Phase 0 acceptance criterion.
 */
export function FoundationsDemo({ today }: { today: string }) {
  const [amount, setAmount] = useState('38123.4567');
  const [valid, setValid] = useState(true);
  const [date, setDate] = useState(today);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Inputs</CardTitle>
        <CardDescription>
          Amounts are typed and kept as exact strings; dates for actual records can never be later
          than today (blueprint M5, R17).
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-4">
          <MoneyInput
            label="Balance"
            name="demo-amount"
            currency="CLF"
            minorUnits={4}
            defaultValue="38123.4567"
            onValueChange={(next, isValid) => {
              setAmount(next);
              setValid(isValid);
            }}
          />
          <div className="flex items-center gap-2">
            <span className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
              Stored and displayed as
            </span>
            {valid && amount !== '' ? (
              <MoneyText amount={amount} currency="CLF" locale="es-CL" minorUnits={4} />
            ) : (
              <MoneyText amount={null} unavailableReason="Enter a valid amount" />
            )}
          </div>
        </div>

        <div className="space-y-4">
          <DateInput
            label="Balance date"
            name="demo-date"
            today={today}
            onValueChange={(next) => {
              setDate(next);
            }}
          />
          <div className="flex items-center gap-2">
            <span className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
              Selected
            </span>
            <Badge tone={date > today ? 'negative' : 'neutral'}>{date || '—'}</Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
