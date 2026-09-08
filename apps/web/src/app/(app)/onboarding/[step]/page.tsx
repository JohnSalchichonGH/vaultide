import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getServices, listCurrencies } from '@vaultide/application';
import { requireSessionPage } from '@/server/context';
import {
  OnboardingAccountStep,
  OnboardingCurrencyStep,
  OnboardingFavoritesStep,
  OnboardingIdentityStep,
} from '@/features/onboarding/onboarding-steps';
import { SUGGESTED_LOCALES, suggestedTimeZones } from '@/lib/intl-options';

export const metadata: Metadata = { title: 'Set up Vaultide' };
export const dynamic = 'force-dynamic';

/**
 * Onboarding steps 1–4 (blueprint 15.2 "Onboarding — steps skippable").
 *
 * One route with the step as a segment, matching 15.1's `/onboarding/[step]`.
 * Phase 1 built the first three; Phase 2 adds the fourth — the first cash
 * account — because Phase 2 is the phase that gives it something to ask about.
 * Steps 5–11 arrive with theirs.
 */
export default async function OnboardingStepPage({
  params,
}: {
  params: Promise<{ step: string }>;
}) {
  const { step } = await params;
  const session = await requireSessionPage(`/onboarding/${step}`);
  const currencies = await listCurrencies(getServices().db, { fxSupportedOnly: true });

  const props = {
    settings: session.settings,
    timezones: suggestedTimeZones(session.settings.timezone),
    locales: [...SUGGESTED_LOCALES],
    currencies,
  };

  switch (step) {
    case '1':
      return <OnboardingIdentityStep {...props} />;
    case '2':
      return <OnboardingCurrencyStep {...props} />;
    case '3':
      return <OnboardingFavoritesStep {...props} />;
    case '4':
      return <OnboardingAccountStep {...props} today={session.today} />;
    default:
      // Steps 5–11 belong to later phases; an unknown step is not a page.
      notFound();
  }
}
