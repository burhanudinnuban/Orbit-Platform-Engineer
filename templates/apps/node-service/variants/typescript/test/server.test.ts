import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createApp } from '../src/server.ts';

let server: http.Server;
let port: number;

before(async () => {
  const { app } = createApp({ serviceName: 'test-service' });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

interface Response {
  status: number | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function get(path: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

test('GET / describes the service', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).service, 'test-service');
});

test('health and readiness endpoints return 200', async () => {
  assert.equal((await get('/healthz')).status, 200);
  assert.equal((await get('/readyz')).status, 200);
});

test('responses carry security headers', async () => {
  const { headers } = await get('/');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.match(String(headers['content-security-policy']), /default-src 'none'/);
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers['x-powered-by'], undefined);
});

test('unknown paths return a JSON 404', async () => {
  const res = await get('/no-such-page');
  assert.equal(res.status, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'not found' });
});

test('/metrics exposes request metrics labeled by route, not raw URL', async () => {
  await get('/');
  await get('/unknown-path-12345');
  const res = await get('/metrics');
  assert.equal(res.status, 200);
  assert.match(res.body, /http_requests_total\{method="GET",route="\/",status="200"\} \d+/);
  assert.match(res.body, /http_request_duration_seconds_bucket\{le="[^"]+",method="GET",route="\/",status="200"\}/);
  assert.match(res.body, /route="unmatched",status="404"/);
  assert.doesNotMatch(res.body, /unknown-path-12345/);
  assert.match(res.body, /process_cpu_user_seconds_total/);
});
