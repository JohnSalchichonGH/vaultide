import type { ReactNode } from 'react';
import type { ConversionCandidateDto, ReconciliationIssueDto } from '@vaultide/application';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { MoneyText } from '@/components/finance/money-text';
import { formatRate } from '@/lib/format';
import {
  ISSUE_CLASS_LABEL,
  ISSUE_CLASS_TONE,
  dayTitle,
  type IssueGroup,
  type IssuePresentation,
} from '@/features/monthly/presentation';
import { DismissAdvisoryButton, RestoreAdvisoryButton } from '@/features/monthly/review-controls';

/**
 * The month's issues (blueprint 8.5, 15.3 sections 1 and 8).
 *
 * Grouped by key, because a dismissal is stored per key (6.2): one advisory
 * group has one "Hide" control, and it hides every instance of that key for the
 * month. Blocking and informational groups have no control at all. Hidden
 * groups wait in a collapsed list with a control to show each again.
 *
 * The details are the ones the engine attached — an account, an amount, a
 * template and its occurrence, conversion candidates, the accounts with newer
 * balances. Nothing here decides whether an issue applies.
 */

interface IssueContext {
  readonly locale: string;
  readonly minorUnitsByCurrency: Readonly<Record<string, number>>;
  /** Account names by position id, for issues that carry only an id. */
  readonly names: ReadonlyMap<string, string>;
}

function Money({ value, context }: { readonly value: { amount: string; currency: string }; readonly context: IssueContext }) {
  return (
    <MoneyText
      amount={value.amount}
      currency={value.currency}
      locale={context.locale}
      minorUnits={context.minorUnitsByCurrency[value.currency] ?? 2}
    />
  );
}

function Candidate({ candidate, context }: { readonly candidate: ConversionCandidateDto; readonly context: IssueContext }) {
  return (
    <li>
      {candidate.destinationCurrency} gained <Money value={candidate.destinationAmount} context={context} /> that
      nothing records, and {candidate.sourceCurrency} lost <Money value={candidate.sourceAmount} context={context} />{' '}
      of unexplained spending — close to <Money value={candidate.comparisonAmount} context={context} /> at the
      month’s average rate ({formatRate({
        rate: candidate.rate,
        from: candidate.destinationCurrency,
        to: candidate.sourceCurrency,
        locale: context.locale,
      })}
      ).
    </li>
  );
}

function InstanceDetail({ issue, context }: { readonly issue: ReconciliationIssueDto; readonly context: IssueContext }) {
  const account =
    issue.positionName ?? (issue.positionId === null ? null : (context.names.get(issue.positionId) ?? null));
  const parts: ReactNode[] = [];

  if (issue.currency !== null) parts.push(<Badge key="currency" tone="neutral">{issue.currency}</Badge>);
  if (account !== null) parts.push(<span key="account">{account}</span>);
  if (issue.templateName !== null) {
    parts.push(
      <span key="template">
        {issue.templateName}
        {issue.occurrenceDate === null ? null : <> · expected {dayTitle(issue.occurrenceDate, context.locale)}</>}
        {issue.expectedAmount === null ? null : (
          <>
            {' '}
            · <Money value={issue.expectedAmount} context={context} />
          </>
        )}
      </span>,
    );
  }
  if (issue.amount !== null) {
    parts.push(
      <span key="amount">
        <Money value={issue.amount} context={context} />
      </span>,
    );
  }
  if (issue.positionIds !== undefined && issue.positionIds !== null && issue.positionIds.length > 0) {
    parts.push(
      <span key="accounts">
        Newer balances: {issue.positionIds.map((id) => context.names.get(id) ?? 'an account').join(', ')}
      </span>,
    );
  }

  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-[length:var(--text-table)]">{parts}</div>
      {issue.candidates === undefined ? null : (
        <ul className="list-disc space-y-1 pl-5 text-[length:var(--text-table)]">
          {issue.candidates.map((candidate) => (
            <Candidate
              key={`${candidate.sourceCurrency}-${candidate.destinationCurrency}`}
              candidate={candidate}
              context={context}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function GroupBody({ group, context }: { readonly group: IssueGroup; readonly context: IssueContext }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={ISSUE_CLASS_TONE[group.issueClass]}>{ISSUE_CLASS_LABEL[group.issueClass]}</Badge>
        <h3 className="font-medium">{group.title}</h3>
        {group.instances.length > 1 ? (
          <span className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
            {group.instances.length} this month
          </span>
        ) : null}
      </div>
      <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">{group.summary}</p>
      <ul className="space-y-2">
        {group.instances.map((issue, index) => (
          <InstanceDetail key={String(index)} issue={issue} context={context} />
        ))}
      </ul>
    </>
  );
}

export function IssuesPanel({
  presentation,
  month,
  monthName,
  context,
}: {
  readonly presentation: IssuePresentation;
  readonly month: string;
  readonly monthName: string;
  readonly context: IssueContext;
}) {
  return (
    <Card id="issues" data-testid="issues">
      <CardHeader>
        <CardTitle>Issues</CardTitle>
        <CardDescription>
          Blocking issues keep spending from being trusted until the data is corrected. Advisories
          can be hidden for {monthName}; they stay in the reconciliation and can be shown again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {presentation.active.length === 0 ? (
          <p className="text-[var(--color-muted-foreground)]" data-testid="no-issues">
            Nothing raised for {monthName}.
          </p>
        ) : (
          <ul className="space-y-6">
            {presentation.active.map((group) => (
              <li key={group.key} className="space-y-2" data-testid={`issue-group-${group.key}`}>
                <GroupBody group={group} context={context} />
                {group.dismissable ? (
                  <div className="space-y-1">
                    <DismissAdvisoryButton
                      month={month}
                      issueKey={group.key}
                      monthName={monthName}
                      title={group.title}
                    />
                    <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
                      Hides this advisory for {monthName}
                      {group.instances.length > 1 ? `, all ${String(group.instances.length)} of them` : ''}.
                      It changes no figure.
                    </p>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {presentation.dismissed.length === 0 ? null : (
          <details className="rounded-[var(--radius-control)] border px-4 py-3" data-testid="dismissed-advisories">
            <summary className="cursor-pointer font-medium">
              Hidden advisories ({presentation.dismissed.length})
            </summary>
            <ul className="mt-4 space-y-6">
              {presentation.dismissed.map((group) => (
                <li key={group.key} className="space-y-2" data-testid={`dismissed-group-${group.key}`}>
                  <GroupBody group={group} context={context} />
                  <RestoreAdvisoryButton month={month} issueKey={group.key} title={group.title} />
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
