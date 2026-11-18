import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createHandler, type NextRequestHandler, type PlatformHandler } from '../server/handler.ts';
import { createRouteMatcher } from '../server/routes.ts';

// Stands in for Next.js: knows / and /items/[id], 404 for everything else.
const fakeNext: NextRequestHandler = async (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/boom') throw new Error('render failed');
  const known = pathname === '/' || /^\/items\/[^/]+$/.test(pathname);
  res.statusCode = known ? 200 : 404;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(known ? '<h1>page</h1>' : '<h1>not found</h1>');
};

const routeOf = createRouteMatcher({
  staticRoutes: [{ page: '/', regex: '^/(?:/)?$' }],
  dynamicRoutes: [{ page: '/items/[id]', regex: '^/items/([^/]+?)(?:/)?$' }],
});

let platform: PlatformHandler;
let server: http.Server;
let port: number;

before(async () => {
  platform = createHandler({ next: fakeNext, routeOf });
  server = http.createServer((req, res) => void platform.handle(req, res));
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

test('pages are rendered by Next.js', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.equal(res.body, '<h1>page</h1>');
});

test('health and readiness endpoints return 200', async () => {
  const health = await get('/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { status: 'ok' });
  assert.equal((await get('/readyz')).status, 200);
});

test('readiness turns 503 while shutting down', async () => {
  platform.setReady(false);
  try {
    const res = await get('/readyz');
    assert.equal(res.status, 503);
    assert.deepEqual(JSON.parse(res.body), { status: 'shutting-down' });
    assert.equal((await get('/healthz')).status, 200);
  } finally {
    platform.setReady(true);
  }
});

test('responses carry security headers', async () => {
  for (const path of ['/', '/healthz', '/no-such-page']) {
    const { headers } = await get(path);
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['x-frame-options'], 'DENY');
    assert.match(String(headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.doesNotMatch(String(headers['content-security-policy']), /unsafe-eval/);
    assert.equal(headers['x-powered-by'], undefined);
  }
});

test('a failing render returns a JSON 500', async () => {
  const res = await get('/boom');
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.body), { error: 'internal error' });
});

test('/metrics exposes request metrics labeled by route, not raw URL', async () => {
  await get('/');
  await get('/items/42');
  await get('/unknown-path-12345');
  const res = await get('/metrics');
  assert.equal(res.status, 200);
  assert.match(res.body, /http_requests_total\{method="GET",route="\/",status="200"\} \d+/);
  assert.match(res.body, /http_requests_total\{method="GET",route="\/items\/\[id\]",status="200"\} \d+/);
  assert.match(res.body, /http_request_duration_seconds_bucket\{le="[^"]+",method="GET",route="\/",status="200"\}/);
  assert.match(res.body, /route="unmatched",status="404"/);
  assert.match(res.body, /route="\/healthz",status="200"/);
  assert.doesNotMatch(res.body, /unknown-path-12345|items\/42/);
  assert.match(res.body, /process_cpu_user_seconds_total/);
});
