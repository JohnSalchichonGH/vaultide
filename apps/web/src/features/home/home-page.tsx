import Link from 'next/link';
import { MoneyText } from '@/components/finance/money-text';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  CLOSING,
  EXAMPLE_MONTH,
  HERO,
  PRINCIPLES,
  ROADMAP,
  STEPS,
  type RoadmapGroup,
} from '@/features/home/content';

/**
 * The public homepage (blueprint 16.1: calm, dense, typographic).
 *
 * Everything here is rendered on the server from `content.ts`. There is no
 * client component in this file: the only script the page needs is the theme
 * control in the shell around it, and the roadmap link is a plain anchor.
 *
 * The reconciliation example is the page's one visual. It is a static
 * explanation of what the Monthly page does with a month's figures, drawn with
 * the product's own money formatting and data-quality vocabulary, and it is
 * not a calculator: its arithmetic is proven in the unit tests, not in the
 * browser.
 */

const CONTAINER = 'mx-auto max-w-[var(--container-content)] px-4 sm:px-6';

const BUTTON =
  'inline-flex items-center justify-center rounded-[var(--radius-control)] px-5 py-2.5 font-medium';
const PRIMARY_BUTTON = cn(
  BUTTON,
  'bg-[var(--color-accent)] text-[var(--color-accent-foreground)] hover:opacity-90',
);
const SECONDARY_BUTTON = cn(
  BUTTON,
  'border border-[var(--color-border-strong)] hover:bg-[var(--color-surface)]',
);

export function HomePage() {
  return (
    <>
      <Hero />
      <HowItWorks />
      <Roadmap />
      <Principles />
      <Closing />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Hero                                                                        */
/* -------------------------------------------------------------------------- */

function Hero() {
  return (
    <section aria-labelledby="hero-title" className={cn(CONTAINER, 'py-16 sm:py-24')}>
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-16">
        <div>
          <p className="font-medium text-[var(--color-accent)]">{HERO.kicker}</p>
          <h1 id="hero-title" className="mt-4 text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
            {HERO.title}
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-[var(--color-muted-foreground)]">
            {HERO.lead}
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href={HERO.primary.href} className={PRIMARY_BUTTON}>
              {HERO.primary.label}
            </Link>
            {/* A same-page anchor: native navigation, no router involved. */}
            <a href={HERO.secondary.href} className={SECONDARY_BUTTON}>
              {HERO.secondary.label}
            </a>
          </div>
        </div>

        <ExampleMonth />
      </div>
    </section>
  );
}

/** One row of the example: a label and its amount, in tabular figures. */
function ExampleRow({
  label,
  amount,
  emphasis = false,
  indent = false,
  divider = false,
}: {
  readonly label: string;
  readonly amount: string;
  readonly emphasis?: boolean;
  readonly indent?: boolean;
  /** A rule above the row: the derived figures sit under the facts they follow from. */
  readonly divider?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-4 py-2',
        emphasis && 'font-semibold',
        indent && 'text-[var(--color-muted-foreground)]',
        divider && 'mt-1 border-t pt-3',
      )}
    >
      <dt className={cn(indent && 'pl-4')}>{label}</dt>
      <dd className="tabular whitespace-nowrap">
        <MoneyText
          amount={amount}
          currency={EXAMPLE_MONTH.currency}
          locale={EXAMPLE_MONTH.locale}
          minorUnits={EXAMPLE_MONTH.minorUnits}
        />
      </dd>
    </div>
  );
}

