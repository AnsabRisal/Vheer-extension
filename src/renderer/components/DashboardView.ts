/**
 * Dashboard view — the landing page showing queue progress and stats.
 */
import { store } from '../state'
import { h, empty, div, fmtDuration } from './ui'

export class DashboardView {
  private root: HTMLElement
  private progressFill!: HTMLElement
  private currentShotEl!: HTMLElement
  private etaEl!: HTMLElement
  private statsEls: Record<string, HTMLElement> = {}
  private stripEl!: HTMLElement
  private errorEl!: HTMLElement

  constructor(root: HTMLElement) {
    this.root = root
  }

  mount(root: HTMLElement): void {
    this.root = root
    this.root.innerHTML = ''

    this.progressFill = h('div', { className: 'progress-bar__fill' })
    this.currentShotEl = h('div', null, '—')
    this.etaEl = h('div', null, '—')
    this.errorEl = h('div', { className: 'text-dim' }, '')

    this.stripEl = div('shot-strip')

    const statKeys = ['completed', 'failed', 'approved', 'generating'] as const
    for (const k of statKeys) {
      this.statsEls[k] = h('div', { className: 'stat__value' }, '0')
    }

    this.root.append(
      h('h1', null, 'Dashboard'),
      div('dashboard__grid gap-16',
        div('card dashboard__stat-card',
          h('h3', null, 'Progress'),
          div('progress-bar', this.progressFill),
          div('dashboard__eta', h('span', null, 'ETA:'), this.etaEl)
        ),
        div('card dashboard__stat-card',
          h('h3', null, 'Current Shot'),
          this.currentShotEl
        ),
        ...['completed', 'failed', 'approved', 'generating'].map(k =>
          div('card dashboard__stat-card',
            h('h3', null, k.charAt(0).toUpperCase() + k.slice(1)),
            this.statsEls[k]
          )
        )
      ),
      div('card mt-auto gap-12',
        h('h3', null, 'Queue'),
        this.stripEl,
        this.errorEl
      )
    )
  }

  update(): void {
    const q = store.queue
    if (!q) return
    const total = q.shots.length || 1
    const done = q.stats.completed + q.stats.approved + q.stats.failed
    this.progressFill.style.width = `${(done / total) * 100}%`
    this.currentShotEl.textContent = q.currentShotNumber != null
      ? `Shot ${q.currentShotNumber}`
      : '—'
    this.etaEl.textContent = q.status === 'done' ? 'Complete' : fmtDuration(q.etaSeconds)
    for (const [k, el] of Object.entries(this.statsEls)) {
      el.textContent = String((q.stats as unknown as Record<string, number>)[k] ?? 0)
    }
    this.errorEl.textContent = q.error ?? ''
    this.renderStrip(q.shots)
  }

  private renderStrip(shots: { number: number; status: string }[]): void {
    this.stripEl.innerHTML = ''
    for (const s of shots.slice(0, 200)) {
      const cls = `shot-strip__item shot-strip__item--${
        s.status === 'completed' ? 'ok' :
        s.status === 'failed' ? 'err' :
        s.status === 'generating' ? 'gen' :
        s.status === 'approved' ? 'star' : ''
      }`
      const el = h('div', { className: cls, title: `SHOT ${s.number} — ${s.status}` },
        String(s.number).padStart(3, '0')
      )
      el.addEventListener('click', () => { store.selectedShot = s.number; store.view = 'shots'; store.notify() })
      this.stripEl.appendChild(el)
    }
  }
}
