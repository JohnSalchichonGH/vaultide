import type { ReactNode } from 'react';
import { getServices, listCurrencies } from '@vaultide/application';
import { AppShell } from '@/components/shell/app-shell';
import { requireSessionPage } from '@/server/context';

/**
 * The signed-in shell (blueprint 19: `src/app/(app)/…`, 17.2).
 *
 * This is the authority `proxy.ts` is only a convenience for: every page below
 * it renders behind `requireSessionPage`, which fails closed and redirects to
 * sign-in. A page that forgot to check would still be covered here.
 *
 * The currency list for the header selector is the FX-supported set (10.4): a
 * currency with no rates could never be converted honestly, so it is not
 * offered as a reporting currency at all.
 */
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireSessionPage();
  const currencies = await listCurrencies(getServices().db, { fxSupportedOnly: true });

  return (
    <AppShell session={session} currencies={currencies}>
      {children}
    </AppShell>
  );
}
