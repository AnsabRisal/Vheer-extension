/**
 * Renderer entry point.
 *
 * Runs inside the Electron renderer process. Imports are bundled by Vite
 * (the alias `@shared/*` is defined in `electron.vite.config.ts`).
 */
import './components/ui' // pull in types for `window.storyStudio` (api.d.ts)
import { store } from './state'
import { AppShell } from './components/AppShell'

async function boot(): Promise<void> {
  store.init()

  const root = document.getElementById('app')!
  const shell = new AppShell(root)
  shell.mount()

  // Auto-open the first project if one exists.
  try {
    const projects = await window.storyStudio.projects.list()
    if (projects.length > 0) {
      const meta = await window.storyStudio.projects.open(projects[0].id)
      store.project = meta
      const state = await window.storyStudio.queue.state()
      store.queue = state
      store.settings = await window.storyStudio.settings.get()
      store.notify()
    }
  } catch {
    // First launch or no projects — the user will see the Projects view.
    store.view = 'projects'
    store.notify()
  }
}

boot().catch(console.error)
