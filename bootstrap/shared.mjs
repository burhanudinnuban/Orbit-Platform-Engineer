// Helpers shared by the bootstrap scripts: compose.mjs (Docker Compose, the
// default) and up.mjs (kind). Node builtins only, so they run before `npm install`.

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'

// ─── output ──────────────────────────────────────────────────────────────────
const color = (code) => (s) =>
  process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s
export const bold = color('1')
export const green = color('32')
export const yellow = color('33')
export const red = color('31')
export const dim = color('2')
let stepNo = 0
export const step = (title) =>
  console.log(`\n${bold(`[${++stepNo}]`)} ${bold(title)}`)
export const ok = (msg) => console.log(`    ${green('✓')} ${msg}`)
export const info = (msg) => console.log(`    ${dim('·')} ${msg}`)
export const warn = (msg) => console.log(`    ${yellow('!')} ${msg}`)

export class BootstrapError extends Error {
  constructor(message, hint) {
    super(message)
    this.hint = hint
  }
}

/** Run main() and turn failures into a readable message and exit code 1. */
export function runMain(main, title = 'Bootstrap') {
  main().catch((err) => {
    console.error(`\n${red(bold(`${title} failed:`))} ${err.message}`)
    if (err.hint) console.error(`\n${yellow('Hint:')}\n${indent(err.hint)}`)
    if (!(err instanceof BootstrapError)) console.error(err.stack)
    process.exit(1)
  })
}

// ─── process helpers ─────────────────────────────────────────────────────────
/** Run a command without a shell. Throws unless allowFail. */
export function run(
  cmd,
  args,
  { input, allowFail = false, inherit = false, redact = [], env } = {}
) {
  const shown = redactText([cmd, ...args].join(' '), redact)
  const res = spawnSync(cmd, args, {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: inherit ? ['pipe', 'inherit', 'inherit'] : 'pipe',
    windowsHide: true,
    env: env ? { ...process.env, ...env } : undefined,
  })
  if (res.error) {
    if (allowFail)
      return {
        ok: false,
        code: -1,
        stdout: '',
        stderr: String(res.error.message),
        missing: res.error.code === 'ENOENT',
      }
    if (res.error.code === 'ENOENT')
      throw new BootstrapError(`'${cmd}' is not installed or not on PATH`)
    throw new BootstrapError(`${shown} failed: ${res.error.message}`)
  }
  const out = {
    ok: res.status === 0,
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    missing: false,
  }
  if (!out.ok && !allowFail) {
    const detail = redactText((out.stderr || out.stdout).trim(), redact)
    throw new BootstrapError(
      `${shown} failed (exit ${res.status})${detail ? `:\n${indent(detail)}` : ''}`
    )
  }
  return out
}

export function redactText(text, secrets) {
  let result = text
  for (const s of secrets) if (s) result = result.split(s).join('***')
  return result
}

export const indent = (s) =>
  s
    .split(/\r?\n/)
    .map((l) => `      ${l}`)
    .join('\n')
export const randomHex = (bytes) => randomBytes(bytes).toString('hex')
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

// ─── .env handling ───────────────────────────────────────────────────────────
/** Keys the Orbit API reads, in the order they are written to a fresh .env. */
export const API_ENV_KEYS = [
  'ORBIT_PORT',
  'ORBIT_PUBLIC_URL',
  'ORBIT_PORTAL_URL',
  'ORBIT_WEBHOOK_URL',
  'ORBIT_WEBHOOK_SECRET',
  'ORBIT_DATA_DIR',
  'ORBIT_KUBE_CONTEXT',
  'ORBIT_ALLOWED_KUBE_CONTEXTS',
  'ORBIT_COMPONENTS',
  'ORBIT_ENVIRONMENTS',
  'ORBIT_BASE_DOMAIN',
  'ORBIT_INGRESS_PORT',
  'ORBIT_API_TOKEN',
  'ORBIT_ADMIN_TOKEN',
  'GITEA_URL',
  'GITEA_INTERNAL_URL',
  'GITEA_USER',
  'GITEA_PASSWORD',
  'GITEA_TOKEN',
  'GITEA_APPS_ORG',
  'GITEA_GITOPS_REPO',
  'GRAFANA_URL',
  'GRAFANA_USER',
  'GRAFANA_PASSWORD',
  'PROMETHEUS_URL',
  'PROMETHEUS_RULES_DIR',
  'REGISTRY_PUSH',
  'REGISTRY_PULL',
  'ORBIT_CLOUD',
  'ORBIT_AWS_REGION',
  'ORBIT_CLOUD_NAME_PREFIX',
  'FLOCI_URL',
  'FLOCI_INTERNAL_URL',
]

