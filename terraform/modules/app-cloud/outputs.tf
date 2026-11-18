# Orbit turns these outputs into Secret <app>-aws in the app's namespace.

output "region" {
  description = "AWS region."
  value       = var.region
}

output "endpoint" {
  description = "Endpoint override (Floci), or null on real AWS."
  value       = local.emulated ? var.endpoint : null
}

output "bucket_name" {
  description = "S3 bucket name, or null when object_storage_enabled is false."
  value       = one(aws_s3_bucket.this[*].bucket)
}

output "bucket_arn" {
  description = "S3 bucket ARN, or null when object_storage_enabled is false."
  value       = one(aws_s3_bucket.this[*].arn)
}

output "queue_url" {
  description = "SQS queue URL, or null when queue_enabled is false."
  value       = one(aws_sqs_queue.this[*].url)
}

output "queue_arn" {
  description = "SQS queue ARN, or null when queue_enabled is false."
  value       = one(aws_sqs_queue.this[*].arn)
}

output "dlq_url" {
  description = "Dead-letter queue URL, or null when queue_enabled is false."
  value       = one(aws_sqs_queue.dlq[*].url)
}
