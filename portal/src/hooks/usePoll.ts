import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

export interface PollState<T> {
  data: T | undefined
  error: Error | undefined
  /** True until the first response (success or failure) for the current deps arrives. */
  loading: boolean
  /** Fetch immediately, outside the polling schedule. */
  refresh: () => Promise<void>
}

/**
 * Calls `fn` now and then every `intervalMs` (0 = load once). Polling pauses while the tab is hidden
 * and resumes immediately when it becomes visible. Changing `deps` resets the state and restarts.
 * Responses that arrive after `deps` changed are ignored.
 */
export function usePoll<T>(
  fn: () => Promise<T>,
  deps: readonly unknown[],
  intervalMs = 3000
): PollState<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<Error | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  // The latest `fn`, read by the poll loop without restarting it every render.
  // A layout effect runs before the poll effect below, so the loop never sees a stale one.
  const fnRef = useRef(fn)
  useLayoutEffect(() => {
    fnRef.current = fn
  })
  const generation = useRef(0)

  const load = useCallback(async (gen: number) => {
    try {
      const result = await fnRef.current()
      if (gen !== generation.current) return
      setData(result)
      setError(undefined)
    } catch (err) {
      if (gen !== generation.current) return
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      if (gen === generation.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    /*
     * The reset has to happen here, in the same step as the generation bump.
     * Done during render instead, an answer for the previous deps that lands
     * between that render and this effect would still match the old
     * generation, and the page would show the previous resource as current.
     */
    const gen = ++generation.current
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setData(undefined)
    setError(undefined)
    setLoading(true)

    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    let disposed = false

    const run = async () => {
      if (disposed || running) return
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      running = true
      try {
        if (!document.hidden) await load(gen)
      } finally {
        running = false
      }
      if (!disposed && intervalMs > 0)
        timer = setTimeout(() => void run(), intervalMs)
    }

    const onVisibility = () => {
      if (!document.hidden) void run()
    }

    void run()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs, load])

  const refresh = useCallback(() => load(generation.current), [load])

  return { data, error, loading, refresh }
}
