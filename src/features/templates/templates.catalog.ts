import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'
import type { TemplateInfo } from '../../types/contract.js'

export interface AppTemplate extends TemplateInfo {
  port: number
  dir: string
}

export interface TemplateVars {
  APP_NAME: string
  TEAM: string
  DESCRIPTION: string
  /** Display name of the chosen language, such as TypeScript. */
  LANGUAGE: string
}

const PLACEHOLDER = /\{\{\s*(APP_NAME|TEAM|DESCRIPTION|LANGUAGE)\s*\}\}/g

const LANGUAGE_NAMES: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
}

export const languageName = (id: string) =>
  LANGUAGE_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1)

const isText = (buf: Buffer) => !buf.subarray(0, 8000).includes(0)

export function renderPlaceholders(text: string, vars: TemplateVars): string {
  return text.replace(PLACEHOLDER, (_, key: keyof TemplateVars) => vars[key])
}

interface TemplateMeta {
  id?: string
  name?: string
  description?: string
  port?: number | string
  /** One language: templates without variants. */
  language?: string
  /** Several: files/ plus variants/<language>/ for each; the first is the default. */
  languages?: string[]
}

/**
 * App templates under templates/apps/<id>/:
 *
 *   template.yaml          id, name, description, port, languages (first = default)
 *   files/                 shared by every language
 *   variants/<language>/   copied over files/; the same path replaces the shared file
 */
export class TemplateCatalog {
  constructor(private readonly rootDir: string) {}

  private get appsDir(): string {
    return path.join(this.rootDir, 'templates', 'apps')
  }

  list(): AppTemplate[] {
    if (!existsSync(this.appsDir)) return []
    const out: AppTemplate[] = []
    for (const entry of readdirSync(this.appsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(this.appsDir, entry.name)
      const metaFile = path.join(dir, 'template.yaml')
      if (!existsSync(metaFile)) continue
      const meta = (parse(readFileSync(metaFile, 'utf8')) ?? {}) as TemplateMeta
      const languages = meta.languages?.length
        ? meta.languages.map(String)
        : [meta.language ?? 'unknown']
      out.push({
        id: meta.id ?? entry.name,
        name: meta.name ?? entry.name,
        description: meta.description ?? '',
        language: languages[0]!,
        languages,
        port: Number(meta.port ?? 8080),
        dir,
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  get(id: string): AppTemplate | undefined {
    return this.list().find((t) => t.id === id)
  }

  /**
   * Copy the template's files, then those of the language's variant, into
   * `outDir`, replacing placeholders in text files. Returns the file count.
   */
  async render(
    id: string,
    language: string,
    vars: Omit<TemplateVars, 'LANGUAGE'>,
    outDir: string
  ): Promise<number> {
    const template = this.get(id)
    if (!template) throw new Error(`unknown template "${id}"`)
    if (!template.languages.includes(language))
      throw new Error(
        `template "${id}" has no ${language} variant (it has ${template.languages.join(', ')})`
      )
    const all: TemplateVars = { ...vars, LANGUAGE: languageName(language) }
    const written = new Set<string>()
    const copyTree = async (srcRoot: string, rel = ''): Promise<void> => {
      for (const entry of await readdir(path.join(srcRoot, rel), {
        withFileTypes: true,
      })) {
        const relPath = path.join(rel, entry.name)
        const target = path.join(outDir, relPath)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue
          await mkdir(target, { recursive: true })
          await copyTree(srcRoot, relPath)
          continue
        }
        const source = path.join(srcRoot, relPath)
        const buf = await readFile(source)
        if (isText(buf))
          await writeFile(target, renderPlaceholders(buf.toString('utf8'), all))
        else await copyFile(source, target)
        written.add(relPath)
      }
    }
    await mkdir(outDir, { recursive: true })
    for (const dir of [
      path.join(template.dir, 'files'),
      path.join(template.dir, 'variants', language),
    ]) {
      if (existsSync(dir)) await copyTree(dir)
    }
    return written.size
  }
}
