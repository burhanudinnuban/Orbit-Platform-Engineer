import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { loadConfig, ROOT_DIR } from '../src/config/env.js'
import { rulesKey } from '../src/features/observability/observability.alerts.js'

/**
 * docker-compose.yml, the files it mounts and Orbit's defaults (which are the
 * Docker Compose runtime) must agree on names, ports and paths.
 */

const read = (...p: string[]) => readFileSync(path.join(ROOT_DIR, ...p), 'utf8')
/** Resolve ${VAR:-default} the way Compose does when VAR is unset. */
const withDefaults = (s: string) => s.replace(/\$\{[A-Z_]+:-([^}]*)\}/g, '$1')

interface ComposeService {
  image?: string
  environment?: Record<string, string>
  volumes?: string[]
  networks?: Record<string, { aliases?: string[] } | null>
}
const compose = parse(withDefaults(read('docker-compose.yml'))) as {
  services: Record<string, ComposeService>
}
const services = compose.services
const config = loadConfig({})

const hostPort = (url: string) => {
  const u = new URL(url.includes('://') ? url : `http://${url}`)
  // URL drops a port that is the scheme's default.
  return {
    host: u.hostname,
    port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
  }
}

describe('Docker Compose: what pods are told to use', () => {
  it('points GITEA_INTERNAL_URL at the gitea service', () => {
    const { host, port } = hostPort(config.gitea.internalUrl)
    assert.ok(services[host], `no Compose service "${host}"`)
    assert.equal(
      Number(services[host]!.environment?.GITEA__server__HTTP_PORT),
      port
    )
  })

  it('points FLOCI_INTERNAL_URL at the floci service, which answers with that URL', () => {
    const { host, port } = hostPort(config.cloud.internalUrl)
    assert.ok(services[host], `no Compose service "${host}"`)
    assert.equal(port, 4566)
    assert.equal(
      services.floci!.environment?.FLOCI_BASE_URL,
      config.cloud.internalUrl
    )
  })

  it('pushes to the registry service and pulls both names from it', () => {
    const { host, port } = hostPort(config.registry.push)
    assert.ok(services[host], `no Compose service "${host}"`)
    assert.equal(port, 5000)
    const registries = parse(
      read('bootstrap', 'compose', 'k3s', 'registries.yaml')
    ) as { mirrors: Record<string, { endpoint: string[] }> }
    for (const name of [config.registry.pull, config.registry.push])
      assert.deepEqual(registries.mirrors[name]?.endpoint, [
        'http://registry:5000',
      ])
  })

  it('gives pods the dns service as their resolver', () => {
    const dns = services.dns!
    const resolvConf = (
      parse(withDefaults(read('docker-compose.yml'))) as {
        configs: Record<string, { content: string }>
      }
    ).configs['k3s-resolv-conf']!.content
    const fixed = (dns.networks?.default as unknown as { ipv4_address: string })
      .ipv4_address
    assert.equal(resolvConf.trim(), `nameserver ${fixed}`)
  })
})

describe('Docker Compose: alert rules', () => {
  it('mounts the directory Orbit writes into where prometheus.yml reads', () => {
    const mount = services.prometheus!.volumes!.find((v) =>
      v.endsWith(':/etc/prometheus/rules:ro')
    )
    assert.ok(mount, 'prometheus does not mount /etc/prometheus/rules')
    const hostDir = mount.slice(0, mount.indexOf(':/etc/prometheus/rules'))
    assert.equal(path.resolve(ROOT_DIR, hostDir), config.prometheus.rulesDir)

    const prom = parse(
      read('bootstrap', 'compose', 'prometheus', 'prometheus.yml')
    ) as {
      rule_files: string[]
    }
    assert.deepEqual(prom.rule_files, ['/etc/prometheus/rules/*.yaml'])
    assert.ok(rulesKey('payments', 'dev').endsWith('.yaml'))
  })

  it('shares the same host directory with the Orbit container', () => {
    const orbit = services.orbit!
    const target = orbit.environment?.PROMETHEUS_RULES_DIR
    const mount = orbit.volumes!.find((v) => v.endsWith(`:${target}`))
    assert.ok(mount, `orbit does not mount ${target}`)
    const hostDir = mount.slice(0, mount.length - target!.length - 1)
    assert.equal(path.resolve(ROOT_DIR, hostDir), config.prometheus.rulesDir)
  })
})

describe('Docker Compose: edge proxy', () => {
  const dynamic = parse(
    read('bootstrap', 'compose', 'traefik', 'dynamic.yml').replace(
      /\{\{ env "ORBIT_BASE_DOMAIN" \}\}/g,
      config.baseDomain
    )
  ) as {
    http: {
      routers: Record<string, { rule: string; service: string }>
      services: Record<string, { loadBalancer: { servers: { url: string }[] } }>
    }
  }
  const target = (router: { service: string }) =>
    hostPort(
      dynamic.http.services[router.service]!.loadBalancer.servers[0]!.url
    )

  for (const [name, url] of [
    ['Gitea', config.gitea.url],
    ['Grafana', config.grafana.url],
    ['Prometheus', config.prometheus.url],
    ['Floci', config.cloud.url],
  ] as const) {
    it(`routes ${name} (${url}) to a Compose service, from the host and from containers`, () => {
      const { host, port } = hostPort(url)
      assert.equal(port, config.ingressPort)
      const router = Object.values(dynamic.http.routers).find((r) =>
        r.rule.includes(`Host(\`${host}\`)`)
      )
      assert.ok(router, `no edge route for ${host}`)
      assert.ok(
        services[target(router).host],
        `route ${host} → unknown service`
      )
      assert.ok(
        services.traefik!.networks?.default?.aliases?.includes(host),
        `traefik has no network alias ${host}`
      )
    })
  }

  it('sends every other host (the apps) to the in-cluster ingress on k3s', () => {
    const catchAll = dynamic.http.routers.cluster!
    assert.equal(catchAll.rule, 'PathPrefix(`/`)')
    assert.deepEqual(target(catchAll), { host: 'k3s', port: 80 })
  })
})

describe('Docker Compose: k3s setup', () => {
  const setup = read('bootstrap', 'compose', 'k3s', 'setup.sh')

  it('applies manifests that exist', () => {
    const shared = [...setup.matchAll(/\/manifests\/(\S+\.yaml)/g)].map(
      (m) => m[1]!
    )
    const own = [...setup.matchAll(/\/setup\/(\S+\.yaml)/g)].map((m) => m[1]!)
    assert.ok(shared.length >= 3 && own.length >= 1)
    for (const f of shared)
      assert.ok(existsSync(path.join(ROOT_DIR, 'bootstrap', 'manifests', f)), f)
    for (const f of own)
      assert.ok(
        existsSync(path.join(ROOT_DIR, 'bootstrap', 'compose', 'k3s', f)),
        f
      )
  })

  it('names the kube context Orbit is allowed to use', () => {
    assert.match(setup, new RegExp(`: ${config.kube.context}/`))
    assert.deepEqual(config.kube.allowedContexts, [config.kube.context])
    assert.equal(
      services.orbit!.environment?.ORBIT_KUBE_CONTEXT,
      config.kube.context
    )
  })
})
