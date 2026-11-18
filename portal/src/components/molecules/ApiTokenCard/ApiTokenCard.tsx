import { useState, type FormEvent } from 'react'
import { getToken, setToken } from '@/features/auth/auth.session'
import { fetchSessionApi } from '@/features/auth/auth.api'
import { usePoll } from '@/hooks/usePoll'

/**
 * Stores the bearer token this browser sends: the API token (when the API
 * runs with ORBIT_API_TOKEN) or the admin token, which also lets platform
 * admins update versions.
 */
export default function ApiTokenCard() {
  const [value, setValue] = useState(() => getToken() ?? '')
  const [saved, setSaved] = useState(0)
  const session = usePoll(() => fetchSessionApi(), [saved], 0)
  const role = session.data?.role

  const save = (e: FormEvent) => {
    e.preventDefault()
    setToken(value.trim() || null)
    setSaved((n) => n + 1)
  }

  return (
    <section className="card">
      <h2>Access</h2>
      <p className="muted small">
        {role === 'admin' ? (
          <>
            Signed in as a <strong>platform admin</strong>: you can update
            platform versions.
          </>
        ) : (
          <>
            Paste the admin token (
            <span className="mono">ORBIT_ADMIN_TOKEN</span> in{' '}
            <span className="mono">.env</span>) to update platform versions, or
            the API token when the API runs with{' '}
            <span className="mono">ORBIT_API_TOKEN</span>.
          </>
        )}{' '}
        Stored in this browser only.
      </p>
      <form className="inline-form" onSubmit={save}>
        <input
          className="input mono"
          type="password"
          value={value}
          placeholder="Bearer token"
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          aria-label="Access token"
        />
        <button type="submit" className="btn">
          Save
        </button>
      </form>
      {saved > 0 && session.data ? (
        <p className="muted small">
          {role === 'admin'
            ? 'Saved: this browser is admin.'
            : session.data.adminConfigured
              ? 'Saved. This token is not the admin token.'
              : 'Saved. The API has no admin token configured.'}
        </p>
      ) : null}
    </section>
  )
}
