import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/**
 * Vaultide web app (blueprint 22.1): portable output, workspace packages
 * transpiled from source, and no third-party scripts.
 */
const nextConfig: NextConfig = {
  // Runs on any Node host, not only Vercel (22.1 portability).
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@vaultide/application', '@vaultide/finance', '@vaultide/validation'],
  typedRoutes: true,
};

export default nextConfig;
