variable "app" {
  description = "Application name (DNS label)."
  type        = string

  validation {
    condition     = can(regex("^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$", var.app))
    error_message = "app must be a lowercase DNS label of at most 40 characters."
  }
}

variable "env" {
  description = "Environment name, for example dev or staging."
  type        = string

  validation {
    condition     = can(regex("^[a-z]([-a-z0-9]{0,18}[a-z0-9])?$", var.env))
    error_message = "env must be a lowercase DNS label of at most 20 characters."
  }
}

variable "team" {
  description = "Owning team, stored as the orbit.dev/team label."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$", var.team))
    error_message = "team must be a valid Kubernetes label value."
  }
}

variable "namespace" {
  description = "Namespace to create, by convention <app>-<env>."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$", var.namespace))
    error_message = "namespace must be a valid DNS label."
  }
}

variable "cpu_quota" {
  description = "Total CPU requests allowed in the namespace, for example \"2\"."
  type        = string
}

variable "memory_quota" {
  description = "Total memory requests allowed in the namespace, for example \"4Gi\"."
  type        = string
}

variable "cpu_limit_quota" {
  description = "Total CPU limits allowed in the namespace. Defaults to cpu_quota."
  type        = string
  default     = null
}

variable "memory_limit_quota" {
  description = "Total memory limits allowed in the namespace. Defaults to memory_quota."
  type        = string
  default     = null
}

variable "database_enabled" {
  description = "Provision a Postgres 16 StatefulSet and a <app>-db Secret with DATABASE_URL."
  type        = bool
  default     = false
}
