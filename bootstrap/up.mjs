#!/usr/bin/env node
// Orbit bootstrap on kind (the alternative to Docker Compose, which is
// bootstrap/compose.mjs): creates the local kind cluster and the platform
// services (Traefik, Gitea, Prometheus, Grafana, Floci), then the Gitea admin,
// token, orgs and gitops repo, and writes .env for the Orbit API.
//
//   node bootstrap/up.mjs                 full bootstrap (idempotent; safe to re-run)
//   node bootstrap/up.mjs --skip-cluster  only redo the Gitea and .env steps
//
// SAFETY: every kubectl call passes --context kind-orbit explicitly. The script
// never talks to whatever cluster your current kubectl context points at, and it
// restores your current context if `kind` changes it.
// Node builtins only, so it runs before `npm install`.

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  API_ENV_KEYS,
  BootstrapError,
  GITEA_ADMIN,
  GITEA_APPS_ORG,
  GITEA_PLATFORM_ORG,
  GITOPS_REPO,
  bold,
  checkDns,
  dim,
  green,
  info,
  ok,
  portIsFree,
  portOwnerHint,
  printSummary,
  randomHex,
  readEnvFile,
  run,
  runMain,
  setupGitea,
  step,
  waitForHttp,
  warn,
  writeEnvFile,
} from './shared.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const ENV_FILE = join(ROOT, '.env')

const CLUSTER = 'orbit'
const CONTEXT = 'kind-orbit'
const SYSTEM_NS = 'orbit-system'
const REGISTRY_NAME = 'kind-registry'
const REGISTRY_HOST_PORT = 5001
const INGRESS_PORT = 8080
const GITEA = { host: 'git.localtest.me', port: INGRESS_PORT }
const ROLLOUTS = ['traefik', 'gitea', 'prometheus', 'grafana', 'floci']

const argv = new Set(process.argv.slice(2))
const SKIP_CLUSTER = argv.has('--skip-cluster')
if (argv.has('--help') || argv.has('-h')) {
  console.log('Usage: node bootstrap/up.mjs [--skip-cluster]')
  process.exit(0)
}

/** kubectl, always pinned to the kind-orbit context. */
function kubectl(args, opts) {
  return run('kubectl', ['--context', CONTEXT, ...args], opts)
}

// ─── .env ────────────────────────────────────────────────────────────────────
const ENV_DEFAULTS = {
  ORBIT_PORT: '4000',
  ORBIT_PUBLIC_URL: 'http://localhost:4000',
  ORBIT_PORTAL_URL: 'http://localhost:5173',
  ORBIT_WEBHOOK_URL: 'http://host.docker.internal:4000/webhooks/gitea',
  ORBIT_DATA_DIR: '.orbit-data',
  ORBIT_COMPONENTS: 'api,worker,ci,gitops',
  ORBIT_ENVIRONMENTS: 'dev,staging',
  ORBIT_BASE_DOMAIN: 'localtest.me',
  ORBIT_INGRESS_PORT: String(INGRESS_PORT),
  ORBIT_API_TOKEN: '',
  GITEA_URL: `http://${GITEA.host}:${INGRESS_PORT}`,
  GITEA_USER: GITEA_ADMIN,
  GITEA_APPS_ORG: GITEA_APPS_ORG,
  GITEA_GITOPS_REPO: `${GITEA_PLATFORM_ORG}/${GITOPS_REPO}`,
  GRAFANA_URL: `http://grafana.localtest.me:${INGRESS_PORT}`,
  GRAFANA_USER: 'admin',
  PROMETHEUS_URL: `http://prometheus.localtest.me:${INGRESS_PORT}`,
  // Floci (bootstrap/manifests/35-floci.yaml) is the local AWS cloud for app resources.
  ORBIT_CLOUD: 'floci',
  ORBIT_AWS_REGION: 'us-east-1',
  ORBIT_CLOUD_NAME_PREFIX: 'orbit',
  FLOCI_URL: `http://aws.localtest.me:${INGRESS_PORT}`,
}

