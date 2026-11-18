# Orbit

Orbit is an internal developer platform. One form in the portal (or one CLI command) gives a team a new service with all of this set up:

1. a Git repository created from a template
2. a CI/CD pipeline: test → build → security scan → deploy → DAST
3. Terraform-managed infrastructure: a Kubernetes namespace with quotas and network policies, plus an optional Postgres, S3 bucket and SQS queue
4. GitOps deployment, reconciled continuously
5. security scanning (SAST, dependencies, secrets, image, DAST) with a policy gate
6. a Grafana dashboard and Prometheus alerts

Everything runs on your machine with Docker Compose ([docker-compose.yml](docker-compose.yml)). Workloads run in a [k3s](https://k3s.io/) Kubernetes cluster that is itself a Compose service, and AWS resources are created in [Floci](https://github.com/floci-io/floci), a local AWS emulator. Point the same Terraform at real AWS with `ORBIT_CLOUD=aws`.

The design and conventions are in [docs/architecture.md](docs/architecture.md). The Terraform modules are described in [terraform/README.md](terraform/README.md).

## Prerequisites

- Docker Desktop, running, with about **6 GB of memory** for Docker (Settings → Resources, or `memory=8GB` under `[wsl2]` in `%UserProfile%\.wslconfig`). The platform idles at roughly 1.5 GB; pipeline jobs (BuildKit, Semgrep, ZAP) need the rest.
- Node.js 22.13 or later
- `kubectl` (Docker Desktop ships it)
- Ports **8080**, 6443, 5001 and 4566 free on 127.0.0.1. Every platform URL goes through 8080 (`*.localtest.me:8080`); to use another port, set `ORBIT_INGRESS_PORT` in `.env` before you bootstrap. Bootstrap checks all four.

You don't need kind, Terraform, the AWS CLI or the scanners on your machine. Orbit runs them as Kubernetes Jobs in k3s.

## Start

```sh
npm install
npm run bootstrap      # generates secrets in .env, docker compose up, Gitea admin/token/orgs, kube context orbit-compose
npm run dev            # API on :4000 and portal on http://localhost:5173
```

Or run the API and portal in a container too, on http://localhost:4000 (stop `npm run dev` first; both use port 4000):

```sh
npm run bootstrap -- --orbit
```

Open the portal and create an application. You can also use the CLI:

```sh
npm run orbit -- create payments --team core --template nestjs --language typescript --env dev --db --s3 --queue
npm run orbit -- watch payments
npm run orbit -- status payments
```

Starter templates: **Next.js** and **NestJS** (TypeScript or JavaScript), a **Node.js** Express service (TypeScript or JavaScript) and a **Python** FastAPI service. Each one deploys, passes the default security gate and exposes the health and metrics endpoints the platform expects ([docs/architecture.md](docs/architecture.md#app-templates)).

**Platform versions.** The portal's **Versions** page lists every component (k3s, Gitea, Grafana, Prometheus, Traefik, Floci, the registry, CoreDNS and the CI tools), the version it runs and newer releases. Platform admins update one component, roll it back, or **Update all** to the recommended versions. To be an admin, save `ORBIT_ADMIN_TOKEN` from `.env` (the bootstrap generates it) on the Platform page. The CLI has `orbit versions` and `orbit update <component> <version>` (with `ORBIT_ADMIN_TOKEN` set). Details: [docs/architecture.md](docs/architecture.md#platform-versions).

The bootstrap is idempotent: run it again after changing `.env` or pulling new platform files. Restart `npm run dev` after a bootstrap, because the API reads `.env` only at startup.

| Service | URL |
|---|---|
| Portal | http://localhost:5173 (`npm run dev`) or http://localhost:4000 (`--orbit`) |
| Gitea | http://git.localtest.me:8080, user `orbit-admin`, password `GITEA_PASSWORD` in `.env` |
| Grafana | http://grafana.localtest.me:8080, anonymous view; admin password `GRAFANA_PASSWORD` in `.env` |
| Prometheus | http://prometheus.localtest.me:8080 |
| Floci (AWS API) | http://aws.localtest.me:8080 or http://localhost:4566, for example `aws --endpoint-url http://localhost:4566 s3 ls` (any credentials) |
| Kubernetes | `kubectl --context orbit-compose get pods -A` (https://127.0.0.1:6443) |
| Image registry | `localhost:5001` |
| Apps | http://&lt;app&gt;-&lt;env&gt;.localtest.me:8080 |

If `*.localtest.me` does not resolve to 127.0.0.1 on your network, bootstrap prints the hosts-file line to add.

## What runs

```text
127.0.0.1:8080 ──▶ traefik (edge) ──┬─ git.*         ──▶ gitea
                                    ├─ grafana.*     ──▶ grafana
                                    ├─ prometheus.*  ──▶ prometheus ──(API server proxy)──▶ pods in k3s
                                    ├─ aws.*         ──▶ floci
                                    └─ anything else ──▶ k3s :80 ──▶ in-cluster Traefik ──▶ app Ingresses

k3s (Kubernetes)   CI jobs (orbit-ci), Terraform jobs (orbit-system), apps (<app>-<env>)
                   pods reach gitea, floci and registry by their Compose names through the dns service
registry           images CI builds: pods push to registry:5000, k3s pulls localhost:5001
k3s-setup          one-shot: kube contexts, platform manifests, Prometheus's API token
```

| Compose service | Image | Data volume |
|---|---|---|
| `k3s` | rancher/k3s | `k3s-data` (cluster state, pulled images, Postgres volumes) |
| `dns` | coredns/coredns | — |
| `registry` | registry:2 | `registry-data` |
| `gitea` | gitea/gitea | `gitea-data` |
| `floci` | floci/floci | `floci-data` |
| `prometheus` | prom/prometheus | `prometheus-data`; alert rules in `.orbit-data/prometheus-rules/` |
| `grafana` | grafana/grafana | `grafana-data` |
| `traefik` | traefik | — |
| `orbit` (profile `orbit`) | built from [Dockerfile](Dockerfile) | `orbit-data` |

Day to day:

```sh
docker compose ps                    # health of every service
docker compose logs -f gitea         # logs of one service
docker compose stop                  # stop everything, keep the data
docker compose start                 # start it again (or: npm run bootstrap)
npm run teardown                     # list what would be deleted
npm run teardown -- --yes            # delete containers, volumes and kube context orbit-compose
npm run teardown -- --yes --keep-data   # remove the containers, keep the volumes
```

### kind instead of Compose

The kind setup is still there: `npm run bootstrap:kind` (needs `kind`: `winget install Kubernetes.kind`) runs Gitea, Prometheus, Grafana and Floci inside a kind cluster, and `npm run teardown:kind -- --yes` deletes it. Each bootstrap rewrites the runtime-specific keys in `.env` (kube context, in-cluster URLs, registry, `PROMETHEUS_RULES_DIR`), so you can switch, but run only one at a time: both need port 8080.

## Cloud resources and Floci

When a service asks for an S3 bucket or an SQS queue, Terraform creates them with the AWS provider. With the default `ORBIT_CLOUD=floci`, the provider points at the Floci container.
The app receives everything it needs through Secret `<app>-aws`: `AWS_REGION`, `AWS_ENDPOINT_URL`, `S3_BUCKET`, `SQS_QUEUE_URL` and test credentials.
AWS SDKs read `AWS_ENDPOINT_URL`, so the same code runs unchanged against real AWS. For S3, enable path-style requests when `S3_FORCE_PATH_STYLE=true`.

## Develop

```sh
npm run typecheck      # API, CLI and portal
npm test               # unit tests (node:test)
npm run lint           # ESLint for the API and the portal
npm run format         # Prettier: no semicolons, single quotes (see .prettierrc)
npm run build          # dist/ and portal/dist/; `npm start` then serves both on :4000
docker compose build orbit   # the container image of the API and portal
```

### Code layout

The API and the portal follow the same layout as `portfolio-web`: shared wiring in `app/`, one folder per domain under `features/` with files named `<domain>.<role>.ts`, and clients for outside systems in `services/`.

```text
src/                          API, workers and CLI (Node)
  main.ts, cli.ts             entry points
  app/                        process wiring: server.ts (Fastify), platform.ts, store.ts (SQLite), events.ts
  config/env.ts               environment → typed config
  routes/                     one <domain>.routes.ts per API area
  features/<domain>/          apps, ci, gitops, observability, security, templates, terraform, versions, workflow
  services/                   Gitea, Grafana, Prometheus, Floci, Kubernetes, git, HTTP
  lib/                        logger, small utilities, HttpProblem
  types/contract.ts           REST contract shared with the CLI and portal

portal/src/                   developer portal (React)
  components/                 atoms → molecules → organisms → templates, one Name/Name.tsx each
  features/<domain>/          <domain>.api.ts and <domain>.types.ts per API area
  pages/, routes/AppRouter.tsx
  services/http.ts            API client
  hooks/, lib/, constants/, styles/

docker-compose.yml            the local platform
Dockerfile                    the Orbit API and portal image (Compose profile orbit)
bootstrap/
  compose.mjs                 npm run bootstrap / teardown (Docker Compose)
  compose/                    files the Compose services mount: dns, k3s, prometheus, grafana, traefik
  manifests/                  Kubernetes manifests: 00, 10 and 50 are applied on both runtimes, the rest only on kind
  up.mjs, down.mjs            npm run bootstrap:kind / teardown:kind
  shared.mjs                  helpers both bootstraps use
```

The portal imports with the `@/` alias (`@/components/atoms/StatusBadge/StatusBadge`) and reads the shared contract as `@contract`.
