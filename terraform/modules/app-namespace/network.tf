# Ingress is denied by default. Allowed sources:
#   - pods in the same namespace (app ↔ database)
#   - orbit-system (Traefik ingress, Prometheus scraping)
#   - orbit-ci (DAST scans against the in-cluster service)
# Egress is not restricted.

resource "kubernetes_network_policy_v1" "default_deny_ingress" {
  metadata {
    name      = "default-deny-ingress"
    namespace = local.namespace
    labels    = local.labels
  }

  spec {
    pod_selector {}
    policy_types = ["Ingress"]
  }
}

resource "kubernetes_network_policy_v1" "allow_same_namespace" {
  metadata {
    name      = "allow-same-namespace"
    namespace = local.namespace
    labels    = local.labels
  }

  spec {
    pod_selector {}
    policy_types = ["Ingress"]

    ingress {
      from {
        pod_selector {}
      }
    }
  }
}

resource "kubernetes_network_policy_v1" "allow_platform" {
  metadata {
    name      = "allow-orbit-platform"
    namespace = local.namespace
    labels    = local.labels
  }

  spec {
    pod_selector {}
    policy_types = ["Ingress"]

    ingress {
      from {
        namespace_selector {
          match_labels = {
            "kubernetes.io/metadata.name" = "orbit-system"
          }
        }
      }
      from {
        namespace_selector {
          match_labels = {
            "kubernetes.io/metadata.name" = "orbit-ci"
          }
        }
      }
    }
  }
}
