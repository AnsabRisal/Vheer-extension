/**
 * Gallery view — grid of generated images with click-to-preview,
 * approve, regenerate and open-in-folder actions.
 */
import { store } from '../state'
import { h, empty, div, statusGlyph } from './ui'
import { toImageUrl, formatShotNumber } from '../../shared/constants'

export class GalleryView {
  private root: HTMLElement

  constructor(root: HTMLElement) {
    this.root = root
  }

  mount(root: HTMLElement): void {
    this.root = root
    this.root.innerHTML = ''
    this.root.appendChild(h('h1', null, 'Gallery'))
  }

  update(): void {
    const q = store.queue
    empty(this.root)
    this.root.appendChild(h('h1', null, 'Gallery'))

    if (!q || q.shots.length === 0) {
      this.root.appendChild(h('div', { className: 'text-dim' }, 'No shots in queue.'))
      return
    }

    const total = q.shots.length
    const grid = div('gallery__grid')
    for (const shot of q.shots) {
      if (!shot.imagePath) continue
      const card = div('gallery__card')
      card.addEventListener('click', () => this.openPreview(shot))

      const img = h('img', {
        className: 'gallery__card-img',
        src: toImageUrl(shot.imagePath),
        alt: `SHOT ${shot.number}`
      }) as HTMLImageElement
      img.loading = 'lazy'

      const foot = div('gallery__card-foot',
        h('span', null, `#${formatShotNumber(shot.number, total)}`),
        h('span', {
          className: `badge badge--${shot.status === 'approved' ? 'star' : shot.status === 'failed' ? 'err' : 'ok'}`
        }, statusGlyph(shot.status))
      )
      card.append(img, foot)
      grid.appendChild(card)
    }

    if (grid.children.length === 0) {
      this.root.appendChild(h('div', { className: 'text-dim' }, 'No images generated yet.'))
    } else {
      this.root.appendChild(grid)
    }
  }

  private openPreview(shot: { number: number; imagePath: string | null }): void {
    if (!shot.imagePath) return
    const backdrop = div('modal-backdrop')
    const modal = div('modal')
    const closeBtn = h('button', { className: 'modal__close' }, '✕')
    closeBtn.addEventListener('click', () => backdrop.remove())

    const img = h('img', {
      className: 'preview-img',
      src: toImageUrl(shot.imagePath),
      alt: `SHOT ${shot.number}`
    }) as HTMLImageElement

    const approveBtn = h('button', { className: 'btn btn--primary' }, '⭐ Approve')
    const regenBtn = h('button', { className: 'btn' }, '🔄 Regenerate')
    const folderBtn = h('button', { className: 'btn' }, '📂 Open Folder')

    approveBtn.addEventListener('click', () => {
      window.storyStudio.queue.approve(shot.number)
      backdrop.remove()
    })
    regenBtn.addEventListener('click', () => {
      window.storyStudio.queue.regenerate(shot.number)
      backdrop.remove()
    })
    folderBtn.addEventListener('click', () => {
      window.storyStudio.files.showInFolder(shot.imagePath!)
    })

    modal.append(
      closeBtn,
      img,
      div('flex gap-8 mt-auto', approveBtn, regenBtn, folderBtn)
    )
    backdrop.appendChild(modal)
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove() })
    document.body.appendChild(backdrop)
  }
}
