#!/usr/bin/env node
// Orbit on Docker Compose: starts every platform service in docker-compose.yml
// (k3s, registry, Gitea, Floci, Prometheus, Grafana, the edge proxy), then
// creates the Gitea admin, token, orgs and gitops repo, adds kube context
// orbit-compose, and writes .env for the Orbit API.
//
//   node bootstrap/compose.mjs up [--orbit]    npm run bootstrap: idempotent, safe to re-run.
//                                              --orbit also runs the API and portal in a container.
//   node bootstrap/compose.mjs down            npm run teardown: lists what would be deleted
//   node bootstrap/compose.mjs down --yes      delete containers, volumes and kube context orbit-compose
//   node bootstrap/compose.mjs down --yes --keep-data   remove the containers, keep the volumes
//
// SAFETY: kubectl calls pass --context orbit-compose. Adding that context never
// changes your current context.
// Node builtins only, so it runs before `npm install`.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
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
  hostRequest,
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
const COMPOSE_FILE = join(ROOT, 'docker-compose.yml')
/** Image versions chosen in the portal (Platform → Versions), merged over COMPOSE_FILE. */
const OVERRIDE_FILE = join(ROOT, 'docker-compose.override.yml')
/** `name:` in docker-compose.yml; Compose labels everything it creates with it. */
const PROJECT = 'orbit'
const CONTEXT = 'orbit-compose'
const SYSTEM_NS = 'orbit-system'
const RECOMMENDED_MEMORY_GB = 6

const args = process.argv.slice(2)
const command = args.find((a) => !a.startsWith('-')) ?? 'up'
const flags = new Set(args.filter((a) => a.startsWith('-')))
if (
  flags.has('--help') ||
  flags.has('-h') ||
  !['up', 'down'].includes(command)
) {
  console.log(
    'Usage: node bootstrap/compose.mjs up [--orbit]\n       node bootstrap/compose.mjs down [--yes] [--keep-data]'
  )
  process.exit(flags.has('--help') || flags.has('-h') ? 0 : 1)
}

/** docker compose for this repository's docker-compose.yml (reads .env). */
function compose(composeArgs, opts) {
  return run(
    'docker',
    [
      'compose',
      '--project-directory',
      ROOT,
      '-f',
      COMPOSE_FILE,
      ...(existsSync(OVERRIDE_FILE) ? ['-f', OVERRIDE_FILE] : []),
      ...composeArgs,
    ],
    opts
  )
}

/** kubectl, always pinned to the orbit-compose context. */
function kubectl(kubectlArgs, opts) {
  return run('kubectl', ['--context', CONTEXT, ...kubectlArgs], opts)
}

// ─── .env ────────────────────────────────────────────────────────────────────
/** Keys only Docker Compose reads (docker-compose.yml). */
const COMPOSE_ENV_KEYS = [
  'ORBIT_NET_PREFIX',
  'GITEA_SECRET_KEY',
  'GITEA_INTERNAL_TOKEN',
]

/** Generated secrets: written when missing, empty or still a .env.example placeholder. */
const SECRET_KEYS = [
  'ORBIT_WEBHOOK_SECRET',
  'ORBIT_ADMIN_TOKEN',
  'GITEA_PASSWORD',
  'GRAFANA_PASSWORD',
  'GITEA_SECRET_KEY',
  'GITEA_INTERNAL_TOKEN',
]

/** Written only when missing: defaults and freshly generated secrets. */
function envDefaults(env) {
  const apiPort = env.ORBIT_PORT || '4000'
  return {
    ORBIT_PORT: apiPort,
    ORBIT_PUBLIC_URL: `http://localhost:${apiPort}`,
    ORBIT_PORTAL_URL: 'http://localhost:5173',
    // Gitea (a container) calls the API on the host for every push.
    ORBIT_WEBHOOK_URL: `http://host.docker.internal:${apiPort}/webhooks/gitea`,
    ORBIT_WEBHOOK_SECRET: randomHex(32),
    ORBIT_DATA_DIR: '.orbit-data',
    ORBIT_COMPONENTS: 'api,worker,ci,gitops',
    ORBIT_ENVIRONMENTS: 'dev,staging',
    ORBIT_BASE_DOMAIN: 'localtest.me',
    ORBIT_INGRESS_PORT: '8080',
    ORBIT_API_TOKEN: '',
    ORBIT_ADMIN_TOKEN: randomHex(24),
    GITEA_USER: GITEA_ADMIN,
    GITEA_PASSWORD: randomHex(16),
    GITEA_APPS_ORG: GITEA_APPS_ORG,
    GITEA_GITOPS_REPO: `${GITEA_PLATFORM_ORG}/${GITOPS_REPO}`,
    GRAFANA_USER: 'admin',
    GRAFANA_PASSWORD: randomHex(16),
    ORBIT_CLOUD: 'floci',
    ORBIT_AWS_REGION: 'us-east-1',
    ORBIT_CLOUD_NAME_PREFIX: 'orbit',
    ORBIT_NET_PREFIX: '10.213.0',
    GITEA_SECRET_KEY: randomHex(32),
    GITEA_INTERNAL_TOKEN: randomHex(48),
  }
}