/** Values copied from .env.example and never replaced; they count as unset. */
export const isPlaceholder = (v) => /^change-me/i.test(v)

/** Parse .env. Placeholder values are left out of `values`, as if missing. */
export function readEnvFile(file) {
  const lines = existsSync(file)
    ? readFileSync(file, 'utf8').split(/\r?\n/)
    : []
  const values = {}
  for (const line of lines) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      v = v.slice(1, -1)
    if (!isPlaceholder(v)) values[m[1]] = v
  }
  return { lines, values }
}

/**
 * Merge into .env. `fill` keys are only written when missing (or still a
 * placeholder); `force` keys are always written (derived values such as a
 * regenerated token). Unknown keys, comments and ordering in an existing file
 * are preserved. Every key in `keys` ends up present, even if empty.
 */
export function writeEnvFile(file, { keys, fill, force, writer }) {
  const { lines, values } = readEnvFile(file)
  const fresh = lines.length === 0 || (lines.length === 1 && lines[0] === '')
  const updates = { ...force }
  for (const [k, v] of Object.entries(fill))
    if (!(k in values) && !(k in updates)) updates[k] = v
  for (const k of keys) if (!(k in values) && !(k in updates)) updates[k] = ''

  if (fresh) {
    const out = [`# Orbit platform configuration — written by ${writer}`, '']
    for (const k of keys) out.push(`${k}=${updates[k] ?? ''}`)
    for (const k of Object.keys(updates))
      if (!keys.includes(k)) out.push(`${k}=${updates[k]}`)
    writeFileSync(file, out.join('\n') + '\n')
    return Object.keys(updates).length
  }

  const pending = { ...updates }
  const out = lines.map((line) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    if (m && m[1] in pending) {
      const v = pending[m[1]]
      delete pending[m[1]]
      return `${m[1]}=${v}`
    }
    return line
  })
  while (out.length && out[out.length - 1] === '') out.pop()
  const appended = Object.keys(pending)
  if (appended.length) {
    out.push('', `# Added by ${writer}`)
    for (const k of appended) out.push(`${k}=${pending[k]}`)
  }
  writeFileSync(file, out.join('\n') + '\n')
  return Object.keys(updates).length
}

// ─── HTTP through the ingress ────────────────────────────────────────────────
/**
 * HTTP request to 127.0.0.1:<port> with a Host header, so the bootstrap works
 * even when *.localtest.me does not resolve on this network.
 */
export function hostRequest(
  { host, port },
  method,
  path,
  { body, auth, timeoutMs = 15_000 } = {}
) {
  return new Promise((resolvePromise, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const headers = { Host: `${host}:${port}`, Accept: 'application/json' }
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(payload)
    }
    if (auth?.token) headers.Authorization = `token ${auth.token}`
    if (auth?.basic)
      headers.Authorization = `Basic ${b64(`${auth.basic.user}:${auth.basic.password}`)}`
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers,
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          let json
          try {
            json = data ? JSON.parse(data) : undefined
          } catch {
            json = undefined
          }
          resolvePromise({ status: res.statusCode ?? 0, text: data, json })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/** Poll `path` until it answers 200. */
export async function waitForHttp(target, path, { timeoutMs, what, hint }) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      const res = await hostRequest(target, 'GET', path)
      if (res.status === 200) return
      last = `HTTP ${res.status}`
    } catch (err) {
      last = err.message
    }
    await sleep(3000)
  }
  throw new BootstrapError(
    `${what} did not answer at http://${target.host}:${target.port}${path} (${last})`,
    hint
  )
}

