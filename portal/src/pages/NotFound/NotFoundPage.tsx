import { Link, useLocation } from 'react-router-dom'
import EmptyState from '@/components/molecules/EmptyState/EmptyState'
import { ROUTES } from '@/constants/routes'

export default function NotFoundPage() {
  const location = useLocation()

  return (
    <div className="page">
      <EmptyState
        title="Page not found"
        action={
          <Link className="btn" to={ROUTES.HOME}>
            Back to applications
          </Link>
        }
      >
        Nothing lives at <span className="mono">{location.pathname}</span>.
      </EmptyState>
    </div>
  )
}
