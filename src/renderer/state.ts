/**
 * Renderer-side state store — a minimal reactive wrapper over the preload API.
 *
 * Main-process pushes queue snapshots via IPC; this store caches the latest
 * one and notifies subscribed components to re-render.
 */
import type { QueueState, ProjectMeta, Settings, QueueStatus } from '../shared/types'

type Listener = () => void

class Store {
  private listeners = new Set<Listener>()

  project: ProjectMeta | null = null
  queue: QueueState | null = null
  settings: Settings | null = null
  view: 'dashboard' | 'shots' | 'gallery' | 'projects' | 'settings' = 'dashboard'
  /** Shot number currently selected in the shot viewer. */
  selectedShot: number | null = null

  private _unsubscribeQueue: (() => void) | null = null

  /** Subscribe to every queue snapshot from the main process. */
  init(): void {
    this._unsubscribeQueue = window.storyStudio.queue.onUpdate((state) => {
      this.queue = state
      // Auto-select the first shot on load if nothing selected yet.
      if (this.selectedShot === null && state.shots.length > 0) {
        this.selectedShot = state.shots[0].number
      }
      this.notify()
    })
  }

  destroy(): void {
    this._unsubscribeQueue?.()
  }

  /** Fire a re-render in every subscribed component. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify(): void {
    for (const l of this.listeners) l()
  }

  /** Convenience getters for the most common values. */
  get status(): QueueStatus {
    return this.queue?.status ?? 'idle'
  }

  get isRunning(): boolean {
    return this.status === 'running' || this.status === 'stopping' || this.status === 'paused'
  }
}

export const store = new Store()
