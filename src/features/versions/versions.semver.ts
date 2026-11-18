import type { VersionCandidate } from '../../types/contract.js'

export interface ImageRef {
  /** Registry host: docker.io, ghcr.io, localhost:5001... */
  registry: string
  /** Repository path in that registry; Docker Hub official images get library/. */
  repository: string
  tag: string
  /** The image as written, without its tag (keeps the original style when the tag changes). */
  name: string
}

/** An OCI tag: what Orbit accepts as a version. */
export const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/

export function parseImage(image: string): ImageRef {
  const at = image.indexOf('@')
  const ref = at >= 0 ? image.slice(0, at) : image
  const slash = ref.lastIndexOf('/')
  const colon = ref.lastIndexOf(':')
  const hasTag = colon > slash
  const name = hasTag ? ref.slice(0, colon) : ref
  const tag = hasTag ? ref.slice(colon + 1) : 'latest'
  const [first, ...rest] = name.split('/')
  const isRegistry =
    rest.length > 0 &&
    (first!.includes('.') || first!.includes(':') || first === 'localhost')
  const registry = isRegistry ? first! : 'docker.io'
  let repository = isRegistry ? rest.join('/') : name
  if (registry === 'docker.io' && !repository.includes('/'))
    repository = `library/${repository}`
  return { registry, repository, tag, name }
}

export const withTag = (image: string, tag: string) =>
  `${parseImage(image).name}:${tag}`

/** The fully qualified name the kubelet reports, such as docker.io/library/busybox:1.36. */
export const canonicalImage = (image: string) => {
  const { registry, repository, tag } = parseImage(image)
  return `${registry}/${repository}:${tag}`
}

/**
 * The numeric parts of a tag, or undefined when the tag is not a release of
 * this component (latest, rc, -rootless, sha-...). The pattern's capture
 * groups are the parts; an optional group that did not match is left out.
 */
export function parseVersion(
  tag: string,
  pattern: RegExp
): number[] | undefined {
  const m = pattern.exec(tag)
  if (!m) return undefined
  return m
    .slice(1)
    .filter((p): p is string => p !== undefined)
    .map(Number)
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export interface UpgradePolicy {
  /** Pattern of release tags, one capture group per numeric part. */
  tags: RegExp
  /**
   * How many minor versions one update may move (Kubernetes supports one at a
   * time). Further ones count as major.
   */
  minorStep?: number
}

export interface Upgrades {
  /** Newer releases, newest first, at most `limit`. */
  candidates: VersionCandidate[]
  latest?: string
  /** Newest candidate that is not major. */
  recommended?: string
}

/** The tag with its numbers blanked: 1.36 → N.N, v2.54.1 → vN.N.N. */
const shape = (tag: string) => tag.replace(/\d+/g, 'N')

/**
 * Newer releases of `image` among `tags`, keeping the shape of the current
 * tag: busybox:1.36 (a floating tag) is only compared with other two-part
 * tags, and alpine/git:2.45.2 with 2.x.y, not with the v2.x.y it also has.
 */
export function upgrades(
  image: string,
  tags: string[],
  policy: UpgradePolicy,
  limit = 10
): Upgrades {
  const tag = parseImage(image).tag
  const current = parseVersion(tag, policy.tags)
  if (!current) return { candidates: [] }
  const newer = tags
    .filter((t) => shape(t) === shape(tag))
    .map((t) => ({ tag: t, v: parseVersion(t, policy.tags) }))
    .filter(
      (t): t is { tag: string; v: number[] } =>
        t.v !== undefined && compareVersions(t.v, current) > 0
    )
    .sort((a, b) => compareVersions(b.v, a.v))
  const seen = new Set<string>()
  const candidates: VersionCandidate[] = []
  for (const { tag, v } of newer) {
    if (seen.has(tag)) continue
    seen.add(tag)
    const major =
      v[0] !== current[0] ||
      (policy.minorStep !== undefined &&
        (v[1] ?? 0) - (current[1] ?? 0) > policy.minorStep)
    candidates.push({ version: tag, image: withTag(image, tag), major })
  }
  return {
    candidates: candidates.slice(0, limit),
    latest: candidates[0]?.version,
    recommended: candidates.find((c) => !c.major)?.version,
  }
}
