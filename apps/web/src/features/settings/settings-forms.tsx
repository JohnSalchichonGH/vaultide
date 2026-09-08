'use client';

import { useId, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { UserSettings } from '@vaultide/application';
import {
  archiveCategoryAction,
  createCategoryAction,
  createTagAction,
  deleteTagAction,
  updateSettingsAction,
} from '@/server/actions/settings';
import { setCountAdditionalSpendingAction } from '@/server/actions/recurring';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useHydrated } from '@/lib/use-hydrated';

/**
 * The settings forms (blueprint 15.2, 16.6, 20.3).
 *
 * Each one sends the `version` it was rendered from, so a change made in
 * another tab produces `CONFLICT_VERSION` with "reload to see the current
 * values" rather than silently overwriting it (20.3). Nothing is optimistic:
 * the server's answer is what the page then shows.
 */

export interface CurrencyOption {
  readonly code: string;
  readonly name: string;
}

function Status({ tone, children }: { tone: 'error' | 'success'; children: ReactNode }) {
  const color = tone === 'error' ? 'var(--color-negative)' : 'var(--color-positive)';
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      data-testid={`settings-${tone}`}
      className="text-[length:var(--text-meta)]"
      style={{ color }}
    >
      {children}
    </p>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[var(--radius-surface)] border p-4">
      <h2 className="text-[length:var(--text-section)] font-semibold">{title}</h2>
      <p className="mt-1 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
        {description}
      </p>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function SaveButton({ pending, children = 'Save' }: { pending: boolean; children?: ReactNode }) {
  // See `useHydrated`: a controlled form is not usable until React owns it.
  const hydrated = useHydrated();
  return (
    <button
      type="submit"
      disabled={!hydrated || pending}
      className="rounded-[var(--radius-control)] bg-[var(--color-accent)] px-4 py-2 font-medium text-[var(--color-accent-foreground)] disabled:opacity-60"
    >
      {pending ? 'Saving…' : children}
    </button>
  );
}

/** Profile: the two things that decide what "today" and "€1,234.56" mean. */
export function ProfileSettingsForm({
  settings,
  timezones,
  locales,
}: {
  settings: UserSettings;
  timezones: readonly string[];
  locales: readonly string[];
}) {
  const router = useRouter();
  const timezoneId = useId();
  const localeId = useId();
  const [timezone, setTimezone] = useState(settings.timezone);
  const [locale, setLocale] = useState(settings.locale);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setSaved(false);
        startTransition(async () => {
          const result = await updateSettingsAction({
            timezone,
            locale,
            expectedVersion: settings.version,
          });
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          setSaved(true);
          router.refresh();
        });
      }}
    >
      <Section
        title="Where and how you read numbers"
        description="Your time zone decides what “today” is, and therefore which dates Vaultide will accept for a record. Changing it never changes a date already stored."
      >
        <div className="space-y-1.5">
          <Label htmlFor={timezoneId}>Time zone</Label>
          <select
            id={timezoneId}
            name="timezone"
            value={timezone}
            data-testid="timezone"
            className="w-full rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-3 py-2"
            onChange={(event) => {
              setTimezone(event.target.value);
            }}
          >
            {timezones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={localeId}>Number and date format</Label>
          <select
            id={localeId}
            name="locale"
            value={locale}
            data-testid="locale"
            className="w-full rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-3 py-2"
            onChange={(event) => {
              setLocale(event.target.value);
            }}
          >
            {locales.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3">
          <SaveButton pending={pending} />
          {error === null ? null : <Status tone="error">{error}</Status>}
          {saved ? <Status tone="success">Saved.</Status> : null}
        </div>
      </Section>
    </form>
  );
}

