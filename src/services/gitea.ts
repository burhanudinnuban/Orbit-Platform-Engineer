import type { Config } from '../config/env.js'
import { HttpError, httpJson, httpText } from './http.js'

export interface GiteaRepo {
  id: number
  name: string
  full_name: string
  html_url: string
  clone_url: string
  default_branch: string
  empty: boolean
}

export interface GiteaBranch {
  name: string
  commit: { id: string; message: string }
}

export interface GiteaHook {
  id: number
  type: string
  active: boolean
  config: { url?: string; content_type?: string }
  events: string[]
}

export type CommitState =
  'pending' | 'success' | 'error' | 'failure' | 'warning'

/** Gitea REST client. Orbit treats Git hosting as a provider so GitLab/GitHub adapters can be added. */
export class Gitea {
  constructor(private readonly config: Config) {}

  get baseUrl(): string {
    return this.config.gitea.url
  }

  private headers(): Record<string, string> {
    if (!this.config.gitea.token)
      throw new Error(
        'GITEA_TOKEN is not set. Run `npm run bootstrap` to create it.'
      )
    return { authorization: `token ${this.config.gitea.token}` }
  }

  private api<T>(
    method: string,
    path: string,
    body?: unknown,
    allow404 = false
  ): Promise<T | null> {
    return httpJson<T>(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: this.headers(),
      body,
      allow404,
    })
  }

  async health(): Promise<string> {
    const v = await httpJson<{ version: string }>(
      `${this.baseUrl}/api/v1/version`,
      { timeoutMs: 3000 }
    )
    if (!this.config.gitea.token)
      throw new Error(
        `Gitea ${v?.version ?? ''} reachable, but GITEA_TOKEN is not set`
      )
    await this.api('GET', '/user')
    return v?.version ?? 'unknown'
  }

  getRepo(owner: string, name: string): Promise<GiteaRepo | null> {
    return this.api<GiteaRepo>(
      'GET',
      `/repos/${owner}/${name}`,
      undefined,
      true
    )
  }

  async createOrgRepo(
    org: string,
    name: string,
    description: string
  ): Promise<GiteaRepo> {
    const repo = await this.api<GiteaRepo>('POST', `/orgs/${org}/repos`, {
      name,
      description,
      private: false,
      auto_init: false,
      default_branch: 'main',
    })
    return repo!
  }

  async deleteRepo(owner: string, name: string): Promise<void> {
    await this.api('DELETE', `/repos/${owner}/${name}`, undefined, true)
  }

  getBranch(
    owner: string,
    repo: string,
    branch: string
  ): Promise<GiteaBranch | null> {
    return this.api<GiteaBranch>(
      'GET',
      `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
      undefined,
      true
    )
  }

  /** Raw file content at a ref, or null when the file doesn't exist. */
  async getRawFile(
    owner: string,
    repo: string,
    filePath: string,
    ref: string
  ): Promise<string | null> {
    const encoded = filePath.split('/').map(encodeURIComponent).join('/')
    return httpText(
      `${this.baseUrl}/api/v1/repos/${owner}/${repo}/raw/${encoded}?ref=${encodeURIComponent(ref)}`,
      {
        headers: this.headers(),
        allow404: true,
      }
    )
  }

  async listHooks(owner: string, repo: string): Promise<GiteaHook[]> {
    return (
      (await this.api<GiteaHook[]>('GET', `/repos/${owner}/${repo}/hooks`)) ??
      []
    )
  }

  async ensurePushHook(
    owner: string,
    repo: string,
    url: string,
    secret: string
  ): Promise<GiteaHook> {
    const existing = (await this.listHooks(owner, repo)).find(
      (h) => h.config.url === url
    )
    if (existing) return existing
    const hook = await this.api<GiteaHook>(
      'POST',
      `/repos/${owner}/${repo}/hooks`,
      {
        type: 'gitea',
        active: true,
        events: ['push'],
        branch_filter: '*',
        config: { url, content_type: 'json', secret },
      }
    )
    return hook!
  }

  async deleteHooksTo(
    owner: string,
    repo: string,
    url: string
  ): Promise<number> {
    let removed = 0
    for (const hook of await this.listHooks(owner, repo).catch(() => [])) {
      if (hook.config.url === url) {
        await this.api(
          'DELETE',
          `/repos/${owner}/${repo}/hooks/${hook.id}`,
          undefined,
          true
        )
        removed++
      }
    }
    return removed
  }

  async setCommitStatus(
    owner: string,
    repo: string,
    sha: string,
    status: {
      state: CommitState
      description: string
      targetUrl?: string
      context?: string
    }
  ): Promise<void> {
    await this.api('POST', `/repos/${owner}/${repo}/statuses/${sha}`, {
      state: status.state,
      description: status.description.slice(0, 140),
      target_url: status.targetUrl,
      context: status.context ?? 'orbit/pipeline',
    })
  }

  /** Require the Orbit pipeline status on pull requests into `branch` (direct pushes stay allowed). */
  async protectBranch(
    owner: string,
    repo: string,
    branch: string,
    statusContext: string
  ): Promise<'created' | 'exists'> {
    const existing = await this.api<
      { rule_name?: string; branch_name?: string }[]
    >('GET', `/repos/${owner}/${repo}/branch_protections`)
    if (existing?.some((p) => (p.rule_name ?? p.branch_name) === branch))
      return 'exists'
    try {
      await this.api('POST', `/repos/${owner}/${repo}/branch_protections`, {
        rule_name: branch,
        branch_name: branch,
        enable_push: true,
        enable_status_check: true,
        status_check_contexts: [statusContext],
      })
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) return 'exists'
      throw err
    }
    return 'created'
  }
}
