import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { ReadinessService } from './readiness.service';

@Controller()
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  /** Liveness probe: the process is up. */
  @Get('healthz')
  @Header('Cache-Control', 'no-store')
  health() {
    return { status: 'ok' };
  }

  /** Readiness probe: 503 while shutting down, so the pod leaves the Service first. */
  @Get('readyz')
  @Header('Cache-Control', 'no-store')
  ready() {
    if (!this.readiness.ready) throw new ServiceUnavailableException({ status: 'shutting-down' });
    return { status: 'ready' };
  }
}
