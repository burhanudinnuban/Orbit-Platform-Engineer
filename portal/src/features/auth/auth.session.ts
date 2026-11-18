/** localStorage key of the API token, needed only when the API runs with ORBIT_API_TOKEN. */
export const TOKEN_KEY = 'orbit.token'

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token)
    else window.localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Storage unavailable (private mode, blocked cookies): the token just won't persist.
  }
}
