import { Route, Routes } from 'react-router-dom'
import AppShell from '@/components/templates/AppShell/AppShell'
import { ROUTES } from '@/constants/routes'
import AppPage from '@/pages/Apps/AppPage'
import AppsPage from '@/pages/Apps/AppsPage'
import NewAppPage from '@/pages/Apps/NewAppPage'
import NotFoundPage from '@/pages/NotFound/NotFoundPage'
import PlatformPage from '@/pages/Platform/PlatformPage'
import VersionsPage from '@/pages/Platform/VersionsPage'

/**
 * Every page renders inside AppShell (sidebar + API status banner).
 *
 * Nothing is lazy: the whole console is a few hundred kB, and every page is
 * one click from every other, so splitting would only add loading flashes.
 */
export default function AppRouter() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path={ROUTES.HOME} element={<AppsPage />} />
        <Route path={ROUTES.NEW_APP} element={<NewAppPage />} />
        <Route path={ROUTES.APP} element={<AppPage />} />
        <Route path={ROUTES.PLATFORM} element={<PlatformPage />} />
        <Route path={ROUTES.VERSIONS} element={<VersionsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
