/**
 * Preload script — the only bridge between renderer and Node.
 *
 * `contextBridge.exposeInMainWorld('storyStudio', ...)` gives the renderer
 * a single typed object. Every value is either a plain data value or a
 * Promise-returning IPC invoke, so the renderer never holds raw handles.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type {
  QueueState,
  Settings,
  ProjectMeta,
  ProjectTreeEntry,
  IpcResult,
  ImportPromptResult
} from '../shared/types'

// ---------------------------------------------------------------------------
// Typed wrapper — avoids typing every channel name twice.
// ---------------------------------------------------------------------------
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args)

const storyStudio = {
  projects: {
    list: () => invoke<ProjectMeta[]>('projects:list'),
    create: (name: string) => invoke<ProjectMeta>('projects:create', name),
    get: (id: string) => invoke<ProjectMeta>('projects:get', id),
    tree: (id: string) => invoke<ProjectTreeEntry[]>('projects:tree', id),
    open: (id: string) => invoke<ProjectMeta>('projects:open', id)
  },

  prompts: {
    loadShots: (id: string) => invoke<QueueState>('prompts:loadShots', id)
  },

  queue: {
    start: (id: string) => invoke<void>('queue:start', id),
    pause: () => invoke<void>('queue:pause'),
    resume: () => invoke<void>('queue:resume'),
    stop: () => invoke<void>('queue:stop'),
    state: () => invoke<QueueState>('queue:state'),
    regenerate: (number: number) => invoke<void>('queue:regenerate', number),
    approve: (number: number) => invoke<void>('queue:approve', number),
    /** Subscribe to live queue updates. Returns an unsubscribe function. */
    onUpdate: (callback: (state: QueueState) => void): (() => void) => {
      const handler = (_event: unknown, state: QueueState) => callback(state)
      ipcRenderer.on('queue:update', handler)
      return () => ipcRenderer.removeListener('queue:update', handler)
    }
  },

  files: {
    openFolder: (path: string) => invoke<IpcResult<void>>('files:openFolder', path),
    showInFolder: (path: string) => invoke<IpcResult<void>>('files:showInFolder', path),
    /** Open the native file picker, parse ALL-MASTER-PROMPTS.md, create a project. */
    importPromptFile: () => invoke<ImportPromptResult>('files:importPromptFile')
  },

  settings: {
    get: () => invoke<Settings>('settings:get'),
    save: (partial: Partial<Settings>) => invoke<Settings>('settings:save', partial)
  },

  generators: {
    list: () => invoke<{ id: string; name: string }[]>('generators:list')
  }
} as const

contextBridge.exposeInMainWorld('storyStudio', storyStudio)
