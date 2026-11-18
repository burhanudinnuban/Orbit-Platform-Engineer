import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthController } from './health/health.controller';
import { ReadinessService } from './health/readiness.service';
import { MetricsController } from './metrics/metrics.controller';
import { MetricsService } from './metrics/metrics.service';

@Module({
  controllers: [AppController, HealthController, MetricsController],
  providers: [AppService, ReadinessService, MetricsService],
})
export class AppModule {}
