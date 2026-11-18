# {{APP_NAME}}

{{DESCRIPTION}}

Owned by **{{TEAM}}**. Created by Orbit from the `nestjs` template ({{LANGUAGE}}, NestJS on Express).

## Run locally

Node.js 24.9 or later (Nest 12 is published as ES modules, and Jest loads them with `require(esm)`).

```sh
npm install
npm run start:dev    # http://localhost:8080, restarts on changes
npm test             # Jest (test/*.e2e-spec.js, src/**/*.spec.js)
npm run build        # compiles src/ to dist/ with Babel (what the container runs)
```

The code uses decorators, which JavaScript does not have yet: Babel compiles them (`babel.config.json`, legacy decorators), as in the official NestJS JavaScript starter. Without TypeScript there is no type metadata, so constructor injection is declared with `@Dependencies(SomeService)`, and parameter decorators go through `@Bind()`, e.g. `@Bind(Param('id'))`.

| Endpoint | Purpose |
|---|---|
| `GET /` | service info |
| `GET /healthz` | liveness probe |
| `GET /readyz` | readiness probe (503 while shutting down) |
| `GET /metrics` | Prometheus metrics |

The service listens on `PORT` (default `8080`). In Kubernetes it also gets `ORBIT_ENV`, `ORBIT_APP` and, if the app has a database, `DATABASE_URL` and the `PG*` variables. Logs are one JSON object per line when `NODE_ENV=production` (the container), plain text locally.

## Layout

| Path | What it does |
|---|---|
| `src/main.js` | starts the app and handles `SIGTERM`: `/readyz` turns 503 so the pod leaves the Service, then `app.close()` drains and the process exits |
| `src/setup.js` | security headers and request metrics, shared by `main.js` and the tests |
| `src/health/` | `/healthz` and `/readyz` |
| `src/metrics/` | the Prometheus registry and `/metrics` |
| `test/app.e2e-spec.js` | HTTP tests against the whole app |

## How deploys work

Every push to `main` runs [.orbit/pipeline.yaml](.orbit/pipeline.yaml) on Orbit CI:

1. **test**: `npm ci && npm test`
2. **build**: builds the `Dockerfile` (Babel in a build stage) with BuildKit and pushes the image to the platform registry
3. **security**: Semgrep (SAST), Gitleaks (secrets) and Trivy (dependencies and image). The pipeline stops if a finding reaches the app's security gate.
4. **deploy-dev**: commits the new image to the gitops repo. The Orbit GitOps controller rolls it out to the `{{APP_NAME}}-dev` namespace.
5. **dast-dev**: OWASP ZAP baseline scan against the running service

Results, logs, findings and metrics are in the Orbit portal. Grafana has a ready-made dashboard for the app.

## Metrics

`http_requests_total` and `http_request_duration_seconds` are labeled by `method`, matched `route` and `status`, plus the default Node.js process metrics.
A handler such as `@Get(':id')` in `@Controller('items')` is labeled `route="/items/:id"`, not by the raw URL; requests no route matches are `unmatched`.
