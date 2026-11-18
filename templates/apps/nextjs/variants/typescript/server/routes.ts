import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface ManifestRoute {
  page: string;
  regex: string;
}

/** The parts of `.next/routes-manifest.json` (written by `next build`) used here. */
export interface RoutesManifest {
  basePath?: string;
  staticRoutes?: ManifestRoute[];
  dynamicRoutes?: ManifestRoute[];
}

/** Maps a request path to its route pattern, e.g. `/items/42` → `/items/[id]`. */
export type RouteMatcher = (pathname: string) => string | undefined;

/**
 * Builds a matcher from the build's route manifest, so metrics are labeled by
 * route pattern and never by the raw URL. Static routes are tried before
 * dynamic ones, like Next.js does. Files from public/ share one label.
 */
export function createRouteMatcher(manifest: RoutesManifest, publicFiles: Iterable<string> = []): RouteMatcher {
  const basePath = manifest.basePath ?? '';
  const routes = [...(manifest.staticRoutes ?? []), ...(manifest.dynamicRoutes ?? [])].map((r) => ({
    page: r.page,
    // The patterns come from the build output, never from a request.
    regex: new RegExp(r.regex), // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  }));
  const publicPaths = new Set(publicFiles);

  return (rawPathname) => {
    if (basePath && !(rawPathname === basePath || rawPathname.startsWith(`${basePath}/`))) return undefined;
    const pathname = rawPathname.slice(basePath.length) || '/';
    if (pathname.startsWith('/_next/static/')) return '/_next/static';
    if (pathname.startsWith('/_next/image')) return '/_next/image';
    if (pathname.startsWith('/_next/')) return '/_next';
    for (const route of routes) if (route.regex.test(pathname)) return route.page;
    if (publicPaths.has(pathname)) return '/public';
    return undefined;
  };
}

function listFiles(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listFiles(path.join(dir, entry.name), `${prefix}/${entry.name}`)
      : [`${prefix}/${entry.name}`],
  );
}

/**
 * The matcher for the app in `dir`. Without a production build (`next dev`),
 * there is no manifest and only public files and Next.js assets get a label.
 */
export function loadRouteMatcher(dir = '.'): RouteMatcher {
  const file = path.join(dir, '.next', 'routes-manifest.json');
  const manifest = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as RoutesManifest) : {};
  return createRouteMatcher(manifest, listFiles(path.join(dir, 'public')));
}
