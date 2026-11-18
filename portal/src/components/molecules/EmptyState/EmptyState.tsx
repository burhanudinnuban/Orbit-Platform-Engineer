import type { ReactNode } from 'react'

interface EmptyStateProps {
  title: string
  children?: ReactNode
  action?: ReactNode
}

export default function EmptyState({
  title,
  children,
  action,
}: EmptyStateProps) {
  return (
    <div className="state state-empty">
      <div className="empty-orbit" aria-hidden="true">
        <span />
      </div>
      <strong>{title}</strong>
      {children ? <div className="muted">{children}</div> : null}
      {action ? <div className="state-action">{action}</div> : null}
    </div>
  )
}
