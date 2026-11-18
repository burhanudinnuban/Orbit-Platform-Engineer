import { Link } from 'react-router-dom'
import CreateAppForm from '@/components/organisms/CreateAppForm/CreateAppForm'
import { ROUTES } from '@/constants/routes'

export default function NewAppPage() {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <Link to={ROUTES.HOME} className="crumb">
            ← Applications
          </Link>
          <h1>Create application</h1>
          <p className="muted">
            One form. Orbit runs the golden path from repository to observed
            deployment.
          </p>
        </div>
      </header>

      <CreateAppForm />
    </div>
  )
}
