/**
 * The public homepage's content (blueprint 16.1, 16.2).
 *
 * Plain data, no React and no IO, so the page renders it and the unit tests
 * read the very same values. The example month in particular is the one place
 * its figures are written down: the card formats them from these exact decimal
 * strings, and the test proves the arithmetic on these same strings, in minor
 * units, never through a floating-point number (7.1.1).
 *
 * The roadmap groups shipped capability and planned work by status, in words.
 * It carries no phase numbers, dates or progress: the public vocabulary is
 * `Available now`, `Next up` and `Planned`, and nothing else.
 */

export const HERO = {
  kicker: 'Personal finance, reconciled monthly',
  title: 'Make every month add up.',
  lead: 'Enter your account balances and income, plus the expenses and transfers you know. Vaultide works out the rest of your spending and what you saved across currencies — without making you log every purchase.',
  primary: { label: 'Create account', href: '/sign-up' },
  secondary: { label: "See what's available", href: '#roadmap' },
} as const;

/**
 * One fictional month, as the Monthly page would reconcile it: opening and
 * closing cash balances, the income received, and what follows from them.
 *
 * Amounts are exact decimal strings in the example's currency, two minor units
 * each, formatted by the same exact path the product uses.
 */
export const EXAMPLE_MONTH = {
  caption: 'Example month · fictional figures',
  currency: 'EUR',
  locale: 'en-GB',
  minorUnits: 2,
  status: 'Reliable',
  statusMeaning: 'Every cash account has a month-end balance for this month and the month before.',
  figures: {
    opening: '15740.00',
    income: '2600.00',
    closing: '16260.00',
    spending: '2080.00',
    knownExpenses: '1145.00',
    unclassified: '935.00',
    saved: '520.00',
  },
  missing: {
    caption: 'If a month-end balance is missing:',
    label: 'Spending',
    status: 'Unavailable',
    reason: 'Month-end balance missing for Savings',
  },
} as const;

export const STEPS = [
  {
    title: 'Enter your balances',
    text: 'Use month-end statements for completed months. During the month, update your current balances when you want a fresh view.',
  },
  {
    title: 'Add what you know',
    text: 'Record income, known expenses and transfers between your accounts. Recurring items come back each month.',
  },
  {
    title: 'See the month add up',
    text: 'Vaultide separates known from unclassified spending, shows what you saved, and shows how reliable the result is.',
  },
] as const;

export type RoadmapStatus = 'available' | 'next' | 'planned';

export interface RoadmapEntry {
  readonly title: string;
  readonly text: string;
}

export interface RoadmapGroup {
  readonly status: RoadmapStatus;
  readonly label: string;
  readonly entries: readonly RoadmapEntry[];
}

export const ROADMAP = {
  title: "What you can use today, and what's next",
  lead: 'Vaultide starts with monthly reconciliation and grows toward a complete view of everything you own and owe. Planned work is shown in the order we currently expect to build it, without release dates.',
  groups: [
    {
      status: 'available',
      label: 'Available now',
      entries: [
        {
          title: 'Monthly reconciliation',
          text: 'Completed months and month-to-date views, with known and unclassified spending, savings, reliability and clear missing-data explanations.',
        },
        {
          title: 'Accounts & net worth',
          text: "Cash accounts and other assets, balances over time, multiple currencies, and total vs financial net worth for what's tracked.",
        },
        {
          title: 'Income, expenses & transfers',
          text: 'One-off and recurring income and known expenses, plus transfers between your own accounts, including cross-currency transfers and linked fees.',
        },
        {
          title: 'Spending over time',
          text: 'A dedicated cross-month view of total and tracked spending, known vs unclassified amounts, recent averages, combined periods where balances have gaps, categories and the largest known expenses.',
        },
      ],
    },
    {
      status: 'next',
      label: 'Next up',
      entries: [
        {
          title: 'Corrections and income over time',
          text: 'Resolve reconciliation issues, correct past months, enter older history faster, and see your income across months in a dedicated view.',
        },
      ],
    },
    {
      status: 'planned',
      label: 'Planned',
      entries: [
        {
          title: 'Investments',
          text: 'Portfolio valuations, contributions and withdrawals, distributions, fees, and performance that separates flows, market moves and currency effects.',
        },
        {
          title: 'Debts & mortgages',
          text: 'Loans and mortgages, schedules, derived balances, and payments split into principal and interest.',
        },
        {
          title: 'Property',
          text: 'Property values, rent, running costs, improvements, sales, and linked mortgages.',
        },
        {
          title: 'Net worth, explained & export',
          text: 'Complete monthly history, net-worth drivers and allocation, richer dashboard analytics, and full data export.',
        },
        {
          title: 'Goals & projections',
          text: 'Goals from actual data, deterministic projections, scenario comparison, and later probabilistic planning.',
        },
      ],
    },
  ] as const satisfies readonly RoadmapGroup[],
} as const;

export const PRINCIPLES = {
  title: 'The rules behind the numbers',
  items: [
    {
      title: "Missing isn't zero",
      text: 'If a balance or exchange rate is missing, Vaultide marks the affected result partial or unavailable instead of silently treating it as zero.',
    },
    {
      title: 'Every currency stays itself',
      text: 'Records keep their native currency. Reporting totals use dated exchange rates, and changing reporting currency never rewrites the recorded amount.',
    },
    {
      title: "Moving money isn't spending",
      text: 'Transfers between your own tracked accounts are movements, not income or spending. A linked fee is counted once.',
    },
    {
      title: 'Amounts stay exact',
      text: "Money is kept as exact decimal values, and formatting respects each currency's minor units.",
    },
  ],
} as const;

export const CLOSING = {
  title: 'Start with one account.',
  lead: 'Add an account and its balance, then build a clear monthly picture from there.',
  primary: { label: 'Create account', href: '/sign-up' },
  secondary: { label: 'Sign in', href: '/sign-in' },
  trust: ['No bank connection required', 'Optional two-factor sign-in', 'Delete your account at any time'],
} as const;

export const FOOTER_LINE = 'Vaultide · Personal finance, reconciled monthly';
