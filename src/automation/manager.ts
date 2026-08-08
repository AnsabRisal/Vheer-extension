/**
 * Browser manager — owns the long-lived Playwright browser instance.
 *
 * The browser is launched once per run (so cookies/rate-limits persist across
 * shots) and a fresh page is created per shot. Headful by default so the user
 * can watch the run and solve any CAPTCHA.
 */
import { chromium, firefox, webkit } from 'playwright'
import type { Browser, BrowserContext } from 'playwright'
import type { BrowserType } from '../shared/types'
import { errorLog } from '../main/services/logService'

const LAUNCHERS = { chromium, firefox, webkit } as const

export class BrowserManager {
  private browser: Browser | null = null
  private context: BrowserContext | null = null

  isConnected(): boolean {
    return this.browser !== null && this.browser.isConnected()
  }

  getBrowser(): Browser | null {
    return this.browser
  }

  getContext(): BrowserContext | null {
    return this.context
  }

  /** Launch (or reuse) the automation browser and return a shared context. */
  async launch(browserType: BrowserType, headless: boolean): Promise<BrowserContext> {
    if (this.isConnected() && this.context) return this.context

    const launcher = LAUNCHERS[browserType] ?? chromium
    errorLog.info(`Launching ${browserType} (headless=${headless})`)

    this.browser = await launcher.launch({
      headless,
      args: ['--no-first-run']
    })

    this.context = await this.browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1280, height: 900 },
      locale: 'en-US'
    })

    // Recreate the context if the browser is ever re-launched.
    this.browser.on('disconnected', () => {
      this.context = null
      this.browser = null
    })

    return this.context
  }

  async close(): Promise<void> {
    try {
      await this.browser?.close()
    } catch {
      /* already gone */
    }
    this.browser = null
    this.context = null
  }
}
