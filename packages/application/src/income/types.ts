import type { MoneyDto } from '@vaultide/finance';
import type { ReportingAmountDto } from '../reconciliation/types';

/**
 * The Income year view's read model (blueprint 15.2 "Income", v2.1.20 30.23;
 * ADR 0012 D1–D3, D5, D7).
 *
 * One server-authoritative answer per page. Every figure is **income
 * recorded** — record-based, placed by `received_on`, and never
 * reconciliation-scoped — so none of it is Monthly's reconciled income, and
 * neither is meant to agree with the other (30.23 item 3). Every reporting
 * figure keeps the availability its conversion gave it, and nothing here is
 * meant to be added, split or averaged by a reader.
 */

/** A gross over some payments: only the recorded ones, and how many had none (30.23 item 4). */
export interface IncomeGrossDto {
  /** `null` when no payment inside the figure has a gross — never a zero. */
  readonly recorded: ReportingAmountDto | null;
  readonly withoutGross: number;
}

/** One income figure: net and gross in the reporting currency, and the net in each native currency. */
export interface IncomeTotalDto {
  readonly net: ReportingAmountDto;
  readonly gross: IncomeGrossDto;
  /** Per native currency, in currency order; exact and never converted. */
  readonly native: readonly MoneyDto[];
  /** How many payments are inside it. */
  readonly count: number;
}

/** One month of the year, split salary / bonus / other (30.23 item 5). */
export interface IncomeMonthDto {
  /** `YYYY-MM`. */
  readonly month: string;
  /** The current month: "so far" (30.23 item 7). */
  readonly current: boolean;
  readonly total: IncomeTotalDto;
  readonly salary: ReportingAmountDto;
  readonly bonus: ReportingAmountDto;
  readonly other: ReportingAmountDto;
}

/** A recurring source with a payment received in the year, or an occurrence scheduled in it. */
export interface IncomeSourceRowDto {
  readonly templateId: string;
  readonly name: string;
  readonly archived: boolean;
  /** The source's own currency. */
  readonly currency: string;
  readonly total: IncomeTotalDto;
}

/** One payment with no recurring source, for the one-off expansion. */
export interface IncomeOneOffPaymentDto {
  readonly entryId: string;
  readonly kind: string;
  /** Its financial date: the Monthly month that holds it. */
  readonly receivedOn: string;
  readonly settlement: 'tracked_cash' | 'external';
  readonly description: string | null;
  readonly net: MoneyDto;
  readonly gross: MoneyDto | null;
  /** The net on `receivedOn`'s rate, or why it could not be stated. */
  readonly reporting: ReportingAmountDto;
  /** The gross the same way, or `null` when none was recorded. */
  readonly reportingGross: ReportingAmountDto | null;
}

export interface IncomeOneOffKindDto {
  readonly kind: string;
  readonly total: IncomeTotalDto;
  /** By date, then by id. */
  readonly payments: readonly IncomeOneOffPaymentDto[];
}

/** "One-off payments": every entry without a source, whatever its `is_one_off` flag says. */
export interface IncomeOneOffDto {
  readonly total: IncomeTotalDto;
  readonly kinds: readonly IncomeOneOffKindDto[];
}

/**
 * One source's missing payments over the year's completed months (ADR 0012 D2),
 * as `suggested_income_missing` finds them, archived sources included.
 */
export interface IncomeMissingFlagDto {
  readonly templateId: string;
  readonly name: string;
  /** Archived: neither Monthly nor Bulk History can record or skip its occurrences. */
  readonly archived: boolean;
  /** Each missing occurrence's scheduled date, `YYYY-MM-DD`, in order. */
  readonly occurrences: readonly string[];
}

export interface IncomeYearTotalDto {
  readonly year: number;
  /** The current year: "so far". */
  readonly current: boolean;
  readonly total: IncomeTotalDto;
}

/** The year in view. */
export interface IncomeYearDto {
  readonly year: number;
  readonly current: boolean;
  /** The months that have begun, January first. */
  readonly months: readonly IncomeMonthDto[];
  readonly total: IncomeTotalDto;
  /** Into tracked accounts, and outside them (30.23 item 1). They add up to `total`. */
  readonly tracked: IncomeTotalDto;
  readonly outside: IncomeTotalDto;
  /**
   * `amount` when every row's net is complete; otherwise `name`, because a
   * ranking resting on a conversion that does not exist would be a guess (ADR
   * 0012 D1).
   */
  readonly sourceOrder: 'amount' | 'name';
  readonly sources: readonly IncomeSourceRowDto[];
  /** `null` when the year has no one-off payment. Always shown after the sources. */
  readonly oneOff: IncomeOneOffDto | null;
  readonly missing: readonly IncomeMissingFlagDto[];
}

/** What the page's two actions offer (ADR 0012 D5). */
export interface IncomeFormsDto {
  /** The kinds Add a payment offers: the seven the page counts (30.23 item 1). */
  readonly paymentKinds: readonly string[];
  readonly cashAccounts: readonly {
    readonly positionId: string;
    readonly name: string;
    readonly currency: string;
  }[];
}

export interface IncomePageDto {
  /** The year in view. */
  readonly year: number;
  readonly currentYear: number;
  readonly today: string;
  readonly reportingCurrency: string;
  readonly minorUnitsByCurrency: Readonly<Record<string, number>>;
  /** Active, FX-supported currencies a picker may offer (10.5). */
  readonly selectableCurrencyCodes: readonly string[];
  /**
   * No payment the page counts, in any year, and no income source, archived or
   * not: 15.2's empty state.
   */
  readonly empty: boolean;
  readonly navigation: {
    /**
     * `null` from the earliest year with a counted payment or an income
     * source's start (never before 1900) backwards, and when there is neither.
     */
    readonly previous: number | null;
    /** `null` on the current year: the next one has not begun. */
    readonly next: number | null;
  };
  readonly view: IncomeYearDto;
  /** Every year with income, newest first. */
  readonly years: readonly IncomeYearTotalDto[];
  /** The twelve calendar months ending with the current one, whichever year is in view. */
  readonly lastTwelveMonths: {
    /** `YYYY-MM`. */
    readonly from: string;
    readonly to: string;
    readonly total: IncomeTotalDto;
  };
  readonly forms: IncomeFormsDto;
}
