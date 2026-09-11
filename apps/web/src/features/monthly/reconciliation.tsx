import type {
  MtdBucketDto,
  ReconciliationBucketDto,
  ReconciliationTotalsDto,
} from '@vaultide/application';
import type { MoneyDto } from '@vaultide/finance/client';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { MoneyText } from '@/components/finance/money-text';
import {
  AS_OF_STATE_LABEL,
  CLOSE_STATE_LABEL,
  STATUS_LABEL,
  STATUS_MEANING,
  STATUS_TONE,
  UNAVAILABLE_CAUSE_MEANING,
  UNAVAILABLE_FIGURE_REASON,
  dayTitle,
  stateLabel,
  unavailableCauseOf,
} from '@/features/monthly/presentation';

/**
 * The month's reconciliation, per native currency (blueprint 8.2, 8.9, 15.3
 * section 8).
 *
 * The identity is laid out line by line with the engine's own figures, in the
 * bucket's own currency — nothing is converted and nothing is added up here. A
 * balance-derived line the engine could not compute is shown as unavailable
 * with the bucket's reason; the four sums of recorded flows are exact in every
 * status and are always shown (30.12).
 */

interface Formatting {
  readonly locale: string;
  readonly minorUnits: number;
}

function Amount({
  value,
  currency,
  formatting,
  unavailableReason,
}: {
  readonly value: MoneyDto | null;
  readonly currency: string;
  readonly formatting: Formatting;
  readonly unavailableReason?: string;
}) {
  return (
    <MoneyText
      amount={value?.amount ?? null}
      currency={currency}
      locale={formatting.locale}
      minorUnits={formatting.minorUnits}
      unavailableReason={unavailableReason}
      // A sign must never wrap away from its amount in a narrow column.
      className="whitespace-nowrap"
    />
  );
}

