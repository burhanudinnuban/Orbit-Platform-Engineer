import { Injectable } from '@nestjs/common';
import client from '@prometheus-io/client';
import type { NextFunction, Request, Response } from 'express';

/**
 * Prometheus metrics. Every app instance gets its own registry, so tests can
 * create as many as they like.
 */
@Injectable()
export class MetricsService {
  readonly registry = new client.Registry();

  private readonly httpRequests = new client.Counter({
    name: 'http_requests_total',
    help: 'HTTP requests handled, by method, matched route and status code',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [this.registry],
  });

  private readonly httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds, by method, matched route and status code',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  constructor() {
    client.collectDefaultMetrics({ register: this.registry });
  }

  /**
   * Express middleware that counts and times every request. It labels by the
   * matched route pattern (e.g. /items/:id), never the raw URL, so metric
   * cardinality stays bounded.
   */
  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const stop = this.httpDuration.startTimer();
      res.on('finish', () => {
        const route = req.route ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched';
        const labels = { method: req.method, route, status: String(res.statusCode) };
        this.httpRequests.inc(labels);
        stop(labels);
      });
      next();
    };
  }
}
