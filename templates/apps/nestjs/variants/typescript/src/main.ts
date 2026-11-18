import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ReadinessService } from './health/readiness.service';
import { configureApp } from './setup';

const port = Number(process.env.PORT ?? 8080);
// In Kubernetes, keep serving briefly after SIGTERM while the pod is removed
// from Service endpoints; locally, exit right away.
const shutdownDelayMs = Number(process.env.SHUTDOWN_DELAY_MS ?? (process.env.KUBERNETES_SERVICE_HOST ? 5000 : 0));

async function bootstrap() {
  // One JSON object per line in the container; readable text locally.
  const logger = new ConsoleLogger({ json: process.env.NODE_ENV === 'production' });
  const app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule, { logger }));
  await app.listen(port);
  logger.log(`listening on port ${port}`, 'Bootstrap');

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.log(`shutting down (${signal})`, 'Bootstrap');
    app.get(ReadinessService).ready = false;
    setTimeout(() => {
      // close() stops the HTTP server and runs the modules' shutdown hooks.
      void app.close().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 10_000).unref();
    }, shutdownDelayMs).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void bootstrap();
