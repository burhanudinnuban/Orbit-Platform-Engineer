import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import {
  APP_SIZES,
  appHost,
  appNamespace,
  gitopsAppDir,
  type Config,
} from '../../config/env.js'
import type { AppRecord } from '../../app/store.js'

export interface GitopsValues {
  app: string
  env: string
  team: string
  namespace: string
  image: string
  replicas: number
  port: number
  host: string
  cpuRequest: string
  memoryRequest: string
  cpuLimit: string
  memoryLimit: string
  revision: string
}

export interface ApplicationSpec {
  app: string
  env: string
  namespace: string
  syncPolicy: { automated: boolean; prune: boolean; selfHeal: boolean }
}

export const APPLICATION_FILE = 'application.yaml'
export const VALUES_FILE = 'values.yaml'

const header = (what: string) =>
  `# ${what}\n# Managed by Orbit. The CI deploy stage updates "image" and "revision".\n`

export function buildValues(
  config: Config,
  app: AppRecord,
  env: string,
  port: number,
  existing?: Partial<GitopsValues>
): GitopsValues {
  const size = APP_SIZES[app.options.size] ?? APP_SIZES.small
  return {
    app: app.name,
    env,
    team: app.team,
    namespace: appNamespace(app.name, env),
    image: existing?.image ?? '',
    replicas: size.replicas,
    port,
    host: appHost(config, app.name, env),
    cpuRequest: size.cpuRequest,
    memoryRequest: size.memoryRequest,
    cpuLimit: size.cpuLimit,
    memoryLimit: size.memoryLimit,
    revision: existing?.revision ?? '',
  }
}

export async function readYamlFile<T>(file: string): Promise<T | undefined> {
  if (!existsSync(file)) return undefined
  return (parse(await readFile(file, 'utf8')) ?? undefined) as T | undefined
}

/**
 * Write (or refresh) apps/<app>/<env>/ in a gitops checkout. The image and
 * revision already deployed are preserved, so re-running provisioning never rolls back.
 */
export async function writeAppEnvironment(
  checkout: string,
  config: Config,
  app: AppRecord,
  env: string,
  port: number
): Promise<void> {
  const dir = path.join(checkout, gitopsAppDir(app.name, env))
  await mkdir(dir, { recursive: true })
  const existing = await readYamlFile<Partial<GitopsValues>>(
    path.join(dir, VALUES_FILE)
  )
  const values = buildValues(config, app, env, port, existing)
  const application: ApplicationSpec = {
    app: app.name,
    env,
    namespace: values.namespace,
    syncPolicy: { automated: true, prune: true, selfHeal: true },
  }
  await writeFile(
    path.join(dir, APPLICATION_FILE),
    header(`GitOps application ${app.name}/${env}`) + stringify(application)
  )
  await writeFile(
    path.join(dir, VALUES_FILE),
    header(`Values for ${app.name}/${env}`) + stringify(values)
  )

  const templatesDir = path.join(config.rootDir, 'templates', 'gitops')
  for (const name of await readdir(templatesDir)) {
    if (!name.endsWith('.yaml') && !name.endsWith('.yml')) continue
    const target = path.join(dir, name)
    // Teams may customize their manifests in the gitops repo; never overwrite an existing file.
    if (existsSync(target)) continue
    await writeFile(
      target,
      await readFile(path.join(templatesDir, name), 'utf8')
    )
  }
}

/** Point an environment at a new image (the CI deploy stage). */
export async function setImage(
  checkout: string,
  app: string,
  env: string,
  image: string,
  revision: string
): Promise<void> {
  const file = path.join(checkout, gitopsAppDir(app, env), VALUES_FILE)
  const values = await readYamlFile<Record<string, unknown>>(file)
  if (!values)
    throw new Error(
      `${gitopsAppDir(app, env)}/${VALUES_FILE} not found in the gitops repo — was the app provisioned?`
    )
  values.image = image
  values.revision = revision
  await writeFile(file, header(`Values for ${app}/${env}`) + stringify(values))
}

export async function removeApp(checkout: string, app: string): Promise<void> {
  await rm(path.join(checkout, 'apps', app), { recursive: true, force: true })
}
