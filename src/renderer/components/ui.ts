/**
 * Tiny DOM helpers — avoids repetitive `document.createElement` noise.
 * `h` creates an element with attributes and children in one call.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> | null = null,
  ...children: (Node | string | null)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') el.className = v
      else el.setAttribute(k, v)
    }
  }
  for (const child of children) {
    if (child == null) continue
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return el
}

/** Shorthand for `div` with className. */
export function div(className: string, ...children: (Node | string | null)[]): HTMLDivElement {
  return h('div', { className }, ...children)
}

/** Empty the children of an element. */
export function empty(el: HTMLElement): void {
  el.innerHTML = ''
}

/** Render a human-readable duration from seconds. */
export function fmtDuration(seconds: number | null): string {
  if (seconds == null || seconds < 0) return '—'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m ${s}s`
}

/** Map shot status to the compact glyph for the progress strip. */
export function statusGlyph(status: string): string {
  const map: Record<string, string> = {
    waiting: '⏳',
    generating: '⚙',
    completed: '✅',
    failed: '❌',
    approved: '⭐'
  }
  return map[status] ?? '?'
}
