import type {
  AppDetail,
  AppSummary,
  DeploymentStatus,
} from '../../types/contract.js'
import { appNamespace, appUrl, dashboardUrl } from '../../config/env.js'
import type { Platform } from '../../app/platform.js'
import type { AppRecord } from '../../app/store.js'
import { pipelineSummary } from '../ci/ci.views.js'
import type { WorkflowEngine } from '../workflow/workflow.engine.js'

/** Deployment status per environment, with placeholders for environments GitOps doesn't track yet. */
export function deploymentsFor(
  platform: Platform,
  app: AppRecord
): DeploymentStatus[] {
  const tracked = platform.store.listDeployments(app.name)
  return app.environments.map(
    (env) =>
      tracked.find((d) => d.env === env) ?? {
        app: app.name,
        env,
        namespace: appNamespace(app.name, env),
        syncStatus: 'Unknown',
        health: 'Unknown',
        message:
          app.status === 'provisioning'
            ? 'provisioning'
            : 'not tracked by the GitOps controller',
        url: appUrl(platform.config, app.name, env),
        resources: [],
      }
  )
}

export function appSummary(platform: Platform, app: AppRecord): AppSummary {
  const { config, store } = platform
  const latest = store.latestPipeline(app.name)
  const urls =
    app.outputs.urls ??
    Object.fromEntries(
      app.environments.map((env) => [env, appUrl(config, app.name, env)])
    )
  const dashboards =
    app.outputs.dashboards ??
    Object.fromEntries(
      app.environments.map((env) => [env, dashboardUrl(config, app.name, env)])
    )
  return {
    name: app.name,
    team: app.team,
    template: app.template,
    language: app.language,
    description: app.description,
    environments: app.environments,
    status: app.status,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    links: { repository: app.outputs.repositoryUrl, urls, dashboards },
    latestPipeline: latest ? pipelineSummary(latest) : undefined,
    deployments: deploymentsFor(platform, app),
    findings: store.findingCounts(app.name),
  }
}

export function appDetail(
  platform: Platform,
  engine: WorkflowEngine,
  app: AppRecord
): AppDetail {
  return {
    ...appSummary(platform, app),
    options: app.options,
    cloud: app.outputs.cloud ?? {},
    workflows: platform.store
      .listWorkflows(app.name)
      .map((wf) => engine.view(wf)),
  }
}
