import type { Info } from './instance'
import { REGIME_ORDER, regimeLabel } from './sim'
import type { Regime, SimStats } from './sim'

export interface HudHandlers {
  runQuery(): void
  checkpoint(): void
  vacuum(): void
  compact(): void
  setSpeed(v: number): void
  setRegime(r: Regime): void
  setOrbit(on: boolean): void
  setFly(on: boolean): void
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
  const btnCompact = $<HTMLButtonElement>('#btn-compact')
  const speedIn = $<HTMLInputElement>('#speed')
  const speedVal = $<HTMLElement>('#speed-val')
  const chkOrbit = $<HTMLInputElement>('#chk-orbit')
  const chkFly = $<HTMLInputElement>('#chk-fly')
  const flyHint = $<HTMLElement>('#fly-hint')

  const stQueries = $<HTMLElement>('#st-queries')
  const stRps = $<HTMLElement>('#st-rps')
  const stConn = $<HTMLElement>('#st-conn')
  const stHit = $<HTMLElement>('#st-hit')
  const stLat = $<HTMLElement>('#st-lat')
  const stWal = $<HTMLElement>('#st-wal')
  const stDead = $<HTMLElement>('#st-dead')
  const stBar = $<HTMLElement>('#st-bar')
  const stNote = $<HTMLElement>('#st-note')

  const procsEl = $<HTMLElement>('#procs')

  const makeRow = (label: string) => {
    const li = document.createElement('li')
    li.innerHTML = '<i class="pt"></i><span></span><b></b>'
    li.querySelector('span')!.textContent = label
    return li
  }

  const postmaster = makeRow('postmaster')
  postmaster.querySelector('i')!.classList.add('on')
  postmaster.querySelector('b')!.textContent = 'listening'
  procsEl.appendChild(postmaster)

  const workerLabels = ['checkpointer', 'walwriter', 'autovacuum'] as const
  const workerRows = workerLabels.map((w) => {
    const row = makeRow(w)
    procsEl.appendChild(row)
    return row
  })

  const backendRows: HTMLElement[] = []
  const syncBackends = (states: boolean[]) => {
    while (backendRows.length < states.length) {
      const row = makeRow(`backend ${backendRows.length + 1}`)
      procsEl.insertBefore(row, workerRows[0])
      backendRows.push(row)
    }
    while (backendRows.length > states.length) {
      backendRows.pop()!.remove()
    }
    backendRows.forEach((row, i) => {
      const busy = states[i]
      row.querySelector('i')!.classList.toggle('on', busy)
      const state = row.querySelector('b')!
      state.textContent = busy ? 'busy' : 'idle'
    })
  }

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
  btnCompact.addEventListener('click', () => handlers.compact())
  speedIn.addEventListener('input', () => {
    const v = Number(speedIn.value)
    speedVal.textContent = `${v}×`
    handlers.setSpeed(v)
  })
  chkOrbit.addEventListener('change', () => handlers.setOrbit(chkOrbit.checked))
  chkFly.addEventListener('change', () => {
    flyHint.hidden = !chkFly.checked
    handlers.setFly(chkFly.checked)
  })

  // workload chips: exclusive, and they only change what arrives
  const regimeOpts = $<HTMLElement>('#regime-opts')
  const regimeButtons: HTMLButtonElement[] = []
  const markRegime = (r: Regime) => {
    for (const b of regimeButtons) b.setAttribute('aria-pressed', String(b.dataset.regime === r))
  }
  for (const r of REGIME_ORDER) {
    const b = document.createElement('button')
    b.className = 'regime'
    b.dataset.regime = r
    b.textContent = regimeLabel(r)
    b.setAttribute('aria-pressed', String(r === 'default'))
    b.addEventListener('click', () => {
      markRegime(r)
      handlers.setRegime(r)
    })
    regimeOpts.appendChild(b)
    regimeButtons.push(b)
  }

  window.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement | null
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
    if (e.code === 'Space') {
      e.preventDefault()
      handlers.runQuery()
    } else if (e.key === 'c') {
      handlers.checkpoint()
    } else if (e.key === 'v') {
      handlers.vacuum()
    } else if (e.key === 'f') {
      handlers.compact()
    }
  })

  const busy = (el: HTMLElement, on: boolean) => el.classList.toggle('busy', on)

  return {
    setQueryBusy(on: boolean) {
      busy(btnQuery, on)
    },
    setRegime(r: Regime) {
      markRegime(r)
      handlers.setRegime(r)
    },
    setStats(s: SimStats) {
      stQueries.textContent = String(s.queries)
      stRps.textContent = `${s.rps.toFixed(1)} rps`
      stConn.textContent =
        s.connections === 0 ? '—' : `${s.busyBackends} busy · ${s.connections}/${s.maxConnections}`
      stHit.textContent = s.hitRate > 0 ? `${s.hitRate.toFixed(1)}%` : '—'
      stLat.textContent = s.latency > 0 ? `${s.latency.toFixed(2)} ms` : '—'
      stWal.textContent = fmtBytes(s.walBytes)
      stDead.textContent = String(s.dead)
      stBar.style.width = `${Math.min(100, s.hitRate)}%`
      addNote(stNote, s.note)

      syncBackends(s.backendStates)
      const busyOk = [s.checkpointing, s.walBytes > 0, s.vacuuming]
      const states = ['flushing', 'streaming', 'reclaiming']
      workerRows.forEach((row, i) => {
        row.querySelector('i')!.classList.toggle('on', busyOk[i])
        row.querySelector('b')!.textContent = busyOk[i] ? states[i] : 'idle'
      })
    },
    inspect(info: Info) {
      inspector.hidden = false
      inspector.classList.remove('collapsed')
      inspector.classList.add('pinned')
      insTitle.textContent = info.title
      insBody.textContent = info.body
      insMeta.textContent = info.meta ?? ''
      // the card may be below the fold of a tall column; bring it into view
      // rather than letting the reader hunt for what they just clicked
      inspector.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
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
  // the legend is a card too: same chevron, same click/keyboard toggle, same
  // remembered state — it just draws a glossary instead of a paragraph
  const cards = Array.from(
    document.querySelectorAll<HTMLElement>('.card:not(#inspector), .legend'),
  )
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
