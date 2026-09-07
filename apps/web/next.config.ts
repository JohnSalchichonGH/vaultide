import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/**
 * Vaultide web app (blueprint 22.1): portable output, workspace packages
 * transpiled from source, and no third-party scripts.
 */

// Vercel builds Next through its own adapter, which expects the default output
// layout: `output: 'standalone'` moves the file-tracing manifests and the build
// fails looking for `.next/next-server.js.nft.json`. Everywhere else the
// standalone server is what makes the app runnable on any Node host (22.1), and
// it is what the E2E suite starts.
const isVercelBuild = process.env.VERCEL === '1';

const nextConfig: NextConfig = {
  ...(isVercelBuild ? {} : { output: 'standalone' as const }),
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@vaultide/application', '@vaultide/finance', '@vaultide/validation'],
  typedRoutes: true,
};

export default nextConfig;
