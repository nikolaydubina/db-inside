import type { Info } from './instance'
import type { SimStats } from './sim'

export interface HudHandlers {
  runQuery(): void
  checkpoint(): void
  vacuum(): void
  setIndexScan(on: boolean): void
  setOrbit(on: boolean): void
  unpin(): void
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!

const fmtBytes = (n: number) => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

export function initHud(handlers: HudHandlers) {
  const btnQuery = $<HTMLButtonElement>('#btn-query')
  const btnCheckpoint = $<HTMLButtonElement>('#btn-checkpoint')
  const btnVacuum = $<HTMLButtonElement>('#btn-vacuum')
  const chkIndex = $<HTMLInputElement>('#chk-index')
  const chkOrbit = $<HTMLInputElement>('#chk-orbit')

  const stQueries = $<HTMLElement>('#st-queries')
  const stHit = $<HTMLElement>('#st-hit')
  const stLat = $<HTMLElement>('#st-lat')
  const stWal = $<HTMLElement>('#st-wal')
  const stDead = $<HTMLElement>('#st-dead')
  const stBar = $<HTMLElement>('#st-bar')
  const stNote = $<HTMLElement>('#st-note')

  const connsEl = $<HTMLElement>('#conns')
  const prCk = $<HTMLElement>('#pr-ck')
  const prWl = $<HTMLElement>('#pr-wl')
  const prAv = $<HTMLElement>('#pr-av')
  const connBoxes = Array.from({ length: 6 }, () => {
    const el = document.createElement('div')
    el.className = 'conn-box'
    connsEl.appendChild(el)
    return el
  })

  const inspector = $<HTMLElement>('#inspector')
  const insTitle = $<HTMLElement>('#ins-title')
  const insBody = $<HTMLElement>('#ins-body')
  const insMeta = $<HTMLElement>('#ins-meta')
  const tooltip = $<HTMLElement>('#tooltip')
  const boot = $<HTMLElement>('#boot')

  setupCards()

  // the inspector is contextual: tapping its title dismisses the selection
  insTitle.addEventListener('click', () => handlers.unpin())

  btnQuery.addEventListener('click', () => handlers.runQuery())
  btnCheckpoint.addEventListener('click', () => handlers.checkpoint())
  btnVacuum.addEventListener('click', () => handlers.vacuum())
  chkIndex.addEventListener('change', () => handlers.setIndexScan(chkIndex.checked))
  chkOrbit.addEventListener('change', () => handlers.setOrbit(chkOrbit.checked))

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault()
      handlers.runQuery()
    } else if (e.key === 'c') {
      handlers.checkpoint()
    } else if (e.key === 'v') {
      handlers.vacuum()
    } else if (e.key === 'i') {
      chkIndex.checked = !chkIndex.checked
      handlers.setIndexScan(chkIndex.checked)
    }
  })

  const busy = (el: HTMLElement, on: boolean) => el.classList.toggle('busy', on)

  return {
    setQueryBusy(on: boolean) {
      busy(btnQuery, on)
    },
    setStats(s: SimStats) {
      stQueries.textContent = String(s.queries)
      stHit.textContent = s.hitRate > 0 ? `${s.hitRate.toFixed(1)}%` : '—'
      stLat.textContent = s.latency > 0 ? `${s.latency.toFixed(2)} ms` : '—'
      stWal.textContent = fmtBytes(s.walBytes)
      stDead.textContent = String(s.dead)
      stBar.style.width = `${Math.min(100, s.hitRate)}%`
      addNote(stNote, s.note)

      connBoxes.forEach((el, i) => {
        el.classList.toggle('open', i < s.connections)
        el.classList.toggle('busy', i < s.busyBackends)
      })
      prCk.classList.toggle('on', s.checkpointing)
      prWl.classList.toggle('on', s.walBytes > 0)
      prAv.classList.toggle('on', s.vacuuming)
    },
    inspect(info: Info) {
      inspector.hidden = false
      inspector.classList.remove('collapsed')
      inspector.classList.add('pinned')
      insTitle.textContent = info.title
      insBody.textContent = info.body
      insMeta.textContent = info.meta ?? ''
    },
    unpin() {
      inspector.hidden = true
      inspector.classList.remove('pinned')
    },
    hover(info: Info | null, x: number, y: number) {
      if (!info) {
        tooltip.classList.remove('on')
        return
      }
      tooltip.textContent = info.title
      tooltip.style.left = `${x}px`
      tooltip.style.top = `${y}px`
      tooltip.classList.add('on')
    },
    bootDone() {
      boot.classList.add('gone')
    },
  }
}

let lastNote = ''

const CARDS_KEY = 'psql.cards'
const COMPACT = () =>
  window.matchMedia('(max-width: 760px), (orientation: portrait) and (max-width: 900px)').matches

function setupCards() {
  const cards = Array.from(document.querySelectorAll<HTMLElement>('.card:not(#inspector)'))
  let saved: Record<string, boolean> = {}
  try {
    saved = JSON.parse(localStorage.getItem(CARDS_KEY) ?? '{}') as Record<string, boolean>
  } catch {
    saved = {}
  }
  const compact = COMPACT()

  for (const card of cards) {
    const head = card.querySelector<HTMLElement>('h2')
    if (!head) continue

    const key = head.textContent?.trim() ?? ''
    const chev = document.createElement('span')
    chev.className = 'chev'
    head.appendChild(chev)
    head.setAttribute('role', 'button')
    head.setAttribute('tabindex', '0')

    const startCollapsed = key in saved ? saved[key] : compact
    card.classList.toggle('collapsed', startCollapsed)
    head.setAttribute('aria-expanded', String(!startCollapsed))

    const toggle = () => {
      const collapsed = card.classList.toggle('collapsed')
      head.setAttribute('aria-expanded', String(!collapsed))
      saved[key] = collapsed
      try {
        localStorage.setItem(CARDS_KEY, JSON.stringify(saved))
      } catch {
        /* private mode */
      }
    }

    head.addEventListener('click', toggle)
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        toggle()
      }
    })
  }

  // going from desktop to a phone layout collapses the whole stack
  window
    .matchMedia('(max-width: 760px), (orientation: portrait) and (max-width: 900px)')
    .addEventListener('change', (e) => {
      if (!e.matches) return
      for (const card of cards) {
        card.classList.add('collapsed')
        card.querySelector('h2')?.setAttribute('aria-expanded', 'false')
      }
    })
}

function addNote(el: HTMLElement, note: string) {
  if (note === lastNote) return
  lastNote = note
  el.style.opacity = '0'
  window.setTimeout(() => {
    el.textContent = note
    el.style.transition = 'opacity .35s'
    el.style.opacity = '1'
  }, 90)
}
