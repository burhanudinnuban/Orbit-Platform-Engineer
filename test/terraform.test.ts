import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseAllDocuments } from 'yaml'
import type { AppOptions } from '../src/types/contract.js'
import { loadConfig, ROOT_DIR } from '../src/config/env.js'
import type { AppRecord } from '../src/app/store.js'
import { DNS_LABEL } from '../src/lib/util.js'
import {
  cloudResources,
  cloudSecretData,
  cloudSecretName,
  cloudVars,
  wantsCloud,
} from '../src/features/terraform/terraform.cloud.js'
import {
  backendTf,
  parseOutputs,
  runBaseName,
  stateSuffix,
  terraformScript,
  type TerraformModule,
} from '../src/features/terraform/terraform.runner.js'
import { namespaceVars } from '../src/features/workflow/workflow.goldenPath.js'

const floci = loadConfig({})
const aws = loadConfig({ ORBIT_CLOUD: 'aws', ORBIT_AWS_REGION: 'eu-west-1' })
const options = (o: Partial<AppOptions> = {}): AppOptions => ({
  database: false,
  objectStorage: false,
  queue: false,
  size: 'small',
  securityGate: 'high',
  ...o,
})

/** `variable "name"` blocks declared by a module. */
function declaredVariables(module: TerraformModule): Set<string> {
  const dir = join(ROOT_DIR, 'terraform', 'modules', module)
  const names = new Set<string>()
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.tf'))) {
    for (const m of readFileSync(join(dir, file), 'utf8').matchAll(
      /^variable\s+"([a-z_]+)"/gm
    ))
      names.add(m[1]!)
  }
  return names
}

describe('cloud configuration', () => {
  it('defaults to Floci on the Docker Compose network', () => {
    assert.equal(floci.cloud.provider, 'floci')
    assert.equal(floci.cloud.region, 'us-east-1')
    assert.equal(floci.cloud.internalUrl, 'http://floci:4566')
    assert.equal(floci.cloud.url, 'http://aws.localtest.me:8080')
    assert.equal(floci.cloud.credentialsSecret, 'orbit-aws-credentials')
  })

  it('has no Floci URLs for real AWS or when disabled', () => {
    assert.equal(aws.cloud.provider, 'aws')
    assert.equal(aws.cloud.url, '')
    assert.equal(aws.cloud.internalUrl, '')
    const none = loadConfig({ ORBIT_CLOUD: 'none' })
    assert.equal(none.cloud.provider, 'none')
    assert.equal(none.cloud.url, '')
  })

  it('rejects unknown providers', () => {
    assert.throws(() => loadConfig({ ORBIT_CLOUD: 'gcp' }), /ORBIT_CLOUD/)
  })

  it('points Terraform at the modules directory', () => {
    assert.equal(
      floci.terraform.modulesDir,
      join(ROOT_DIR, 'terraform', 'modules')
    )
  })
})

