import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type * as k8s from '@kubernetes/client-node'
import { Store } from '../src/app/store.js'
import {
  DEFAULT_CI_IMAGES,
  loadConfig,
  usableSecret,
} from '../src/config/env.js'
import { startingImage } from '../src/services/jobs.js'
import {
  COMPONENTS,
  componentsFor,
} from '../src/features/versions/versions.catalog.js'
import {
  OVERRIDE_FILE,
  overrideImages,
  parsePs,
  setOverrideImages,
} from '../src/features/versions/versions.compose.js'
import { applyImageOverrides } from '../src/features/versions/versions.overrides.js'
import { listTags } from '../src/features/versions/versions.registry.js'
import {
  canonicalImage,
  parseImage,
  upgrades,
} from '../src/features/versions/versions.semver.js'

const def = (id: string) => COMPONENTS.find((c) => c.id === id)!

describe('image references', () => {
  it('splits registry, repository and tag the way Docker does', () => {
    assert.deepEqual(parseImage('busybox:1.36'), {
      registry: 'docker.io',
      repository: 'library/busybox',
      tag: '1.36',
      name: 'busybox',
    })
    assert.deepEqual(parseImage('ghcr.io/zaproxy/zaproxy:2.15.0'), {
      registry: 'ghcr.io',
      repository: 'zaproxy/zaproxy',
      tag: '2.15.0',
      name: 'ghcr.io/zaproxy/zaproxy',
    })
    assert.equal(
      parseImage('localhost:5001/app:abc').registry,
      'localhost:5001'
    )
    assert.equal(parseImage('rancher/k3s').tag, 'latest')
    assert.equal(
      canonicalImage('registry:2.8.3'),
      'docker.io/library/registry:2.8.3'
    )
  })
})

describe('newer versions', () => {
  it('recommends the newest release of the same major and flags majors', () => {
    const up = upgrades(
      'prom/prometheus:v2.54.1',
      [
        'v2.54.1',
        'v2.55.0',
        'v2.55.1',
        'v3.0.0',
        'v3.1.0-rc.0',
        'main',
        'latest',
      ],
      def('prometheus')
    )
    assert.equal(up.recommended, 'v2.55.1')
    assert.equal(up.latest, 'v3.0.0')
    assert.deepEqual(
      up.candidates.map((c) => [c.version, c.major]),
      [
        ['v3.0.0', true],
        ['v2.55.1', false],
        ['v2.55.0', false],
      ]
    )
    assert.equal(up.candidates[1]!.image, 'prom/prometheus:v2.55.1')
  })

  it('moves Kubernetes one minor version at a time', () => {
    const up = upgrades(
      'rancher/k3s:v1.31.4-k3s1',
      ['v1.31.5-k3s1', 'v1.32.13-k3s1', 'v1.33.2-k3s1', 'v1.32.1-rc1-k3s1'],
      def('k3s')
    )
    assert.equal(up.recommended, 'v1.32.13-k3s1')
    assert.equal(up.latest, 'v1.33.2-k3s1')
    assert.equal(
      up.candidates.find((c) => c.version === 'v1.33.2-k3s1')?.major,
      true
    )
  })

  it('keeps the shape of the current tag', () => {
    // alpine/git publishes both 2.x.y and v2.x.y; busybox:1.36 is a floating tag.
    assert.equal(
      upgrades('alpine/git:2.45.2', ['v2.54.1', '2.54.1', '2.47.0'], def('git'))
        .recommended,
      '2.54.1'
    )
    assert.deepEqual(
      upgrades(
        'busybox:1.36',
        ['1.36.1', '1.37', '1.37.0', '1.38'],
        def('busybox')
      ).candidates.map((c) => c.version),
      ['1.38', '1.37']
    )
  })

  it('offers nothing for a tag that is not a release', () => {
    assert.deepEqual(
      upgrades('gitea/gitea:latest', ['1.22.3'], def('gitea')).candidates,
      []
    )
  })
})

