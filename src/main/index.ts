/**
 * AI Story Studio — main process entry point.
 *
 * Responsibilities:
 *  1. Register the `story-image://` protocol (renderer image previews).
 *  2. Create the app window.
 *  3. Wire services + engine to IPC.
 *  4. Seed the sample project on first launch.
 */
import { app, protocol, net } from 'electron'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createMainWindow } from './window'
import { ensureRuntimeDirs, paths } from './paths'
import { ProjectService } from './services/projectService'
import { QueueService } from './services/queueService'
import { SettingsService } from './services/settingsService'
import { QueueEngine } from '../automation/engine'
import { registerIpc } from './ipc'
import { errorLog } from './services/logService'

// Must run before the app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'story-image',
    privileges: { secure: true, stream: true, bypassCSP: true }
  }
])

// Services (constructed once, shared across handlers).
const projects = new ProjectService()
const settings = new SettingsService()
const queue = new QueueService(projects)
const engine = new QueueEngine(queue, settings)

let mainWindow: ReturnType<typeof createMainWindow> | null = null

// Single instance — prevents two automation browsers fighting over one queue.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    ensureRuntimeDirs()
    projects.ensureSampleProject()

    registerImageProtocol()
    mainWindow = createMainWindow()
    registerIpc(
      { projects, queue, settings, engine },
      () => mainWindow
    )

    app.on('activate', () => {
      if (mainWindow === null) mainWindow = createMainWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  await engine.dispose()
})

/**
 * Serve local files to the renderer under `story-image://`.
 * Only paths inside the app's runtime root are allowed.
 */
function registerImageProtocol(): void {
  protocol.handle('story-image', (request) => {
    try {
      const encoded = request.url.slice('story-image://'.length)
      const file = decodeURIComponent(encoded)
      const resolved = resolve(file)
      const rootPrefix = resolve(paths.root) + sep
      if (!resolved.startsWith(rootPrefix)) {
        return new Response('Forbidden', { status: 403 })
      }
      return net.fetch(pathToFileURL(resolved).toString())
    } catch (err) {
      errorLog.warn(`story-image protocol error: ${(err as Error).message}`)
      return new Response('Not found', { status: 404 })
    }
  })
}