/** Currencies: base, reporting, favourites, and the savings-rate preference. */
export function CurrencySettingsForm({
  settings,
  currencies,
}: {
  settings: UserSettings;
  currencies: readonly CurrencyOption[];
}) {
  const router = useRouter();
  const baseId = useId();
  const reportingId = useId();
  const countId = useId();

  const [baseCurrency, setBaseCurrency] = useState(settings.baseCurrency);
  const [reportingCurrency, setReportingCurrency] = useState(settings.reportingCurrency);
  const [favorites, setFavorites] = useState<string[]>([...settings.favoriteCurrencies]);
  const [countAdditionalSpending, setCountAdditionalSpending] = useState(
    settings.countAdditionalSpending,
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function toggleFavorite(code: string): void {
    setFavorites((current) =>
      current.includes(code) ? current.filter((item) => item !== code) : [...current, code],
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setSaved(false);
        startTransition(async () => {
          /*
           * Two writes, deliberately.
           *
           * The currency preferences are cheap and reversible and go through
           * the ordinary cached-session action. The savings-rate setting is a
           * financial input — it re-interprets every past month's personal
           * savings (12.5) — so it goes through its own action, which
           * revalidates the session against the store (ADR 0003). It is
           * written first: if the session has been revoked, the request that
           * matters fails before anything else is saved.
           */
          if (countAdditionalSpending !== settings.countAdditionalSpending) {
            const preference = await setCountAdditionalSpendingAction({
              countAdditionalSpending,
              expectedVersion: settings.version,
            });
            if (!preference.ok) {
              setError(preference.error.message);
              return;
            }
          }

          const result = await updateSettingsAction({
            baseCurrency,
            reportingCurrency,
            favoriteCurrencies: favorites,
            expectedVersion:
              countAdditionalSpending === settings.countAdditionalSpending
                ? settings.version
                : settings.version + 1,
          });
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          setSaved(true);
          router.refresh();
        });
      }}
    >
      <Section
        title="Currencies"
        description="Base currency is what you think in. Reporting currency is what totals are shown in — it is a display choice, and no converted value is ever stored."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={baseId}>Base currency</Label>
            <select
              id={baseId}
              name="baseCurrency"
              value={baseCurrency}
              data-testid="base-currency"
              className="w-full rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-3 py-2"
              onChange={(event) => {
                setBaseCurrency(event.target.value);
              }}
            >
              {currencies.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.code} — {currency.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={reportingId}>Reporting currency</Label>
            <select
              id={reportingId}
              name="reportingCurrency"
              value={reportingCurrency}
              data-testid="reporting-currency-setting"
              className="w-full rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-3 py-2"
              onChange={(event) => {
                setReportingCurrency(event.target.value);
              }}
            >
              {currencies.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.code} — {currency.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-[length:var(--text-meta)] font-medium">
            Favourite currencies
          </legend>
          <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
            Shown first in every currency picker. Vaultide fetches the exchange-rate history of a
            currency the first time anyone uses it.
          </p>
          <div className="flex flex-wrap gap-2">
            {currencies.map((currency) => {
              const selected = favorites.includes(currency.code);
              return (
                <label
                  key={currency.code}
                  className={cn(
                    'cursor-pointer rounded-[var(--radius-control)] border px-2 py-1 text-[length:var(--text-meta)]',
                    selected && 'border-[var(--color-accent)] text-[var(--color-accent)]',
                  )}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    name="favoriteCurrencies"
                    value={currency.code}
                    checked={selected}
                    onChange={() => {
                      toggleFavorite(currency.code);
                    }}
                  />
                  {currency.code}
                </label>
              );
            })}
          </div>
        </fieldset>
      </Section>

      <Section
        title="Spending you paid from outside Vaultide"
        description="Money you spent from an account Vaultide does not track is still your spending. Counting it keeps “Total spending” and “Savings rate” consistent with each other."
      >
        <label htmlFor={countId} className="flex items-start gap-3">
          <input
            id={countId}
            type="checkbox"
            name="countAdditionalSpending"
            checked={countAdditionalSpending}
            data-testid="count-additional-spending"
            onChange={(event) => {
              setCountAdditionalSpending(event.target.checked);
            }}
          />
          <span>
            Count spending I paid from outside my tracked accounts in my savings rate
            <span className="mt-1 block text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
              Expenses somebody else paid are never counted, whichever way this is set.
            </span>
          </span>
        </label>

        <div className="flex items-center gap-3">
          <SaveButton pending={pending} />
          {error === null ? null : <Status tone="error">{error}</Status>}
          {saved ? <Status tone="success">Saved.</Status> : null}
        </div>
      </Section>
    </form>
  );
}

export interface CategoryView {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly groupName: string | null;
  readonly isSystem: boolean;
}

export interface TagView {
  readonly id: string;
  readonly name: string;
}

/** Categories and tags (6.2, T5, T6). System categories are listed, not editable. */
export function CategoriesManager({
  categories,
  tags,
  kinds,
}: {
  categories: readonly CategoryView[];
  tags: readonly TagView[];
  kinds: readonly string[];
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [kind, setKind] = useState(kinds[0] ?? 'general');
  const [tagName, setTagName] = useState('');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const ordinary = categories.filter((category) => !category.isSystem);
  const system = categories.filter((category) => category.isSystem);

  function run(work: () => Promise<{ ok: boolean; error?: { message: string } }>): void {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        setError(result.error?.message ?? 'That did not work.');
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <Section
        title="Your categories"
        description="Categories organise your spending. Rename, add and archive them freely — archiving keeps the history intact and frees the name."
      >
        {error === null ? null : <Status tone="error">{error}</Status>}

        <ul className="divide-y" data-testid="category-list">
          {ordinary.map((category) => (
            <li key={category.id} className="flex items-center justify-between gap-4 py-2">
              <span>
                {category.name}
                {category.groupName === null ? null : (
                  <span className="ml-2 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
                    {category.groupName}
                  </span>
                )}
              </span>
              <button
                type="button"
                disabled={pending}
                className="text-[length:var(--text-meta)] underline"
                onClick={() => {
                  run(() => archiveCategoryAction({ categoryId: category.id }));
                }}
              >
                Archive
              </button>
            </li>
          ))}
        </ul>

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            run(async () => {
              const result = await createCategoryAction({ kind, name });
              if (result.ok) setName('');
              return result;
            });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="new-category-name">New category</Label>
            <Input
              id="new-category-name"
              name="name"
              value={name}
              data-testid="new-category-name"
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-category-kind">Kind</Label>
            <select
              id="new-category-kind"
              name="kind"
              value={kind}
              className="rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-3 py-2"
              onChange={(event) => {
                setKind(event.target.value);
              }}
            >
              {kinds.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <SaveButton pending={pending}>Add category</SaveButton>
        </form>
      </Section>

      <Section
        title="Categories Vaultide manages"
        description="These seven carry accounting meaning: a property cost, an investment fee, a transfer fee, an acquisition or disposal cost, a capital improvement and money leaving your tracked accounts each land in exactly one place in the analysis. They cannot be archived."
      >
        <ul className="divide-y" data-testid="system-category-list">
          {system.map((category) => (
            <li key={category.id} className="flex items-center justify-between gap-4 py-2">
              <span>{category.name}</span>
              <span className="text-[length:var(--text-meta)] text-[var(--color-unavailable)]">
                {category.kind}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Tags" description="Free-form labels you can put on any record.">
        <ul className="flex flex-wrap gap-2" data-testid="tag-list">
          {tags.map((tag) => (
            <li
              key={tag.id}
              className="flex items-center gap-2 rounded-[var(--radius-control)] border px-2 py-1 text-[length:var(--text-meta)]"
            >
              {tag.name}
              <button
                type="button"
                disabled={pending}
                aria-label={`Delete tag ${tag.name}`}
                onClick={() => {
                  run(() => deleteTagAction({ tagId: tag.id }));
                }}
              >
                ×
              </button>
            </li>
          ))}
          {tags.length === 0 ? (
            <li className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
              No tags yet.
            </li>
          ) : null}
        </ul>

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            run(async () => {
              const result = await createTagAction({ name: tagName });
              if (result.ok) setTagName('');
              return result;
            });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="new-tag-name">New tag</Label>
            <Input
              id="new-tag-name"
              name="name"
              value={tagName}
              data-testid="new-tag-name"
              onChange={(event) => {
                setTagName(event.target.value);
              }}
            />
          </div>
          <SaveButton pending={pending}>Add tag</SaveButton>
        </form>
      </Section>
    </div>
  );
}

export { Section, Status };
