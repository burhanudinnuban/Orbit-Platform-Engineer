import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // No X-Powered-By header; server/handler.ts sets the security headers.
  poweredByHeader: false,
};

export default nextConfig;
