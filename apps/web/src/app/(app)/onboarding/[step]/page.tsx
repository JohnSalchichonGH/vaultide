import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getServices, listCurrencies } from '@vaultide/application';
import { requireSessionPage } from '@/server/context';
import {
  OnboardingCurrencyStep,
  OnboardingFavoritesStep,
  OnboardingIdentityStep,
} from '@/features/onboarding/onboarding-steps';
import { SUGGESTED_LOCALES, suggestedTimeZones } from '@/lib/intl-options';

export const metadata: Metadata = { title: 'Set up Vaultide' };
export const dynamic = 'force-dynamic';

/**
 * Onboarding steps 1–3 (blueprint Phase 1, 15.2 "Onboarding — steps skippable").
 *
 * One route with the step as a segment, matching 15.1's `/onboarding/[step]`.
 * Later phases add steps 4–11 here, each with the data it needs.
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
    default:
      // Steps 4–11 belong to later phases; an unknown step is not a page.
      notFound();
  }
}
