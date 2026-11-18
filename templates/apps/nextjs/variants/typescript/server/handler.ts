import type { IncomingMessage, ServerResponse } from 'node:http';
import client from '@prometheus-io/client';
import type { RouteMatcher } from './routes.ts';

/** What `next().getRequestHandler()` returns. */
export type NextRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface HandlerOptions {
  /** Renders everything that is not a platform endpoint. */
  next: NextRequestHandler;
  /** Route pattern of a path; unknown paths are labeled `unmatched`. */
  routeOf: RouteMatcher;
  /** `next dev` needs eval and a websocket for hot reloading. */
  dev?: boolean;
}

export interface PlatformHandler {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  registry: client.Registry;
  setReady(value: boolean): void;
}

/**
 * Security headers for every response. Next.js inlines scripts and styles, so
 * the CSP allows 'unsafe-inline' (see the Next.js CSP guide for nonces).
 * Set before Next.js renders: it starts the response inside its handler.
 */
export function securityHeaders(dev = false): Record<string, string> {
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? ' ws: wss:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * The request handler of the custom server: health and readiness probes and
 * Prometheus metrics for the platform, everything else rendered by Next.js.
 * Every instance gets its own metrics registry, so tests can create many.
 */
export function createHandler({ next, routeOf, dev = false }: HandlerOptions): PlatformHandler {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const httpRequests = new client.Counter({
    name: 'http_requests_total',
    help: 'HTTP requests handled, by method, matched route and status code',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });
  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds, by method, matched route and status code',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const headers = Object.entries(securityHeaders(dev));
  const platformRoutes = new Set(['/healthz', '/readyz', '/metrics']);
  let ready = true;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const stop = httpDuration.startTimer();
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    res.on('finish', () => {
      // Label by route pattern (e.g. /items/[id]), never the raw URL, so
      // metric cardinality stays bounded.
      const route = platformRoutes.has(pathname) ? pathname : (routeOf(pathname) ?? 'unmatched');
      const labels = { method: req.method ?? 'GET', route, status: String(res.statusCode) };
      httpRequests.inc(labels);
      stop(labels);
    });
    for (const [name, value] of headers) res.setHeader(name, value);

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname === '/healthz') return json(res, 200, { status: 'ok' });
      if (pathname === '/readyz')
        return ready ? json(res, 200, { status: 'ready' }) : json(res, 503, { status: 'shutting-down' });
      if (pathname === '/metrics') {
        const body = await registry.metrics();
        res.setHeader('Content-Type', registry.contentType);
        res.setHeader('Cache-Control', 'no-store');
        res.end(body);
        return;
      }
    }

    try {
      await next(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ level: 'error', msg: 'unhandled error', error: message }));
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.destroy();
    }
  }

  return {
    handle,
    registry,
    setReady(value) {
      ready = value;
    },
  };
}
