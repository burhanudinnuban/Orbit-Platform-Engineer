import { errorMessage, isOffline } from '@/services/http'

interface ErrorStateProps {
  error: unknown
  onRetry?: () => void
}

/** A failed load. An unreachable API reads as "waiting", not as a failure. */
export default function ErrorState({ error, onRetry }: ErrorStateProps) {
  const offline = isOffline(error)

  return (
    <div
      className={`state state-error ${offline ? 'is-offline' : ''}`}
      role="alert"
    >
      <div>
        <strong>
          {offline ? 'Waiting for the Orbit API' : 'Something went wrong'}
        </strong>
        <div className="muted">{errorMessage(error)}</div>
      </div>
      {onRetry ? (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  )
}
