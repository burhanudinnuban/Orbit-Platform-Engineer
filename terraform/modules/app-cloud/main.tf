locals {
  emulated  = var.endpoint != ""
  base_name = "${var.name_prefix}-${var.app}-${var.env}"

  tags = {
    "orbit.dev/app"  = var.app
    "orbit.dev/env"  = var.env
    "orbit.dev/team" = var.team
    "managed-by"     = "orbit"
  }
}

# ── Object storage ───────────────────────────────────────────────────────────
# New buckets on real AWS already block public access and encrypt with SSE-S3,
# so the bucket needs no extra resources to be private.
resource "aws_s3_bucket" "this" {
  count  = var.object_storage_enabled ? 1 : 0
  bucket = local.base_name

  # Teardown removes the bucket even when it still holds objects.
  force_destroy = true

  lifecycle {
    precondition {
      condition     = length(local.base_name) <= 63
      error_message = "Bucket name ${local.base_name} is longer than 63 characters; use a shorter name_prefix, app or env."
    }
  }
}

# ── Queue ────────────────────────────────────────────────────────────────────
resource "aws_sqs_queue" "dlq" {
  count = var.queue_enabled ? 1 : 0
  name  = "${local.base_name}-dlq"

  message_retention_seconds = 1209600 # 14 days, the maximum
}

resource "aws_sqs_queue" "this" {
  count = var.queue_enabled ? 1 : 0
  name  = local.base_name

  visibility_timeout_seconds = 30
  message_retention_seconds  = 345600 # 4 days
  receive_wait_time_seconds  = 10     # long polling

  # After 5 failed receives a message moves to the dead-letter queue.
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[0].arn
    maxReceiveCount     = 5
  })
}
