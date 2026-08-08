/**
 * Project service — creates, lists and inspects story projects.
 *
 * A project is a folder under `projects/` that looks like:
 *
 *   projects/The Hush/
 *     project.json            ← metadata (see ProjectMeta)
 *     ALL-MASTER-PROMPTS.md   ← the master prompt file
 *     queue.json              ← persisted queue state (created by queue service)
 *     Story/ Continuity Bible/ Images/ Videos/ Audio/ Exports/
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROMPTS_FILE, PROJECT_FILE, PROJECT_FOLDERS } from '../../shared/constants'
import type { ProjectMeta, ProjectTreeEntry } from '../../shared/types'
import { paths } from '../paths'
import { generationLog } from './logService'

const SAMPLE_PROMPTS = `# The Hush — Master Prompts

A sci-fi noir short film. All master prompts are written for cinematic 2.39:1 framing.

SHOT 001

MASTER PROMPT
Ultra-wide establishing shot of a rain-slicked neon city at night, lone figure in a long coat crossing an empty street, volumetric fog, teal and magenta lighting, cinematic noir atmosphere, photorealistic, dramatic depth of field, film grain

NEGATIVE PROMPT
blurry, low quality, cartoon, text, watermark, extra limbs, distorted faces, overexposed

SHOT 002

MASTER PROMPT
Close-up profile of the figure lifting a silver locket, warm lamplight catching their eye, shallow depth of field, rain droplets on the lens, photorealistic, moody chiaroscuro lighting, 85mm lens

NEGATIVE PROMPT
blurry, low quality, cartoon, text, watermark, jpeg artifacts, deformed hands

SHOT 003

MASTER PROMPT
Wide shot of an abandoned subway platform stretching into darkness, a single flickering fluorescent light, wet concrete reflections, dust motes in the light beam, cinematic, eerie stillness, photorealistic

NEGATIVE PROMPT
blurry, low quality, cartoon, text, watermark, people, bright daylight, overexposed

SHOT 004

MASTER PROMPT
Over-the-shoulder shot of the figure watching a train approach through rain-smeared glass, motion blur on the headlights, reflection doubling their silhouette, teal shadows, amber highlights, cinematic noir, photorealistic

NEGATIVE PROMPT
blurry, low quality, cartoon, text, watermark, distorted reflections, oversaturated

SHOT 005

MASTER PROMPT
Extreme close-up of a hand pressing a button on a small brass device, tiny blue light glowing, dust motes swirling, macro detail, cinematic, shallow depth of field, photorealistic

NEGATIVE PROMPT
blurry, low quality, cartoon, text, watermark, deformed hand, extra fingers, lens flare
`

const STARTER_PROMPTS = `# <PROJECT NAME> — Master Prompts

Write every shot below. Format:

SHOT 001

MASTER PROMPT
...your cinematic master prompt...

NEGATIVE PROMPT
...things to avoid...

`

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `project-${Date.now()}`
}

export class ProjectService {
  /** Every project on disk, sorted by name. */
  list(): ProjectMeta[] {
    try {
      const entries = readdirSync(paths.projects, { withFileTypes: true })
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => join(paths.projects, e.name))
        .map((dir) => {
          try {
            return this.readProjectFile(dir)
          } catch {
            return null
          }
        })
        .filter((p): p is ProjectMeta => p !== null)
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return []
    }
  }

  private readProjectFile(dir: string): ProjectMeta {
    return JSON.parse(readFileSync(join(dir, PROJECT_FILE), 'utf-8')) as ProjectMeta
  }

  /** Metadata for a single project. */
  get(id: string): ProjectMeta {
    const found = this.list().find((p) => p.id === id)
    if (!found) throw new Error(`Project not found: ${id}`)
    return found
  }

  /** Scaffold a brand-new project folder with the standard structure. */
  create(name: string): ProjectMeta {
    const id = slugify(name)
    const root = join(paths.projects, name)

    mkdirSync(root, { recursive: true })
    for (const folder of PROJECT_FOLDERS) {
      mkdirSync(join(root, folder), { recursive: true })
    }

    const meta: ProjectMeta = {
      id,
      name,
      root,
      promptsFile: join(root, PROMPTS_FILE),
      createdAt: new Date().toISOString()
    }

    // Never clobber an existing prompt file.
    if (!readdirSync(root).includes(PROMPTS_FILE)) {
      writeFileSync(
        meta.promptsFile,
        STARTER_PROMPTS.replace('<PROJECT NAME>', name),
        'utf-8'
      )
    }
    writeFileSync(join(root, PROJECT_FILE), JSON.stringify(meta, null, 2), 'utf-8')
    generationLog.info(`Created project "${name}" at ${root}`)
    return meta
  }

  /** Recursive listing of a project folder for the sidebar tree. */
  tree(id: string): ProjectTreeEntry[] {
    const meta = this.get(id)
    return walk(meta.root)
  }

  /** Seed the demo project on first launch so the app works immediately. */
  ensureSampleProject(): ProjectMeta | null {
    if (this.list().length > 0) return null
    try {
      const meta = this.create('The Hush')
      writeFileSync(meta.promptsFile, SAMPLE_PROMPTS, 'utf-8')
      generationLog.info('Seeded sample project "The Hush".')
      return meta
    } catch (err) {
      generationLog.warn(`Could not seed sample project: ${(err as Error).message}`)
      return null
    }
  }
}

function walk(dir: string): ProjectTreeEntry[] {
  const out: ProjectTreeEntry[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    out.push({ name: entry.name, path: full, type: entry.isDirectory() ? 'dir' : 'file' })
    if (entry.isDirectory()) out.push(...walk(full))
  }
  return out
}
