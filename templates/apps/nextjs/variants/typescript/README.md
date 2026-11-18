# {{APP_NAME}}

{{DESCRIPTION}}

Owned by **{{TEAM}}**. Created by Orbit from the `nextjs` template ({{LANGUAGE}}, Next.js App Router).

## Run locally

```sh
npm install
npm run dev          # http://localhost:8080 with hot reloading
npm test             # next typegen, tsc --noEmit, then node --test
npm run build        # production build into .next/
npm start            # serves the production build
```

Pages live in `app/` ([App Router](https://nextjs.org/docs/app)). `cacheComponents` is on: a page is prerendered at build time, and anything that needs request-time data (cookies, headers, `connection()`, environment variables read per request) goes inside `<Suspense>`, like the `Environment` component in `app/page.tsx`.

| Endpoint | Purpose |
|---|---|
| `GET /` | the home page (`app/page.tsx`) |
| `GET /api/info` | service info as JSON (`app/api/info/route.ts`) |
| `GET /healthz` | liveness probe |
| `GET /readyz` | readiness probe (503 while shutting down) |
| `GET /metrics` | Prometheus metrics |

The app listens on `PORT` (default `8080`). In Kubernetes it also gets `ORBIT_ENV`, `ORBIT_APP` and, if the app has a database, `DATABASE_URL` and the `PG*` variables.

## The custom server

`server.ts` starts Next.js with its [custom server API](https://nextjs.org/docs/app/guides/custom-server) and adds what the platform needs and Next.js has no hook for: the health and readiness probes, Prometheus metrics for every request, security headers, and a graceful shutdown (on `SIGTERM`, `/readyz` turns 503 so the pod leaves the Service, then the server drains and exits). That code is in `server/` with tests in `test/`.

Node runs `server.ts` directly (type stripping), so files in `server/` import each other with the `.ts` extension and use only syntax Node can strip: no `enum`, `namespace` or constructor parameter properties. The app code in `app/` is compiled by Next.js as usual.

## How deploys work

Every push to `main` runs [.orbit/pipeline.yaml](.orbit/pipeline.yaml) on Orbit CI:

1. **test**: `npm ci && npm test`
2. **build**: builds the `Dockerfile` (`next build` in a build stage) with BuildKit and pushes the image to the platform registry
3. **security**: Semgrep (SAST), Gitleaks (secrets) and Trivy (dependencies and image). The pipeline stops if a finding reaches the app's security gate.
4. **deploy-dev**: commits the new image to the gitops repo. The Orbit GitOps controller rolls it out to the `{{APP_NAME}}-dev` namespace.
5. **dast-dev**: OWASP ZAP baseline scan against the running app

Results, logs, findings and metrics are in the Orbit portal. Grafana has a ready-made dashboard for the app.

The container's root filesystem is read-only, and `/tmp` (64 MiB) is the only writable directory. `.next/cache`, where Next.js keeps optimized images and regenerated pages, points there, so that cache starts empty in every pod. For a cache shared by all pods, configure a [cache handler](https://nextjs.org/docs/app/guides/self-hosting#configuring-caching).

## Metrics

`http_requests_total` and `http_request_duration_seconds` are labeled by `method`, `route` and `status`, plus the default Node.js process metrics. `route` is the route pattern from the build's `.next/routes-manifest.json` (`/items/[id]`, never `/items/42`); all files under `/_next/static` share one label, files from `public/` are `/public`, and paths no route matches are `unmatched`. Under `npm run dev` there is no manifest yet, so pages show up as `unmatched`.

## Security headers

`server/handler.ts` sets a Content-Security-Policy and the usual hardening headers on every response. Next.js inlines scripts and styles, so the policy allows `'unsafe-inline'`; to drop it, switch to [nonces](https://nextjs.org/docs/app/guides/content-security-policy).
