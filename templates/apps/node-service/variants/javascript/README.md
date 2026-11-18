# {{APP_NAME}}

{{DESCRIPTION}}

Owned by **{{TEAM}}**. Created by Orbit from the `node-service` template ({{LANGUAGE}}, Express).

## Run locally

```sh
npm install
npm run dev          # http://localhost:8080
npm test
```

| Endpoint | Purpose |
|---|---|
| `GET /` | service info |
| `GET /healthz` | liveness probe |
| `GET /readyz` | readiness probe (503 while shutting down) |
| `GET /metrics` | Prometheus metrics |

The service listens on `PORT` (default `8080`). In Kubernetes it also gets `ORBIT_ENV`, `ORBIT_APP` and, if the app has a database, `DATABASE_URL` and the `PG*` variables.

## How deploys work

Every push to `main` runs [.orbit/pipeline.yaml](.orbit/pipeline.yaml) on Orbit CI:

1. **test**: `npm ci && npm test`
2. **build**: builds the `Dockerfile` with BuildKit and pushes the image to the platform registry
3. **security**: Semgrep (SAST), Gitleaks (secrets) and Trivy (dependencies and image). The pipeline stops if a finding reaches the app's security gate.
4. **deploy-dev**: commits the new image to the gitops repo. The Orbit GitOps controller rolls it out to the `{{APP_NAME}}-dev` namespace.
5. **dast-dev**: OWASP ZAP baseline scan against the running service

Results, logs, findings and metrics are in the Orbit portal. Grafana has a ready-made dashboard for the app.

## Metrics

`http_requests_total` and `http_request_duration_seconds` are labeled by `method`, matched `route` and `status`, plus the default Node.js process metrics.
Add a route with `app.get('/items/:id', …)`: it is labeled `route="/items/:id"`, not by the raw URL.
