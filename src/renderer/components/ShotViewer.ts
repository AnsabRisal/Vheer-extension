/**
 * Shot viewer — detailed look at a single shot: prompts, status, preview,
 * and actions (Copy Prompt, Regenerate, Open Folder, Previous/Next).
 */
import { store } from '../state'
import { h, empty, div, statusGlyph } from './ui'
import { toImageUrl } from '../../shared/constants'

export class ShotViewer {
  private root: HTMLElement
  private numEl!: HTMLElement
  private badgeEl!: HTMLElement
  private masterEl!: HTMLElement
  private negativeEl!: HTMLElement
  private previewEl!: HTMLImageElement
  private prevBtn!: HTMLElement
  private nextBtn!: HTMLElement

  constructor(root: HTMLElement) {
    this.root = root
    this.previewEl = h('img', { className: 'shot-viewer__preview', alt: 'Shot preview' }) as HTMLImageElement
  }

  mount(root: HTMLElement): void {
    this.root = root
    this.root.innerHTML = ''

    this.numEl = h('div', { className: 'shot-viewer__num' }, '001')
    this.badgeEl = h('span', { className: 'badge badge--muted' }, 'Waiting')
    this.masterEl = h('pre')
    this.negativeEl = h('pre')

    const copyBtn = h('button', { className: 'btn btn--small' }, '📋 Copy Prompt')
    const regenBtn = h('button', { className: 'btn btn--small' }, '🔄 Regenerate')
    const folderBtn = h('button', { className: 'btn btn--small' }, '📂 Open Folder')
    this.prevBtn = h('button', { className: 'btn btn--small' }, '← Prev')
    this.nextBtn = h('button', { className: 'btn btn--small' }, 'Next →')

    copyBtn.addEventListener('click', () => this.copyPrompt())
    regenBtn.addEventListener('click', () => {
      if (store.selectedShot != null) window.storyStudio.queue.regenerate(store.selectedShot)
    })
    folderBtn.addEventListener('click', () => this.openFolder())
    this.prevBtn.addEventListener('click', () => this.nav(-1))
    this.nextBtn.addEventListener('click', () => this.nav(1))

    this.root.append(
      div('shot-viewer__header', h('h1', null, 'Shot Viewer'), this.numEl, this.badgeEl),
      div('shot-viewer__prompts',
        div('shot-viewer__prompt-block', h('h3', null, 'Master Prompt'), this.masterEl),
        div('shot-viewer__prompt-block', h('h3', null, 'Negative Prompt'), this.negativeEl)
      ),
      div('shot-viewer__actions', this.prevBtn, this.nextBtn, copyBtn, regenBtn, folderBtn),
      this.previewEl
    )
  }

  update(): void {
    const q = store.queue
    const num = store.selectedShot
    if (!q || num == null) return
    const shot = q.shots.find((s) => s.number === num)
    if (!shot) return

    this.numEl.textContent = String(num).padStart(3, '0')
    this.badgeEl.textContent = shot.status
    this.badgeEl.className = `badge badge--${badgeClass(shot.status)}`
    this.masterEl.textContent = shot.masterPrompt || '(none)'
    this.negativeEl.textContent = shot.negativePrompt || '(none)'

    if (shot.imagePath) {
      this.previewEl.src = toImageUrl(shot.imagePath)
      this.previewEl.classList.remove('hidden')
    } else {
      this.previewEl.src = ''
      this.previewEl.classList.add('hidden')
    }
  }

  private copyPrompt(): void {
    const shot = store.queue?.shots.find((s) => s.number === store.selectedShot)
    if (!shot) return
    navigator.clipboard.writeText(shot.masterPrompt).catch(() => {})
  }

  private openFolder(): void {
    const shot = store.queue?.shots.find((s) => s.number === store.selectedShot)
    if (shot?.imagePath) window.storyStudio.files.openFolder(shot.imagePath)
  }

  private nav(delta: number): void {
    const shots = store.queue?.shots ?? []
    const idx = shots.findIndex((s) => s.number === store.selectedShot)
    const next = idx + delta
    if (next >= 0 && next < shots.length) {
      store.selectedShot = shots[next].number
      store.notify()
    }
  }
}

function badgeClass(status: string): string {
  const map: Record<string, string> = {
    completed: 'ok',
    approved: 'star',
    failed: 'err',
    generating: 'gen',
    waiting: 'muted'
  }
  return map[status] ?? 'muted'
}