/**
 * Values that follow from docker-compose.yml. Always written, so they track
 * ORBIT_BASE_DOMAIN and ORBIT_INGRESS_PORT, and switching from kind rewrites them.
 */
function runtimeEnv(env) {
  const domain = env.ORBIT_BASE_DOMAIN || 'localtest.me'
  const port = env.ORBIT_INGRESS_PORT || '8080'
  const url = (sub) => `http://${sub}.${domain}:${port}`
  return {
    ORBIT_KUBE_CONTEXT: CONTEXT,
    ORBIT_ALLOWED_KUBE_CONTEXTS: CONTEXT,
    GITEA_URL: url('git'),
    GRAFANA_URL: url('grafana'),
    PROMETHEUS_URL: url('prometheus'),
    FLOCI_URL: url('aws'),
    // Pods resolve Compose service names (service dns in docker-compose.yml).
    GITEA_INTERNAL_URL: 'http://gitea:3000',
    FLOCI_INTERNAL_URL: 'http://floci:4566',
    REGISTRY_PUSH: 'registry:5000',
    REGISTRY_PULL: 'localhost:5001',
    // Prometheus mounts this directory; Orbit writes alert rule files into it.
    PROMETHEUS_RULES_DIR:
      env.PROMETHEUS_RULES_DIR || './.orbit-data/prometheus-rules',
  }
}

function writeEnv(fill, force) {
  return writeEnvFile(ENV_FILE, {
    keys: [...API_ENV_KEYS, ...COMPOSE_ENV_KEYS],
    fill,
    force,
    writer: 'bootstrap/compose.mjs',
  })
}

// ─── steps ───────────────────────────────────────────────────────────────────
function checkPrerequisites() {
  step('Checking prerequisites')
  const docker = run('docker', ['version', '--format', '{{.Client.Version}}'], {
    allowFail: true,
  })
  if (docker.missing)
    throw new BootstrapError(
      "'docker' is not installed or not on PATH",
      'Install Docker Desktop: https://docs.docker.com/desktop/  (winget install Docker.DockerDesktop)'
    )
  ok(`docker ${docker.stdout.trim()}`)
  const composeVersion = run('docker', ['compose', 'version', '--short'], {
    allowFail: true,
  })
  if (!composeVersion.ok)
    throw new BootstrapError(
      'Docker Compose v2 is not available (`docker compose version` failed)',
      'Docker Desktop ships it. On Linux install the docker-compose-plugin package.'
    )
  ok(`docker compose ${composeVersion.stdout.trim()}`)
  const kubectlVersion = run('kubectl', ['version', '--client', '-o', 'json'], {
    allowFail: true,
  })
  if (kubectlVersion.missing)
    throw new BootstrapError(
      "'kubectl' is not installed or not on PATH",
      'Docker Desktop ships kubectl; otherwise: winget install Kubernetes.kubectl'
    )
  ok('kubectl found')
  const daemon = run(
    'docker',
    ['info', '--format', '{{.ServerVersion}} {{.MemTotal}}'],
    { allowFail: true }
  )
  if (!daemon.ok)
    throw new BootstrapError(
      'The Docker daemon is not running',
      'Start Docker Desktop, wait until it reports "running", then re-run.'
    )
  const [server, mem] = daemon.stdout.trim().split(' ')
  ok(`docker daemon running (server ${server})`)
  const memGb = Number(mem) / 1024 ** 3
  if (memGb && memGb < RECOMMENDED_MEMORY_GB)
    warn(
      `Docker has ${memGb.toFixed(1)} GB of memory; the platform and a pipeline need about ${RECOMMENDED_MEMORY_GB} GB. ` +
        'Raise it in Docker Desktop (Settings → Resources) or in %UserProfile%\\.wslconfig ([wsl2] memory=8GB).'
    )
}

