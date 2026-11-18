import { createApp } from './server.ts';

const port = Number(process.env.PORT ?? 8080);
// In Kubernetes, keep serving briefly after SIGTERM while the pod is removed
// from Service endpoints; locally, exit right away.
const shutdownDelayMs = Number(process.env.SHUTDOWN_DELAY_MS ?? (process.env.KUBERNETES_SERVICE_HOST ? 5000 : 0));

const { app, setReady } = createApp();
const server = app.listen(port, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'listening', port }));
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
  setReady(false);
  setTimeout(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  }, shutdownDelayMs).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
