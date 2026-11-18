import { z } from 'zod'
import { DNS_LABEL } from '../../lib/util.js'

/** Names an app may not take: they collide with platform namespaces, hosts or repos. */
const RESERVED = new Set([
  'orbit',
  'platform',
  'default',
  'kube',
  'system',
  'admin',
  'api',
  'git',
  'grafana',
  'prometheus',
])

/** A Kubernetes label value, which is what the team ends up as. */
const LABEL_VALUE = /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/

/** Body of `POST /api/apps`. */
export const CreateAppSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(30)
    .regex(
      DNS_LABEL,
      'lowercase letters, digits and dashes; must start with a letter'
    )
    .refine(
      (n) =>
        !RESERVED.has(n) && !n.startsWith('orbit-') && !n.startsWith('kube-'),
      'this name is reserved'
    ),
  team: z
    .string()
    .min(1)
    .max(40)
    .regex(LABEL_VALUE, 'letters, digits, dashes, dots and underscores'),
  template: z.string().min(1),
  /** Checked against the template's languages by the route; absent means its default. */
  language: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,30}$/)
    .optional(),
  description: z.string().max(200).optional().default(''),
  environments: z.array(z.string().regex(DNS_LABEL)).min(1).max(5),
  options: z
    .object({
      database: z.boolean().default(false),
      objectStorage: z.boolean().default(false),
      queue: z.boolean().default(false),
      size: z.enum(['small', 'medium', 'large']).default('small'),
      securityGate: z
        .enum(['critical', 'high', 'medium', 'off'])
        .default('high'),
    })
    .default({}),
})
