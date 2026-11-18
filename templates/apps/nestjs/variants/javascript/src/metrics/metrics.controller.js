import { Bind, Controller, Dependencies, Get, Res } from '@nestjs/common';
import { MetricsService } from './metrics.service';

@Controller('metrics')
@Dependencies(MetricsService)
export class MetricsController {
  constructor(metrics) {
    this.metrics = metrics;
  }

  // JavaScript has no parameter decorators; @Bind() applies them to the method.
  @Get()
  @Bind(Res({ passthrough: true }))
  async scrape(res) {
    res.set('Content-Type', this.metrics.registry.contentType);
    res.set('Cache-Control', 'no-store');
    return this.metrics.registry.metrics();
  }
}
