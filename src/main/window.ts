/**
 * Browser window factory.
 *
 * Security posture:
 *  - contextIsolation: true  → the preload script runs in its own world.
 *  - nodeIntegration: false  → the renderer cannot touch Node.js.
 *  - The only bridge to Node is the typed API in `preload/index.ts`.
 */
import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0d10',
    title: 'AI Story Studio',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // Open external links in the system browser, never in the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Dev: load the Vite dev server. Prod: load the bundled HTML.
  if (!process.env.ELECTRON_RENDERER_URL) {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  } else {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  }

  return win
}
