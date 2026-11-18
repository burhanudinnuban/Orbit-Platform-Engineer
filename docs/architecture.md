# Orbit — Internal Developer Platform

Orbit turns "I need a new service" into a running, scanned, observed deployment with one form submission.

```
Developer ──▶ Portal / CLI ──▶ Orbit API ──▶ Provisioning workflow (golden path)
                                              1. Git repository (from template)
                                              2. CI/CD pipeline registration
                                              3. Terraform (namespace, quotas, policies, RBAC, optional Postgres;
                                                 optional S3 bucket / SQS queue in Floci locally, AWS in prod)
                                              4. Kubernetes namespace verification
                                              5. GitOps application (manifests in the gitops repo)
                                              6. Security policy (SAST, SCA, secrets, image, DAST)
                                              7. Observability (Grafana dashboard + Prometheus alerts)
                                              8. First pipeline run
git push ──▶ Orbit CI ──▶ test ─▶ build ─▶ scan ─▶ deploy (commit to gitops repo) ─▶ DAST
                                                      │
                               Orbit GitOps controller ◀┘  (reconciles gitops repo → cluster)
```

## What is Orbit's own code, and what is reused

| Concern | Orbit's own code | Reused engine |
|---|---|---|
| Developer portal | `portal/` (React) | — |
| Platform API + CLI | `src/app/server.ts`, `src/routes`, `src/cli.ts` | — |
| Workflow engine (durable steps, retries, teardown) | `src/features/workflow` | — |
| Git hosting | `src/services/gitea.ts` adapter, repo seeding | Gitea (storage, web UI) |
| CI/CD engine | `src/features/ci` (pipeline spec, scheduler, Kubernetes Job executor, triggers, commit statuses) | BuildKit for image builds |
| Infrastructure as code | `src/features/terraform` (runner as Kubernetes Jobs, state in Kubernetes), `terraform/modules` | Terraform CLI |
| Cloud resources (S3, SQS) | `terraform/modules/app-cloud`, `src/features/terraform/terraform.cloud.ts` (binding Secret) | [Floci](https://github.com/floci-io/floci) locally (AWS emulator), AWS in production |
| GitOps (Argo CD-like) | `src/features/gitops` (render, server-side apply, drift diff, prune, health) | — |
| Security scanning | `src/features/security` (normalizers, policy gate, findings store) | Semgrep, Trivy, Gitleaks, OWASP ZAP |
| Observability | `src/features/observability` (dashboards + alert rules per app, metrics API) | Prometheus, Grafana |
| Ingress | — | Traefik: an edge proxy in Docker Compose (file provider) and the in-cluster ingress controller (Kubernetes Ingress provider only, no CRDs) |
| Kubernetes (local) | — | k3s as a Docker Compose service (kind as the alternative) |

## Runtime topology (local development)

The default runtime is Docker Compose (`docker-compose.yml`, `npm run bootstrap`):

```
Windows host                     Docker Compose project "orbit" (network <ORBIT_NET_PREFIX>.0/24)
───────────────────────────      ───────────────────────────────────────────────────────────────
npm run dev                      traefik (edge, 127.0.0.1:8080) ─▶ gitea · grafana · prometheus · floci
  ├─ Orbit API        :4000                                     └▶ k3s :80 (everything else)
  ├─ workflow worker             k3s (127.0.0.1:6443, context orbit-compose)
  ├─ CI engine     ── kubeconfig ──▶  ns orbit-system: in-cluster Traefik, terraform jobs
  ├─ GitOps controller                ns orbit-ci:     pipeline jobs (clone, script, buildkit, scanners, zap)
  └─ Portal (Vite)    :5173           ns <app>-<env>:  workloads managed by GitOps
                                 registry (127.0.0.1:5001)   dns (CoreDNS, fixed address .53)
or: npm run bootstrap -- --orbit k3s-setup (one-shot: kube contexts, manifests, Prometheus token)
    → service orbit (:4000)
```

- Pods resolve names through the `dns` service (k3s `--resolv-conf`), which forwards to Docker's embedded DNS. So pods reach `gitea`, `floci` and `registry` by their Compose names, and everything else through the host's resolvers (corporate DNS included).
- Prometheus runs outside the cluster, where pod IPs are not routable. It discovers pods and nodes through the Kubernetes API and scrapes them through the API server proxy (`/api/v1/namespaces/<ns>/pods/<pod>:<port>/proxy<path>`) as ServiceAccount `orbit-system/prometheus`, whose token `k3s-setup` writes to a volume. The labels are the same as with an in-cluster Prometheus.
- The edge proxy has network aliases for `git.`, `grafana.`, `prometheus.` and `aws.localtest.me`, so the Orbit container uses the same URLs as the browser.

The kind runtime (`npm run bootstrap:kind`) runs the same platform services inside a kind cluster:

```
Windows host                                      kind cluster "orbit" (Docker)
───────────────────────────                       ──────────────────────────────────────────────
npm run dev                                       ns orbit-system: gitea, prometheus, grafana,
  ├─ Orbit API        :4000                                        traefik, floci, terraform jobs
  ├─ workflow worker                              ns orbit-ci:     pipeline jobs (clone, script,
  ├─ CI engine            ── kubeconfig ──▶                         buildkit, scanners, zap)
  ├─ GitOps controller       (context kind-orbit)  ns <app>-<env>: workloads managed by GitOps
  └─ Portal (Vite)    :5173
                                                   docker container kind-registry (registry:2)
http://*.localtest.me:8080 ──▶ host port 8080 ──▶ node port 80 ──▶ Traefik
```

`*.localtest.me` is public DNS that resolves to `127.0.0.1`. If your DNS resolver blocks that, add hosts-file entries.

## Conventions (all components must agree on these)

### Names

Where the two runtimes differ, the table shows Docker Compose first, then kind. The bootstrap of each runtime writes its values to `.env`.

| Thing | Value |
|---|---|
| Cluster / kube context | k3s service `k3s`, node `orbit` / `orbit-compose` · kind cluster `orbit` / `kind-orbit` |
| Platform namespace | `orbit-system` |
| CI namespace | `orbit-ci` (privileged allowed, for BuildKit) |
| App namespace | `<app>-<env>`, e.g. `payments-dev` |
| Gitea URL from pods (`GITEA_INTERNAL_URL`) | `http://gitea:3000` · `http://gitea.orbit-system.svc.cluster.local:3000` |
| Gitea external URL | `http://git.localtest.me:8080` |
| Grafana external | `http://grafana.localtest.me:8080` |
| Prometheus external | `http://prometheus.localtest.me:8080` |
| App URL | `http://<app>-<env>.localtest.me:8080` |
| Gitea admin user | `orbit-admin` |
| Gitea org for app repos | `apps` → repo `apps/<app>` |
| GitOps repo | `platform/gitops` |
| Registry (push, from pods) | `registry:5000/<app>:<sha>` · `kind-registry:5000/<app>:<sha>` |
| Registry (pull, by kubelet) | `localhost:5001/<app>:<sha>` (containerd mirror → the registry container) |
| Ingress class | `traefik` |
| Git credentials for CI pods | Secret `orbit-git-credentials` in `orbit-ci`, keys `username`, `token` (created by Orbit at startup) |
| Trivy vulnerability DB | PVC `orbit-scan-cache` in `orbit-ci`, refreshed by CronJob `trivy-db` (both created by Orbit at startup) |
| Terraform state | Kubernetes backend, Secret `tfstate-default-<app>-<env>` in `orbit-system` |
| Terraform service account | `orbit-terraform` in `orbit-system` |
| Prometheus alert rules | one `<app>-<env>.rules.yaml` per app: files in `PROMETHEUS_RULES_DIR` (default `.orbit-data/prometheus-rules`, mounted by Prometheus; Orbit calls `/-/reload`) · keys of ConfigMap `prometheus-rules` in `orbit-system` (`PROMETHEUS_RULES_DIR` empty) |
| Grafana dashboard | folder uid `orbit-apps`, dashboard uid `orbit-<app>-<env>`, datasource uid `prometheus` |
| Floci (local AWS) from pods / external | `http://floci:4566` · `http://floci.orbit-system.svc.cluster.local:4566` / `http://aws.localtest.me:8080` |
| Cloud provider switch | `ORBIT_CLOUD`: `floci` (default), `aws` or `none` |
| App bucket / queue | `<prefix>-<app>-<env>` (+ `-dlq`), prefix `ORBIT_CLOUD_NAME_PREFIX` (default `orbit`) |
| App cloud binding | Secret `<app>-aws` in `<app>-<env>`: `AWS_REGION`, `AWS_ENDPOINT_URL` (Floci), `S3_BUCKET`, `SQS_QUEUE_URL`… |
| Terraform state (cloud) | Secret `tfstate-default-<app>-<env>-cloud` in `orbit-system` |
| AWS credentials for Terraform (real AWS only) | Secret `orbit-aws-credentials` in `orbit-system` |

### Labels

| Label | Where |
|---|---|
| `app.kubernetes.io/managed-by: orbit` | Everything Orbit creates (Terraform, CI jobs) |
| `app.kubernetes.io/managed-by: orbit-gitops` | Everything the GitOps controller applies |
| `orbit.dev/app`, `orbit.dev/env`, `orbit.dev/team` | Namespaces and workloads |
| `orbit.dev/application: <app>-<env>` | GitOps-managed objects (used for pruning) |
| `app.kubernetes.io/name: <app>` | Pods (Prometheus maps it to the `app` label) |
| `orbit.dev/pipeline`, `orbit.dev/stage` | CI job pods |

Prometheus scrapes pods annotated `prometheus.io/scrape: "true"`, `prometheus.io/port`, `prometheus.io/path`, and adds `namespace`, `pod`, `app`, `env` labels. On Docker Compose a pod without `prometheus.io/port` is not scraped, because the API server proxy needs the port.

### App metrics contract (every template must expose these on `/metrics`)

- `http_requests_total{method, route, status}` (counter)
- `http_request_duration_seconds{method, route, status}` (histogram)
- default process metrics
- `/healthz` (liveness) and `/readyz` (readiness) return 200
- listens on `PORT` (default `8080`), runs as UID `10001`

## App templates

`templates/apps/<id>/template.yaml`:

```yaml
id: nestjs
name: NestJS service
description: NestJS API with Prometheus metrics, health checks and tests
port: 8080
languages: [typescript, javascript]   # the first is the default; one-language templates may write `language: python`
```

```text
templates/apps/<id>/
  template.yaml
  files/                 shared by every language
  variants/<language>/   copied over files/ for that language; the same path replaces the shared file
```

The person creating the app picks the template and, when it has more than one, the language (`language` in
`POST /api/apps`, the portal's Language switch, `orbit create --language`); Orbit stores it with the app. In every
text file Orbit replaces `{{APP_NAME}}`, `{{TEAM}}`, `{{DESCRIPTION}}` and `{{LANGUAGE}}` (TypeScript, JavaScript...).
Each variant ships `.orbit/pipeline.yaml`, a `Dockerfile` and a `package-lock.json` (CI runs `npm ci`).
Runtime images of the Node templates remove npm, npx, corepack and yarn: the base image's copies carry CVEs that would
otherwise fail the default `high` security gate on the very first pipeline.

## Pipeline spec — `.orbit/pipeline.yaml`

```yaml
version: 1
stages:
  - name: test
    type: script            # default type
    image: node:22-alpine
    script:
      - npm ci
      - npm test
  - name: build
    type: build             # BuildKit → REGISTRY_PUSH/<app>:<sha> (registry:5000, or kind-registry:5000 on kind)
    dockerfile: Dockerfile  # optional
    context: .              # optional
  - name: security
    type: scan              # semgrep, gitleaks, trivy-fs, trivy-image (default: all)
    scanners: [semgrep, gitleaks, trivy-fs, trivy-image]
  - name: deploy-dev
    type: deploy            # commits the image to the gitops repo, waits for Synced + Healthy
    environment: dev
  - name: dast-dev
    type: dast              # OWASP ZAP baseline against the in-cluster service
    environment: dev
```

Rules: `trivy-image` and `deploy` need an earlier `build`; `dast` needs an earlier `deploy` to the same environment.
Script stages get `CI=true`, `ORBIT_APP`, `ORBIT_COMMIT_SHA`, `ORBIT_BRANCH`, `ORBIT_PIPELINE_ID`.

Every stage runs as a Kubernetes Job in `orbit-ci`: an init container clones the commit into `/workspace`, then the stage containers run.
Scan and DAST stages write reports to `/workspace/.orbit-reports/` and a final container prints each report between
`::orbit-report-begin::<tool>` and `::orbit-report-end::<tool>` markers. The CI engine extracts them from the pod log, so pods never call back into the API.

Trivy reads its vulnerability DB (about 135 MB) from PVC `orbit-scan-cache`, so pipelines don't download it.
At startup Orbit creates the PVC and CronJob `trivy-db`, and runs the job right away when it hasn't succeeded in the last 12 hours.
The job checks every 6 hours and replaces a DB older than 12 hours, from `ORBIT_TRIVY_DB_REPOSITORY` (default `mirror.gcr.io/aquasec/trivy-db:2`, with a timeout of `ORBIT_TRIVY_DB_TIMEOUT_MINUTES`, default 20).
Scans run with `--skip-db-update`; a scan downloads the DB itself only when the volume has none yet.
`flock` on the volume keeps a scan from reading a DB while it's being replaced (see `src/features/ci/ci.scanCache.ts`).

Triggers: Gitea push webhooks (`POST /webhooks/gitea`, HMAC-SHA256 signed) plus a polling fallback.

## GitOps repo layout and controller semantics

```
platform/gitops
└── apps/<app>/<env>/
    ├── application.yaml   # { app, env, namespace, syncPolicy: { automated, prune, selfHeal } }
    ├── values.yaml        # flat key → value map, see below
    ├── deployment.yaml    # manifests with ${key} placeholders
    ├── service.yaml
    └── ingress.yaml
```

`values.yaml` keys: `app, env, team, namespace, image, replicas, port, host, cpuRequest, memoryRequest, cpuLimit, memoryLimit, revision`.
The CI `deploy` stage changes only `image` and `revision`.

The controller loop (every 15 s, and immediately after a deploy):

1. Fetch the gitops repo.
2. For each `apps/*/*/application.yaml`: substitute `${key}` from `values.yaml` into the other manifests (text substitution before YAML parsing) and inject the labels.
3. If `image` is empty, report `Pending` ("waiting for first build").
4. Server-side apply (field manager `orbit-gitops`), compute drift by comparing desired fields with live objects, prune labeled objects that are no longer in git, and assess health.
5. Write the sync and health status (`Synced`/`OutOfSync`/`Error`, `Healthy`/`Progressing`/`Degraded`/`Missing`) to the store.

## Security

Findings from every tool are normalized to one shape (`tool`, `category`, `severity`, `title`, `ruleId`, `location`, `fingerprint`).
Each app has a gate (`critical` | `high` | `medium` | `off`). The `scan` and `dast` stages fail when a finding at or above the gate exists.
Findings are stored per pipeline, so the portal always shows the latest scan for each tool.

## Terraform

`terraform/modules/app-namespace` is the root module that Orbit applies per app and environment:
the namespace (Pod Security `baseline` enforced, `restricted` warned), ResourceQuota, LimitRange, NetworkPolicies
(default-deny ingress; allow same namespace, `orbit-system` and the Traefik pod), the workload ServiceAccount `<app>`,
and optionally a Postgres StatefulSet and Service plus a Secret `<app>-db` with `DATABASE_URL`.
Workloads load that Secret with `envFrom` and `optional: true`.
The runner bundles the module into a ConfigMap and runs `terraform init/apply` (or `destroy`) as a Job with the `orbit-terraform` service account.

`terraform/modules/app-cloud` runs after it when the app asked for an S3 bucket or an SQS queue (with a dead-letter queue).
It only uses the AWS provider. With `ORBIT_CLOUD=floci` its endpoint is Floci, an AWS emulator that the bootstrap starts
(service `floci` on Docker Compose, a Deployment in `orbit-system` on kind; only its in-process services are used,
so it needs no Docker socket); with `ORBIT_CLOUD=aws` the same module creates the
resources in real AWS. Orbit turns the outputs into Secret `<app>-aws`, which the Deployment loads with `envFrom` (`optional: true`).
AWS SDKs read `AWS_ENDPOINT_URL`, so app code is identical in both clouds. Teardown destroys `app-cloud` before `app-namespace`.
Details: `terraform/README.md`.

## Platform versions

Portal → Versions (`GET /api/platform/versions`, `orbit versions`) lists every platform component, the version it runs,
and the newer releases in its registry (Docker Hub's API for docker.io images, the OCI tags API with an anonymous token
elsewhere; asked again every six hours or on "Check for updates"). Release tags are matched per component (no rc,
`-rootless`, `latest`...) and compared only with tags of the same shape. The **recommended** version is the newest of
the same major; for k3s, at most one Kubernetes minor ahead. Newer majors are listed but marked.

Only **admins** change versions: callers that send `ORBIT_ADMIN_TOKEN` as their bearer token (the bootstrap generates
it; the portal stores it on the Platform page). The admin token also passes the `ORBIT_API_TOKEN` check; values that
start with `change-me` or are shorter than 16 characters count as unset. `GET /api/session` tells the portal the role.

Updates run one at a time, each with a log (Versions → Updates). How Orbit applies one depends on the component:

| Kind | Components | Update | When it fails |
|---|---|---|---|
| CI and Terraform job images | git, BuildKit, Semgrep, Trivy, Gitleaks, ZAP, BusyBox, Terraform | A Job in `orbit-ci` pulls the image and runs a check (Trivy and Gitleaks: a real scan with the flags CI passes). Then the store records it and the next jobs use it; Trivy's DB CronJob is re-applied. | Nothing changes |
| Docker Compose services | k3s (and `k3s-setup`), CoreDNS, edge Traefik, registry, Gitea, Prometheus, Grafana, Floci | `docker pull`, the image goes to `docker-compose.override.yml`, `docker compose up -d --no-deps --wait <service>`, then a probe (Gitea, Grafana, Prometheus, Floci, the registry and the Kubernetes API answer). | Back to the previous image, unless the component cannot go back |
| Deployments in `orbit-system` | in-cluster Traefik (both runtimes); Gitea, Prometheus, Grafana, Floci on kind | New container image, wait for the rollout, probe. | Back to the previous image |

- `docker-compose.override.yml` (gitignored) holds only admin-chosen images; `docker-compose.yml` keeps the defaults.
  Docker Compose merges it by itself and the bootstrap passes it explicitly, so a re-run keeps the versions. Orbit
  edits only `services.<name>.image` in it and deletes the file when nothing is left.
- A bootstrap re-applies `bootstrap/manifests`, which resets Deployments to their manifest image: Orbit re-applies
  admin-chosen images at startup and every ten minutes.
- Admin-chosen CI images live in the store and win over `ORBIT_IMAGE_*` in `.env`; every process applies them at
  startup and the CI engine before each pipeline.
- Gitea, Grafana and k3s migrate their data on upgrade: Orbit refuses to downgrade them and offers no rollback.
- Updating k3s restarts the cluster, so Orbit refuses it while pipelines or workflows run.
- Compose services can only be changed when Orbit runs on the host (`npm run dev`); in the `orbit` container it has
  no Docker access and shows them read-only.
- **Update all** queues the recommended update of every component: job images first, the cluster last.

At startup Orbit also pulls every CI image the node does not have yet, one at a time, so the first pipeline of a new
app does not wait for them. Stage timeouts do not count time spent waiting for an image (up to 60 minutes); the stage
log says which image it is waiting for. ZAP (1.2 GB) comes from Docker Hub (`zaproxy/zap-stable`), which is much faster
than ghcr.io on slow networks.

## Safety

Orbit refuses any kube context that is not in `ORBIT_ALLOWED_KUBE_CONTEXTS` (default `orbit-compose`; `kind-orbit` on kind), so it can never touch a production cluster by accident.
Both bootstraps add their context without switching your current one.
Git tokens are passed to pods through Secrets, and logs redact credentials embedded in URLs.

## Repository layout

```
src/
  core/          config, store (SQLite), logger, events, kube client guard, git workspace
  providers/     gitea, grafana, prometheus, floci HTTP clients
  workflow/      durable workflow engine + golden-path steps
  ci/            pipeline spec, scheduler, k8s executor, triggers
  gitops/        controller, renderer, diff, health
  security/      report parsers, policy gate
  terraform/     terraform runner, app-cloud variables and binding Secret
  observability/ dashboards, alert rules
  api/           REST API (Fastify)
  contract.ts    REST API types shared with the portal
  main.ts        starts components selected by ORBIT_COMPONENTS
  cli.ts         `orbit` CLI
portal/          developer portal (Vite + React)
terraform/       Terraform modules
templates/       app templates + gitops manifest templates
docker-compose.yml  the local platform (k3s, registry, dns, Gitea, Floci, Prometheus, Grafana, edge Traefik, optional Orbit)
Dockerfile       Orbit API + portal image (Compose profile orbit)
bootstrap/       compose.mjs + compose/ (Docker Compose, default); up.mjs / down.mjs + kind-config.yaml (kind);
                 manifests/ (00, 10, 50 on both runtimes, the rest kind only); shared.mjs
test/            unit tests (node:test)
```

## Roadmap

- SSO (OIDC) for the portal and API, with team-scoped RBAC
- Real-AWS workload identity (IRSA / EKS Pod Identity) and a per-app IAM role scoped to its bucket and queue
- More Floci-backed resources: DynamoDB tables, SNS topics, Secrets Manager (in-process); RDS by giving the Compose `floci` service the Docker socket
- A shared Terraform provider cache for the runner Jobs (the AWS provider is downloaded on every run today)
- Logs (Loki + Alloy) next to metrics
- Preview environments per pull request
- Gateway API instead of Ingress
- Split the components into separate deployments in `orbit-system` (each already starts independently through `ORBIT_COMPONENTS`)
