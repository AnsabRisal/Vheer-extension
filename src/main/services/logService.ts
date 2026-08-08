/**
 * Logging service.
 *
 * Four dedicated log files live in `logs/`:
 *   generation.log — every shot lifecycle event
 *   errors.log     — exceptions and failed attempts
 *   downloads.log  — file moves / renames / deletes
 *   debug.log      — verbose step-by-step automation trace
 *
 * Each file rotates: when it exceeds `maxBytes` it is renamed to `<file>.old`
 * (overwriting the previous .old) and a fresh file is started.
 *
 * Screenshot support: when automation fails, `captureScreenshot()` saves a
 * timestamped PNG to `logs/debug/` for post-mortem diagnosis.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../paths'

type LogLevel = 'info' | 'warn' | 'error'

const MAX_BYTES = 2 * 1024 * 1024 // 2 MB

class Logger {
  constructor(
    private readonly fileName: string,
    private readonly maxBytes: number = MAX_BYTES
  ) {}

  private file(): string {
    return join(paths.logs, this.fileName)
  }

  private rotateIfNeeded(): void {
    const file = this.file()
    if (!existsSync(file)) return
    try {
      if (statSync(file).size >= this.maxBytes) {
        renameSync(file, `${file}.old`)
      }
    } catch {
      /* rotation is best-effort */
    }
  }

  private write(level: LogLevel, message: string): void {
    try {
      this.rotateIfNeeded()
      const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}\n`
      appendFileSync(this.file(), line)
    } catch {
      /* logging must never crash the app */
    }
  }

  info(message: string): void {
    this.write('info', message)
  }

  warn(message: string): void {
    this.write('warn', message)
  }

  error(message: string): void {
    this.write('error', message)
  }
}

export const generationLog = new Logger('generation.log')
export const errorLog = new Logger('errors.log')
export const downloadLog = new Logger('downloads.log')
export const debugLog = new Logger('debug.log')

// ---------------------------------------------------------------------------
// Screenshot capture — called when automation fails, saves to logs/debug/
// ---------------------------------------------------------------------------

const debugDir = join(paths.logs, 'debug')

/**
 * Save a PNG screenshot from a Playwright page.
 * `page` is typed as `unknown` so this file doesn't pull in Playwright types
 * (logService is compiled into both main and renderer-like contexts).
 * The caller must pass a real Playwright Page object.
 */
export async function captureScreenshot(
  page: unknown,
  label: string
): Promise<string | null> {
  try {
    const p = page as { screenshot?(opts: { path: string; fullPage?: boolean }): Promise<unknown> }
    if (typeof p?.screenshot !== 'function') return null

    mkdirSync(debugDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)
    const filePath = join(debugDir, `${ts}_${safeLabel}.png`)

    await p.screenshot({ path: filePath, fullPage: false })
    debugLog.info(`Screenshot saved → ${filePath}`)
    return filePath
  } catch (err) {
    debugLog.warn(`Screenshot capture failed: ${(err as Error).message}`)
    return null
  }
}
