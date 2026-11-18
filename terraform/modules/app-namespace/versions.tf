terraform {
  required_version = ">= 1.5.0"

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.32"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # No backend block: Orbit's Terraform runner adds backend.tf
  # (Kubernetes backend, Secret tfstate-default-<app>-<env> in orbit-system).
}

# Empty on purpose: inside the runner Job the provider uses the pod's
# in-cluster service account (orbit-terraform).
provider "kubernetes" {}
