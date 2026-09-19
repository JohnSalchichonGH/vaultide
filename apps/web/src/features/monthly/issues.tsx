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
  issueSummary,
  issueTitle,
  type IssueGroup,
  type IssuePresentation,
} from '@/features/monthly/presentation';
import { DismissAdvisoryButton, RestoreAdvisoryButton } from '@/features/monthly/review-controls';
import { IssueActionControls } from '@/features/monthly/issue-action-host';
import { issueActions, type IssueAction, type IssueActionContext } from '@/features/monthly/issue-actions';

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
 *
 * Beside each instance are its corrective actions (15.3 section 8, 30.21),
 * taken from the pure model in `issue-actions`: this file renders them and
 * chooses none. A conversion candidate keeps its own control, so the suggestion
 * and the transfer it would record read as one thing.
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

function Candidate({
  candidate,
  context,
  action,
}: {
  readonly candidate: ConversionCandidateDto;
  readonly context: IssueContext;
  readonly action: IssueAction | undefined;
}) {
  return (
    <li className="space-y-1">
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
      {action === undefined ? null : <IssueActionControls actions={[action]} />}
    </li>
  );
}

function InstanceDetail({
  issue,
  context,
  actionContext,
  ownReading,
}: {
  readonly issue: ReconciliationIssueDto;
  readonly context: IssueContext;
  readonly actionContext: IssueActionContext;
  /** Say which reading this instance is, because its group's words cover more than one. */
  readonly ownReading: boolean;
}) {
  const actions = issueActions(issue, actionContext);
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
    <li className="space-y-1" data-testid={`issue-instance-${issue.key}`}>
      <div className="flex flex-wrap items-center gap-2 text-[length:var(--text-table)]">{parts}</div>
      {ownReading ? (
        <p className="text-[length:var(--text-meta)]" data-testid="issue-instance-reading">
          <span className="font-medium">{issueTitle(issue)}.</span> {issueSummary(issue)}
        </p>
      ) : null}
      {issue.candidates === undefined ? null : (
        <ul className="list-disc space-y-3 pl-5 text-[length:var(--text-table)]">
          {issue.candidates.map((candidate, index) => (
            <Candidate
              key={`${candidate.sourceCurrency}-${candidate.destinationCurrency}`}
              candidate={candidate}
              context={context}
              action={actions[index]}
            />
          ))}
        </ul>
      )}
      {/* A candidate carries its own control; everything else lists them here. */}
      {issue.candidates === undefined ? <IssueActionControls actions={actions} /> : null}
    </li>
  );
}

function GroupBody({
  group,
  context,
  actionContext,
}: {
  readonly group: IssueGroup;
  readonly context: IssueContext;
  readonly actionContext: IssueActionContext;
}) {
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
          <InstanceDetail
            key={String(index)}
            issue={issue}
            context={context}
            actionContext={actionContext}
            ownReading={group.variantsDiffer}
          />
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
  actionContext,
}: {
  readonly presentation: IssuePresentation;
  readonly month: string;
  readonly monthName: string;
  readonly context: IssueContext;
  readonly actionContext: IssueActionContext;
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
                <GroupBody group={group} context={context} actionContext={actionContext} />
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
                  <GroupBody group={group} context={context} actionContext={actionContext} />
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
