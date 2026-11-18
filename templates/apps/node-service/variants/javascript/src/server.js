import client from '@prometheus-io/client';
import express from 'express';

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Cache-Control': 'no-store',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * Builds the HTTP app. Every instance gets its own metrics registry, so tests
 * can create as many as they like.
 */
export function createApp({ serviceName = process.env.ORBIT_APP || '{{APP_NAME}}' } = {}) {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const httpRequests = new client.Counter({
    name: 'http_requests_total',
    help: 'HTTP requests handled, by method, matched route and status code',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });
  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds, by method, matched route and status code',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  let ready = true;
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
  });

  // Label by the matched route pattern (e.g. /items/:id), never the raw URL,
  // so metric cardinality stays bounded.
  app.use((req, res, next) => {
    const stop = httpDuration.startTimer();
    res.on('finish', () => {
      const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      const labels = { method: req.method, route, status: String(res.statusCode) };
      httpRequests.inc(labels);
      stop(labels);
    });
    next();
  });

  app.get('/', (req, res) => {
    res.json({ service: serviceName, status: 'ok', environment: process.env.ORBIT_ENV ?? 'local' });
  });

  app.get('/healthz', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/readyz', (req, res) => {
    if (ready) res.json({ status: 'ready' });
    else res.status(503).json({ status: 'shutting-down' });
  });

  app.get('/metrics', async (req, res, next) => {
    try {
      res.set('Content-Type', registry.contentType);
      res.end(await registry.metrics());
    } catch (err) {
      next(err);
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(JSON.stringify({ level: 'error', msg: 'unhandled error', error: err.message }));
    res.status(500).json({ error: 'internal error' });
  });

  return {
    app,
    registry,
    setReady(value) {
      ready = value;
    },
  };
}
