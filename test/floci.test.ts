import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { loadConfig } from '../src/config/env.js'
import { Floci } from '../src/services/floci.js'

/** Tiny HTTP server answering each path with a fixed status and body. */
function serve(
  routes: Record<string, [number, string]>
): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const [status, body] = routes[req.url ?? ''] ?? [
      404,
      '<html>404 Not Found</html>',
    ]
    res.writeHead(status, {
      'content-type': body.startsWith('{') ? 'application/json' : 'text/html',
    })
    res.end(body)
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      })
    )
  )
}

const flociAt = (url: string) => new Floci(loadConfig({ FLOCI_URL: url }))

describe('Floci health', () => {
  const servers: Server[] = []
  const start = async (routes: Record<string, [number, string]>) => {
    const s = await serve(routes)
    servers.push(s.server)
    return s.url
  }
  after(() => servers.forEach((s) => s.close()))

  it('reports the version from /_floci/health', async () => {
    const url = await start({
      '/_floci/health': [
        200,
        '{"version":"2.4.0","services":{"s3":"running","sqs":"running"}}',
      ],
    })
    assert.equal(
      await flociAt(url).health(),
      `Floci 2.4.0 · 2 services · ${url}`
    )
  })

  it('falls back to the LocalStack-compatible path', async () => {
    const url = await start({
      '/_localstack/health': [200, '{"version":"2.3.0"}'],
    })
    assert.equal(await flociAt(url).health(), `Floci 2.3.0 · ${url}`)
  })

  it('does not mistake another server on the same port for Floci', async () => {
    const url = await start({})
    await assert.rejects(flociAt(url).health(), /no Floci at .*404/)
  })

  it('fails when nothing listens', async () => {
    await assert.rejects(
      flociAt('http://127.0.0.1:9').health(),
      /no Floci at .*unreachable/
    )
  })

  it('is not used unless ORBIT_CLOUD is floci', async () => {
    await assert.rejects(
      new Floci(loadConfig({ ORBIT_CLOUD: 'aws' })).health(),
      /not floci/
    )
  })
})
