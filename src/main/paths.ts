/**
 * Runtime path resolution.
 *
 * In development the app reads/writes the repository folders directly
 * (`projects/`, `downloads/`, `settings/`, `logs/`) so everything the user
 * cares about is visible in the project. In a packaged install those folders
 * are not writable, so runtime data moves under the per-user app-data dir.
 */
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface AppPaths {
  root: string
  projects: string
  downloads: string
  settings: string
  logs: string
  assets: string
}

function runtimeRoot(): string {
  // process.cwd() is the project root when launched via electron-vite.
  return app.isPackaged ? app.getPath('userData') : process.cwd()
}

export const paths: AppPaths = {
  root: runtimeRoot(),
  projects: join(runtimeRoot(), 'projects'),
  downloads: join(runtimeRoot(), 'downloads'),
  settings: join(runtimeRoot(), 'settings'),
  logs: join(runtimeRoot(), 'logs'),
  assets: join(runtimeRoot(), 'assets')
}

/** Create every runtime folder once at startup. */
export function ensureRuntimeDirs(): void {
  for (const dir of Object.values(paths)) {
    mkdirSync(dir, { recursive: true })
  }
}

/** Absolute path to the settings.json file. */
export function settingsFile(): string {
  return join(paths.settings, 'settings.json')
}