describe('registries', () => {
  const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init,
    })

  it('reads Docker Hub tags from its API, page by page', async () => {
    const urls: string[] = []
    const fake = (async (url: string) => {
      urls.push(url)
      return url.includes('page=2')
        ? json({ next: null, results: [{ name: '1.0.0' }] })
        : json({
            next: 'https://hub.docker.com/v2/namespaces/library/repositories/registry/tags?page=2',
            results: [{ name: '3.0.0' }, { name: 'latest' }],
          })
    }) as unknown as typeof fetch
    assert.deepEqual(await listTags('registry:2.8.3', fake), [
      '3.0.0',
      'latest',
      '1.0.0',
    ])
    assert.match(
      urls[0]!,
      /namespaces\/library\/repositories\/registry\/tags\?page_size=100&ordering=last_updated/
    )
  })

  it('gets an anonymous token when an OCI registry asks for one', async () => {
    const seen: { url: string; auth?: string }[] = []
    const fake = (async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization
      seen.push({ url, auth })
      if (url.startsWith('https://ghcr.io/token'))
        return json({ token: 't0ken' })
      if (!auth)
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:zaproxy/zaproxy:pull"',
          },
        })
      if (url.includes('last=b')) return json({ tags: ['c'] })
      return json(
        { tags: ['a', 'b'] },
        {
          headers: {
            link: '</v2/zaproxy/zaproxy/tags/list?n=1000&last=b>; rel="next"',
          },
        }
      )
    }) as unknown as typeof fetch
    assert.deepEqual(await listTags('ghcr.io/zaproxy/zaproxy:2.15.0', fake), [
      'a',
      'b',
      'c',
    ])
    const token = new URL(seen.find((s) => s.url.includes('/token'))!.url)
    assert.equal(
      token.searchParams.get('scope'),
      'repository:zaproxy/zaproxy:pull'
    )
    assert.equal(token.searchParams.get('service'), 'ghcr.io')
    assert.equal(seen.at(-1)!.auth, 'Bearer t0ken')
  })
})

