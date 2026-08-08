/**
 * Settings view — edit generator, browser, delays, filename format, retries.
 * Saves immediately on change.
 */
import { store } from '../state'
import { h, empty, div } from './ui'
import type { Settings, BrowserType, ImageFormat } from '../../shared/types'

export class SettingsView {
  private root: HTMLElement
  private fields: { key: keyof Settings; label: string; type: string; options?: string[] }[] = [
    { key: 'generator', label: 'Generator', type: 'select' },
    { key: 'browser', label: 'Browser', type: 'select', options: ['chromium', 'firefox', 'webkit'] },
    { key: 'headless', label: 'Headless mode', type: 'checkbox' },
    { key: 'downloadFolder', label: 'Download staging folder', type: 'text' },
    { key: 'delayBetweenShotsSec', label: 'Delay between shots (seconds)', type: 'select', options: ['0', '5', '10', '30', '60'] },
    { key: 'imageFormat', label: 'Image format', type: 'select', options: ['png', 'jpeg', 'webp'] },
    { key: 'filenameFormat', label: 'Filename template ({N}=shot number)', type: 'text' },
    { key: 'retries', label: 'Retries per shot', type: 'text' }
  ]

  constructor(root: HTMLElement) {
    this.root = root
  }

  mount(root: HTMLElement): void {
    this.root = root
    this.root.innerHTML = ''
  }

  async update(): Promise<void> {
    empty(this.root)
    this.root.appendChild(h('h1', null, 'Settings'))
    const settings = store.settings ?? await window.storyStudio.settings.get()
    store.settings = settings
    const generators = await window.storyStudio.generators.list()

    const grid = div('settings-grid')

    const labelsCol = div('settings-group')
    const inputsCol = div('settings-group')

    for (const f of this.fields) {
      labelsCol.appendChild(h('label', null, f.label))
      if (f.type === 'select') {
        const sel = h('select') as HTMLSelectElement
        let source: string[] = f.options ?? []
        if (f.key === 'generator') source = generators.map((g) => g.name)
        for (const opt of source) {
          const o = h('option', { value: opt }, opt)
          if (opt === String(settings[f.key])) o.selected = true
          sel.appendChild(o)
        }
        sel.addEventListener('change', () => this.saveField(f.key, sel.value))
        inputsCol.appendChild(sel)
      } else if (f.type === 'checkbox') {
        const label = h('label', { className: 'flex gap-8', style: 'padding:6px 0' })
        const cb = h('input', { type: 'checkbox' }) as HTMLInputElement
        cb.checked = Boolean(settings[f.key])
        cb.addEventListener('change', () => this.saveField(f.key, cb.checked))
        label.append(cb, h('span', null, String(settings[f.key])))
        inputsCol.appendChild(label)
      } else {
        const inp = h('input', { type: 'text', value: String(settings[f.key] ?? '') }) as HTMLInputElement
        inp.addEventListener('blur', () => this.saveField(f.key, inp.value))
        inputsCol.appendChild(inp)
      }
    }

    grid.append(labelsCol, inputsCol)
    this.root.appendChild(grid)
  }

  private async saveField(key: keyof Settings, raw: unknown): Promise<void> {
    const patch: Record<string, unknown> = {}
    const defaults: Record<string, unknown> = { retries: 3, delayBetweenShotsSec: 5 }
    // Coerce numeric strings.
    if (key === 'retries' || key === 'delayBetweenShotsSec') {
      const n = Number(raw)
      patch[key] = isNaN(n) ? defaults[key] : n
    } else if (key === 'headless') {
      patch[key] = Boolean(raw)
    } else {
      patch[key] = raw
    }
    const saved = await window.storyStudio.settings.save(patch as Partial<Settings>)
    store.settings = saved
    store.notify()
  }
}
