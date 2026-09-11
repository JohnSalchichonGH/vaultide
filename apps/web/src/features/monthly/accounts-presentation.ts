import type {
  AccountOpeningDto,
  CompletedAccountDto,
  CompletedClosingDto,
  CurrentAccountDto,
  LatestBalanceDto,
} from '@vaultide/application';
import type { QuickUpdatePosition } from '@/features/accounts/quick-update';

/**
 * How Monthly's Accounts section reads (blueprint 8.1, 8.6, 15.3 section 4).
 *
 * Words for the states the server attached, and the two selections the section
 * makes from them. No state is decided here: an opening, a closing and whether
 * an action may be offered all arrive on the account, from the same authorities
 * the reconciliation uses.
 */

/**
 * The words for an opening that is not a statement. Structural zeros say why
 * they are zero; unknown evidence says so and never shows a number (7.6).
 */
export function openingText(
  opening: Exclude<AccountOpeningDto, { kind: 'statement' }>,
  previousMonthName: string,
): string {
  switch (opening.kind) {
    case 'opened_zero':
      return 'Opened this month — previous balance 0';
    case 'dormant_zero':
      return 'Dormant (0)';
    case 'closed_zero':
      return 'Closed — balance 0';
    case 'first_balance':
      return 'First balance — not part of this month’s spending';
    case 'no_statement':
      return opening.state === 'carried'
        ? `No statement balance for ${previousMonthName}`
        : 'No balance recorded';
  }
}

/** The words for a closing that is zero by definition. */
export function structuralClosingText(
  closing: Extract<CompletedClosingDto, { kind: 'closed_zero' | 'dormant_zero' }>,
): string {
  return closing.kind === 'closed_zero' ? 'Closed this month — current balance 0' : 'Dormant (0)';
}

export type AccountStatusTone = 'positive' | 'negative' | 'warning' | 'info';

export interface AccountStatus {
  readonly label: string;
  readonly tone: AccountStatusTone;
  /** A glyph beside the words, so the state is never carried by colour alone (16.6). */
  readonly glyph: string;
}

/**
 * A completed month's account, in one phrase — read off the state the server
 * sent (8.1): whether both ends are settled, and which end is not.
 */
export function accountStatus(account: CompletedAccountDto, previousMonthName: string): AccountStatus {
  const { state } = account;
  if (state.firstBalance) return { label: 'First balance', tone: 'info', glyph: 'i' };
  if (state.included) return { label: 'Complete', tone: 'positive', glyph: '✓' };
  if (state.close === 'carried' || state.close === 'missing') {
    return { label: 'Needs statement balance', tone: 'negative', glyph: '!' };
  }
  return { label: `Needs ${previousMonthName} statement`, tone: 'warning', glyph: '!' };
}

/**
 * The accounts "Confirm all untouched as unchanged" names: every one whose
 * month may be confirmed unchanged — no balance on its last day, and a previous
 * statement to carry (8.1, R22) — that nobody has typed into. Touching a field
 * is never read as "unchanged"; the server judges each account again.
 */
export function untouchedUnchangedTargets(
  accounts: readonly CompletedAccountDto[],
  touched: ReadonlySet<string>,
): CompletedAccountDto[] {
  return accounts.filter(
    (account) =>
      account.closing.kind === 'no_statement' &&
      account.closing.canConfirmUnchanged &&
      !touched.has(account.positionId),
  );
}

/** Whether any account could be confirmed unchanged at all, touched or not. */
export function anyUnchangedEligible(accounts: readonly CompletedAccountDto[]): boolean {
  return untouchedUnchangedTargets(accounts, new Set()).length > 0;
}

/**
 * The accounts "Update all today" lists: those the server allows an update of
 * today — active, and not dormant (15.3, R22).
 */
export function quickUpdatePositionsOf(
  accounts: readonly CurrentAccountDto[],
  minorUnitsByCurrency: Readonly<Record<string, number>>,
): QuickUpdatePosition[] {
  return accounts
    .filter((account) => account.canUpdateToday)
    .map((account) => ({
      id: account.positionId,
      name: account.name,
      currency: account.currency,
      minorUnits: minorUnitsByCurrency[account.currency] ?? 2,
      status: account.status,
      isDormant: account.dormant,
      value: { native: account.latest.amount, valuedOn: account.latest.valuedOn },
    }));
}

/** What the latest balance is, beside its amount — its own date, never "today" unless it is. */
export function latestText(latest: LatestBalanceDto, today: string, day: (date: string) => string): string {
  switch (latest.state) {
    case 'missing':
      return 'No balance recorded';
    case 'closed':
      return latest.valuedOn === null ? 'Closed' : `Closed on ${day(latest.valuedOn)}`;
    case 'opened_zero':
      return latest.valuedOn === null
        ? 'Opened empty; nothing recorded since'
        : `Opened ${day(latest.valuedOn)}; nothing recorded since`;
    default: {
      if (latest.valuedOn === null) return '';
      const when = latest.valuedOn === today ? 'today' : day(latest.valuedOn);
      return latest.statement ? `Statement balance, ${when}` : `Snapshot, ${when}`;
    }
  }
}
