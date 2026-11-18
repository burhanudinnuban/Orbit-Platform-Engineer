import { useLayoutEffect, useMemo, useRef } from 'react'
import { stripAnsi } from '@/lib/format'

interface LogViewProps {
  text: string | undefined
  maxHeight?: number
  emptyText?: string
}

/**
 * Monospace log viewer. Sticks to the bottom while new output arrives, unless the
 * reader has scrolled up to look at something.
 */
export default function LogView({
  text,
  maxHeight = 380,
  emptyText = 'No output yet.',
}: LogViewProps) {
  const ref = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  const clean = useMemo(() => (text ? stripAnsi(text) : ''), [text])

  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [clean])

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32
  }

  return (
    <pre
      ref={ref}
      className="log"
      style={{ maxHeight }}
      onScroll={onScroll}
      tabIndex={0}
    >
      {clean || <span className="log-empty">{emptyText}</span>}
    </pre>
  )
}
