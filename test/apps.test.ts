import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/app/server.js'
import { createPlatform } from '../src/app/platform.js'
import { Store } from '../src/app/store.js'
import { loadConfig, ROOT_DIR } from '../src/config/env.js'
import { TemplateCatalog } from '../src/features/templates/templates.catalog.js'
import type { WorkflowEngine } from '../src/features/workflow/workflow.engine.js'
import { createLogger } from '../src/lib/logger.js'

const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

describe('template languages', () => {
  let root: string
  before(() => {
    root = mkdtempSync(path.join(tmpdir(), 'orbit-templates-'))
    const t = path.join(root, 'templates', 'apps', 'demo')
    write(
      path.join(t, 'template.yaml'),
      'id: demo\nname: Demo\ndescription: d\nport: 3000\nlanguages: [typescript, javascript]\n'
    )
    write(
      path.join(t, 'files', 'README.md'),
      '# {{APP_NAME}} in {{LANGUAGE}}\n'
    )
    write(path.join(t, 'files', 'Dockerfile'), 'FROM shared\n')
    write(path.join(t, 'variants', 'typescript', 'Dockerfile'), 'FROM ts\n')
    write(
      path.join(t, 'variants', 'typescript', 'src', 'main.ts'),
      'export const app = "{{APP_NAME}}"\n'
    )
    write(
      path.join(t, 'variants', 'javascript', 'src', 'main.js'),
      'export const app = "{{APP_NAME}}"\n'
    )
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  it('lists the languages, the first as default', () => {
    const [demo] = new TemplateCatalog(root).list()
    assert.deepEqual(demo?.languages, ['typescript', 'javascript'])
    assert.equal(demo?.language, 'typescript')
    assert.equal(demo?.port, 3000)
  })

  it('renders the shared files, then the variant over them', async () => {
    const out = path.join(root, 'out-ts')
    const vars = { APP_NAME: 'payments', TEAM: 'core', DESCRIPTION: 'x' }
    const count = await new TemplateCatalog(root).render(
      'demo',
      'typescript',
      vars,
      out
    )
    assert.equal(count, 3)
    assert.equal(
      readFileSync(path.join(out, 'README.md'), 'utf8'),
      '# payments in TypeScript\n'
    )
    assert.equal(
      readFileSync(path.join(out, 'Dockerfile'), 'utf8'),
      'FROM ts\n'
    )
    assert.match(
      readFileSync(path.join(out, 'src', 'main.ts'), 'utf8'),
      /"payments"/
    )
    assert.equal(existsSync(path.join(out, 'src', 'main.js')), false)

    const js = path.join(root, 'out-js')
    await new TemplateCatalog(root).render('demo', 'javascript', vars, js)
    assert.equal(
      readFileSync(path.join(js, 'Dockerfile'), 'utf8'),
      'FROM shared\n'
    )
    assert.ok(existsSync(path.join(js, 'src', 'main.js')))
  })

  it('refuses a language the template does not have', async () => {
    await assert.rejects(
      new TemplateCatalog(root).render(
        'demo',
        'python',
        { APP_NAME: 'a', TEAM: 'b', DESCRIPTION: 'c' },
        path.join(root, 'x')
      ),
      /no python variant/
    )
  })

  it('every bundled template has a variant directory per language', () => {
    const templates = new TemplateCatalog(ROOT_DIR).list()
    assert.ok(templates.length > 0)
    for (const t of templates) {
      if (t.languages.length < 2) continue
      for (const l of t.languages)
        assert.ok(
          existsSync(path.join(t.dir, 'variants', l)),
          `${t.id} has variants/${l}`
        )
    }
  })
})

describe('store migration', () => {
  it('adds the language column to databases from before it, backfilled', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orbit-store-'))
    const file = path.join(dir, 'orbit.db')
    try {
      const require = createRequire(import.meta.url)
      const { DatabaseSync } =
        require('node:sqlite') as typeof import('node:sqlite')
      const old = new DatabaseSync(file)
      old.exec(`CREATE TABLE apps (name TEXT PRIMARY KEY, team TEXT NOT NULL, template TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', environments TEXT NOT NULL, options TEXT NOT NULL,
        status TEXT NOT NULL, outputs TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
      old.exec(`INSERT INTO apps VALUES ('web', 't', 'node-service', '', '["dev"]', '{}', 'ready', '{}', 'x', 'x'),
        ('ml', 't', 'python-service', '', '["dev"]', '{}', 'ready', '{}', 'x', 'x')`)
      old.close()
      const store = new Store(file)
      assert.equal(store.getApp('web')?.language, 'javascript')
      assert.equal(store.getApp('ml')?.language, 'python')
      store.close()
      // Opening again must not try to add the column twice.
      new Store(file).close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('API access', () => {
  const ADMIN = 'admin-token-0123456789abcdef'
  const API = 'api-token-0123456789abcdef'
  let app: FastifyInstance
  let withApiToken: FastifyInstance
  // Nothing real behind it: no kube context, and closed ports for the tools.
  const OFFLINE = {
    ORBIT_RUNTIME: 'compose',
    ORBIT_KUBE_CONTEXT: 'orbit-test-none',
    ORBIT_ALLOWED_KUBE_CONTEXTS: 'orbit-test-none',
    GITEA_URL: 'http://127.0.0.1:9',
    GRAFANA_URL: 'http://127.0.0.1:9',
    PROMETHEUS_URL: 'http://127.0.0.1:9',
    FLOCI_URL: 'http://127.0.0.1:9',
  }
  const server = async (env: Record<string, string>) => {
    const config = loadConfig({ ...OFFLINE, ...env })
    const platform = createPlatform(
      config,
      createLogger('silent'),
      new Store(':memory:')
    )
    return buildServer({ platform, engine: {} as WorkflowEngine })
  }
  before(async () => {
    app = await server({ ORBIT_ADMIN_TOKEN: ADMIN })
    withApiToken = await server({
      ORBIT_ADMIN_TOKEN: ADMIN,
      ORBIT_API_TOKEN: API,
    })
  })
  after(async () => {
    await app.close()
    await withApiToken.close()
  })
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })

  it('makes the admin token admin and everyone else a member', async () => {
    const anon = await app.inject({ url: '/api/session' })
    assert.deepEqual(anon.json(), { role: 'member', adminConfigured: true })
    const admin = await app.inject({
      url: '/api/session',
      headers: auth(ADMIN),
    })
    assert.equal(admin.json().role, 'admin')
    const wrong = await app.inject({
      url: '/api/session',
      headers: auth('nope'),
    })
    assert.equal(wrong.json().role, 'member')
  })

  it('keeps version updates for admins', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/platform/versions/gitea/update',
      payload: { version: '1.27.3' },
    })
    assert.equal(res.statusCode, 403)
    assert.match(res.json().error, /admin token/)
    const all = await app.inject({
      method: 'POST',
      url: '/api/platform/versions/update-all',
    })
    assert.equal(all.statusCode, 403)
  })

  it('lets the admin token through when the API also needs its own token', async () => {
    assert.equal(
      (await withApiToken.inject({ url: '/api/session' })).statusCode,
      401
    )
    const member = await withApiToken.inject({
      url: '/api/session',
      headers: auth(API),
    })
    assert.equal(member.json().role, 'member')
    const admin = await withApiToken.inject({
      url: '/api/session',
      headers: auth(ADMIN),
    })
    assert.equal(admin.json().role, 'admin')
  })

  it("checks the language against the template's", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/apps',
      payload: {
        name: 'demo',
        team: 'core',
        template: 'python-service',
        language: 'typescript',
        environments: ['dev'],
      },
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error, /comes in python, not typescript/)
  })

  it('lists template languages in the platform info', async () => {
    const info = await app.inject({ url: '/api/platform' })
    const python = info
      .json()
      .templates.find((t: { id: string }) => t.id === 'python-service')
    assert.deepEqual(python.languages, ['python'])
    assert.equal(info.json().runtime, 'compose')
  })
})
