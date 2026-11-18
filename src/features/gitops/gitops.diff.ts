const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const scalarEqual = (a: unknown, b: unknown) =>
  a === b || (a !== null && b !== null && String(a) === String(b))

/** Arrays of named objects (containers, env, ports, volumes) are matched by name. */
const namedItems = (arr: unknown[]) =>
  arr.length > 0 && arr.every((x) => isObject(x) && typeof x.name === 'string')

/**
 * Compare the fields Orbit declares (desired) with the live object.
 * Only fields present in `desired` are compared, so defaults and fields owned
 * by other controllers don't count as drift. Returns the drifted paths.
 */
export function diffObject(
  desired: unknown,
  live: unknown,
  path = ''
): string[] {
  if (isObject(desired)) {
    if (!isObject(live)) return [path || '.']
    const drift: string[] = []
    for (const [key, value] of Object.entries(desired)) {
      if (!path && key === 'status') continue
      drift.push(...diffObject(value, live[key], path ? `${path}.${key}` : key))
    }
    return drift
  }
  if (Array.isArray(desired)) {
    if (!Array.isArray(live))
      return desired.length === 0 && live === undefined ? [] : [path]
    if (namedItems(desired)) {
      const drift: string[] = []
      for (const item of desired as Record<string, unknown>[]) {
        const match = live.find((l) => isObject(l) && l.name === item.name)
        if (!match) drift.push(`${path}[${String(item.name)}]`)
        else
          drift.push(
            ...diffObject(item, match, `${path}[${String(item.name)}]`)
          )
      }
      return drift
    }
    if (desired.length !== live.length) return [path]
    return desired.flatMap((item, i) =>
      diffObject(item, live[i], `${path}[${i}]`)
    )
  }
  if (desired === null || desired === undefined) return []
  return scalarEqual(desired, live) ? [] : [path]
}
