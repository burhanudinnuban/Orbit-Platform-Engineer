import type { AppOptions, CloudResources } from '../../types/contract.js'
import type { Config } from '../../config/env.js'

/** Secret in the app namespace that the Deployment loads with envFrom (optional). */
export const cloudSecretName = (app: string) => `${app}-aws`

/** Floci accepts any non-empty credentials; real AWS never gets these. */
const FLOCI_CREDENTIALS = {
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
}

export function wantsCloud(options: Partial<AppOptions>): boolean {
  return Boolean(options.objectStorage || options.queue)
}

export interface CloudVarsInput {
  app: string
  env: string
  team: string
  options: Partial<AppOptions>
}

/** Variables for terraform/modules/app-cloud. */
export function cloudVars(
  config: Config,
  input: CloudVarsInput
): Record<string, string | boolean> {
  return {
    app: input.app,
    env: input.env,
    team: input.team,
    region: config.cloud.region,
    endpoint: config.cloud.provider === 'floci' ? config.cloud.internalUrl : '',
    name_prefix: config.cloud.namePrefix,
    object_storage_enabled: Boolean(input.options.objectStorage),
    queue_enabled: Boolean(input.options.queue),
  }
}

/** Turn app-cloud's Terraform outputs into the view the API and portal show. */
export function cloudResources(
  config: Config,
  app: string,
  outputs: Record<string, unknown>
): CloudResources {
  const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  return {
    provider: config.cloud.provider,
    region: s(outputs.region) ?? config.cloud.region,
    endpoint: s(outputs.endpoint),
    bucket: s(outputs.bucket_name),
    queueUrl: s(outputs.queue_url),
    dlqUrl: s(outputs.dlq_url),
    secret: cloudSecretName(app),
  }
}

/**
 * Environment variables for the app. AWS SDKs (JS v3, boto3 ≥ 1.28, Go v2, Java v2)
 * read AWS_ENDPOINT_URL, so an app written for real AWS runs unchanged against Floci.
 * S3_FORCE_PATH_STYLE tells the app to use path-style S3 requests, which Floci requires.
 */
export function cloudSecretData(res: CloudResources): Record<string, string> {
  const data: Record<string, string> = {
    AWS_REGION: res.region,
    AWS_DEFAULT_REGION: res.region,
  }
  if (res.endpoint)
    Object.assign(
      data,
      { AWS_ENDPOINT_URL: res.endpoint, S3_FORCE_PATH_STYLE: 'true' },
      FLOCI_CREDENTIALS
    )
  if (res.bucket) data.S3_BUCKET = res.bucket
  if (res.queueUrl) data.SQS_QUEUE_URL = res.queueUrl
  if (res.dlqUrl) data.SQS_DLQ_URL = res.dlqUrl
  return data
}