// ─── Gitea ───────────────────────────────────────────────────────────────────
export const GITEA_ADMIN = 'orbit-admin'
export const GITEA_EMAIL = 'orbit-admin@orbit.local'
export const GITEA_APPS_ORG = 'apps'
export const GITEA_PLATFORM_ORG = 'platform'
export const GITOPS_REPO = 'gitops'

/**
 * Create the admin user, or reset its password to match .env.
 * `cli(args, redact)` runs the gitea CLI as the git user inside the Gitea
 * container (kubectl exec or docker compose exec) and returns run()'s result.
 */
export function ensureGiteaAdmin(cli, password) {
  const created = cli(
    [
      'admin',
      'user',
      'create',
      '--admin',
      '--username',
      GITEA_ADMIN,
      '--password',
      password,
      '--email',
      GITEA_EMAIL,
      '--must-change-password=false',
    ],
    [password]
  )
  if (created.ok) {
    ok(`Gitea admin '${GITEA_ADMIN}' created`)
    return
  }
  const output = `${created.stdout}\n${created.stderr}`
  if (!/already exists/i.test(output)) {
    throw new BootstrapError(
      `Could not create the Gitea admin user:\n${indent(redactText(output.trim(), [password]))}`
    )
  }
  // Existing user: make sure its password matches .env so basic auth works.
  let changed = cli(
    [
      'admin',
      'user',
      'change-password',
      '--username',
      GITEA_ADMIN,
      '--password',
      password,
      '--must-change-password=false',
    ],
    [password]
  )
  if (!changed.ok && /flag provided but not defined/i.test(changed.stderr)) {
    changed = cli(
      [
        'admin',
        'user',
        'change-password',
        '--username',
        GITEA_ADMIN,
        '--password',
        password,
      ],
      [password]
    )
  }
  if (!changed.ok) {
    throw new BootstrapError(
      `Could not reset the Gitea admin password:\n${indent(redactText(`${changed.stdout}\n${changed.stderr}`.trim(), [password]))}`
    )
  }
  ok(`Gitea admin '${GITEA_ADMIN}' already exists (password synced with .env)`)
}

export async function ensureGiteaToken(gitea, existingToken, password) {
  if (existingToken) {
    const res = await hostRequest(gitea, 'GET', '/api/v1/user', {
      auth: { token: existingToken },
    })
    if (res.status === 200) {
      ok('existing GITEA_TOKEN is valid')
      return existingToken
    }
    warn(
      `existing GITEA_TOKEN rejected (HTTP ${res.status}); creating a new one`
    )
  }
  const res = await hostRequest(
    gitea,
    'POST',
    `/api/v1/users/${GITEA_ADMIN}/tokens`,
    {
      auth: { basic: { user: GITEA_ADMIN, password } },
      body: {
        name: `orbit-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomHex(3)}`,
        scopes: [
          'write:admin',
          'write:organization',
          'write:repository',
          'write:user',
        ],
      },
    }
  )
  if (res.status !== 201 || !res.json?.sha1) {
    throw new BootstrapError(
      `Creating a Gitea access token failed (HTTP ${res.status}): ${res.text.slice(0, 300)}`
    )
  }
  ok('Gitea access token created')
  return res.json.sha1
}

export async function ensureGiteaOrg(gitea, token, name, fullName) {
  const res = await hostRequest(gitea, 'POST', '/api/v1/orgs', {
    auth: { token },
    body: {
      username: name,
      full_name: fullName,
      visibility: 'public',
      repo_admin_change_team_access: true,
    },
  })
  if (res.status === 201) ok(`org '${name}' created`)
  else if (res.status === 409 || res.status === 422)
    ok(`org '${name}' already exists`)
  else
    throw new BootstrapError(
      `Creating org '${name}' failed (HTTP ${res.status}): ${res.text.slice(0, 300)}`
    )
}

