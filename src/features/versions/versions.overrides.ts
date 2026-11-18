import type { Store } from '../../app/store.js'
import type { Config } from '../../config/env.js'
import { COMPONENTS } from './versions.catalog.js'

/**
 * Put admin-chosen CI and Terraform images (Platform → Versions, kept in the
 * store) into config.images, over .env and the defaults. Every process calls
 * it at startup, and the CI engine before each pipeline, so an update made by
 * the API process reaches the others.
 */
export function applyImageOverrides(config: Config, store: Store): void {
  const overrides = store.versionOverrides()
  for (const def of COMPONENTS) {
    const o = def.ci && overrides.get(def.id)
    if (def.ci && o) config.images[def.ci.key] = o.image
  }
}