/** Host ports published by this project's running containers. */
function ourPublishedPorts() {
  const res = compose(['--profile', 'orbit', 'ps', '--format', 'json'], {
    allowFail: true,
  })
  const ports = new Set()
  if (!res.ok) return ports
  const text = res.stdout.trim()
  // One JSON object per line (Compose 2.21+), or one JSON array (older).
  const rows = text.startsWith('[')
    ? JSON.parse(text)
    : text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l))
  for (const row of rows)
    for (const p of row.Publishers ?? [])
      if (p.PublishedPort) ports.add(p.PublishedPort)
  return ports
}

async function checkPorts(env, withOrbit) {
  step('Host ports')
  const ingress = Number(env.ORBIT_INGRESS_PORT || 8080)
  const wanted = [
    [ingress, 'edge proxy for *.localtest.me'],
    [6443, 'Kubernetes API'],
    [5001, 'image registry'],
    [4566, 'Floci (AWS API)'],
  ]
  if (withOrbit) wanted.push([Number(env.ORBIT_PORT || 4000), 'Orbit API'])
  const ours = ourPublishedPorts()
  for (const [port, what] of wanted) {
    if (ours.has(port)) ok(`${port} (${what}): already Orbit's`)
    else if (await portIsFree(port)) ok(`${port} (${what}): free`)
    else
      throw new BootstrapError(
        `Port ${port} on 127.0.0.1 is already in use; Orbit needs it for the ${what}.`,
        [
          portOwnerHint(port),
          port === ingress
            ? `Or move Orbit's ingress: set ORBIT_INGRESS_PORT in .env (for example 9080) and re-run.`
            : '',
          port === ingress || port === 5001
            ? 'If it is the kind setup: npm run teardown:kind -- --yes'
            : '',
          withOrbit && port === Number(env.ORBIT_PORT || 4000)
            ? 'If it is `npm run dev`, stop it: the container replaces it.'
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      )
  }
}

function startServices() {
  step('Starting the platform (docker compose up)')
  info(
    'the first run pulls about 2 GB of images; later runs take under a minute…'
  )
  compose(['up', '-d', '--wait', '--wait-timeout', '900'], { inherit: true })
  ok(
    'k3s, registry, Gitea, Floci, Prometheus, Grafana and the edge proxy are healthy'
  )
}

/** Add (or refresh) kube context orbit-compose in your kubeconfig, without switching to it. */
function installKubeContext() {
  step(`Kube context ${CONTEXT}`)
  const kubeconfig = compose([
    'exec',
    '-T',
    'k3s',
    'cat',
    '/output/orbit-host.kubeconfig',
  ]).stdout
  const pem = (re, what) => {
    const m = re.exec(kubeconfig)
    if (!m)
      throw new BootstrapError(
        `The k3s kubeconfig has no ${what}`,
        'Check: docker compose logs k3s-setup'
      )
    return Buffer.from(m[1], 'base64')
  }
  const ca = pem(/certificate-authority-data:\s*(\S+)/, 'CA')
  const cert = pem(/client-certificate-data:\s*(\S+)/, 'client certificate')
  const key = pem(/client-key-data:\s*(\S+)/, 'client key')

  // kubectl embeds the files into the kubeconfig; they exist only for these calls.
  const dir = mkdtempSync(join(tmpdir(), 'orbit-kube-'))
  try {
    const file = (name, data) => {
      const p = join(dir, name)
      writeFileSync(p, data, { mode: 0o600 })
      return p
    }
    run('kubectl', [
      'config',
      'set-cluster',
      CONTEXT,
      '--server=https://127.0.0.1:6443',
      `--certificate-authority=${file('ca.crt', ca)}`,
      '--embed-certs=true',
    ])
    run('kubectl', [
      'config',
      'set-credentials',
      CONTEXT,
      `--client-certificate=${file('client.crt', cert)}`,
      `--client-key=${file('client.key', key)}`,
      '--embed-certs=true',
    ])
    run('kubectl', [
      'config',
      'set-context',
      CONTEXT,
      `--cluster=${CONTEXT}`,
      `--user=${CONTEXT}`,
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  ok(
    `context ${CONTEXT} → https://127.0.0.1:6443 (your current context is unchanged)`
  )

  info('waiting for the in-cluster ingress (Traefik)…')
  kubectl([
    'rollout',
    'status',
    'deployment/traefik',
    '-n',
    SYSTEM_NS,
    '--timeout=600s',
  ])
  ok('in-cluster Traefik ready for app Ingresses')
}

function giteaCli(cliArgs, redact) {
  return compose(
    [
      'exec',
      '-T',
      '-u',
      'git',
      'gitea',
      'gitea',
      '--config',
      '/data/gitea/conf/app.ini',
      ...cliArgs,
    ],
    { allowFail: true, redact }
  )
}

/**
 * Grafana applies GF_SECURITY_ADMIN_PASSWORD only when it creates its database,
 * so after GRAFANA_PASSWORD changes the stored password has to be reset.
 */
async function syncGrafanaPassword(grafana, user, password) {
  step('Grafana admin password')
  await waitForHttp(grafana, '/api/health', {
    timeoutMs: 120_000,
    what: 'Grafana',
    hint: 'Check: docker compose logs grafana',
  })
  const login = () =>
    hostRequest(grafana, 'GET', '/api/user', {
      auth: { basic: { user, password } },
    })
  if ((await login()).status === 200) {
    ok('matches .env (GRAFANA_PASSWORD)')
    return
  }
  compose(
    [
      'exec',
      '-T',
      'grafana',
      'grafana',
      'cli',
      '--homepath',
      '/usr/share/grafana',
      'admin',
      'reset-admin-password',
      password,
    ],
    { redact: [password] }
  )
  const res = await login()
  if (res.status !== 200)
    throw new BootstrapError(
      `Grafana still rejects the admin password from .env (HTTP ${res.status})`,
      'Check GRAFANA_USER in .env; it must be the admin login (default: admin).'
    )
  ok('reset to match .env (GRAFANA_PASSWORD)')
}

function startOrbit() {
  step('Orbit API and portal (container)')
  info('building the image (first build takes a few minutes)…')
  compose(
    [
      '--profile',
      'orbit',
      'up',
      '-d',
      '--build',
      '--wait',
      '--wait-timeout',
      '300',
      'orbit',
    ],
    { inherit: true }
  )
  ok('orbit is healthy')
}

// ─── up ──────────────────────────────────────────────────────────────────────
async function up() {
  const withOrbit = flags.has('--orbit')
  console.log(
    bold('Orbit bootstrap (Docker Compose)') +
      dim(`  (kube context: ${CONTEXT}, never your current context)`)
  )
  checkPrerequisites()

  // Secrets go into .env before the first `up`: Compose reads them from there.
  step('Writing .env')
  let env = readEnvFile(ENV_FILE).values
  const fill = envDefaults(env)
  const emptySecrets = Object.fromEntries(
    SECRET_KEYS.filter((k) => !env[k]).map((k) => [k, fill[k]])
  )
  const changed = writeEnv(fill, {
    ...emptySecrets,
    ...runtimeEnv({ ...fill, ...env }),
  })
  env = readEnvFile(ENV_FILE).values
  ok(`${ENV_FILE} (${changed} key(s) written; existing values kept)`)
  const domain = env.ORBIT_BASE_DOMAIN || 'localtest.me'
  const port = Number(env.ORBIT_INGRESS_PORT || 8080)
  const apiPort = env.ORBIT_PORT || '4000'
  const grafanaUser = env.GRAFANA_USER || 'admin'
  const rulesDir = resolve(ROOT, env.PROMETHEUS_RULES_DIR)
  mkdirSync(rulesDir, { recursive: true })
  ok(`alert rules directory ${rulesDir}`)

  await checkPorts(env, withOrbit)
  startServices()
  installKubeContext()

  const gitea = { host: `git.${domain}`, port }
  step('Gitea: admin user, access token, orgs and gitops repo')
  await waitForHttp(gitea, '/api/healthz', {
    timeoutMs: 120_000,
    what: 'Gitea',
    hint: 'Check: docker compose ps; docker compose logs traefik gitea',
  })
  ok('Gitea is answering through the edge proxy')
  const token = await setupGitea(gitea, giteaCli, {
    password: env.GITEA_PASSWORD,
    existingToken: env.GITEA_TOKEN,
  })
  if (token !== env.GITEA_TOKEN) {
    writeEnv({}, { GITEA_TOKEN: token })
    ok('GITEA_TOKEN written to .env')
  }

  await syncGrafanaPassword(
    { host: `grafana.${domain}`, port },
    grafanaUser,
    env.GRAFANA_PASSWORD
  )

  if (withOrbit) startOrbit()

  step('DNS check')
  if (
    await checkDns([
      `git.${domain}`,
      `grafana.${domain}`,
      `prometheus.${domain}`,
      `aws.${domain}`,
    ])
  )
    ok(`*.${domain} resolves to 127.0.0.1`)

  console.log(`\n${green(bold('Orbit platform is up.'))}\n`)
  const at = (sub) => `http://${sub}.${domain}:${port}`
  printSummary([
    ...(withOrbit
      ? [['Orbit', `http://localhost:${apiPort}`, 'API and portal (container)']]
      : []),
    [
      'Gitea',
      at('git'),
      `user ${GITEA_ADMIN}, password in .env (GITEA_PASSWORD)`,
    ],
    [
      'Grafana',
      at('grafana'),
      `anonymous view; ${grafanaUser} password in .env (GRAFANA_PASSWORD)`,
    ],
    ['Prometheus', at('prometheus'), ''],
    [
      'Floci (AWS)',
      `${at('aws')}`,
      'or http://localhost:4566 (any credentials)',
    ],
    ['Registry', 'localhost:5001', 'pods push to registry:5000'],
    ['Kubernetes', 'https://127.0.0.1:6443', `kubectl --context ${CONTEXT}`],
    ['Apps', at('<app>-<env>'), ''],
    [
      'Admin token',
      '.env ORBIT_ADMIN_TOKEN',
      "save it on the portal's Platform page to update platform versions",
    ],
  ])
  console.log(
    withOrbit
      ? `\nNext: open http://localhost:${apiPort} and create your first application.\n`
      : `\nNext steps:\n  1. npm run dev\n  2. open http://localhost:5173 and create your first application\n`
  )
  console.log(
    dim(
      `Status: docker compose ps   Logs: docker compose logs -f <service>   Pods: kubectl --context ${CONTEXT} get pods -A`
    )
  )
}

// ─── down ────────────────────────────────────────────────────────────────────
async function down() {
  const yes = flags.has('--yes') || flags.has('-y')
  const keepData = flags.has('--keep-data')
  const containers = compose(
    ['--profile', 'orbit', 'ps', '-a', '--format', '{{.Name}}'],
    { allowFail: true }
  )
    .stdout.split(/\r?\n/)
    .filter(Boolean)
  const volumes = run(
    'docker',
    [
      'volume',
      'ls',
      '-q',
      '--filter',
      `label=com.docker.compose.project=${PROJECT}`,
    ],
    { allowFail: true }
  )
    .stdout.split(/\r?\n/)
    .filter(Boolean)
  const hasContext = run('kubectl', ['config', 'get-contexts', CONTEXT], {
    allowFail: true,
  }).ok

  const plan = []
  if (containers.length)
    plan.push(`containers: ${containers.join(', ')} (and the network)`)
  if (!keepData && volumes.length)
    plan.push(
      `volumes, with every repository, image, cluster object, metric and dashboard: ${volumes.join(', ')}`
    )
  if (!keepData && hasContext)
    plan.push(`kube context, cluster and user '${CONTEXT}' in your kubeconfig`)
  if (plan.length === 0) {
    console.log(
      'Nothing to delete: no Orbit containers, volumes or kube context found.'
    )
    return
  }
  console.log('This will delete:')
  for (const item of plan) console.log(`  - ${item}`)
  if (keepData)
    console.log('Keeping the volumes and the kube context (--keep-data).')
  console.log('Not touched: other kube contexts, .env, .orbit-data/.')
  if (!yes) {
    console.log(
      '\nRe-run with --yes to proceed:  npm run teardown -- --yes' +
        (keepData ? ' --keep-data' : '')
    )
    return
  }

  compose(
    [
      '--profile',
      'orbit',
      'down',
      '--remove-orphans',
      ...(keepData ? [] : ['--volumes']),
    ],
    { inherit: true }
  )
  if (!keepData && hasContext) {
    for (const what of ['context', 'cluster', 'user'])
      run('kubectl', ['config', `delete-${what}`, CONTEXT], { allowFail: true })
    console.log(`Removed kube context ${CONTEXT}.`)
  }
  console.log(
    keepData
      ? 'Done. `npm run bootstrap` starts it again with the same data.'
      : 'Done. Delete .orbit-data/ too if you want Orbit to forget its apps.'
  )
}

runMain(
  command === 'down' ? down : up,
  command === 'down' ? 'Teardown' : 'Bootstrap'
)
