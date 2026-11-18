// Custom Next.js server (https://nextjs.org/docs/app/guides/custom-server):
// Next.js renders the app, and this process adds what the platform needs —
// /healthz, /readyz, /metrics and a graceful shutdown. Node runs this file
// directly (type stripping), so keep it to syntax Node can strip.
import { createServer } from 'node:http';
import { createHandler } from './server/handler.ts';
import { loadRouteMatcher } from './server/routes.ts';

const dev = process.argv.includes('--dev');
// React and Next.js pick their development or production build from NODE_ENV
// when they are first loaded, so set it before importing Next.js.
if (!process.env.NODE_ENV) Object.assign(process.env, { NODE_ENV: dev ? 'development' : 'production' });
const { default: next } = await import('next');

const port = Number(process.env.PORT ?? 8080);
// In Kubernetes, keep serving briefly after SIGTERM while the pod is removed
// from Service endpoints; locally, exit right away.
const shutdownDelayMs = Number(process.env.SHUTDOWN_DELAY_MS ?? (process.env.KUBERNETES_SERVICE_HOST ? 5000 : 0));

const server = createServer();
// httpServer lets `next dev` attach its hot-reload websocket.
const app = next({ dev, port, httpServer: server });
const nextHandler = app.getRequestHandler();
await app.prepare();

const platform = createHandler({ next: (req, res) => nextHandler(req, res), routeOf: loadRouteMatcher(), dev });
server.on('request', (req, res) => void platform.handle(req, res));
server.listen(port, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'listening', port, dev }));
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
  platform.setReady(false);
  setTimeout(() => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 10_000).unref();
  }, shutdownDelayMs).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
