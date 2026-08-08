/**
 * Queue engine — the automation orchestration loop.
 *
 * Runs shots sequentially (one at a time). For each shot it:
 *   1. Marks it `generating`.
 *   2. Calls the active generator plugin: open → generate → download.
 *   3. Validates/renames the bytes via the download manager.
 *   4. Marks it `completed` (or `failed` after the retry budget).
 *
 * Controls:
 *   start()   — begin/resume the whole run (idempotent while running).
 *   pause()   — let the current shot finish, then hold.
 *   resume()  — continue picking shots.
 *   stop()    — abort immediately; the in-flight shot returns to `waiting`
 *               so a later start re-runs it.
 *
 * Resume-after-crash is provided by QueueService: completed shots persist,
 * so a killed process restarts from the first unfinished shot.
 */
import { unlink, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser } from 'playwright'
import type { Page } from 'playwright'
import type { GeneratorContext, GeneratorPlugin } from '../shared/generator'
import type { Settings, Shot } from '../shared/types'
import { QueueService } from '../main/services/queueService'
import { SettingsService } from '../main/services/settingsService'
import { saveImage } from '../main/services/downloadService'
import { errorLog, generationLog } from '../main/services/logService'
import { getGenerator } from './registry'
import { BrowserManager } from './manager'

