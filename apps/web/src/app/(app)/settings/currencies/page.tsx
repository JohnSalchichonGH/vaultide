import type { Metadata } from 'next';
import { getServices, listCurrencies } from '@vaultide/application';
import { requireSessionPage } from '@/server/context';
import { CurrencySettingsForm } from '@/features/settings/settings-forms';

export const metadata: Metadata = { title: 'Currencies' };
export const dynamic = 'force-dynamic';

/**
 * Settings → Currencies (blueprint 15.2, 12.5).
 *
 * The list is the FX-supported set (10.4): a currency Vaultide has no rates for
 * could never be converted honestly, so it is not offered. Crypto is not in the
 * catalogue at all — it is an investment asset class, not a currency (R28).
 */
export default async function CurrencySettingsPage() {
  const session = await requireSessionPage('/settings/currencies');
  const currencies = await listCurrencies(getServices().db, { fxSupportedOnly: true });

  return (
    <div className="space-y-4">
      <CurrencySettingsForm settings={session.settings} currencies={currencies} />
      <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
        Vaultide supports the {currencies.length} official currencies its rate provider publishes
        daily reference rates for. Crypto is tracked as an investment held in the currency your
        broker reports, not as a currency of its own.
      </p>
    </div>
  );
}
