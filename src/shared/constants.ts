/**
 * Renderer-safe constants and small formatting helpers.
 * Imported by main, preload and renderer.
 */
import type { ImageFormat, Settings, ShotStatus } from './types'

export const APP_NAME = 'AI Story Studio'

export const PROMPTS_FILE = 'ALL-MASTER-PROMPTS.md'
export const QUEUE_FILE = 'queue.json'
export const PROJECT_FILE = 'project.json'

/** Sub-folders scaffolded for every new project. */
export const PROJECT_FOLDERS = [
  'Story',
  'Continuity Bible',
  'Images',
  'Videos',
  'Audio',
  'Exports'
] as const

export const DEFAULT_SETTINGS: Settings = {
  generator: 'vheer',
  browser: 'chromium',
  headless: false,
  downloadFolder: 'downloads',
  delayBetweenShotsSec: 5,
  imageFormat: 'png',
  filenameFormat: 'SHOT{N}',
  retries: 3
}

export const STATUS_LABELS: Record<ShotStatus, string> = {
  waiting: 'Waiting',
  generating: 'Generating',
  completed: 'Completed',
  failed: 'Failed',
  approved: 'Approved'
}

/** Human glyphs used in the compact progress strip (001 ✅ 002 ⏳ …). */
export const STATUS_GLYPHS: Record<ShotStatus, string> = {
  waiting: '⏳',
  generating: '⚙',
  completed: '✅',
  failed: '❌',
  approved: '⭐'
}

// ---------------------------------------------------------------------------
// Filename helpers
// ---------------------------------------------------------------------------

/** Zero-pad a shot number to at least 3 digits (or to the width of the total). */
export function formatShotNumber(n: number, total: number): string {
  const width = Math.max(3, String(total).length)
  return String(n).padStart(width, '0')
}

/**
 * Apply the user's filename template to a shot number.
 * `format` = "SHOT{N}" → "SHOT001". `total` controls padding width.
 */
export function formatFilename(
  shot: number,
  total: number,
  format: string,
  ext: string
): string {
  const num = formatShotNumber(shot, total)
  const base = (format || 'SHOT{N}').replace('{N}', num)
  return `${base}.${ext}`
}

export function defaultImageExt(format: ImageFormat): string {
  return format === 'jpeg' ? 'jpg' : format
}

/**
 * Build a `story-image://` URL for a local file so the renderer can display
 * images without loading them into JS. The whole path is percent-encoded
 * (so `#`, `?`, spaces etc. are safe) and decoded by the main-process
 * protocol handler.
 */
export function toImageUrl(filePath: string): string {
  const forward = filePath.replace(/\\/g, '/')
  return `story-image://${encodeURIComponent(forward)}`
}