/**
 * Values that depend on the runtime (kind here, Docker Compose in
 * compose.mjs). Always written, so switching runtimes rewrites them.
 */
const RUNTIME_ENV = {
  ORBIT_KUBE_CONTEXT: CONTEXT,
  ORBIT_ALLOWED_KUBE_CONTEXTS: CONTEXT,
  GITEA_INTERNAL_URL: `http://gitea.${SYSTEM_NS}.svc.cluster.local:3000`,
  FLOCI_INTERNAL_URL: `http://floci.${SYSTEM_NS}.svc.cluster.local:4566`,
  REGISTRY_PUSH: `${REGISTRY_NAME}:5000`,
  REGISTRY_PULL: `localhost:${REGISTRY_HOST_PORT}`,
  // Empty: alert rules go to ConfigMap prometheus-rules, which Prometheus mounts.
  PROMETHEUS_RULES_DIR: '',
}

// ─── steps ───────────────────────────────────────────────────────────────────
function checkPrerequisites() {
  step('Checking prerequisites')
  const hints = {
    docker:
      'Install Docker Desktop: https://docs.docker.com/desktop/  (winget install Docker.DockerDesktop)',
    kind: 'Install kind: winget install Kubernetes.kind   (or: choco install kind / brew install kind)',
    kubectl:
      'Install kubectl: winget install Kubernetes.kubectl   (or: choco install kubernetes-cli / brew install kubectl)',
  }
  const checks = [
    ['docker', ['version', '--format', '{{.Client.Version}}']],
    ['kind', ['version']],
    ['kubectl', ['version', '--client', '--output=yaml']],
  ]
  if (SKIP_CLUSTER) checks.splice(0, 2) // only kubectl is needed for the Gitea/.env steps
  const missing = []
  for (const [cmd, args] of checks) {
    const res = run(cmd, args, { allowFail: true })
    if (res.missing) missing.push(cmd)
    else ok(`${cmd} found`)
  }
  if (missing.length) {
    throw new BootstrapError(
      `Missing tools: ${missing.join(', ')}`,
      missing.map((m) => hints[m]).join('\n')
    )
  }
  if (!SKIP_CLUSTER) {
    const daemon = run('docker', ['info', '--format', '{{.ServerVersion}}'], {
      allowFail: true,
    })
    if (!daemon.ok) {
      throw new BootstrapError(
        'The Docker daemon is not running',
        'Start Docker Desktop, wait until it reports "running", then re-run.'
      )
    }
    ok(`docker daemon running (server ${daemon.stdout.trim()})`)
  }
}

function ensureRegistry() {
  step(
    `Local image registry (${REGISTRY_NAME} on 127.0.0.1:${REGISTRY_HOST_PORT})`
  )
  const state = run(
    'docker',
    ['inspect', '-f', '{{.State.Running}}', REGISTRY_NAME],
    { allowFail: true }
  )
  if (!state.ok) {
    run('docker', [
      'run',
      '-d',
      '--restart=always',
      '-p',
      `127.0.0.1:${REGISTRY_HOST_PORT}:5000`,
      '--network',
      'bridge',
      '--name',
      REGISTRY_NAME,
      'registry:2',
    ])
    ok('registry container created')
  } else if (state.stdout.trim() !== 'true') {
    run('docker', ['start', REGISTRY_NAME])
    ok('registry container started')
  } else {
    ok('registry container already running')
  }
}

function currentKubeContext() {
  // `kubectl config` only reads ~/.kube/config; it never contacts a cluster.
  const res = run('kubectl', ['config', 'current-context'], { allowFail: true })
  return res.ok ? res.stdout.trim() : ''
}

function restoreKubeContext(previous) {
  if (!previous || previous === CONTEXT) return
  if (currentKubeContext() !== previous) {
    run('kubectl', ['config', 'use-context', previous])
    info(`restored your kubectl current context to '${previous}'`)
  }
}

