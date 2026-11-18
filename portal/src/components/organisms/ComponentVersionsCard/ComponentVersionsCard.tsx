import ComponentVersionRow from '@/components/molecules/ComponentVersionRow/ComponentVersionRow'
import type { ComponentVersion } from '@/features/versions/versions.types'

interface ComponentVersionsCardProps {
  title: string
  hint: string
  components: ComponentVersion[]
  isAdmin: boolean
  busyId: string | undefined
  onUpdate: (id: string, version: string) => void
  onRollback: (id: string) => void
}

/** One group of platform components (runtime, services, CI tools) as a table. */
export default function ComponentVersionsCard({
  title,
  hint,
  components,
  isAdmin,
  busyId,
  onUpdate,
  onRollback,
}: ComponentVersionsCardProps) {
  if (components.length === 0) return null

  return (
    <section className="card">
      <h2>{title}</h2>
      <p className="muted small">{hint}</p>
      <div className="table-wrap">
        <table className="table versions-table">
          <thead>
            <tr>
              <th>Component</th>
              <th>Current</th>
              <th>Available</th>
              <th>{isAdmin ? 'Update' : ''}</th>
            </tr>
          </thead>
          <tbody>
            {components.map((c) => (
              <ComponentVersionRow
                key={c.id}
                component={c}
                isAdmin={isAdmin}
                busy={busyId === c.id}
                onUpdate={onUpdate}
                onRollback={onRollback}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
