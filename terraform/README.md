# Terraform

Orbit has two root modules. Both run in the golden path's "Terraform" step, once per app and environment:

| Module | Provider | When | What |
|---|---|---|---|
| `modules/app-namespace` | Kubernetes | always | namespace, quotas, policies, RBAC, optional Postgres |
| `modules/app-cloud` | AWS | the app asked for an S3 bucket or SQS queue | bucket, queue and dead-letter queue, in **Floci** locally or real AWS in production |

## app-namespace

## What the module creates

| Resource | Name | Notes |
|---|---|---|
| Namespace | `<app>-<env>` | labels `orbit.dev/app`, `orbit.dev/env`, `orbit.dev/team`, `app.kubernetes.io/managed-by=orbit`; Pod Security `baseline` enforced, `restricted` warned and audited |
| ResourceQuota | `orbit-quota` | CPU and memory from `cpu_quota` / `memory_quota` (limits default to the same values), 20 pods, 5 PVCs |
| LimitRange | `orbit-defaults` | container defaults: request 100m / 128Mi, limit 500m / 256Mi |
| NetworkPolicies | `default-deny-ingress`, `allow-same-namespace`, `allow-orbit-platform` | ingress allowed only from the same namespace, `orbit-system` (Traefik, Prometheus) and `orbit-ci` (DAST) |
| ServiceAccount | `<app>` | token not mounted |
| Postgres (optional) | Secret, Service and StatefulSet `<app>-db` | `database_enabled = true`; Secret holds `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` |

Inputs: `app`, `env`, `team`, `namespace`, `cpu_quota`, `memory_quota`, `database_enabled`, and optionally `cpu_limit_quota` and `memory_limit_quota`.
Outputs: `namespace`, `service_account`, `database_secret` (null when the database is disabled).

## app-cloud

The same module targets two clouds, chosen by the `endpoint` variable that Orbit sets from `ORBIT_CLOUD`:

| `ORBIT_CLOUD` | `endpoint` | Provider behaviour |
|---|---|---|
| `floci` (default) | `FLOCI_INTERNAL_URL`: `http://floci:4566` on Docker Compose, `http://floci.orbit-system.svc.cluster.local:4566` on kind | [Floci](https://github.com/floci-io/floci), the local AWS emulator that the bootstrap starts. Test credentials, path-style S3, no account or credential lookups. |
| `aws` | empty | Real AWS. Credentials come from Secret `orbit-aws-credentials` in `orbit-system` (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`), loaded into the Terraform Job. |
| `none` | — | The module never runs; the portal greys out the options. |

| Resource | Name | Notes |
|---|---|---|
| S3 bucket | `<prefix>-<app>-<env>` | `object_storage_enabled`; `force_destroy` so teardown removes it with its objects; private and SSE-S3 by AWS default |
| SQS queue | `<prefix>-<app>-<env>` | `queue_enabled`; long polling, 4-day retention, redrive to the DLQ after 5 receives |
| SQS dead-letter queue | `<prefix>-<app>-<env>-dlq` | 14-day retention |

Inputs: `app`, `env`, `team`, `region`, `endpoint`, `name_prefix` (`ORBIT_CLOUD_NAME_PREFIX`, default `orbit`), `object_storage_enabled`, `queue_enabled`.
Outputs: `region`, `endpoint`, `bucket_name`, `bucket_arn`, `queue_url`, `queue_arn`, `dlq_url` (null when not created).

The module has no Kubernetes provider, so it runs anywhere. After it applies, Orbit writes Secret `<app>-aws` in the app namespace from the outputs.
The Deployment loads that Secret with `envFrom` (`optional: true`):

| Key | Floci | Real AWS |
|---|---|---|
| `AWS_REGION`, `AWS_DEFAULT_REGION` | ✓ | ✓ |
| `AWS_ENDPOINT_URL` | in-cluster Floci URL | — |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `test` / `test` | — (use IRSA / EKS Pod Identity; see the roadmap) |
| `S3_FORCE_PATH_STYLE` | `true` | — |
| `S3_BUCKET` | if enabled | if enabled |
| `SQS_QUEUE_URL`, `SQS_DLQ_URL` | if enabled | if enabled |

Current AWS SDKs (JS v3, boto3 ≥ 1.28, Go v2, Java v2) read `AWS_ENDPOINT_URL`, so the same app code runs against Floci and AWS.
For S3, set path-style addressing when `S3_FORCE_PATH_STYLE=true` (for example `forcePathStyle` in the JS SDK).

## How Orbit runs it

The module is a root module that has no backend. Orbit's runner (`src/features/terraform`) does this:

1. Bundles the module's `*.tf` files, a generated `backend.tf` and `terraform.tfvars.json` into a ConfigMap in `orbit-system` (named `tf-ns-…` or `tf-cloud-…` plus a short hash).
2. Starts a Job running `hashicorp/terraform` as the `orbit-terraform` service account (RBAC in `bootstrap/manifests/50-orbit-rbac.yaml`).
3. Runs `terraform init`, `plan -out` and `apply` of that plan (or `destroy -auto-approve`), then prints `terraform output -json` for Orbit to read.

The Kubernetes provider uses the Job's in-cluster credentials. State lives in the Kubernetes backend, as Secret `tfstate-default-<app>-<env>` (app-namespace) or `tfstate-default-<app>-<env>-cloud` (app-cloud) in `orbit-system`, with a Lease for locking:

```hcl
terraform {
  backend "kubernetes" {
    secret_suffix     = "<app>-<env>"
    namespace         = "orbit-system"
    in_cluster_config = true
  }
}
```

## Running it by hand (debugging)

You need `terraform` ≥ 1.5 and the kube context of the local cluster (`orbit-compose` on Docker Compose, `kind-orbit` on kind). Use a throwaway local state; never point it at another cluster.

```sh
cd terraform/modules/app-namespace
export KUBE_CONFIG_PATH=~/.kube/config KUBE_CTX=orbit-compose
terraform init
terraform plan -var app=demo -var env=dev -var team=core -var namespace=demo-dev \
  -var cpu_quota=2 -var memory_quota=4Gi
```

The empty `provider "kubernetes" {}` block reads `KUBE_CONFIG_PATH` and `KUBE_CTX` from the environment.

To try `app-cloud` against Floci from the host (bootstrap exposes it at `http://aws.localtest.me:8080`, and on Docker Compose also at `http://localhost:4566`):

```sh
cd terraform/modules/app-cloud
terraform init
terraform apply -var app=demo -var env=dev -var team=core \
  -var endpoint=http://aws.localtest.me:8080 -var object_storage_enabled=true -var queue_enabled=true
aws --endpoint-url http://aws.localtest.me:8080 s3 ls     # any credentials work, e.g. AWS_ACCESS_KEY_ID=test
```
