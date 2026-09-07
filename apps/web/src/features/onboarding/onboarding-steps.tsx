'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { UserSettings } from '@vaultide/application';
import { completeOnboardingStepAction } from '@/server/actions/settings';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useHydrated } from '@/lib/use-hydrated';

/**
 * Onboarding steps 1–3 (blueprint Phase 1 "onboarding steps 1–3"; spec §90's
 * later steps arrive with the phases that give them something to ask about).
 *
 * Each step saves immediately rather than at the end, so a person who stops
 * half way keeps what they answered. Every step is skippable: the defaults set
 * at sign-up are usable, and a wizard that cannot be escaped is a worse
 * introduction than one that can.
 */

export interface StepProps {
  readonly settings: UserSettings;
  readonly timezones: readonly string[];
  readonly locales: readonly string[];
  readonly currencies: readonly { code: string; name: string }[];
  /** The browser's own guess, offered as the default for step 1. */
  readonly detectedTimezone?: string;
}

function StepShell({
  step,
  title,
  description,
  children,
}: {
  step: number;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-xl">
      <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
        Step {step} of 3
      </p>
      <h1 className="mt-1 text-[length:var(--text-page)] font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-[var(--color-muted-foreground)]">{description}</p>
      <div className="mt-6">{children}</div>
    </div>
  );
}