function ExampleMonth() {
  const { figures, missing } = EXAMPLE_MONTH;
  return (
    <section
      aria-labelledby="example-title"
      data-testid="example-month"
      className="rounded-[var(--radius-surface)] border bg-[var(--color-surface)]"
    >
      <header className="border-b px-5 py-4 sm:px-6">
        <h2
          id="example-title"
          className="text-[length:var(--text-meta)] font-medium text-[var(--color-muted-foreground)]"
        >
          {EXAMPLE_MONTH.caption}
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="text-[length:var(--text-section)] font-semibold">
            {EXAMPLE_MONTH.currency}
          </span>
          <Badge tone="positive">{EXAMPLE_MONTH.status}</Badge>
        </div>
        <p className="mt-2 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
          {EXAMPLE_MONTH.statusMeaning}
        </p>
      </header>

      <dl className="px-5 py-3 sm:px-6">
        <ExampleRow label="Opening cash balances" amount={figures.opening} />
        <ExampleRow label="Income" amount={figures.income} />
        <ExampleRow label="Closing cash balances" amount={figures.closing} />
        <ExampleRow label="Spending" amount={figures.spending} emphasis divider />
        <ExampleRow label="Known expenses" amount={figures.knownExpenses} indent />
        <ExampleRow label="Unclassified (not recorded)" amount={figures.unclassified} indent />
        <ExampleRow label="Saved from income" amount={figures.saved} emphasis divider />
      </dl>

      <div className="border-t px-5 py-4 sm:px-6">
        <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
          {missing.caption}
        </p>
        <dl className="mt-2">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <dt>{missing.label}</dt>
            <dd className="flex items-center gap-3">
              <MoneyText amount={null} unavailableReason={missing.reason} />
              <Badge tone="unavailable">{missing.status}</Badge>
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
          {missing.reason}
        </p>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* How it works                                                                */
/* -------------------------------------------------------------------------- */

function HowItWorks() {
  return (
    <section aria-labelledby="how-title" className="border-t">
      <div className={cn(CONTAINER, 'py-16 sm:py-20')}>
        <h2 id="how-title" className="text-2xl font-semibold tracking-tight sm:text-3xl">
          How it works
        </h2>
        <ol className="mt-10 grid gap-8 sm:grid-cols-3 sm:gap-10">
          {STEPS.map((step, index) => (
            <li key={step.title} className="border-t pt-5">
              {/* The list is ordered already; the printed number is decoration. */}
              <span
                aria-hidden="true"
                className="tabular text-[length:var(--text-meta)] font-medium text-[var(--color-muted-foreground)]"
              >
                {String(index + 1).padStart(2, '0')}
              </span>
              <h3 className="mt-2 text-[length:var(--text-section)] font-semibold">{step.title}</h3>
              <p className="mt-2 leading-relaxed text-[var(--color-muted-foreground)]">{step.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Roadmap                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A group's status, in words first and then as a small square. The square is
 * not a data-quality badge — those are the bordered chips the example uses —
 * and the three shapes differ from one another, not only in colour (16.6).
 */
function StatusMarker({ status }: { readonly status: RoadmapGroup['status'] }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-2.5 rounded-[2px]',
        status === 'available' && 'bg-[var(--color-accent)]',
        status === 'next' && 'bg-[var(--color-foreground)]',
        status === 'planned' && 'border border-[var(--color-border-strong)]',
      )}
    />
  );
}

function GroupLabel({ group, id }: { readonly group: RoadmapGroup; readonly id: string }) {
  return (
    <h3
      id={id}
      className="flex items-center gap-2 text-[length:var(--text-meta)] font-semibold uppercase tracking-wide"
    >
      <StatusMarker status={group.status} />
      {group.label}
    </h3>
  );
}

function AvailableGroup({ group }: { readonly group: RoadmapGroup }) {
  return (
    <div
      data-testid="roadmap-available"
      className="rounded-[var(--radius-surface)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-6 sm:p-8"
    >
      <GroupLabel group={group} id="roadmap-available" />
      <dl className="mt-6 grid gap-8 md:grid-cols-3">
        {group.entries.map((entry) => (
          <div key={entry.title}>
            <dt className="text-[length:var(--text-section)] font-semibold">{entry.title}</dt>
            <dd className="mt-2 leading-relaxed text-[var(--color-muted-foreground)]">{entry.text}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function NextGroup({ group }: { readonly group: RoadmapGroup }) {
  return (
    <div data-testid="roadmap-next" className="rounded-[var(--radius-surface)] border p-6 sm:p-8">
      <GroupLabel group={group} id="roadmap-next" />
      <dl className="mt-6 grid gap-8 md:grid-cols-3">
        {group.entries.map((entry) => (
          <div key={entry.title} className="md:col-span-2">
            <dt className="text-[length:var(--text-section)] font-semibold">{entry.title}</dt>
            <dd className="mt-2 leading-relaxed text-[var(--color-muted-foreground)]">{entry.text}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function PlannedGroup({ group }: { readonly group: RoadmapGroup }) {
  return (
    <div data-testid="roadmap-planned" className="px-6 sm:px-8">
      <GroupLabel group={group} id="roadmap-planned" />
      <dl className="mt-4">
        {group.entries.map((entry) => (
          <div
            key={entry.title}
            className="grid gap-1 border-t py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-8"
          >
            <dt className="font-medium">{entry.title}</dt>
            <dd className="leading-relaxed text-[var(--color-muted-foreground)]">{entry.text}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Roadmap() {
  const [available, next, planned] = ROADMAP.groups;
  return (
    <section id="roadmap" aria-labelledby="roadmap-title" className="scroll-mt-6 border-t">
      <div className={cn(CONTAINER, 'py-16 sm:py-20')}>
        <h2 id="roadmap-title" className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {ROADMAP.title}
        </h2>
        <p className="mt-4 max-w-2xl leading-relaxed text-[var(--color-muted-foreground)]">
          {ROADMAP.lead}
        </p>
        <div className="mt-10 space-y-6">
          <AvailableGroup group={available} />
          <NextGroup group={next} />
          <PlannedGroup group={planned} />
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Principles                                                                  */
/* -------------------------------------------------------------------------- */

function Principles() {
  return (
    <section aria-labelledby="principles-title" className="border-t">
      <div className={cn(CONTAINER, 'py-16 sm:py-20')}>
        <h2 id="principles-title" className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {PRINCIPLES.title}
        </h2>
        <ul className="mt-10 grid gap-8 sm:grid-cols-2 sm:gap-x-12 sm:gap-y-10">
          {PRINCIPLES.items.map((item) => (
            <li key={item.title} className="border-t pt-5">
              <h3 className="text-[length:var(--text-section)] font-semibold">{item.title}</h3>
              <p className="mt-2 leading-relaxed text-[var(--color-muted-foreground)]">{item.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Closing                                                                     */
/* -------------------------------------------------------------------------- */

function Closing() {
  return (
    <section aria-labelledby="closing-title" className="border-t">
      <div className={cn(CONTAINER, 'py-16 text-center sm:py-24')}>
        <h2 id="closing-title" className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {CLOSING.title}
        </h2>
        <p className="mx-auto mt-4 max-w-xl leading-relaxed text-[var(--color-muted-foreground)]">
          {CLOSING.lead}
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link href={CLOSING.primary.href} className={PRIMARY_BUTTON}>
            {CLOSING.primary.label}
          </Link>
          <Link href={CLOSING.secondary.href} className={SECONDARY_BUTTON}>
            {CLOSING.secondary.label}
          </Link>
        </div>
        <p className="mt-8 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
          {CLOSING.trust.join(' · ')}
        </p>
      </div>
    </section>
  );
}