export async function ensureGitopsRepo(gitea, token) {
  const res = await hostRequest(
    gitea,
    'POST',
    `/api/v1/orgs/${GITEA_PLATFORM_ORG}/repos`,
    {
      auth: { token },
      body: {
        name: GITOPS_REPO,
        description:
          'Orbit GitOps desired state — managed by Orbit, reconciled by the Orbit GitOps controller',
        auto_init: true,
        default_branch: 'main',
        readme: 'Default',
        private: false,
      },
    }
  )
  if (res.status === 201)
    ok(`repo '${GITEA_PLATFORM_ORG}/${GITOPS_REPO}' created`)
  else if (res.status === 409)
    ok(`repo '${GITEA_PLATFORM_ORG}/${GITOPS_REPO}' already exists`)
  else
    throw new BootstrapError(
      `Creating repo ${GITEA_PLATFORM_ORG}/${GITOPS_REPO} failed (HTTP ${res.status}): ${res.text.slice(0, 300)}`
    )

  const readme = [
    '# apps/',
    '',
    'Desired state for every Orbit application, one directory per app and environment:',
    '',
    '    apps/<app>/<env>/{application.yaml, values.yaml, deployment.yaml, service.yaml, ingress.yaml}',
    '',
    'Orbit writes these files. Changes merged here are applied to the cluster by the Orbit GitOps controller.',
    '',
  ].join('\n')
  const put = await hostRequest(
    gitea,
    'POST',
    `/api/v1/repos/${GITEA_PLATFORM_ORG}/${GITOPS_REPO}/contents/apps/README.md`,
    {
      auth: { token },
      body: {
        content: b64(readme),
        message: 'chore: add apps/ directory',
        branch: 'main',
      },
    }
  )
  if (put.status === 201) ok('apps/README.md added to the gitops repo')
  else if (put.status === 422 || put.status === 409)
    ok('apps/ directory already present')
  else
    warn(
      `could not add apps/README.md (HTTP ${put.status}); the controller creates apps/ on first use`
    )
}

/** Admin user, token, orgs and gitops repo. Returns the token. */
export async function setupGitea(gitea, cli, { password, existingToken }) {
  ensureGiteaAdmin(cli, password)
  const token = await ensureGiteaToken(gitea, existingToken, password)
  await ensureGiteaOrg(gitea, token, GITEA_APPS_ORG, 'Orbit applications')
  await ensureGiteaOrg(gitea, token, GITEA_PLATFORM_ORG, 'Orbit platform')
  await ensureGitopsRepo(gitea, token)
  return token
}

// ─── host checks ─────────────────────────────────────────────────────────────
/** True when nothing listens on 127.0.0.1:<port>. */
export function portIsFree(port) {
  return new Promise((done) => {
    const probe = net.createServer()
    probe.once('error', () => done(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)))
  })
}

/** How to find out who holds a port, for error hints. */
export function portOwnerHint(port) {
  return process.platform === 'win32'
    ? [
        `Find the owner (PowerShell):`,
        `  Get-NetTCPConnection -LocalPort ${port} | ForEach-Object { Get-Process -Id $_.OwningProcess }`,
        `If it is wslrelay.exe, a server inside WSL holds the port; stop it there, for example:`,
        `  wsl -u root service nginx stop`,
      ].join('\n')
    : `Find the owner:  lsof -iTCP:${port} -sTCP:LISTEN`
}

/** Warn with the hosts-file line when the platform hosts do not resolve to 127.0.0.1. */
export async function checkDns(hosts) {
  try {
    const { address } = await lookup(hosts[0])
    if (address === '127.0.0.1') return true
    warn(`${hosts[0]} resolves to ${address}, not 127.0.0.1`)
  } catch {
    warn(
      `${hosts[0]} does not resolve on this network (DNS rebinding protection?)`
    )
  }
  const hostsFile =
    process.platform === 'win32'
      ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
      : '/etc/hosts'
  warn(
    `add this line to ${hostsFile} (plus one per app, e.g. <app>-dev.localtest.me):`
  )
  console.log(`      127.0.0.1 ${hosts.join(' ')}`)
  return false
}

export function printSummary(rows) {
  for (const [name, url, note] of rows)
    console.log(`  ${name.padEnd(11)} ${url.padEnd(44)} ${dim(note)}`)
}
