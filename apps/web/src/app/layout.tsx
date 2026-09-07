import type { Metadata, Viewport } from 'next';
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

/**
 * The root layout holds the document only. The visual shell moved into the
 * route groups in Phase 1, because a signed-in page and a sign-in page need
 * different chrome — and the sign-in page must not render a user menu.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
