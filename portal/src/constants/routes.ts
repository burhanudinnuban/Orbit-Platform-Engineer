export const ROUTES = {
  HOME: '/',
  NEW_APP: '/new',
  APP: '/apps/:name',
  PLATFORM: '/platform',
  VERSIONS: '/platform/versions',
} as const

/** The address of one application's page. */
export const appPath = (name: string) => `/apps/${encodeURIComponent(name)}`
