/**
 * Generator plugin contract.
 *
 * Every AI image generator the app can drive implements this interface.
 * The app core (queue engine, download manager, UI) only knows about
 * `GeneratorPlugin` — never about a specific provider.
 *
 * To add a new generator:
 *   1. Create `src/automation/generators/<name>.ts` implementing this.
 *   2. Register it in `src/automation/registry.ts` (one line).
 *   3. Select it in Settings → Generator.
 *
 * This file is compiled into the main process only (it references Playwright
 * types), so it lives apart from `types.ts` which is renderer-safe.
 */
import type { Browser, Page } from 'playwright'
import type { Settings, Shot } from './types'

/** Metadata about where the finished image bytes can be found. */
export interface GenerationResult {
  /**
   * - 'buffer': `data` is the raw encoded image bytes (Uint8Array).
   * - 'path':   `data` is an absolute path to a temp file on disk.
   */
  kind: 'buffer' | 'path'
  data: Uint8Array | string
}

/** Everything a plugin needs to do its job for one shot. */
export interface GeneratorContext {
  shot: Shot
  settings: Settings
  /** Shared, long-lived browser instance (kept open across shots). */
  browser: Browser
  /** Fresh page for THIS shot (created by the engine, closed after). */
  page: Page
}

export interface GeneratorPlugin {
  /** Stable unique id, used in settings.json and the registry. */
  id: string
  /** Human-readable name shown in the UI. */
  name: string
  /** Whether the service accepts a negative prompt. */
  supportsNegativePrompt: boolean

  /**
   * Navigate to the generator, fill the prompt (and negative prompt if the
   * service supports it), and trigger generation.
   */
  open(ctx: GeneratorContext): Promise<void>

  /**
   * Block until the image has finished rendering and is ready to be pulled.
   * Should throw if generation clearly failed or timed out.
   */
  generate(ctx: GeneratorContext): Promise<void>

  /**
   * Pull the finished image bytes from the browser and return them.
   * The engine validates the magic bytes and renames the file.
   */
  download(ctx: GeneratorContext): Promise<GenerationResult>

  /** Best-effort cleanup of the current page. Must not throw. */
  close(ctx: GeneratorContext): Promise<void>
}
