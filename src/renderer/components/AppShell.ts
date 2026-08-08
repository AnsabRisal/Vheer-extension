/**
 * AppShell — mounts the sidebar, view container, topbar and footer.
 * Handles navigation and owns the QueueBar.
 */
import { store } from '../state'
import { h, empty, div } from './ui'
import { DashboardView } from './DashboardView'
import { ShotViewer } from './ShotViewer'
import { GalleryView } from './GalleryView'
import { ProjectView } from './ProjectView'
import { SettingsView } from './SettingsView'
import { QueueBar } from './QueueBar'

const NAV = [
  { id: 'dashboard' as const, icon: '📊', label: 'Dashboard' },
  { id: 'shots' as const, icon: '🎬', label: 'Shot Viewer' },
  { id: 'gallery' as const, icon: '🖼', label: 'Gallery' },
  { id: 'projects' as const, icon: '📁', label: 'Projects' },
  { id: 'settings' as const, icon: '⚙', label: 'Settings' }
]

export class AppShell {
  private root: HTMLElement
  private sidebar: HTMLElement
  private viewArea: HTMLElement
  private topbarTitle: HTMLElement
  private topbarControls: HTMLElement
  private footerArea: HTMLElement
  private queueBar: QueueBar

  private views: Record<string, { mount(el: HTMLElement): void; update(): void }> = {}
  private currentViewKey: string = ''

  constructor(root: HTMLElement) {
    this.root = root
    this.sidebar = div('sidebar')
    this.viewArea = div('view')
    this.topbarTitle = h('div', { className: 'topbar__title' }, 'Dashboard')
    this.topbarControls = h('div', { className: 'topbar__controls' })
    this.footerArea = h('div', { id: 'footer' })
    this.queueBar = new QueueBar()

    store.subscribe(() => this.onStateChange())
  }

  mount(): void {
    // Build the full DOM tree inside #app.
    this.root.innerHTML = ''

    const sidebar = this.buildSidebar()
    const mainCol = h('div', { id: 'main' },
      h('header', { className: 'topbar' }, this.topbarTitle, this.topbarControls),
      this.viewArea
    )
    this.root.appendChild(sidebar)
    this.root.appendChild(mainCol)
    this.root.appendChild(this.footerArea)

    this.queueBar.mount(this.footerArea)

    // Mount each view inside a wrapper so it can be swapped.
    for (const nav of NAV) {
      const wrapper = div('hidden', '')
      wrapper.id = `view-${nav.id}`
      this.viewArea.appendChild(wrapper)
    }
    this.views.dashboard = new DashboardView(document.getElementById('view-dashboard')!)
    this.views.shots = new ShotViewer(document.getElementById('view-shots')!)
    this.views.gallery = new GalleryView(document.getElementById('view-gallery')!)
    this.views.projects = new ProjectView(document.getElementById('view-projects')!)
    this.views.settings = new SettingsView(document.getElementById('view-settings')!)

    for (const v of Object.values(this.views)) v.mount(document.getElementById('view-' + Object.keys(this.views).find(k => this.views[k] === v)!)!)

    this.switchView(store.view)
  }

  private buildSidebar(): HTMLElement {
    empty(this.sidebar)
    this.sidebar.appendChild(
      div('sidebar__brand',
        h('span', null, '🎬'),
        h('span', null, 'AI Story Studio')
      )
    )
    const nav = h('nav', { className: 'sidebar__nav' })
    for (const item of NAV) {
      const link = h('div', { className: 'sidebar__link', 'data-view': item.id },
        h('span', { className: 'sidebar__link__icon' }, item.icon),
        h('span', null, item.label)
      )
      link.addEventListener('click', () => this.switchView(item.id))
      nav.appendChild(link)
    }
    this.sidebar.appendChild(nav)

    const projectInfo = div('sidebar__project',
      div('sidebar__project-label', 'CURRENT PROJECT'),
      this.topbarTitle.cloneNode(true)
    )
    // Replace the cloned title with the live one.
    this.sidebar.appendChild(projectInfo)
    this.updateSidebarProject()
    return this.sidebar
  }

  private switchView(key: string): void {
    store.view = key as typeof store.view
    // hide all, show target
    for (const nav of NAV) {
      const el = document.getElementById(`view-${nav.id}`)
      if (el) el.classList.toggle('hidden', nav.id !== key)
      // sidebar link active state
      const link = this.sidebar.querySelector(`[data-view="${nav.id}"]`)
      link?.classList.toggle('sidebar__link--active', nav.id === key)
    }
    this.views[key]?.update()
    this.currentViewKey = key
  }

  private onStateChange(): void {
    this.updateSidebarProject()
    this.views[this.currentViewKey]?.update()
    this.queueBar.update()
  }

  private updateSidebarProject(): void {
    const label = this.sidebar.querySelector('.sidebar__project-name')
    if (label) label.textContent = store.project?.name ?? 'No project open'
    this.topbarTitle.textContent = store.project?.name ?? store.view
  }
}
