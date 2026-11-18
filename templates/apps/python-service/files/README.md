# {{APP_NAME}}

{{DESCRIPTION}}

Owned by **{{TEAM}}**. Created by Orbit from the `python-service` template.

## Run locally

```sh
python -m venv .venv
. .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt -r requirements-dev.txt
python -m app                   # http://localhost:8080
pytest -q
```

| Endpoint | Purpose |
|---|---|
| `GET /` | service info |
| `GET /healthz` | liveness probe |
| `GET /readyz` | readiness probe |
| `GET /metrics` | Prometheus metrics |

The service listens on `PORT` (default `8080`). In Kubernetes it also gets `ORBIT_ENV`, `ORBIT_APP` and, if the app has a database, `DATABASE_URL` and the `PG*` variables.
FastAPI's `/docs` page is off because the strict Content-Security-Policy blocks its CDN scripts. Enable it in `app/main.py` if you need it locally.

## How deploys work

Every push to `main` runs [.orbit/pipeline.yaml](.orbit/pipeline.yaml) on Orbit CI:

1. **test**: `pip install` and `pytest`
2. **build**: builds the `Dockerfile` with BuildKit and pushes the image to the platform registry
3. **security**: Semgrep (SAST), Gitleaks (secrets) and Trivy (dependencies and image). The pipeline stops if a finding reaches the app's security gate.
4. **deploy-dev**: commits the new image to the gitops repo. The Orbit GitOps controller rolls it out to the `{{APP_NAME}}-dev` namespace.
5. **dast-dev**: OWASP ZAP baseline scan against the running service

Results, logs, findings and metrics are in the Orbit portal. Grafana has a ready-made dashboard for the app.

## Metrics

`http_requests_total` and `http_request_duration_seconds` are labeled by `method`, matched `route` and `status`, plus the default process and Python metrics.
A route like `@app.get("/items/{item_id}")` is labeled `route="/items/{item_id}"`, not by the raw URL.