function Actions({
  pending,
  error,
  onSkip,
  submitLabel,
}: {
  pending: boolean;
  error: string | null;
  onSkip: () => void;
  submitLabel: string;
}) {
  // See `useHydrated`: a controlled form is not usable until React owns it.
  const hydrated = useHydrated();

  return (
    <div className="space-y-3">
      {error === null ? null : (
        <p role="alert" data-testid="onboarding-error" className="text-[var(--color-negative)]">
          {error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!hydrated || pending}
          data-testid="onboarding-continue"
          className="rounded-[var(--radius-control)] bg-[var(--color-accent)] px-4 py-2 font-medium text-[var(--color-accent-foreground)] disabled:opacity-60"
        >
          {pending ? 'Saving…' : submitLabel}
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="text-[length:var(--text-meta)] underline"
          data-testid="onboarding-skip"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}

/** Step 1: what "today" means for this user, and how numbers are formatted. */
export function OnboardingIdentityStep({ settings, timezones, locales, detectedTimezone }: StepProps) {
  const router = useRouter();
  const timezoneId = useId();
  const localeId = useId();

  // The browser knows where it is; asking a person to find their zone in a list
  // of four hundred is a worse first question than confirming a good guess.
  const initialZone =
    detectedTimezone !== undefined && timezones.includes(detectedTimezone)
      ? detectedTimezone
      : settings.timezone;

  const [timezone, setTimezone] = useState(initialZone);
  const [locale, setLocale] = useState(settings.locale);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <StepShell
      step={1}
      title="Where are you?"
      description="Your time zone decides what “today” means — and Vaultide never accepts a record dated after today. Changing it later never changes a date already stored."
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          startTransition(async () => {
            const result = await completeOnboardingStepAction({
              step: 1,
              timezone,
              locale,
              expectedVersion: settings.version,
            });
            if (!result.ok) {
              setError(result.error.message);
              return;
            }
            // The header and the sidebar live in a layout shared by every
            // step, and a shared layout is not re-rendered by a navigation.
            // Refreshing first is what makes the new reporting currency show
            // up in the header rather than a page reload later.
            router.refresh();
            router.push('/onboarding/2');
          });
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor={timezoneId}>Time zone</Label>
          <select
            id={timezoneId}
            value={timezone}
            data-testid="onboarding-timezone"
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
            value={locale}
            data-testid="onboarding-locale"
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

        <Actions
          pending={pending}
          error={error}
          submitLabel="Continue"
          onSkip={() => {
            router.push('/onboarding/2');
          }}
        />
      </form>
    </StepShell>
  );
}

/** Step 2: the two currency choices, and the difference between them. */
export function OnboardingCurrencyStep({ settings, currencies }: StepProps) {
  const router = useRouter();
  const baseId = useId();
  const reportingId = useId();
  const [baseCurrency, setBaseCurrency] = useState(settings.baseCurrency);
  const [reportingCurrency, setReportingCurrency] = useState(settings.reportingCurrency);
  const [sameAsBase, setSameAsBase] = useState(
    settings.baseCurrency === settings.reportingCurrency,
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const effectiveReporting = sameAsBase ? baseCurrency : reportingCurrency;

  return (
    <StepShell
      step={2}
      title="What currency do you think in?"
      description="Vaultide stores every record in the currency it actually happened in. Your base currency is what you think in; your reporting currency is what totals are shown in."
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          startTransition(async () => {
            const result = await completeOnboardingStepAction({
              step: 2,
              baseCurrency,
              reportingCurrency: effectiveReporting,
              expectedVersion: settings.version,
            });
            if (!result.ok) {
              setError(result.error.message);
              return;
            }
            router.refresh();
            router.push('/onboarding/3');
          });
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor={baseId}>Base currency</Label>
          <select
            id={baseId}
            value={baseCurrency}
            data-testid="onboarding-base-currency"
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

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={sameAsBase}
            data-testid="onboarding-same-currency"
            onChange={(event) => {
              setSameAsBase(event.target.checked);
            }}
          />
          <span>Show totals in the same currency</span>
        </label>

        {sameAsBase ? null : (
          <div className="space-y-1.5">
            <Label htmlFor={reportingId}>Reporting currency</Label>
            <select
              id={reportingId}
              value={reportingCurrency}
              data-testid="onboarding-reporting-currency"
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
        )}

        <Actions
          pending={pending}
          error={error}
          submitLabel="Continue"
          onSkip={() => {
            router.push('/onboarding/3');
          }}
        />
      </form>
    </StepShell>
  );
}

/** Step 3: favourites, which is also what warms the rate history (10.4). */
export function OnboardingFavoritesStep({ settings, currencies }: StepProps) {
  const [favorites, setFavorites] = useState<string[]>(() => {
    const initial = new Set(settings.favoriteCurrencies);
    initial.add(settings.baseCurrency);
    initial.add(settings.reportingCurrency);
    return [...initial];
  });
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function finish(): void {
    // A full navigation, not a client-side push.
    //
    // Onboarding and the settings pages share the `(app)` layout, and the App
    // Router reuses a shared layout across a navigation rather than
    // re-rendering it — so the header would keep showing the reporting
    // currency it was rendered with when onboarding began, which is precisely
    // the value the user has just changed. Leaving the wizard happens once per
    // account; a real navigation is the honest way to end it.
    window.location.assign('/settings/profile');
  }

  return (
    <StepShell
      step={3}
      title="Which other currencies do you deal with?"
      description="These appear first in every currency picker. Vaultide fetches a currency's full exchange-rate history the first time anyone uses it, so picking them now means your first conversion is instant."
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          startTransition(async () => {
            const result = await completeOnboardingStepAction({
              step: 3,
              favoriteCurrencies: favorites,
              expectedVersion: settings.version,
            });
            if (!result.ok) {
              setError(result.error.message);
              return;
            }
            finish();
          });
        }}
      >
        <div className="flex flex-wrap gap-2" data-testid="onboarding-favorites">
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
                  checked={selected}
                  value={currency.code}
                  onChange={() => {
                    setFavorites((current) =>
                      current.includes(currency.code)
                        ? current.filter((code) => code !== currency.code)
                        : [...current, currency.code],
                    );
                  }}
                />
                {currency.code}
              </label>
            );
          })}
        </div>

        <Actions pending={pending} error={error} submitLabel="Finish setup" onSkip={finish} />
      </form>
    </StepShell>
  );
}
