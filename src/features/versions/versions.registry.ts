import { parseImage, type ImageRef } from './versions.semver.js'

const TIMEOUT_MS = 15_000
const HUB_PAGES = 3
const OCI_PAGES = 10

type Fetch = typeof fetch

async function getJson<T>(
  fetchFn: Fetch,
  url: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body?: T; headers: Headers }> {
  const res = await fetchFn(url, {
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    await res.body?.cancel()
    return { status: res.status, headers: res.headers }
  }
  return {
    status: res.status,
    body: (await res.json()) as T,
    headers: res.headers,
  }
}

/**
 * Docker Hub's own API: the most recently pushed tags first, which is where
 * new releases are. The registry API would return every tag ever pushed
 * (thousands for some images) in one response.
 */
async function hubTags(fetchFn: Fetch, ref: ImageRef): Promise<string[]> {
  const [namespace, ...rest] = ref.repository.split('/')
  let url: string | undefined =
    `https://hub.docker.com/v2/namespaces/${namespace}/repositories/${rest.join('/')}/tags?page_size=100&ordering=last_updated`
  const tags: string[] = []
  for (let page = 0; url && page < HUB_PAGES; page++) {
    const res: {
      status: number
      body?: { next?: string | null; results?: { name: string }[] }
    } = await getJson(fetchFn, url)
    if (!res.body)
      throw new Error(`Docker Hub answered HTTP ${res.status} for ${ref.name}`)
    tags.push(...(res.body.results ?? []).map((r) => r.name))
    url = res.body.next ?? undefined
  }
  return tags
}

/** Parse `Bearer realm="...",service="...",scope="..."`. */
function bearerChallenge(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header?.toLowerCase().startsWith('bearer ')) return out
  for (const m of header.slice(7).matchAll(/(\w+)="([^"]*)"/g))
    out[m[1]!] = m[2]!
  return out
}

/** The OCI distribution API, with an anonymous pull token when the registry asks for one. */
async function ociTags(fetchFn: Fetch, ref: ImageRef): Promise<string[]> {
  const base = `https://${ref.registry}`
  let url: string | undefined = `${base}/v2/${ref.repository}/tags/list?n=1000`
  let auth: Record<string, string> = {}
  const tags: string[] = []
  for (let page = 0; url && page < OCI_PAGES; page++) {
    let res: {
      status: number
      body?: { tags?: string[] | null }
      headers: Headers
    } = await getJson(fetchFn, url, auth)
    if (res.status === 401 && !auth.Authorization) {
      const c = bearerChallenge(res.headers.get('www-authenticate'))
      if (!c.realm)
        throw new Error(
          `${ref.registry} asked for credentials Orbit does not have`
        )
      const tokenUrl = new URL(c.realm)
      if (c.service) tokenUrl.searchParams.set('service', c.service)
      tokenUrl.searchParams.set(
        'scope',
        c.scope ?? `repository:${ref.repository}:pull`
      )
      const token = await getJson<{ token?: string; access_token?: string }>(
        fetchFn,
        tokenUrl.toString()
      )
      const value = token.body?.token ?? token.body?.access_token
      if (!value)
        throw new Error(
          `${ref.registry} refused an anonymous token (HTTP ${token.status})`
        )
      auth = { Authorization: `Bearer ${value}` }
      res = await getJson(fetchFn, url, auth)
    }
    if (!res.body)
      throw new Error(
        `${ref.registry} answered HTTP ${res.status} for ${ref.name}`
      )
    tags.push(...(res.body.tags ?? []))
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')
    url = next ? new URL(next[1]!, base).toString() : undefined
  }
  return tags
}

/** Tags of an image's repository, from whichever registry hosts it. */
export async function listTags(
  image: string,
  fetchFn: Fetch = fetch
): Promise<string[]> {
  const ref = parseImage(image)
  return ref.registry === 'docker.io'
    ? hubTags(fetchFn, ref)
    : ociTags(fetchFn, ref)
}