function IdentityTable({
  totals,
  currency,
  formatting,
  missingReason,
}: {
  readonly totals: ReconciliationTotalsDto;
  readonly currency: string;
  readonly formatting: Formatting;
  readonly missingReason: string;
}) {
  const rows: readonly { label: string; value: MoneyDto | null; derived?: boolean; testId: string }[] = [
    { label: 'Income and other inflows (I)', value: totals.externalInflows, testId: 'identity-I' },
    { label: 'Moved in from elsewhere (Nin)', value: totals.nonIncomeInflows, testId: 'identity-Nin' },
    { label: 'Moved out, not spending (Nout)', value: totals.nonExpenseOutflows, testId: 'identity-Nout' },
    { label: 'Change in cash balances (Δ)', value: totals.cashDelta, testId: 'identity-delta' },
    {
      label: 'Tracked total spending = I + Nin − Nout − Δ',
      value: totals.trackedTotalSpending,
      derived: true,
      testId: 'identity-tracked',
    },
    { label: 'Known tracked expenses (K)', value: totals.knownTrackedExpenses, testId: 'identity-K' },
    {
      label: 'Unclassified = tracked total − K',
      value: totals.unclassified,
      derived: true,
      testId: 'identity-unclassified',
    },
  ];

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[length:var(--text-table)]">
        <caption className="sr-only">The {currency} reconciliation identity</caption>
        <thead>
          <tr className="border-b text-left text-[var(--color-muted-foreground)]">
            <th scope="col" className="py-2 pr-4 font-medium">Line</th>
            <th scope="col" className="py-2 text-right font-medium">{currency}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.testId} className="border-b last:border-0" data-testid={row.testId}>
              <th scope="row" className={row.derived === true ? 'py-2 pr-4 text-left font-semibold' : 'py-2 pr-4 text-left font-normal'}>
                {row.label}
              </th>
              <td className={row.derived === true ? 'py-2 text-right font-semibold' : 'py-2 text-right'}>
                <Amount
                  value={row.value}
                  currency={currency}
                  formatting={formatting}
                  unavailableReason={`Not computed: ${missingReason}`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A bucket's heading, and what its status means for this bucket.
 *
 * An unavailable bucket says its own cause — read from the bucket's `reason`
 * and issues by `unavailableCauseOf`, never assumed from the status — and the
 * figures it could not compute give the same cause as their reason.
 */
function describeBucket(bucket: {
  readonly status: ReconciliationBucketDto['status'];
  readonly reason?: string | null;
  readonly issues: ReconciliationBucketDto['issues'];
}): { meaning: string; figureReason: string } {
  const cause = unavailableCauseOf(bucket);
  return cause === null
    ? { meaning: STATUS_MEANING[bucket.status], figureReason: 'not computed for this currency.' }
    : { meaning: UNAVAILABLE_CAUSE_MEANING[cause], figureReason: UNAVAILABLE_FIGURE_REASON[cause] };
}

function StatusHeader({
  currency,
  status,
  meaning,
}: {
  readonly currency: string;
  readonly status: ReconciliationBucketDto['status'];
  readonly meaning: string;
}) {
  return (
    <CardHeader>
      <div className="flex flex-wrap items-center gap-3">
        <CardTitle>{currency}</CardTitle>
        <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
      </div>
      <CardDescription data-testid={`bucket-meaning-${currency}`}>{meaning}</CardDescription>
    </CardHeader>
  );
}

function Explanation({ lines }: { readonly lines: readonly string[] }) {
  return lines.length === 0 ? null : (
    <details className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
      <summary className="cursor-pointer">How this was calculated</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {lines.map((line, index) => (
          <li key={String(index)}>{line}</li>
        ))}
      </ul>
    </details>
  );
}

function OutsideIdentity({
  additional,
  thirdParty,
  currency,
  formatting,
}: {
  readonly additional: MoneyDto;
  readonly thirdParty: MoneyDto;
  readonly currency: string;
  readonly formatting: Formatting;
}) {
  return (
    <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
      Outside the identity: additional spending{' '}
      <Amount value={additional} currency={currency} formatting={formatting} /> · paid by others{' '}
      <Amount value={thirdParty} currency={currency} formatting={formatting} /> (informational).
    </p>
  );
}

function inArithmetic(account: {
  readonly included: boolean;
  readonly excludedFirstBalance: boolean;
  readonly dormant: boolean;
}): string {
  const base = account.included
    ? 'Included'
    : account.excludedFirstBalance
      ? 'Excluded — first balance'
      : 'Missing evidence';
  return account.dormant ? `${base} · dormant` : base;
}

function Endpoint({
  state,
  amount,
  currency,
  formatting,
  labels,
}: {
  readonly state: string;
  readonly amount: MoneyDto | null;
  readonly currency: string;
  readonly formatting: Formatting;
  readonly labels: Readonly<Record<string, string>>;
}) {
  // An endpoint carries an amount only while the account is in the month's
  // arithmetic (8.4): otherwise it is a dash, never a zero, with its state beside it.
  return (
    <span className="flex flex-col items-end">
      <Amount
        value={amount}
        currency={currency}
        formatting={formatting}
        unavailableReason="Not in this month’s arithmetic."
      />
      <span className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
        {stateLabel(labels, state)}
      </span>
    </span>
  );
}

export function CompletedBucket({
  bucket,
  formatting,
}: {
  readonly bucket: ReconciliationBucketDto;
  readonly formatting: Formatting;
}) {
  const { currency } = bucket;
  const described = describeBucket(bucket);
  return (
    <Card data-testid={`bucket-${currency}`}>
      <StatusHeader currency={currency} status={bucket.status} meaning={described.meaning} />
      <CardContent className="space-y-4">
        <IdentityTable
          totals={bucket.totals}
          currency={currency}
          formatting={formatting}
          missingReason={described.figureReason}
        />
        {bucket.accounts.length === 0 ? null : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[length:var(--text-table)]">
              <caption className="sr-only">The {currency} accounts in the month</caption>
              <thead>
                <tr className="border-b text-left text-[var(--color-muted-foreground)]">
                  <th scope="col" className="py-2 pr-4 font-medium">Account</th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">Opening</th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">Closing</th>
                  <th scope="col" className="py-2 pr-4 font-medium">In the arithmetic</th>
                  <th scope="col" className="py-2 text-right font-medium">Residual</th>
                </tr>
              </thead>
              <tbody>
                {bucket.accounts.map((account) => (
                  <tr key={account.positionId} className="border-b last:border-0">
                    <th scope="row" className="py-2 pr-4 text-left font-normal">{account.name}</th>
                    <td className="py-2 pr-4 text-right">
                      <Endpoint state={account.openState} amount={account.opening} currency={currency} formatting={formatting} labels={CLOSE_STATE_LABEL} />
                    </td>
                    <td className="py-2 pr-4 text-right">
                      <Endpoint state={account.closeState} amount={account.closing} currency={currency} formatting={formatting} labels={CLOSE_STATE_LABEL} />
                    </td>
                    <td className="py-2 pr-4">{inArithmetic(account)}</td>
                    <td className="py-2 text-right">
                      <Amount
                        value={account.residual}
                        currency={currency}
                        formatting={formatting}
                        unavailableReason="A residual exists only for an included account of a reconciled month."
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <OutsideIdentity additional={bucket.additionalSpending} thirdParty={bucket.thirdPartyPaid} currency={currency} formatting={formatting} />
        <Explanation lines={bucket.explanation} />
      </CardContent>
    </Card>
  );
}

export function MonthToDateBucket({
  bucket,
  asOf,
  formatting,
}: {
  readonly bucket: MtdBucketDto;
  readonly asOf: string;
  readonly formatting: Formatting;
}) {
  const { currency } = bucket;
  const described = describeBucket(bucket);
  return (
    <Card data-testid={`bucket-${currency}`}>
      <StatusHeader currency={currency} status={bucket.status} meaning={described.meaning} />
      <CardContent className="space-y-4">
        <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
          Provisional, through {dayTitle(asOf, formatting.locale)}.
        </p>
        <IdentityTable
          totals={bucket.totals}
          currency={currency}
          formatting={formatting}
          missingReason={described.figureReason}
        />
        {bucket.accounts.length === 0 ? null : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[length:var(--text-table)]">
              <caption className="sr-only">The {currency} accounts through the common date</caption>
              <thead>
                <tr className="border-b text-left text-[var(--color-muted-foreground)]">
                  <th scope="col" className="py-2 pr-4 font-medium">Account</th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">Opening</th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">At {dayTitle(asOf, formatting.locale)}</th>
                  <th scope="col" className="py-2 pr-4 font-medium">In the arithmetic</th>
                  <th scope="col" className="py-2 font-medium">Newer balance</th>
                </tr>
              </thead>
              <tbody>
                {bucket.accounts.map((account) => (
                  <tr key={account.positionId} className="border-b last:border-0">
                    <th scope="row" className="py-2 pr-4 text-left font-normal">{account.name}</th>
                    <td className="py-2 pr-4 text-right">
                      <Endpoint state={account.openState} amount={account.opening} currency={currency} formatting={formatting} labels={CLOSE_STATE_LABEL} />
                    </td>
                    <td className="py-2 pr-4 text-right">
                      <Endpoint state={account.asOfState} amount={account.asOfAmount} currency={currency} formatting={formatting} labels={AS_OF_STATE_LABEL} />
                    </td>
                    <td className="py-2 pr-4">{inArithmetic(account)}</td>
                    <td className="tabular py-2">
                      {account.newerBalanceOn === null ? '—' : dayTitle(account.newerBalanceOn, formatting.locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <OutsideIdentity additional={bucket.additionalSpending} thirdParty={bucket.thirdPartyPaid} currency={currency} formatting={formatting} />
        <Explanation lines={bucket.explanation} />
      </CardContent>
    </Card>
  );
}