describe('app-cloud variables and outputs', () => {
  const input = {
    app: 'payments',
    env: 'dev',
    team: 'core',
    options: options({ objectStorage: true }),
  }

  it('only asks for cloud when S3 or a queue is wanted', () => {
    assert.equal(wantsCloud(options()), false)
    assert.equal(wantsCloud(options({ database: true })), false)
    assert.equal(wantsCloud(options({ objectStorage: true })), true)
    assert.equal(wantsCloud(options({ queue: true })), true)
    assert.equal(wantsCloud({}), false)
  })

  it('sends the Floci endpoint pods use locally and none on real AWS', () => {
    assert.deepEqual(cloudVars(floci, input), {
      app: 'payments',
      env: 'dev',
      team: 'core',
      region: 'us-east-1',
      endpoint: 'http://floci:4566',
      name_prefix: 'orbit',
      object_storage_enabled: true,
      queue_enabled: false,
    })
    const real = cloudVars(aws, { ...input, options: options({ queue: true }) })
    assert.equal(real.endpoint, '')
    assert.equal(real.region, 'eu-west-1')
    assert.equal(real.object_storage_enabled, false)
    assert.equal(real.queue_enabled, true)
  })

  it('only sends variables the modules declare', () => {
    const cloudDeclared = declaredVariables('app-cloud')
    for (const key of Object.keys(cloudVars(floci, input)))
      assert.ok(cloudDeclared.has(key), `app-cloud lacks variable "${key}"`)

    const app: AppRecord = {
      name: 'payments',
      team: 'core',
      template: 'node-service',
      language: 'javascript',
      description: '',
      environments: ['dev'],
      options: options({ database: true }),
      status: 'provisioning',
      outputs: {},
      createdAt: '',
      updatedAt: '',
    }
    const nsDeclared = declaredVariables('app-namespace')
    for (const key of Object.keys(namespaceVars(app, 'dev', '1', '1Gi'))) {
      assert.ok(nsDeclared.has(key), `app-namespace lacks variable "${key}"`)
    }
  })

  it('maps Terraform outputs and drops nulls', () => {
    const res = cloudResources(floci, 'payments', {
      region: 'us-east-1',
      endpoint: 'http://floci.orbit-system.svc.cluster.local:4566',
      bucket_name: 'orbit-payments-dev',
      bucket_arn: 'arn:aws:s3:::orbit-payments-dev',
      queue_url: null,
      queue_arn: null,
      dlq_url: null,
    })
    assert.deepEqual(res, {
      provider: 'floci',
      region: 'us-east-1',
      endpoint: 'http://floci.orbit-system.svc.cluster.local:4566',
      bucket: 'orbit-payments-dev',
      queueUrl: undefined,
      dlqUrl: undefined,
      secret: 'payments-aws',
    })
    assert.equal(cloudResources(aws, 'x', {}).region, 'eu-west-1')
  })

  it('gives Floci apps an endpoint and test credentials', () => {
    const data = cloudSecretData({
      provider: 'floci',
      region: 'us-east-1',
      endpoint: 'http://floci.orbit-system.svc.cluster.local:4566',
      bucket: 'orbit-payments-dev',
      queueUrl:
        'http://floci.orbit-system.svc.cluster.local:4566/000000000000/orbit-payments-dev',
      dlqUrl:
        'http://floci.orbit-system.svc.cluster.local:4566/000000000000/orbit-payments-dev-dlq',
      secret: cloudSecretName('payments'),
    })
    assert.deepEqual(data, {
      AWS_REGION: 'us-east-1',
      AWS_DEFAULT_REGION: 'us-east-1',
      AWS_ENDPOINT_URL: 'http://floci.orbit-system.svc.cluster.local:4566',
      S3_FORCE_PATH_STYLE: 'true',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      S3_BUCKET: 'orbit-payments-dev',
      SQS_QUEUE_URL:
        'http://floci.orbit-system.svc.cluster.local:4566/000000000000/orbit-payments-dev',
      SQS_DLQ_URL:
        'http://floci.orbit-system.svc.cluster.local:4566/000000000000/orbit-payments-dev-dlq',
    })
  })

  it('never puts credentials or an endpoint in a real-AWS Secret', () => {
    const data = cloudSecretData({
      provider: 'aws',
      region: 'eu-west-1',
      bucket: 'orbit-payments-dev',
      secret: 'payments-aws',
    })
    assert.deepEqual(data, {
      AWS_REGION: 'eu-west-1',
      AWS_DEFAULT_REGION: 'eu-west-1',
      S3_BUCKET: 'orbit-payments-dev',
    })
  })
})

