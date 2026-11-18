import { Outlet } from 'react-router-dom'
import Sidebar from '@/components/organisms/Sidebar/Sidebar'
import { fetchPlatformApi } from '@/features/platform/platform.api'
import { usePoll } from '@/hooks/usePoll'
import { isOffline, OFFLINE_MESSAGE } from '@/services/http'

/**
 * The console frame: sidebar on the left, the routed page on the right.
 *
 * Polls the platform every 15 seconds for the sidebar's API indicator, and
 * shows a banner over every page while the API cannot be reached.
 */
export default function AppShell() {
  const platform = usePoll(() => fetchPlatformApi(), [], 15000)
  const offline = isOffline(platform.error)

  return (
    <div className="shell">
      <Sidebar platform={platform.data} offline={offline} />
      <main className="main">
        {offline ? (
          <div className="banner banner-error" role="alert">
            {/* Backticked parts of the message render as code. */}
            {OFFLINE_MESSAGE.split('`').map((part, i) =>
              i % 2 ? <code key={i}>{part}</code> : part
            )}
          </div>
        ) : null}
        <Outlet />
      </main>
    </div>
  )
}
