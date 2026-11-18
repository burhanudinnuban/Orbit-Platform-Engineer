/** @type {import('next').NextConfig} */
const nextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // No X-Powered-By header; server/handler.js sets the security headers.
  poweredByHeader: false,
};

export default nextConfig;