/**
 * kind maps host port INGRESS_PORT to Traefik. Any other server on 127.0.0.1:INGRESS_PORT
 * makes cluster creation fail, or silently answers every *.localtest.me request instead
 * of Traefik. Checked only before the cluster exists, since the cluster then holds the port.
 */
async function checkIngressPort() {
  const clusters = run('kind', ['get', 'clusters'], { allowFail: true })
    .stdout.split(/\r?\n/)
    .map((s) => s.trim())
  if (clusters.includes(CLUSTER)) return
  if (await portIsFree(INGRESS_PORT)) {
    ok(`port ${INGRESS_PORT} is free for the ingress`)
    return
  }
  throw new BootstrapError(
    `Port ${INGRESS_PORT} on 127.0.0.1 is already in use. Orbit's ingress (Traefik) needs it for *.localtest.me.`,
    `${portOwnerHint(INGRESS_PORT)}\nIf it is Orbit on Docker Compose, stop that first: docker compose stop`
  )
}

function ensureCluster() {
  step(`kind cluster '${CLUSTER}' (context ${CONTEXT})`)
  const previous = currentKubeContext()
  const clusters = run('kind', ['get', 'clusters'])
    .stdout.split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  try {
    if (!clusters.includes(CLUSTER)) {
      info('creating cluster (this takes a minute or two)…')
      run(
        'kind',
        ['create', 'cluster', '--config', join(HERE, 'kind-config.yaml')],
        { inherit: true }
      )
      ok('cluster created')
    } else {
      ok('cluster already exists')
      const ctx = run('kubectl', ['config', 'get-contexts', CONTEXT], {
        allowFail: true,
      })
      if (!ctx.ok) {
        run('kind', ['export', 'kubeconfig', '--name', CLUSTER])
        ok(`re-exported kubeconfig context ${CONTEXT}`)
      }
    }
  } finally {
    restoreKubeContext(previous)
  }
  kubectl(['wait', '--for=condition=Ready', 'node', '--all', '--timeout=180s'])
  ok('nodes ready')
}

function configureRegistryMirror() {
  step('Wiring the registry into the cluster')
  const nodes = run('kind', ['get', 'nodes', '--name', CLUSTER])
    .stdout.split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  const dir = `/etc/containerd/certs.d/localhost:${REGISTRY_HOST_PORT}`
  for (const node of nodes) {
    run('docker', ['exec', node, 'mkdir', '-p', dir])
    run(
      'docker',
      ['exec', '-i', node, 'cp', '/dev/stdin', `${dir}/hosts.toml`],
      { input: `[host."http://${REGISTRY_NAME}:5000"]\n` }
    )
    ok(
      `containerd mirror localhost:${REGISTRY_HOST_PORT} → http://${REGISTRY_NAME}:5000 on ${node}`
    )
  }
  const net = run('docker', [
    'inspect',
    '-f',
    '{{json .NetworkSettings.Networks.kind}}',
    REGISTRY_NAME,
  ])
  if (net.stdout.trim() === 'null' || net.stdout.trim() === '') {
    const res = run('docker', ['network', 'connect', 'kind', REGISTRY_NAME], {
      allowFail: true,
    })
    if (!res.ok && !/already exists|already connected/i.test(res.stderr)) {
      throw new BootstrapError(
        `docker network connect kind ${REGISTRY_NAME} failed: ${res.stderr.trim()}`
      )
    }
  }
  ok(`${REGISTRY_NAME} attached to the 'kind' docker network`)
  kubectl(['apply', '-f', '-'], {
    input: [
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata:',
      '  name: local-registry-hosting',
      '  namespace: kube-public',
      'data:',
      '  localRegistryHosting.v1: |',
      `    host: "localhost:${REGISTRY_HOST_PORT}"`,
      '    help: "https://kind.sigs.k8s.io/docs/user/local-registry/"',
      '',
    ].join('\n'),
  })
  ok('ConfigMap kube-public/local-registry-hosting applied')
}

