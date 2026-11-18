import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Document, isMap, parse, parseDocument } from 'yaml'

/*
 * Platform services on the Docker Compose runtime. Admin-chosen images go to
 * docker-compose.override.yml, which `docker compose` merges over
 * docker-compose.yml by itself (and the bootstrap passes explicitly), so a
 * re-run of `npm run bootstrap` keeps them. docker-compose.yml keeps the
 * defaults. Orbit only touches services.<name>.image in the override file and
 * leaves anything else people put there alone.
 */

export const COMPOSE_FILE = 'docker-compose.yml'
export const OVERRIDE_FILE = 'docker-compose.override.yml'

// The yaml library writes each comment line as "#" + line.
const OVERRIDE_HEADER = [
  ' Image versions chosen in the Orbit portal (Platform → Versions).',
  ' Docker Compose merges this file over docker-compose.yml, which keeps the',
  " defaults. Delete a service's image line to go back to its default.",
].join('\n')

export interface ComposeResult {
  code: number
  output: string
}

export function composeArgs(rootDir: string): string[] {
  const files = [COMPOSE_FILE, OVERRIDE_FILE].filter((f) =>
    existsSync(path.join(rootDir, f))
  )
  return [
    'compose',
    '--project-directory',
    rootDir,
    ...files.flatMap((f) => ['-f', path.join(rootDir, f)]),
  ]
}

/** Run docker with argv (no shell), streaming each output line to onLine. */
export function runDocker(
  args: string[],
  opts: {
    cwd?: string
    onLine?: (line: string) => void
    timeoutMs?: number
  } = {}
): Promise<ComposeResult> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, {
      cwd: opts.cwd,
      env: process.env,
      windowsHide: true,
    })
    let output = ''
    let pending = ''
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      output += text
      pending += text
      const lines = pending.split(/\r?\n|\r/)
      pending = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) opts.onLine?.(line)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill(), opts.timeoutMs)
      : undefined
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, output: `${output}${err.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (pending.trim()) opts.onLine?.(pending)
      resolve({ code: code ?? -1, output })
    })
  })
}

export function runCompose(
  rootDir: string,
  args: string[],
  opts: { onLine?: (line: string) => void; timeoutMs?: number } = {}
): Promise<ComposeResult> {
  return runDocker([...composeArgs(rootDir), ...args], {
    ...opts,
    cwd: rootDir,
  })
}

/** Images of docker-compose.yml's services: the defaults. */
export function composeDefaults(rootDir: string): Map<string, string> {
  const doc = parse(readFileSync(path.join(rootDir, COMPOSE_FILE), 'utf8')) as {
    services?: Record<string, { image?: string }>
  }
  return new Map(
    Object.entries(doc.services ?? {})
      .filter(([, s]) => typeof s?.image === 'string')
      .map(([name, s]) => [name, s.image!])
  )
}

/** Images set in docker-compose.override.yml. */
export function overrideImages(rootDir: string): Map<string, string> {
  const file = path.join(rootDir, OVERRIDE_FILE)
  if (!existsSync(file)) return new Map()
  const doc = (parse(readFileSync(file, 'utf8')) ?? {}) as {
    services?: Record<string, { image?: string } | null>
  }
  return new Map(
    Object.entries(doc.services ?? {})
      .filter(([, s]) => typeof s?.image === 'string')
      .map(([name, s]) => [name, s!.image!])
  )
}

/**
 * Set (or, with undefined or the default image, remove) the image of services
 * in the override file. The file is deleted when nothing is left in it.
 */
export async function setOverrideImages(
  rootDir: string,
  images: Record<string, string | undefined>
): Promise<void> {
  const file = path.join(rootDir, OVERRIDE_FILE)
  const defaults = composeDefaults(rootDir)
  const existing = existsSync(file)
    ? parseDocument(readFileSync(file, 'utf8'))
    : undefined
  let doc: Document
  if (existing && isMap(existing.contents)) doc = existing
  else {
    // Built from an object, so new maps come out in block style.
    doc = new Document({ services: {} })
    doc.commentBefore = OVERRIDE_HEADER
  }
  for (const [service, image] of Object.entries(images)) {
    if (image === undefined || image === defaults.get(service)) {
      doc.deleteIn(['services', service, 'image'])
      const entry = doc.getIn(['services', service])
      if (isMap(entry) && entry.items.length === 0)
        doc.deleteIn(['services', service])
    } else {
      doc.setIn(['services', service, 'image'], image)
    }
  }
  const services = doc.get('services')
  const empty =
    (!services || (isMap(services) && services.items.length === 0)) &&
    isMap(doc.contents) &&
    doc.contents.items.every((p) => String(p.key) === 'services')
  if (empty) {
    await rm(file, { force: true })
    return
  }
  await writeFile(file, doc.toString())
}

export interface ComposeContainer {
  service: string
  image: string
  state: string
  health: string
}

/** `docker compose ps`: one JSON object per line (Compose 2.21+) or one array (older). */
export function parsePs(output: string): ComposeContainer[] {
  const text = output.trim()
  if (!text) return []
  const rows = (
    text.startsWith('[')
      ? (JSON.parse(text) as unknown[])
      : text
          .split(/\r?\n/)
          .filter((l) => l.trim().startsWith('{'))
          .map((l) => JSON.parse(l) as unknown)
  ) as { Service?: string; Image?: string; State?: string; Health?: string }[]
  return rows.map((r) => ({
    service: String(r.Service ?? ''),
    image: String(r.Image ?? ''),
    state: String(r.State ?? ''),
    health: String(r.Health ?? ''),
  }))
}

export async function composeContainers(
  rootDir: string
): Promise<ComposeContainer[]> {
  const res = await runCompose(rootDir, ['ps', '--all', '--format', 'json'], {
    timeoutMs: 20_000,
  })
  if (res.code !== 0)
    throw new Error(res.output.trim() || `docker compose ps exited ${res.code}`)
  return parsePs(res.output)
}
