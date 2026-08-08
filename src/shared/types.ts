/**
 * Shared data types used across all three Electron layers
 * (main, preload, renderer). This file is intentionally free of any
 * Node.js or Electron imports so it can be compiled into the renderer.
 */

// ---------------------------------------------------------------------------
// Shots & Queue
// ---------------------------------------------------------------------------

export type ShotStatus =
  | 'waiting'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'approved'

/** A single parsed shot from ALL-MASTER-PROMPTS.md */
export interface Shot {
  /** 1-based shot number as written in the prompt file (SHOT 001 → 1). */
  number: number
  masterPrompt: string
  negativePrompt: string
  status: ShotStatus
  /** Absolute path to the generated image, if any. */
  imagePath: string | null
  /** How many generation attempts have been made for this shot. */
  retryCount: number
}

export type QueueStatus =
  | 'idle' // engine stopped, nothing scheduled
  | 'running' // actively generating
  | 'paused' // current shot will finish, no new shot picked
  | 'stopping' // abort requested, cleaning up
  | 'done' // all shots processed

export interface QueueStats {
  waiting: number
  generating: number
  completed: number
  failed: number
  approved: number
}

/** Full queue snapshot pushed to the renderer on every change. */
export interface QueueState {
  projectId: string
  projectName: string
  shots: Shot[]
  currentShotNumber: number | null
  status: QueueStatus
  stats: QueueStats
  /** Rolling average seconds-per-shot × remaining shots. */
  etaSeconds: number | null
  error: string | null
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type BrowserType = 'chromium' | 'firefox' | 'webkit'
export type ImageFormat = 'png' | 'jpeg' | 'webp'

export interface Settings {
  /** Id of the active generator plugin (see automation/registry). */
  generator: string
  browser: BrowserType
  /** Run the automation browser headless (no visible window). */
  headless: boolean
  /** Staging folder for in-flight downloads (resolved against app root). */
  downloadFolder: string
  /** Pause (seconds) between COMPLETED generations, to be gentle on the service. */
  delayBetweenShotsSec: number
  imageFormat: ImageFormat
  /** Filename template. `{N}` is replaced by the zero-padded shot number. */
  filenameFormat: string
  /** Generation attempts per shot before marking it failed. */
  retries: number
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ProjectMeta {
  /** Stable slug id, e.g. "the-hush". */
  id: string
  name: string
  /** Absolute path to the project folder. */
  root: string
  /** Absolute path to ALL-MASTER-PROMPTS.md */
  promptsFile: string
  createdAt: string
}

export interface ProjectTreeEntry {
  name: string
  path: string
  type: 'file' | 'dir'
}

// ---------------------------------------------------------------------------
// IPC result wrapper
// ---------------------------------------------------------------------------

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

/** Result of importing an ALL-MASTER-PROMPTS.md file. */
export interface ImportPromptResult {
  project: ProjectMeta | null
  shots: Shot[]
  count: number
  warnings: string[]
  /** True when the user cancelled the file picker. */
  canceled: boolean
}
