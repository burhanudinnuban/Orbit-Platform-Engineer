import LogView from '@/components/molecules/LogView/LogView'
import { fetchPlatformUpdateApi } from '@/features/versions/versions.api'
import type { PlatformUpdate } from '@/features/versions/versions.types'
import { usePoll } from '@/hooks/usePoll'

interface PlatformUpdateLogProps {
  update: PlatformUpdate
}

/** The full log of one platform update, refreshed while it runs. */
export default function PlatformUpdateLog({ update }: PlatformUpdateLogProps) {
  const live = update.status === 'queued' || update.status === 'running'
  const { data } = usePoll(
    () => fetchPlatformUpdateApi(update.id),
    [update.id, live],
    live ? 3000 : 0
  )
  const current = data ?? update

  return (
    <>
      {current.error ? (
        <div className="banner banner-error">{current.error}</div>
      ) : null}
      <LogView
        text={current.logs}
        emptyText={live ? 'Waiting to start…' : 'No output.'}
      />
    </>
  )
}