describe('docker-compose.override.yml', () => {
  const project = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orbit-versions-'))
    writeFileSync(
      path.join(dir, 'docker-compose.yml'),
      'services:\n  gitea:\n    image: gitea/gitea:1.22.3\n  k3s:\n    image: rancher/k3s:v1.31.4-k3s1\n  k3s-setup:\n    image: rancher/k3s:v1.31.4-k3s1\n'
    )
    return dir
  }

  it('sets images, drops defaults and deletes the file once empty', async () => {
    const dir = project()
    try {
      await setOverrideImages(dir, { gitea: 'gitea/gitea:1.27.3' })
      const text = readFileSync(path.join(dir, OVERRIDE_FILE), 'utf8')
      assert.match(text, /^# Image versions chosen in the Orbit portal/)
      assert.deepEqual(
        [...overrideImages(dir)],
        [['gitea', 'gitea/gitea:1.27.3']]
      )

      await setOverrideImages(dir, { gitea: 'gitea/gitea:1.22.3' })
      assert.equal(existsSync(path.join(dir, OVERRIDE_FILE)), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps what people put in the file themselves', async () => {
    const dir = project()
    try {
      writeFileSync(
        path.join(dir, OVERRIDE_FILE),
        '# mine\nservices:\n  gitea:\n    environment:\n      GITEA__log__LEVEL: debug\n'
      )
      await setOverrideImages(dir, {
        k3s: 'rancher/k3s:v1.32.13-k3s1',
        'k3s-setup': 'rancher/k3s:v1.32.13-k3s1',
      })
      await setOverrideImages(dir, { k3s: undefined, 'k3s-setup': undefined })
      const text = readFileSync(path.join(dir, OVERRIDE_FILE), 'utf8')
      assert.match(text, /# mine/)
      assert.match(text, /GITEA__log__LEVEL: debug/)
      assert.doesNotMatch(text, /k3s/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads docker compose ps in both output formats', () => {
    const row = {
      Service: 'gitea',
      Image: 'gitea/gitea:1.22.3',
      State: 'running',
      Health: 'healthy',
    }
    const expected = [
      {
        service: 'gitea',
        image: 'gitea/gitea:1.22.3',
        state: 'running',
        health: 'healthy',
      },
    ]
    assert.deepEqual(parsePs(`${JSON.stringify(row)}\n`), expected)
    assert.deepEqual(parsePs(JSON.stringify([row])), expected)
    assert.deepEqual(parsePs(''), [])
  })
})

describe('component catalog', () => {
  it('lists Compose services on compose and orbit-system Deployments on kind', () => {
    const compose = componentsFor('compose').map((c) => c.id)
    const kind = componentsFor('kind').map((c) => c.id)
    assert.ok(compose.includes('k3s') && compose.includes('edge-proxy'))
    assert.ok(!kind.includes('k3s') && !kind.includes('edge-proxy'))
    for (const id of [
      'gitea',
      'prometheus',
      'grafana',
      'floci',
      'ingress',
      'trivy',
    ])
      assert.ok(kind.includes(id), `kind has ${id}`)
  })

  it('has every CI image, and the defaults match docker-compose.yml', () => {
    const keys = COMPONENTS.flatMap((c) => (c.ci ? [c.ci.key] : [])).sort()
    assert.deepEqual(keys, Object.keys(DEFAULT_CI_IMAGES).sort())
    const compose = readFileSync('docker-compose.yml', 'utf8')
    for (const c of COMPONENTS)
      for (const service of c.compose ?? [])
        assert.match(
          compose,
          new RegExp(`\\n  ${service}:\\n(?:    .*\\n)*?    image: `),
          service
        )
  })

  it('pulls ZAP from Docker Hub by default', () => {
    assert.equal(parseImage(DEFAULT_CI_IMAGES.zap).registry, 'docker.io')
  })
})

describe('admin-chosen CI images', () => {
  it('apply over .env, and keep the previous image for a rollback', () => {
    const store = new Store(':memory:')
    const config = loadConfig({ ORBIT_IMAGE_TRIVY: 'aquasec/trivy:0.60.0' })
    assert.equal(config.images.trivy, 'aquasec/trivy:0.60.0')
    store.setVersionOverride(
      'trivy',
      'aquasec/trivy:0.76.2',
      'aquasec/trivy:0.60.0'
    )
    applyImageOverrides(config, store)
    assert.equal(config.images.trivy, 'aquasec/trivy:0.76.2')
    assert.equal(
      store.versionOverrides().get('trivy')?.previousImage,
      'aquasec/trivy:0.60.0'
    )
    store.close()
  })

  it('fail updates interrupted by a restart', () => {
    const store = new Store(':memory:')
    const u = store.createPlatformUpdate({
      component: 'gitea',
      kind: 'update',
      toImage: 'gitea/gitea:1.27.3',
    })
    store.setPlatformUpdateStatus(u.id, 'running')
    assert.equal(store.recoverInterruptedPlatformUpdates(), 1)
    const after = store.getPlatformUpdate(u.id)!
    assert.equal(after.status, 'failed')
    assert.ok(after.startedAt && after.finishedAt)
    store.close()
  })
})

describe('admin token', () => {
  it('ignores placeholders and short values', () => {
    assert.equal(usableSecret('change-me-random-hex'), '')
    assert.equal(usableSecret('short'), '')
    assert.equal(usableSecret(' 0123456789abcdef0123 '), '0123456789abcdef0123')
    assert.equal(
      loadConfig({ ORBIT_ADMIN_TOKEN: 'change-me-random-hex' }).adminToken,
      ''
    )
  })
})

describe('image pulls in CI jobs', () => {
  const pod = (statuses: k8s.V1ContainerStatus[]): k8s.V1Pod => ({
    spec: {
      initContainers: [
        { name: 'prepare', image: 'busybox:1.36' },
        { name: 'zap', image: 'zaproxy/zap-stable:2.17.0' },
      ],
      containers: [{ name: 'dump', image: 'busybox:1.36' }],
    },
    status: { initContainerStatuses: statuses },
  })
  const done = (name: string): k8s.V1ContainerStatus => ({
    name,
    image: '',
    imageID: '',
    ready: false,
    restartCount: 0,
    state: { terminated: { exitCode: 0 } },
  })
  const waiting = (name: string, reason: string): k8s.V1ContainerStatus => ({
    name,
    image: '',
    imageID: '',
    ready: false,
    restartCount: 0,
    state: { waiting: { reason } },
  })

  it('names the image the pod waits for, so the wait is not counted as run time', () => {
    assert.equal(
      startingImage(pod([done('prepare'), waiting('zap', 'PodInitializing')])),
      'zaproxy/zap-stable:2.17.0'
    )
    const running = pod([done('prepare')])
    running.status!.initContainerStatuses!.push({
      ...waiting('zap', ''),
      state: { running: {} },
    })
    assert.equal(startingImage(running), undefined)
    assert.equal(
      startingImage(pod([done('prepare'), waiting('zap', 'ErrImagePull')])),
      undefined
    )
  })
})