function secretExists(name) {
  return kubectl(['get', 'secret', name, '-n', SYSTEM_NS, '-o', 'name'], {
    allowFail: true,
  }).ok
}

function createSecret(name, stringData) {
  // Piped as YAML on stdin so secret values never appear in process arguments.
  const data = Object.entries(stringData)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join('\n')
  kubectl(['create', '-f', '-'], {
    input: `apiVersion: v1\nkind: Secret\nmetadata:\n  name: ${name}\n  namespace: ${SYSTEM_NS}\n  labels:\n    app.kubernetes.io/managed-by: orbit\ntype: Opaque\nstringData:\n${data}\n`,
  })
}

function readSecretKey(name, key) {
  const res = kubectl(
    ['get', 'secret', name, '-n', SYSTEM_NS, '-o', `jsonpath={.data.${key}}`],
    { allowFail: true }
  )
  if (!res.ok || !res.stdout.trim()) return ''
  return Buffer.from(res.stdout.trim(), 'base64').toString('utf8')
}

function applyPlatform(env) {
  step('Platform services (Traefik, Gitea, Prometheus, Grafana, Floci)')
  kubectl(['apply', '-f', join(HERE, 'manifests', '00-namespaces.yaml')])
  ok('namespaces orbit-system and orbit-ci')

  if (!secretExists('grafana-admin')) {
    createSecret('grafana-admin', {
      password: env.GRAFANA_PASSWORD || randomHex(16),
    })
    ok('Secret grafana-admin created')
  } else {
    ok('Secret grafana-admin already exists')
  }
  if (!secretExists('gitea-secrets')) {
    createSecret('gitea-secrets', {
      'secret-key': randomHex(32),
      'internal-token': randomHex(48),
    })
    ok('Secret gitea-secrets created')
  } else {
    ok('Secret gitea-secrets already exists')
  }

  // Created before Prometheus starts, and never re-applied: Orbit owns its keys.
  const rules = kubectl(
    ['get', 'configmap', 'prometheus-rules', '-n', SYSTEM_NS, '-o', 'name'],
    { allowFail: true }
  )
  if (!rules.ok) {
    kubectl(['create', 'configmap', 'prometheus-rules', '-n', SYSTEM_NS])
    kubectl([
      'label',
      'configmap',
      'prometheus-rules',
      '-n',
      SYSTEM_NS,
      'app.kubernetes.io/managed-by=orbit',
      '--overwrite',
    ])
    ok('ConfigMap prometheus-rules created (empty)')
  } else {
    ok('ConfigMap prometheus-rules kept (existing alert rules preserved)')
  }

  kubectl(['apply', '-f', join(HERE, 'manifests')], { inherit: true })
  ok('manifests applied')

  info(
    'waiting for rollouts (first run pulls images; this can take several minutes)…'
  )
  for (const name of ROLLOUTS) {
    kubectl([
      'rollout',
      'status',
      `deployment/${name}`,
      '-n',
      SYSTEM_NS,
      '--timeout=600s',
    ])
    ok(`${name} ready`)
  }
}

