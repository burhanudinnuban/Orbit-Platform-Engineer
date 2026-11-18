import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRouteMatcher } from '../server/routes.js';

// Shaped like .next/routes-manifest.json after `next build`.
const manifest = {
  staticRoutes: [
    { page: '/', regex: '^/(?:/)?$' },
    { page: '/api/info', regex: '^/api/info(?:/)?$' },
    { page: '/items/new', regex: '^/items/new(?:/)?$' },
  ],
  dynamicRoutes: [
    { page: '/items/[id]', regex: '^/items/([^/]+?)(?:/)?$' },
    { page: '/docs/[...slug]', regex: '^/docs/(.+?)(?:/)?$' },
  ],
};

test('pages and route handlers map to their route pattern', () => {
  const routeOf = createRouteMatcher(manifest);
  assert.equal(routeOf('/'), '/');
  assert.equal(routeOf('/api/info'), '/api/info');
  assert.equal(routeOf('/api/info/'), '/api/info');
  assert.equal(routeOf('/items/42'), '/items/[id]');
  assert.equal(routeOf('/docs/a/b/c'), '/docs/[...slug]');
});

test('static routes win over dynamic ones', () => {
  assert.equal(createRouteMatcher(manifest)('/items/new'), '/items/new');
});

test('Next.js assets and public files share one label each', () => {
  const routeOf = createRouteMatcher(manifest, ['/robots.txt']);
  assert.equal(routeOf('/_next/static/chunks/app-1234.js'), '/_next/static');
  assert.equal(routeOf('/_next/image'), '/_next/image');
  assert.equal(routeOf('/_next/data/x.json'), '/_next');
  assert.equal(routeOf('/robots.txt'), '/public');
});

test('unknown paths have no route', () => {
  const routeOf = createRouteMatcher(manifest);
  assert.equal(routeOf('/nope'), undefined);
  assert.equal(routeOf('/items/42/edit'), undefined);
  assert.equal(createRouteMatcher({})('/'), undefined);
});

test('routes are matched below the basePath', () => {
  const routeOf = createRouteMatcher({ ...manifest, basePath: '/shop' });
  assert.equal(routeOf('/shop'), '/');
  assert.equal(routeOf('/shop/items/7'), '/items/[id]');
  assert.equal(routeOf('/items/7'), undefined);
});
