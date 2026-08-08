/**
 * Vheer generator plugin — Vheer Text-to-Image automation.
 *
 * Drives https://vheer.com/app/text-to-image with Playwright.
 *
 * Brand-new provider: no frame/iframe scanning. The page is a Next.js SPA;
 * page validation is a URL match, then we wait for the prompt textarea to
 * render (SPA), fill it, click Generate, and wait for the finished image.
 *
 * Download strategy (in order):
 *   A. real download event → click the Download button, waitForEvent('download')
 *   B. blob/data/src     → fetch() the image bytes from the page.
 */
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { Page } from 'playwright'
import type { GeneratorContext, GeneratorPlugin, GenerationResult } from '../../shared/generator'
import { paths } from '../../main/paths'
import { debugLog, captureScreenshot } from '../../main/services/logService'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GENERATOR_URL = 'https://vheer.com/app/text-to-image'
const NAV_TIMEOUT = 90_000
const IMAGE_TIMEOUT = 300_000
const POLL_INTERVAL = 500

const debugDir = join(paths.logs, 'debug')

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function logShot(shotNum: number, step: string, detail = ''): void {
  const msg = `[SHOT ${String(shotNum).padStart(3, '0')}] ${step}${detail ? ' — ' + detail : ''}`
  debugLog.info(msg)
}

// ---------------------------------------------------------------------------
// Element finders (single top document; no frame scanning)
// ---------------------------------------------------------------------------

/** The Vheer prompt textarea, detected by its distinctive placeholder. */
async function findPromptTextarea(page: Page) {
  // Strategy 1: placeholder mentioning describe / image / prompt.
  const byPlaceholder = page.getByPlaceholder(/describe|image|prompt|enter.*text/i).first()
  if ((await byPlaceholder.count()) > 0 && (await byPlaceholder.isVisible().catch(() => false))) {
    return { locator: byPlaceholder, method: 'getByPlaceholder' }
  }

  // Strategy 2: first visible textarea.
  const count = await page.locator('textarea').count()
  for (let i = 0; i < count; i++) {
    const ta = page.locator('textarea').nth(i)
    if (await ta.isVisible().catch(() => false)) {
      return { locator: ta, method: `visible-textarea-${i}` }
    }
  }
  return null
}

/** The Generate button, matched by its visible text. */
async function findGenerateButton(page: Page) {
  const byRole = page.getByRole('button', { name: /generate/i }).first()
  if ((await byRole.count()) > 0 && (await byRole.isVisible().catch(() => false))) {
    return byRole
  }
  return null
}

/** Wait for the SPA to render the prompt textarea. */
async function waitForPrompt(page: Page, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await findPromptTextarea(page)) return true
    await sleep(300)
  }
  return false
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const vheerGenerator: GeneratorPlugin = {
  id: 'vheer',
  name: 'Vheer',
  supportsNegativePrompt: false,

  async open(ctx: GeneratorContext): Promise<void> {
    const { shot, page } = ctx
    const shotNum = shot.number

    logShot(shotNum, 'Navigating to Vheer', GENERATOR_URL)
    await page.goto(GENERATOR_URL, { timeout: NAV_TIMEOUT, waitUntil: 'domcontentloaded' })

    // Wait for the SPA to render the prompt textarea.
    const rendered = await waitForPrompt(page)
    if (!rendered) {
      await captureScreenshot(page, join(debugDir, `shot-${shotNum}-no-prompt.png`))
      throw new Error(`Prompt textarea never appeared at ${GENERATOR_URL}`)
    }
    logShot(shotNum, 'Prompt found')

    const prompt = await findPromptTextarea(page)
    if (!prompt) throw new Error('Prompt textarea not found')
    await prompt.locator.click()
    await prompt.locator.fill(shot.masterPrompt)
    logShot(shotNum, 'Prompt filled', `${shot.masterPrompt.length} chars via ${prompt.method}`)

    const gen = await findGenerateButton(page)
    if (!gen) {
      await captureScreenshot(page, join(debugDir, `shot-${shotNum}-no-generate.png`))
      throw new Error('Generate button not found')
    }
    await gen.click()
    logShot(shotNum, 'Generate clicked')
  },

  async download(ctx: GeneratorContext): Promise<GenerationResult> {
    const { shot, page } = ctx
    const shotNum = shot.number
    const deadline = Date.now() + IMAGE_TIMEOUT

    // Strategy A: wait for a real download event after clicking Download.
    try {
      const dlBtn = page.getByRole('button', { name: /download|save|⬇/i }).first()
      while (Date.now() < deadline) {
        if ((await dlBtn.count()) > 0 && (await dlBtn.isVisible().catch(() => false))) {
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 15_000 }).catch(() => null),
            dlBtn.click().catch(() => {})
          ])
          if (download) {
            logShot(shotNum, 'Download event captured', download.suggestedFilename())
            const tempPath = join(paths.downloads, `vheer-${shotNum}-${Date.now()}`)
            const filePath = await download.saveAs(tempPath)
            const { readFile } = await import('node:fs/promises')
            const data = new Uint8Array(await readFile(filePath))
            if (data.length > 0) {
              logShot(shotNum, 'Image downloaded', `${data.length} bytes`)
              return { kind: 'buffer', data }
            }
          }
        }
        await sleep(POLL_INTERVAL)
      }
    } catch (e) {
      logShot(shotNum, 'Download-event path failed', (e as Error).message)
    }

    // Strategy B: fetch the rendered image src from the page.
    try {
      const src = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img'))
        const candidates = imgs
          .filter(i => i.complete && i.naturalWidth > 0 && i.src && !i.src.startsWith('data:') && !i.src.startsWith('blob:'))
          .map(i => i.src)
        const nonUi = candidates.filter((s) => !/logo|icon|avatar|thumb|placeholder|spinner/i.test(s))
        return (nonUi[0] || candidates[0]) || null
      })
      if (src) {
        logShot(shotNum, 'Fetching image src', src.slice(0, 80))
        const buffer = await page.evaluate(async (url: string) => {
          const resp = await fetch(url, { mode: 'cors', credentials: 'include' })
          const blob = await resp.blob()
          const arrayBuffer = await blob.arrayBuffer()
          return Array.from(new Uint8Array(arrayBuffer))
        }, src)
        const data = new Uint8Array(buffer)
        if (data.length > 0) {
          logShot(shotNum, 'Image fetched', `${data.length} bytes`)
          return { kind: 'buffer', data }
        }
      }
    } catch (e) {
      logShot(shotNum, 'Fetch path failed', (e as Error).message)
    }

    await captureScreenshot(page, join(debugDir, `shot-${shotNum}-no-image.png`))
    throw new Error(`No image produced within ${IMAGE_TIMEOUT / 1000}s at ${GENERATOR_URL}`)
  }
}

export { vheerGenerator }
