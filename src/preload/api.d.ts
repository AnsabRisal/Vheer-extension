/**
 * Global type declaration for the preload-bridged API surface.
 * Included in the renderer's tsconfig.web.json so all renderer code
 * can reference `window.storyStudio.*` without import errors.
 */
import type {
  QueueState,
  Settings,
  ProjectMeta,
  ProjectTreeEntry,
  IpcResult,
  ImportPromptResult
} from '../shared/types'

export interface StoryStudioBridge {
  readonly projects: {
    list(): Promise<ProjectMeta[]>
    create(name: string): Promise<ProjectMeta>
    get(id: string): Promise<ProjectMeta>
    tree(id: string): Promise<ProjectTreeEntry[]>
    open(id: string): Promise<ProjectMeta>
  }

  readonly prompts: {
    loadShots(id: string): Promise<QueueState>
  }

  readonly queue: {
    start(id: string): Promise<void>
    pause(): Promise<void>
    resume(): Promise<void>
    stop(): Promise<void>
    state(): Promise<QueueState>
    regenerate(number: number): Promise<void>
    approve(number: number): Promise<void>
    onUpdate(callback: (state: QueueState) => void): () => void
  }

  readonly files: {
    openFolder(path: string): Promise<IpcResult<void>>
    showInFolder(path: string): Promise<IpcResult<void>>
    importPromptFile(): Promise<ImportPromptResult>
  }

  readonly settings: {
    get(): Promise<Settings>
    save(partial: Partial<Settings>): Promise<Settings>
  }

  readonly generators: {
    list(): Promise<{ id: string; name: string }[]>
  }
}

declare global {
  interface Window {
    storyStudio: StoryStudioBridge
  }
}
