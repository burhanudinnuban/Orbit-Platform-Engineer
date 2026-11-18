terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # No backend block: Orbit's Terraform runner adds backend.tf
  # (Kubernetes backend, Secret tfstate-default-<app>-<env>-cloud in orbit-system).
}

# One module, two clouds:
#   endpoint = "http://floci...:4566"  → Floci, the local AWS emulator (fixed test
#                                       credentials, path-style S3, no account lookups)
#   endpoint = ""                      → real AWS; credentials come from the runner's
#                                       environment (Secret orbit-aws-credentials)
provider "aws" {
  region = var.region

  access_key                  = local.emulated ? "test" : null
  secret_key                  = local.emulated ? "test" : null
  skip_credentials_validation = local.emulated
  skip_metadata_api_check     = local.emulated
  skip_requesting_account_id  = local.emulated
  s3_use_path_style           = local.emulated

  # Every service this module calls needs an endpoint, or the provider goes to real AWS.
  dynamic "endpoints" {
    for_each = local.emulated ? [var.endpoint] : []
    content {
      s3  = endpoints.value
      sqs = endpoints.value
      sts = endpoints.value
    }
  }

  default_tags {
    tags = local.tags
  }
}