/** The gitea CLI refuses to run as root; the image ships su-exec for this. */
function giteaCli(args, redact) {
  return kubectl(
    [
      'exec',
      '-n',
      SYSTEM_NS,
      'deploy/gitea',
      '-c',
      'gitea',
      '--',
      'su-exec',
      'git',
      'gitea',
      '--config',
      '/data/gitea/conf/app.ini',
      ...args,
    ],
    { allowFail: true, redact }
  )
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(
    bold('Orbit bootstrap (kind)') +
      dim(`  (kube context: ${CONTEXT}, never your current context)`)
  )
  checkPrerequisites()

  const env = readEnvFile(ENV_FILE).values

  if (SKIP_CLUSTER) {
    info('--skip-cluster: skipping registry, cluster and platform manifests')
  } else {
    await checkIngressPort()
    ensureRegistry()
    ensureCluster()
    configureRegistryMirror()
    applyPlatform(env)
  }

  step('Gitea: admin user, access token, orgs and gitops repo')
  const giteaPassword = env.GITEA_PASSWORD || randomHex(16)
  info(`waiting for Gitea at http://${GITEA.host}:${GITEA.port} …`)
  await waitForHttp(GITEA, '/api/healthz', {
    timeoutMs: 240_000,
    what: 'Gitea',
    hint: `Check Traefik and Gitea: kubectl --context ${CONTEXT} -n ${SYSTEM_NS} get pods`,
  })
  ok('Gitea is answering through Traefik')
  const token = await setupGitea(GITEA, giteaCli, {
    password: giteaPassword,
    existingToken: env.GITEA_TOKEN,
  })

  step('Writing .env')
  const grafanaPassword =
    readSecretKey('grafana-admin', 'password') || env.GRAFANA_PASSWORD || ''
  if (!grafanaPassword)
    warn('could not read Secret grafana-admin; GRAFANA_PASSWORD left empty')
  const fill = {
    ...ENV_DEFAULTS,
    ORBIT_WEBHOOK_SECRET: env.ORBIT_WEBHOOK_SECRET || randomHex(32),
    ORBIT_ADMIN_TOKEN: env.ORBIT_ADMIN_TOKEN || randomHex(24),
  }
  const force = {
    ...RUNTIME_ENV,
    GITEA_PASSWORD: giteaPassword,
    GITEA_TOKEN: token,
  }
  if (grafanaPassword) force.GRAFANA_PASSWORD = grafanaPassword
  if (!env.ORBIT_WEBHOOK_SECRET)
    force.ORBIT_WEBHOOK_SECRET = fill.ORBIT_WEBHOOK_SECRET
  if (!env.ORBIT_ADMIN_TOKEN) force.ORBIT_ADMIN_TOKEN = fill.ORBIT_ADMIN_TOKEN
  const changed = writeEnvFile(ENV_FILE, {
    keys: API_ENV_KEYS,
    fill,
    force,
    writer: 'bootstrap/up.mjs',
  })
  ok(`${ENV_FILE} (${changed} key(s) written; existing values kept)`)

  step('DNS check')
  if (
    await checkDns([
      GITEA.host,
      'grafana.localtest.me',
      'prometheus.localtest.me',
      'aws.localtest.me',
    ])
  )
    ok('*.localtest.me resolves to 127.0.0.1')

  console.log(`\n${green(bold('Orbit platform is up.'))}\n`)
  printSummary([
    [
      'Gitea',
      `http://${GITEA.host}:${INGRESS_PORT}`,
      `user ${GITEA_ADMIN}, password in .env (GITEA_PASSWORD)`,
    ],
    [
      'Grafana',
      `http://grafana.localtest.me:${INGRESS_PORT}`,
      'anonymous view; admin password in .env (GRAFANA_PASSWORD)',
    ],
    ['Prometheus', `http://prometheus.localtest.me:${INGRESS_PORT}`, ''],
    [
      'Floci (AWS)',
      `http://aws.localtest.me:${INGRESS_PORT}`,
      'local AWS: aws --endpoint-url <url> s3 ls (any credentials)',
    ],
    [
      'Registry',
      `localhost:${REGISTRY_HOST_PORT}`,
      `pods push to ${REGISTRY_NAME}:5000`,
    ],
    ['Apps', `http://<app>-<env>.localtest.me:${INGRESS_PORT}`, ''],
  ])
  console.log(
    `\nNext steps:\n  1. npm run dev\n  2. open http://localhost:5173 and create your first application\n`
  )
  console.log(
    dim(`Inspect the cluster with: kubectl --context ${CONTEXT} get pods -A`)
  )
}

runMain(main)
