# Optional Postgres for the app (database_enabled = true).
# The app's Deployment loads Secret <app>-db with envFrom (optional: true), so
# DATABASE_URL and the PG* variables appear as soon as this exists.

locals {
  db_count    = var.database_enabled ? 1 : 0
  db_name     = "${var.app}-db"
  db_host     = "${var.app}-db.${var.namespace}.svc.cluster.local"
  db_user     = "app"
  db_dbname   = replace(var.app, "-", "_")
  db_selector = { "app.kubernetes.io/name" = local.db_name }
  db_labels   = merge(local.labels, local.db_selector, { "app.kubernetes.io/component" = "database" })
}

resource "random_password" "db" {
  count   = local.db_count
  length  = 32
  special = false
}

resource "kubernetes_secret_v1" "db" {
  count = local.db_count

  metadata {
    name      = local.db_name
    namespace = local.namespace
    labels    = local.db_labels
  }

  type = "Opaque"

  # Plain values; the provider base64-encodes them.
  data = {
    DATABASE_URL = "postgres://${local.db_user}:${random_password.db[0].result}@${local.db_host}:5432/${local.db_dbname}"
    PGHOST       = local.db_host
    PGPORT       = "5432"
    PGUSER       = local.db_user
    PGPASSWORD   = random_password.db[0].result
    PGDATABASE   = local.db_dbname
  }
}

resource "kubernetes_service_v1" "db" {
  count = local.db_count

  metadata {
    name      = local.db_name
    namespace = local.namespace
    labels    = local.db_labels
  }

  spec {
    type     = "ClusterIP"
    selector = local.db_selector

    port {
      name        = "postgres"
      port        = 5432
      target_port = "postgres"
    }
  }
}

resource "kubernetes_stateful_set_v1" "db" {
  count = local.db_count

  metadata {
    name      = local.db_name
    namespace = local.namespace
    labels    = local.db_labels
  }

  spec {
    service_name = kubernetes_service_v1.db[0].metadata[0].name
    replicas     = 1

    selector {
      match_labels = local.db_selector
    }

    template {
      metadata {
        labels = local.db_labels
      }

      spec {
        automount_service_account_token = false

        # postgres:16-alpine's postgres user is uid/gid 70. Meets Pod Security "restricted".
        security_context {
          run_as_non_root = true
          run_as_user     = 70
          run_as_group    = 70
          fs_group        = 70

          seccomp_profile {
            type = "RuntimeDefault"
          }
        }

        container {
          name  = "postgres"
          image = "postgres:16-alpine"

          port {
            name           = "postgres"
            container_port = 5432
          }

          env {
            name = "POSTGRES_USER"
            value_from {
              secret_key_ref {
                name = kubernetes_secret_v1.db[0].metadata[0].name
                key  = "PGUSER"
              }
            }
          }

          env {
            name = "POSTGRES_PASSWORD"
            value_from {
              secret_key_ref {
                name = kubernetes_secret_v1.db[0].metadata[0].name
                key  = "PGPASSWORD"
              }
            }
          }

          env {
            name = "POSTGRES_DB"
            value_from {
              secret_key_ref {
                name = kubernetes_secret_v1.db[0].metadata[0].name
                key  = "PGDATABASE"
              }
            }
          }

          # Subdirectory, so initdb works on volumes that contain lost+found.
          env {
            name  = "PGDATA"
            value = "/var/lib/postgresql/data/pgdata"
          }

          readiness_probe {
            exec {
              command = ["sh", "-c", "pg_isready -h 127.0.0.1 -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\""]
            }
            initial_delay_seconds = 5
            period_seconds        = 5
          }

          liveness_probe {
            exec {
              command = ["sh", "-c", "pg_isready -h 127.0.0.1 -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\""]
            }
            initial_delay_seconds = 30
            period_seconds        = 15
            failure_threshold     = 6
          }

          resources {
            requests = {
              cpu    = "100m"
              memory = "256Mi"
            }
            limits = {
              cpu    = "500m"
              memory = "512Mi"
            }
          }

          security_context {
            allow_privilege_escalation = false

            capabilities {
              drop = ["ALL"]
            }
          }

          volume_mount {
            name       = "data"
            mount_path = "/var/lib/postgresql/data"
          }
        }
      }
    }

    volume_claim_template {
      metadata {
        name   = "data"
        labels = local.db_labels
      }

      spec {
        access_modes = ["ReadWriteOnce"]

        resources {
          requests = {
            storage = "1Gi"
          }
        }
      }
    }
  }

  timeouts {
    create = "10m"
    update = "10m"
  }
}
