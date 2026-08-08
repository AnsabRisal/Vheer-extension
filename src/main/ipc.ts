/**
 * IPC layer — the single place every renderer↔main channel is registered.
 * The preload bridge (`window.storyStudio`) calls these handlers by name, so
 * the channel names here must stay in sync with `preload/index.ts`.
 */
import { ipcMain, shell, dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { QueueEngine } from '../automation/engine'
import { listGenerators } from '../automation/registry'
import type { ImportPromptResult, ProjectMeta, Settings } from '../shared/types'
import { ProjectService } from './services/projectService'
import { QueueService } from './services/queueService'
import { SettingsService } from './services/settingsService'
import { parsePromptFile } from './services/promptReader'
import { generationLog } from './services/logService'

const importDialogOptions = {
  title: 'Import Master Prompt File',
  buttonLabel: 'Import',
  filters: [
    { name: 'Master Prompt File', extensions: ['md', 'markdown', 'txt'] },
    { name: 'All Files', extensions: ['*'] }
  ],
  properties: ['openFile'] as ('openFile' | 'openDirectory' | 'multiSelections')[]
}

/** Folders that make bad project names (desktop, downloads, documents…). */
const GENERIC_FOLDERS = new Set([
  'desktop', 'downloads', 'documents', 'pictures', 'videos', 'music',
  'onedrive', 'onedrive-desktop', 'onedrive-documents', 'onedrive-pictures',
  'temp', 'tmp', 'new folder'
])

/** Derive a safe project name from the location of the picked file. */
function projectNameFromPath(picked: string): string {
  const parent = basename(dirname(picked)).trim()
  const base = basename(picked).replace(/\.[^.]+$/, '').trim()

  if (parent && !GENERIC_FOLDERS.has(parent.toLowerCase())) {
    return parent.slice(0, 60)
  }
  if (base) return base.slice(0, 60)
  return 'Imported Project'
}

export interface AppDeps {
  projects: ProjectService
  queue: QueueService
  engine: QueueEngine
  settings: SettingsService
}

export function registerIpc(deps: AppDeps, getWindow: () => BrowserWindow | null): void {
  const { projects, queue, engine, settings } = deps

  // Push every queue change to the renderer as soon as it happens.
  queue.onUpdate((state) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('queue:update', state)
    }
  })

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  ipcMain.handle('projects:list', () => projects.list())
  ipcMain.handle('projects:create', (_e, name: string) => projects.create(String(name)))
  ipcMain.handle('projects:get', (_e, id: string) => projects.get(String(id)))
  ipcMain.handle('projects:tree', (_e, id: string) => projects.tree(String(id)))
  ipcMain.handle('projects:open', async (_e, id: string) => {
    await queue.loadForProject(String(id))
    return projects.get(String(id))
  })

  // -------------------------------------------------------------------------
  // Prompts
  // -------------------------------------------------------------------------

  ipcMain.handle('prompts:loadShots', (_e, id: string) => queue.loadForProject(String(id)))

  // -------------------------------------------------------------------------
  // Queue
  // -------------------------------------------------------------------------

  ipcMain.handle('queue:start', (_e, id: string) => engine.start(String(id)))
  ipcMain.handle('queue:pause', () => engine.pause())
  ipcMain.handle('queue:resume', () => engine.resume())
  ipcMain.handle('queue:stop', () => engine.stop())
  ipcMain.handle('queue:state', () => queue.getState())
  ipcMain.handle('queue:regenerate', (_e, number: number) =>
    engine.regenerate(Number(number))
  )
  ipcMain.handle('queue:approve', (_e, number: number) =>
    queue.approve(Number(number))
  )

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  ipcMain.handle('files:openFolder', async (_e, path: string) => {
    const err = await shell.openPath(String(path))
    return err ? { ok: false, error: err } : { ok: true }
  })
  ipcMain.handle('files:showInFolder', (_e, path: string) => {
    shell.showItemInFolder(String(path))
    return { ok: true }
  })

  // -------------------------------------------------------------------------
  // Import ALL-MASTER-PROMPTS.md → auto-create project → load queue
  // -------------------------------------------------------------------------

  ipcMain.handle('files:importPromptFile', async (): Promise<ImportPromptResult> => {
    const win = getWindow()
    const pick = win
      ? await dialog.showOpenDialog(win, importDialogOptions)
      : await dialog.showOpenDialog(importDialogOptions)
    if (pick.canceled || !pick.filePaths[0]) {
      return { project: null as unknown as ProjectMeta, shots: [], count: 0, warnings: [], canceled: true }
    }

    const picked = pick.filePaths[0]
    const content = await readFile(picked, 'utf-8')
    const { shots, warnings } = parsePromptFile(content)
    if (shots.length === 0) {
      return { project: null as unknown as ProjectMeta, shots: [], count: 0, warnings, canceled: false }
    }

    const name = projectNameFromPath(picked)
    const existing = projects.list().find((p) => p.name === name)
    let meta: ProjectMeta
    if (existing) {
      // Re-import updates the existing project's prompt file, then reloads.
      meta = existing
      await writeFile(meta.promptsFile, content, 'utf-8')
      generationLog.info(`Re-imported prompts into "${name}" (${shots.length} shots).`)
    } else {
      meta = projects.create(name)
      await writeFile(meta.promptsFile, content, 'utf-8')
      generationLog.info(`Imported "${name}" from ${picked} (${shots.length} shots).`)
    }

    await queue.loadForProject(meta.id)
    return { project: meta, shots, count: shots.length, warnings, canceled: false }
  })

  // -------------------------------------------------------------------------
  // Settings & generators
  // -------------------------------------------------------------------------

  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('settings:save', (_e, partial: Partial<Settings>) =>
    settings.save(partial ?? {})
  )
  ipcMain.handle('generators:list', () => listGenerators())
}
