/**
 * Settings service — loads/validates/persists `settings/settings.json`.
 *
 * The stored file only needs to contain the keys the user has overridden;
 * anything missing falls back to DEFAULT_SETTINGS, so the file survives
 * schema changes across versions.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_SETTINGS } from '../../shared/constants'
import type { Settings } from '../../shared/types'
import { settingsFile } from '../paths'

/** Deep-merge partial settings over defaults, dropping unknown keys. */
function sanitize(raw: unknown): Settings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const base: Settings = { ...DEFAULT_SETTINGS }
  const result: Settings = { ...base }

  // v0.1 → v0.2: `delayBetweenRequestsMs` was replaced by
  // `delayBetweenShotsSec` (milliseconds → seconds).
  if (
    src['delayBetweenShotsSec'] === undefined &&
    typeof src['delayBetweenRequestsMs'] === 'number'
  ) {
    src['delayBetweenShotsSec'] = Math.max(0, Math.round((src['delayBetweenRequestsMs'] as number) / 1000))
    delete src['delayBetweenRequestsMs']
  }

  for (const key of Object.keys(base) as (keyof Settings)[]) {
    const value = src[key]
    if (value === undefined || value === null) continue
    // Only accept values of the same shape as the default for the key.
    if (typeof value === typeof base[key]) {
      ;(result as unknown as Record<string, unknown>)[key] = value
    }
  }
  return result
}

export class SettingsService {
  private current: Settings

  constructor() {
    this.current = this.load()
  }

  load(): Settings {
    try {
      const raw = JSON.parse(readFileSync(settingsFile(), 'utf-8')) as unknown
      return sanitize(raw)
    } catch {
      // First launch or unreadable file → defaults.
      return { ...DEFAULT_SETTINGS }
    }
  }

  get(): Settings {
    return { ...this.current }
  }

  save(partial: Partial<Settings>): Settings {
    this.current = sanitize({ ...this.current, ...partial })
    try {
      mkdirSync(dirname(settingsFile()), { recursive: true })
      writeFileSync(settingsFile(), JSON.stringify(this.current, null, 2), 'utf-8')
    } catch {
      /* persist is best-effort; in-memory state still applies */
    }
    return this.get()
  }
}
