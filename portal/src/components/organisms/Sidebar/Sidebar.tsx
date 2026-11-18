import { Link, NavLink, useLocation } from 'react-router-dom'
import NavIcon from '@/components/atoms/NavIcon/NavIcon'
import OrbitLogo from '@/components/atoms/OrbitLogo/OrbitLogo'
import { ROUTES } from '@/constants/routes'
import type { PlatformInfo } from '@/features/platform/platform.types'

interface SidebarProps {
  /** Latest platform answer; undefined while connecting or when the API is down. */
  platform: PlatformInfo | undefined
  offline: boolean
}

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `nav-link ${isActive ? 'active' : ''}`

export default function Sidebar({ platform, offline }: SidebarProps) {
  const location = useLocation()
  // An app's own page is still "Apps" in the navigation.
  const appsActive =
    location.pathname === ROUTES.HOME || location.pathname.startsWith('/apps/')

  return (
    <aside className="sidebar">
      <Link to={ROUTES.HOME} className="brand">
        <OrbitLogo />
        <span>Orbit</span>
      </Link>
      <nav className="nav" aria-label="Main">
        <NavLink
          to={ROUTES.HOME}
          className={() => linkClass({ isActive: appsActive })}
          end
        >
          <NavIcon d="M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z" />
          <span>Apps</span>
        </NavLink>
        <NavLink to={ROUTES.NEW_APP} className={linkClass}>
          <NavIcon d="M10 4v12M4 10h12" />
          <span>Create</span>
        </NavLink>
        <NavLink to={ROUTES.PLATFORM} className={linkClass} end>
          <NavIcon d="M10 2.5l7 4v7l-7 4-7-4v-7zM10 10l7-3.5M10 10v7.5M10 10L3 6.5" />
          <span>Platform</span>
        </NavLink>
        <NavLink to={ROUTES.VERSIONS} className={linkClass}>
          <NavIcon d="M4 13l4-4 3 3 5-6M12 6h4v4" />
          <span>Versions</span>
        </NavLink>
      </nav>
      <div className="sidebar-foot">
        <span
          className={`api-dot ${platform ? 'ok' : offline ? 'down' : 'unknown'}`}
          aria-hidden="true"
        />
        <span className="small">
          {platform ? (
            <>
              API online
              <br />
              <span className="muted mono">{platform.kubeContext}</span>
            </>
          ) : offline ? (
            'API offline'
          ) : (
            'Connecting…'
          )}
        </span>
      </div>
    </aside>
  )
}