describe('terraform runner', () => {
  it('keeps one state Secret per module, app and environment', () => {
    assert.equal(
      stateSuffix('app-namespace', 'payments', 'dev'),
      'payments-dev'
    )
    assert.equal(
      stateSuffix('app-cloud', 'payments', 'dev'),
      'payments-dev-cloud'
    )
    assert.match(
      backendTf(floci, 'app-cloud', 'payments', 'dev'),
      /secret_suffix\s+= "payments-dev-cloud"/
    )
    assert.match(
      backendTf(floci, 'app-namespace', 'payments', 'dev'),
      /namespace\s+= "orbit-system"/
    )
  })

  it('names runs uniquely even when long names are truncated', () => {
    const app = 'a-thirty-character-service-nm'
    const names = [
      runBaseName('app-namespace', app, 'staging-eu-1'),
      runBaseName('app-namespace', app, 'staging-eu-2'),
      runBaseName('app-cloud', app, 'staging-eu-1'),
      runBaseName('app-cloud', app, 'staging-eu-2'),
    ]
    assert.equal(new Set(names).size, names.length)
    for (const n of names) {
      assert.ok(n.length <= 40, `${n} is longer than 40 characters`)
      assert.match(n, DNS_LABEL)
      // ConfigMap and Job names derived from it must stay valid DNS labels too.
      assert.ok(`${n}-destroy-${Date.now().toString(36)}`.length <= 63)
    }
    assert.equal(
      runBaseName('app-cloud', 'web', 'dev'),
      runBaseName('app-cloud', 'web', 'dev')
    )
  })

  it('plans, applies and prints outputs on apply; only destroys on destroy', () => {
    const apply = terraformScript('apply')
    assert.match(apply, /terraform plan .* -out=\/work\/plan\.out/)
    assert.match(apply, /terraform apply .* \/work\/plan\.out/)
    assert.match(apply, /terraform output -json/)
    const destroy = terraformScript('destroy')
    assert.match(destroy, /terraform destroy -auto-approve/)
    assert.doesNotMatch(destroy, /terraform plan|terraform output/)
  })

  it('reads outputs printed after the marker', () => {
    const log = [
      'Apply complete! Resources: 3 added, 0 changed, 0 destroyed.',
      '::orbit-terraform-outputs::',
      JSON.stringify({
        bucket_name: { value: 'orbit-web-dev', type: 'string' },
        queue_url: { value: null },
      }),
    ].join('\n')
    assert.deepEqual(parseOutputs(log), {
      bucket_name: 'orbit-web-dev',
      queue_url: null,
    })
    assert.deepEqual(parseOutputs('no marker here'), {})
    assert.deepEqual(parseOutputs('::orbit-terraform-outputs::\nnot json'), {})
  })
})

describe('Floci manifest (kind)', () => {
  // The in-cluster URL bootstrap/up.mjs writes to .env for kind.
  const kindFloci = loadConfig({
    FLOCI_INTERNAL_URL: 'http://floci.orbit-system.svc.cluster.local:4566',
  })
  const docs = parseAllDocuments(
    readFileSync(
      join(ROOT_DIR, 'bootstrap', 'manifests', '35-floci.yaml'),
      'utf8'
    )
  ).map(
    (d) =>
      d.toJS() as {
        kind: string
        metadata: { name: string; namespace: string }
        // Untyped YAML, read several levels deep by the assertions below.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        spec: Record<string, any>
      }
  )
  const byKind = (kind: string) => docs.find((d) => d.kind === kind)!

  it('serves the in-cluster URL Orbit is configured with', () => {
    const url = new URL(kindFloci.cloud.internalUrl)
    const svc = byKind('Service')
    assert.equal(
      `${svc.metadata.name}.${svc.metadata.namespace}.svc.cluster.local`,
      url.hostname
    )
    assert.equal(svc.spec.ports[0].port, Number(url.port))
    const env = byKind('Deployment').spec.template.spec.containers[0].env as {
      name: string
      value: string
    }[]
    assert.equal(
      env.find((e) => e.name === 'FLOCI_BASE_URL')?.value,
      kindFloci.cloud.internalUrl
    )
  })

  it('is reachable from the host at FLOCI_URL through Traefik', () => {
    const ingress = byKind('Ingress')
    assert.equal(ingress.spec.rules[0].host, new URL(floci.cloud.url).hostname)
    assert.equal(ingress.spec.ingressClassName, 'traefik')
  })

  it('pins the image and keeps data on a volume', () => {
    const pod = byKind('Deployment').spec.template.spec
    assert.match(pod.containers[0].image, /^floci\/floci:\d+\.\d+\.\d+$/)
    assert.equal(pod.containers[0].volumeMounts[0].mountPath, '/app/data')
    assert.equal(pod.automountServiceAccountToken, false)
  })
})
