locals {
  labels = {
    "orbit.dev/app"                = var.app
    "orbit.dev/env"                = var.env
    "orbit.dev/team"               = var.team
    "app.kubernetes.io/managed-by" = "orbit"
  }

  # Every namespaced resource references this, so it is created after the namespace.
  namespace = kubernetes_namespace_v1.this.metadata[0].name
}

resource "kubernetes_namespace_v1" "this" {
  metadata {
    name = var.namespace
    labels = merge(local.labels, {
      "pod-security.kubernetes.io/enforce"         = "baseline"
      "pod-security.kubernetes.io/enforce-version" = "latest"
      "pod-security.kubernetes.io/warn"            = "restricted"
      "pod-security.kubernetes.io/warn-version"    = "latest"
      "pod-security.kubernetes.io/audit"           = "restricted"
      "pod-security.kubernetes.io/audit-version"   = "latest"
    })
  }
}

resource "kubernetes_resource_quota_v1" "this" {
  metadata {
    name      = "orbit-quota"
    namespace = local.namespace
    labels    = local.labels
  }

  spec {
    hard = {
      "requests.cpu"           = var.cpu_quota
      "requests.memory"        = var.memory_quota
      "limits.cpu"             = coalesce(var.cpu_limit_quota, var.cpu_quota)
      "limits.memory"          = coalesce(var.memory_limit_quota, var.memory_quota)
      "pods"                   = "20"
      "persistentvolumeclaims" = "5"
    }
  }
}

# The quota requires every container to declare requests and limits; these
# defaults cover containers that don't.
resource "kubernetes_limit_range_v1" "this" {
  metadata {
    name      = "orbit-defaults"
    namespace = local.namespace
    labels    = local.labels
  }

  spec {
    limit {
      type = "Container"
      default_request = {
        cpu    = "100m"
        memory = "128Mi"
      }
      default = {
        cpu    = "500m"
        memory = "256Mi"
      }
    }
  }
}

# Identity for the app's pods (serviceAccountName in the gitops Deployment).
# The app never needs the Kubernetes API, so no token is mounted.
resource "kubernetes_service_account_v1" "app" {
  metadata {
    name      = var.app
    namespace = local.namespace
    labels    = local.labels
  }

  automount_service_account_token = false
}
