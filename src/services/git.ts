import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { Mutex } from '../lib/util.js'

const COMMON_FLAGS = [
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.longpaths=true',
  '-c',
  'user.name=Orbit',
  '-c',
  'user.email=orbit@orbit.local',
  '-c',
  'init.defaultBranch=main',
]

/** Mask credentials embedded in URLs (`https://user:token@host`). */
export function redact(text: string): string {
  return text.replace(/(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1***:***@')
}

export function authUrl(
  baseUrl: string,
  fullName: string,
  user: string,
  token: string
): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/${fullName}.git`)
  url.username = encodeURIComponent(user)
  url.password = encodeURIComponent(token)
  return url.toString()
}

export async function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...COMMON_FLAGS, ...args],
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              redact(
                `git ${args[0]} failed: ${stderr || stdout || err.message}`.trim()
              )
            )
          )
        } else {
          resolve(stdout.trim())
        }
      }
    )
  })
}

/**
 * A local clone of a remote repository, used by Orbit to read and write the
 * gitops repo and to seed new app repositories.
 */
export class GitWorkspace {
  private mutex = new Mutex()

  constructor(
    readonly dir: string,
    private readonly remote: string,
    readonly branch = 'main'
  ) {}

  /** Clone (first time) or hard-reset to the remote branch. Returns the HEAD sha. */
  async sync(): Promise<string> {
    if (!existsSync(path.join(this.dir, '.git'))) {
      await rm(this.dir, { recursive: true, force: true })
      await mkdir(path.dirname(this.dir), { recursive: true })
      await git([
        'clone',
        '--quiet',
        '--branch',
        this.branch,
        this.remote,
        this.dir,
      ])
    } else {
      await git(['remote', 'set-url', 'origin', this.remote], this.dir)
      await git(
        ['fetch', '--quiet', '--prune', 'origin', this.branch],
        this.dir
      )
      await git(
        ['checkout', '--quiet', '-B', this.branch, `origin/${this.branch}`],
        this.dir
      )
      await git(
        ['reset', '--quiet', '--hard', `origin/${this.branch}`],
        this.dir
      )
      await git(['clean', '-fdq'], this.dir)
    }
    return git(['rev-parse', 'HEAD'], this.dir)
  }

  /**
   * Apply `mutate` on a fresh checkout, then commit and push. If the push is
   * rejected because the remote moved, re-sync and re-apply (up to `retries`).
   */
  async commit(
    message: string,
    mutate: (dir: string) => Promise<void>,
    retries = 3
  ): Promise<{ changed: boolean; sha: string }> {
    return this.mutex.run(async () => {
      for (let attempt = 1; ; attempt++) {
        await this.sync()
        await mutate(this.dir)
        await git(['add', '-A'], this.dir)
        const status = await git(['status', '--porcelain'], this.dir)
        if (!status)
          return {
            changed: false,
            sha: await git(['rev-parse', 'HEAD'], this.dir),
          }
        await git(['commit', '--quiet', '-m', message], this.dir)
        try {
          await git(
            ['push', '--quiet', 'origin', `HEAD:${this.branch}`],
            this.dir
          )
          return {
            changed: true,
            sha: await git(['rev-parse', 'HEAD'], this.dir),
          }
        } catch (err) {
          if (attempt >= retries) throw err
        }
      }
    })
  }
}

/** Initialize a repository from a directory of files and push it as the first commit. */
export async function pushInitialCommit(
  dir: string,
  remote: string,
  message: string,
  branch = 'main'
): Promise<string> {
  await git(['init', '--quiet', '-b', branch], dir)
  await git(['add', '-A'], dir)
  await git(['commit', '--quiet', '-m', message], dir)
  await git(['push', '--quiet', remote, `HEAD:${branch}`], dir)
  return git(['rev-parse', 'HEAD'], dir)
}
