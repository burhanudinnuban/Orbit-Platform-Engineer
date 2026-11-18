import SeverityPill from '@/components/atoms/SeverityPill/SeverityPill'
import { CATEGORIES } from '@/features/security/security.severity'
import type { Finding } from '@/features/security/security.types'
import { relativeTime } from '@/lib/format'

interface FindingRowProps {
  finding: Finding
}

export default function FindingRow({ finding: f }: FindingRowProps) {
  const category =
    CATEGORIES.find((c) => c.id === f.category)?.label ?? f.category

  return (
    <tr>
      <td>
        <SeverityPill severity={f.severity} />
      </td>
      <td className="nowrap">
        <span className="tag">{f.tool}</span>{' '}
        <span className="muted small">{category}</span>
      </td>
      <td className="finding-title" title={f.description ?? f.title}>
        {f.title}
      </td>
      <td className="mono small break">{f.location ?? '—'}</td>
      <td className="mono small break">{f.ruleId}</td>
      <td className="muted small nowrap">{relativeTime(f.createdAt)}</td>
    </tr>
  )
}
