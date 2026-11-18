import { Controller, Get, Param } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { ReadinessService } from '../src/health/readiness.service';
import { configureApp } from '../src/setup';

// A route with a parameter, to check that metrics use the route pattern.
@Controller('items')
class ItemsController {
  @Get(':id')
  get(@Param('id') id: string) {
    return { id };
  }
}

describe('{{APP_NAME}} (e2e)', () => {
  let app: NestExpressApplication;
  let server: App;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ItemsController],
    }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }));
    await app.init();
    server = app.getHttpServer();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET / describes the service', async () => {
    const res = await request(server).get('/').expect(200);
    expect(res.body).toEqual({ service: expect.any(String), status: 'ok', environment: expect.any(String) });
  });

  it('health and readiness endpoints return 200', async () => {
    await request(server).get('/healthz').expect(200, { status: 'ok' });
    await request(server).get('/readyz').expect(200, { status: 'ready' });
  });

  it('readiness turns 503 while shutting down', async () => {
    app.get(ReadinessService).ready = false;
    await request(server).get('/readyz').expect(503, { status: 'shutting-down' });
    await request(server).get('/healthz').expect(200);
  });

  it('responses carry security headers', async () => {
    const res = await request(server).get('/').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('unknown paths return a JSON 404', async () => {
    const res = await request(server).get('/no-such-page').expect(404);
    expect(res.body).toMatchObject({ statusCode: 404 });
  });

  it('/metrics exposes request metrics labeled by route, not raw URL', async () => {
    await request(server).get('/');
    await request(server).get('/items/42');
    await request(server).get('/unknown-path-12345');
    const res = await request(server).get('/metrics').expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toMatch(/http_requests_total\{method="GET",route="\/",status="200"\} \d+/);
    expect(res.text).toMatch(/http_requests_total\{method="GET",route="\/items\/:id",status="200"\} \d+/);
    expect(res.text).toMatch(/http_request_duration_seconds_bucket\{le="[^"]+",method="GET",route="\/",status="200"\}/);
    expect(res.text).toMatch(/route="unmatched",status="404"/);
    expect(res.text).not.toMatch(/unknown-path-12345|items\/42/);
    expect(res.text).toMatch(/process_cpu_user_seconds_total/);
  });
});