/** Thrown when the user hits Stop (or the browser is closed mid-action). */
export class AbortRunError extends Error {
  constructor() {
    super('Run aborted by user.')
    this.name = 'AbortRunError'
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class QueueEngine {
  private running = false
  private paused = false
  private stopping = false
  private manager = new BrowserManager()
  private plugin: GeneratorPlugin | null = null
  private page: Page | null = null

  constructor(
    private readonly queue: QueueService,
    private readonly settings: SettingsService
  ) {}

  get isRunning(): boolean {
    return this.running
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  async start(projectId: string): Promise<void> {
    if (this.running) return
    // Load the queue for this project if it isn't already in memory.
    if (this.queue.getState().projectId !== projectId) {
      await this.queue.loadForProject(projectId)
    }
    this.paused = false
    this.stopping = false
    this.queue.resetEta()
    this.queue.setStatus('running')
    this.running = true
    void this.runLoop()
  }

  async pause(): Promise<void> {
    if (!this.running) return
    this.paused = true
    this.queue.setStatus('paused')
    generationLog.info('Queue paused.')
  }

  async resume(): Promise<void> {
    if (!this.running) return
    this.paused = false
    this.queue.setStatus('running')
    generationLog.info('Queue resumed.')
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.stopping = true
    this.queue.setStatus('stopping')
    generationLog.info('Queue stop requested.')
    // Closing the page unblocks any hung Playwright wait inside the engine.
    await this.page?.close().catch(() => {})
    this.page = null
  }

  /** Manually re-run one shot; starts the engine if it is idle. */
  async regenerate(number: number): Promise<void> {
    this.queue.regenerate(number)
    if (!this.running) {
      await this.start(this.queue.getState().projectId)
    }
  }

  /** Close the automation browser regardless of run state (app shutdown). */
  async dispose(): Promise<void> {
    this.stopping = true
    await this.page?.close().catch(() => {})
    this.page = null
    await this.manager.close().catch(() => {})
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  private async runLoop(): Promise<void> {
    try {
      while (!this.stopping) {
        if (this.paused) {
          await sleep(300)
          continue
        }
        const shot = this.queue.nextPending()
        if (!shot) break
        await this.processShot(shot)

        // Wait the configured delay between COMPLETED generations, unless
        // this was the last shot or the run is stopping/paused.
        if (this.stopping || this.paused) continue
        if (!this.queue.nextPending()) break
        const delaySec = this.settings.get().delayBetweenShotsSec
        if (delaySec > 0) {
          generationLog.info(`Waiting ${delaySec}s before next shot…`)
          await this.interruptibleSleep(delaySec * 1000)
        }
      }

      if (!this.stopping) {
        const { failed } = this.queue.getState().stats
        this.queue.setStatus('done', failed ? `Finished with ${failed} failed shot(s).` : null)
        generationLog.info('Queue finished.')
      }
    } catch (err) {
      if (err instanceof AbortRunError) {
        generationLog.info('Run aborted; in-flight shot reset to waiting.')
      } else {
        errorLog.error(`Queue engine crashed: ${(err as Error).stack ?? err}`)
        this.queue.setStatus('idle', `Engine error: ${(err as Error).message}`)
      }
    } finally {
      this.running = false
      this.queue.setCurrent(null)
      await this.manager.close().catch(() => {})
      if (this.stopping) this.queue.setStatus('idle')
    }
  }

  /** Sleep that can be interrupted by Stop (checked every 100 ms). */
  private async interruptibleSleep(ms: number): Promise<void> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (this.stopping) throw new AbortRunError()
      await sleep(100)
    }
  }

  // -------------------------------------------------------------------------
  // One shot
  // -------------------------------------------------------------------------

  private async processShot(shot: Shot): Promise<void> {
    if (this.stopping) throw new AbortRunError()
    const settings = this.settings.get()
    const total = this.queue.getState().shots.length
    const startedAt = Date.now()

    this.queue.setCurrent(shot.number)
    this.queue.updateShot(shot.number, { status: 'generating' })

    for (let attempt = 1; attempt <= settings.retries; attempt++) {
      if (this.stopping) throw new AbortRunError()
      this.queue.updateShot(shot.number, { retryCount: attempt })

      try {
        const { page, plugin } = await this.ensureAutomation(settings)
        this.page = page
        this.plugin = plugin

        const gctx: GeneratorContext = {
          shot: this.queue.getShot(shot.number) as Shot,
          settings,
          browser: this.manager.getBrowser() as Browser,
          page
        }

        await this.abortable(plugin.open(gctx))
        await this.abortable(plugin.generate(gctx))
        const result = await this.abortable(plugin.download(gctx))
        await this.abortable(plugin.close(gctx)).catch(() => {})
        this.page = null

        // Resolve bytes (buffer or temp path) and clean up any temp file.
        let buffer: Uint8Array
        if (typeof result.data === 'string') {
          // Temp file on disk — read and clean up.
          const tmpPath = result.data
          buffer = new Uint8Array(await readFile(tmpPath))
          await unlink(tmpPath).catch(() => {})
        } else {
          buffer = result.data
        }

        const dest = saveImage(
          this.queue.imagesDir(),
          shot.number,
          total,
          buffer,
          settings.filenameFormat
        )

        this.queue.updateShot(shot.number, { status: 'completed', imagePath: dest })
        this.queue.noteElapsed(Date.now() - startedAt)
        generationLog.info(
          `SHOT ${shot.number}: completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s → ${dest}`
        )
        return
      } catch (err) {
        // Stop was requested (or the page was force-closed) → not a retry case.
        if (this.stopping) {
          this.queue.updateShot(shot.number, { status: 'waiting', retryCount: attempt })
          throw new AbortRunError()
        }

        errorLog.error(`SHOT ${shot.number} attempt ${attempt} failed: ${(err as Error).stack ?? err}`)
        await this.page?.close().catch(() => {})
        this.page = null

        if (attempt < settings.retries) {
          generationLog.warn(
            `SHOT ${shot.number}: attempt ${attempt}/${settings.retries} failed — retrying.`
          )
          this.queue.updateShot(shot.number, { status: 'generating' })
          await this.interruptibleSleep(Math.max(2000, settings.delayBetweenShotsSec * 1000))
        }
      }
    }

    // Retry budget exhausted.
    if (this.stopping) {
      this.queue.updateShot(shot.number, { status: 'waiting', retryCount: settings.retries })
      throw new AbortRunError()
    }
    this.queue.updateShot(shot.number, { status: 'failed' })
    generationLog.error(`SHOT ${shot.number}: failed after ${settings.retries} attempts.`)
  }

  /** Await a plugin call, then re-check the stop flag. */
  private async abortable<T>(promise: Promise<T>): Promise<T> {
    const value = await promise
    if (this.stopping) throw new AbortRunError()
    return value
  }

  /** Reuse the browser; spawn a fresh page and resolve the generator plugin. */
  private async ensureAutomation(settings: Settings): Promise<{ page: Page; plugin: GeneratorPlugin }> {
    const context = await this.manager.launch(settings.browser, settings.headless)
    if (!this.plugin || this.plugin.id !== settings.generator) {
      this.plugin = getGenerator(settings.generator)
    }
    return { page: await context.newPage(), plugin: this.plugin }
  }
}
