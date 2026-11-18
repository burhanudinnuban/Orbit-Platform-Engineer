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
  description = "Owning team, stored as a resource tag."
  type        = string
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "endpoint" {
  description = "AWS API endpoint override. Set it to Floci's URL for local development; leave it empty for real AWS."
  type        = string
  default     = ""
}

variable "name_prefix" {
  description = "Prefix for bucket and queue names. S3 bucket names are global on real AWS, so make it unique per organization."
  type        = string
  default     = "orbit"

  validation {
    condition     = can(regex("^[a-z0-9]([-a-z0-9]{0,10}[a-z0-9])?$", var.name_prefix))
    error_message = "name_prefix must be a lowercase DNS label of at most 12 characters."
  }
}

variable "object_storage_enabled" {
  description = "Create an S3 bucket for the app."
  type        = bool
  default     = false
}

variable "queue_enabled" {
  description = "Create an SQS queue (with a dead-letter queue) for the app."
  type        = bool
  default     = false
}
