import type { Metadata, Viewport } from 'next';
import { AppShell } from '@/components/shell/app-shell';
import './globals.css';

/** Product metadata (blueprint 19: app metadata title "Vaultide"). */
export const metadata: Metadata = {
  title: {
    default: 'Vaultide',
    template: '%s · Vaultide',
  },
  description:
    'Vaultide is a monthly, snapshot-driven personal finance platform: balances and known flows in, inferred spending, net worth and projections out.',
  applicationName: 'Vaultide',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
