/**
 * Project view — list available projects, create a new one, open one,
 * and import an ALL-MASTER-PROMPTS.md file (auto-creates a project).
 */
import { store } from '../state'
import { h, empty, div } from './ui'

export class ProjectView {
  private root: HTMLElement
  private listEl: HTMLElement
  private inputEl: HTMLInputElement
  private statusEl: HTMLElement

  constructor(root: HTMLElement) {
    this.root = root
    this.listEl = div('project-list')
    this.inputEl = h('input', { type: 'text', placeholder: 'Project name…' }) as HTMLInputElement
    this.statusEl = h('div', { className: 'text-dim' })
  }

  mount(root: HTMLElement): void {
    this.root = root
    this.root.innerHTML = ''

    const createBtn = h('button', { className: 'btn btn--primary' }, '+ New')
    createBtn.addEventListener('click', () => this.createProject())

    const importBtn = h('button', { className: 'btn' }, '📂 Import Master Prompt File')
    importBtn.addEventListener('click', () => this.importPromptFile())

    const form = div('new-project-form', this.inputEl, createBtn)
    this.root.append(
      h('h1', null, 'Projects'),
      div('flex gap-12', form, importBtn),
      this.statusEl,
      this.listEl
    )
  }

  async update(): Promise<void> {
    const projects = await window.storyStudio.projects.list()
    empty(this.listEl)
    for (const p of projects) {
      const card = div('project-card',
        div('',
          div('project-card__name', p.name),
          div('project-card__date', new Date(p.createdAt).toLocaleDateString())
        ),
        h('button', { className: 'btn btn--small' }, 'Open')
      )
      card.addEventListener('click', () => this.openProject(p.id))
      this.listEl.appendChild(card)
    }
    if (projects.length === 0) {
      this.listEl.appendChild(h('div', { className: 'text-dim' }, 'No projects yet.'))
    }
  }

  private async createProject(): Promise<void> {
    const name = this.inputEl.value.trim()
    if (!name) return
    await window.storyStudio.projects.create(name)
    this.inputEl.value = ''
    await this.update()
  }

  /**
   * Open the native file picker, parse ALL-MASTER-PROMPTS.md, auto-create a
   * project, populate the queue, and jump to the Dashboard.
   */
  private async importPromptFile(): Promise<void> {
    this.statusEl.textContent = 'Choosing file…'
    const result = await window.storyStudio.files.importPromptFile()
    if (result.canceled) {
      this.statusEl.textContent = ''
      return
    }
    if (!result.project || result.count === 0) {
      const why = result.warnings.join('; ') || 'no valid SHOT blocks found.'
      this.statusEl.textContent = `No shots found in that file — ${why}`
      return
    }

    // Point the app at the new project and show the loaded queue.
    store.project = result.project
    const state = await window.storyStudio.queue.state()
    store.queue = state
    store.settings = await window.storyStudio.settings.get()

    const warnNote = result.warnings.length
      ? ` (warnings: ${result.warnings.join('; ')})`
      : ''
    this.statusEl.textContent = `${result.count} shots loaded${warnNote}`
    this.statusEl.classList.remove('text-dim')
    this.statusEl.classList.add('text-accent')

    store.view = 'dashboard'
    store.notify()
  }

  private async openProject(id: string): Promise<void> {
    const meta = await window.storyStudio.projects.open(id)
    store.project = meta
    const state = await window.storyStudio.queue.state()
    store.queue = state
    store.view = 'dashboard'
    store.notify()
  }
}
