/**
 * QueueBar — the persistent footer showing start/pause/resume/stop,
 * progress bar, generated/failed counts, and ETA.
 */
import { store } from '../state'
import { h, empty, div, fmtDuration } from './ui'

export class QueueBar {
  private root: HTMLElement
  private progressFill!: HTMLElement
  private generatedEl!: HTMLElement
  private failedEl!: HTMLElement
  private etaEl!: HTMLElement
  private startBtn!: HTMLButtonElement
  private pauseBtn!: HTMLButtonElement
  private resumeBtn!: HTMLButtonElement
  private stopBtn!: HTMLButtonElement

  constructor() {
    this.root = div('footer-inner')
  }

  mount(container: HTMLElement): void {
    empty(container)

    this.generatedEl = h('span', null, '0')
    this.failedEl = h('span', null, '0')
    this.etaEl = h('span', null, '—')
    this.progressFill = h('div', { className: 'progress-bar__fill' })

    this.startBtn = h('button', { className: 'btn btn--primary btn--small' }, '▶ Start') as HTMLButtonElement
    this.pauseBtn = h('button', { className: 'btn btn--small' }, '⏸ Pause') as HTMLButtonElement
    this.resumeBtn = h('button', { className: 'btn btn--small' }, '▶ Resume') as HTMLButtonElement
    this.stopBtn = h('button', { className: 'btn btn--danger btn--small' }, '■ Stop') as HTMLButtonElement

    this.startBtn.addEventListener('click', () => {
      if (store.project) window.storyStudio.queue.start(store.project.id)
    })
    this.pauseBtn.addEventListener('click', () => window.storyStudio.queue.pause())
    this.resumeBtn.addEventListener('click', () => window.storyStudio.queue.resume())
    this.stopBtn.addEventListener('click', () => window.storyStudio.queue.stop())

    this.root.append(
      div('footer__stats',
        div('stat', h('span', null, '—'), h('div', null, 'Generated')),
        div('stat', h('span', null, '—'), h('div', null, 'Failed'))
      ),
      div('footer__progress', div('progress-bar', this.progressFill)),
      div('footer__eta', this.etaEl),
      div('footer__controls', this.startBtn, this.pauseBtn, this.resumeBtn, this.stopBtn)
    )
    container.appendChild(this.root)

    // Rename the generated/failed stat values to have IDs.
    const statSpans = this.root.querySelectorAll('.footer__stats .stat span')
    if (statSpans[0]) this.generatedEl = statSpans[0] as HTMLElement
    if (statSpans[1]) this.failedEl = statSpans[1] as HTMLElement
  }

  update(): void {
    const q = store.queue
    if (!q) return
    const total = q.shots.length || 1
    const done = q.stats.completed + q.stats.approved + q.stats.failed
    this.progressFill.style.width = `${(done / total) * 100}%`
    this.generatedEl.textContent = String(q.stats.completed + q.stats.approved)
    this.failedEl.textContent = String(q.stats.failed)
    this.etaEl.textContent = q.status === 'done' ? 'Complete' : fmtDuration(q.etaSeconds)

    const running = store.isRunning
    const paused = q.status === 'paused'
    const hasProject = !!store.project

    this.startBtn.classList.toggle('hidden', running || !hasProject)
    this.pauseBtn.classList.toggle('hidden', !running || paused)
    this.resumeBtn.classList.toggle('hidden', !paused)
    this.stopBtn.classList.toggle('hidden', !running)
  }
}
