import type { AppSize, SecurityGate } from './apps.types'

const NAME_RE = /^[a-z]([-a-z0-9]*[a-z0-9])?$/
const TEAM_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

/** Host suffix of app URLs on the local kind cluster, for the preview only. */
export const BASE_DOMAIN = 'localtest.me:8080'

export const SIZES: { id: AppSize; label: string; hint: string }[] = [
  { id: 'small', label: 'Small', hint: '1 CPU · 1Gi quota' },
  { id: 'medium', label: 'Medium', hint: '2 CPU · 4Gi quota' },
  { id: 'large', label: 'Large', hint: '4 CPU · 8Gi quota' },
]

const LANGUAGES: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
}

/** Display name of a template language id (typescript → TypeScript). */
export const languageLabel = (id: string) =>
  LANGUAGES[id] ?? id.charAt(0).toUpperCase() + id.slice(1)

export const GATES: { id: SecurityGate; label: string; hint: string }[] = [
  { id: 'critical', label: 'Critical', hint: 'Block only critical findings' },
  { id: 'high', label: 'High', hint: 'Block high and critical (recommended)' },
  { id: 'medium', label: 'Medium', hint: 'Block medium and above' },
  { id: 'off', label: 'Off', hint: 'Report only, never block' },
]

/** What provisioning does, in order. `<name>` and `<env>` are filled in from the form. */
export const GOLDEN_PATH: { title: string; detail: string }[] = [
  { title: 'Git repository', detail: 'Create apps/<name> from the template' },
  {
    title: 'CI/CD pipeline',
    detail: 'Register the webhook and .orbit/pipeline.yaml',
  },
  {
    title: 'Terraform',
    detail: 'Namespace, quotas, network policies, RBAC, cloud resources',
  },
  { title: 'Kubernetes namespace', detail: 'Verify <name>-<env> is active' },
  { title: 'GitOps application', detail: 'Manifests in platform/gitops' },
  { title: 'Security policy', detail: 'SAST, SCA, secrets, image and DAST' },
  { title: 'Observability', detail: 'Grafana dashboard and Prometheus alerts' },
  { title: 'First pipeline', detail: 'test → build → scan → deploy → DAST' },
]

/** Same rules as the API's CreateAppSchema, so most mistakes never reach it. */
export function validateName(name: string): string | undefined {
  if (!name) return 'Name is required.'
  if (name.length > 30) return 'Use at most 30 characters.'
  if (!NAME_RE.test(name)) {
    return 'Use lowercase letters, digits and dashes. Start with a letter and end with a letter or digit.'
  }
  return undefined
}

export function validateTeam(team: string): string | undefined {
  if (!team) return 'Team is required.'
  if (team.length > 63) return 'Use at most 63 characters.'
  if (!TEAM_RE.test(team)) return 'Use lowercase letters, digits and dashes.'
  return undefined
}
