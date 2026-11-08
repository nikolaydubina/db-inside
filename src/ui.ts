import type { Info } from './instance'
import { REGIME_ORDER, regimeLabel } from './sim'
import type { Regime, SimStats } from './sim'

export type DbName = 'postgres' | 'redis'

export interface HudHandlers {
  runQuery(): void
  checkpoint(): void
  vacuum(): void
  compact(): void
  /** redis: send one command by hand */
  runCommand(): void
  /** redis: SAVE — the dump is written on the one thread, nothing is served */
  save(): void
  /** redis: BGSAVE — a forked child writes the dump, nothing is locked */
  bgsave(): void
  /** redis: start-up, base file then log replay, no listener until done */
  load(): void
  /** redis: bgrewriteaof */
  rewriteAof(): void
  setSpeed(v: number): void
  setRegime(r: Regime): void
  /** grab-the-cage mode: drag a cage to slide it on the floor */
  setMove(on: boolean): void
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
  const moveBtn = $<HTMLButtonElement>('#btn-move')

  /**
   * The clock reads as a glyph and a slider. At 1× there is nothing to say, so the
   * number is hidden and only the slider shows; once it differs, the number sits
   * next to the glyph and the slider gives up that space.
   */
  const showSpeed = (v: number) => {
    speedVal.textContent = `${v}×`
    // Hidden at 1×: the readout sits AFTER the slider, so dropping it out of the
    // layout shortens the row without moving anything the cursor is on.
    speedVal.hidden = v === 1
  }
  showSpeed(Number(speedIn.value))

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

  /* --------------------------- database panels --------------------------- */

  const panels: Record<DbName, HTMLElement> = {
    postgres: $<HTMLElement>('#db-postgres'),
    redis: $<HTMLElement>('#db-redis'),
  }
  /** The column both panels live in — it is only there while one of them is. */
  const panelColumn = $<HTMLElement>('.panel.right')
  let db: DbName | null = null

  /**
   * The two switches at the top right. Both engines are always running, so the
   * dot is always lit; the lit border says whose panel is open, and tapping the
   * open one closes it. Nothing is selected at boot — the scene is the landing
   * page, and the panel is something you ask for.
   */
  const dbButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.dbtn'))

  /** Exactly one database panel is on screen, and only when one is selected. */
  const setDb = (next: DbName | null) => {
    db = next
    for (const name of Object.keys(panels) as DbName[]) panels[name].hidden = name !== next
    panelColumn.hidden = next === null
    // the inspector lives over the same corner: it steps aside while a panel is open
    document.body.classList.toggle('db-open', next !== null)
    for (const b of dbButtons) b.classList.toggle('active', b.dataset.db === next)
  }
  for (const b of dbButtons) {
    b.addEventListener('click', () => {
      const name = (b.dataset.db as DbName) ?? 'postgres'
      setDb(db === name ? null : name)
    })
  }
  setDb(null)

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

  // redis has one thread, not one process per connection: the only other things
  // that ever run are the two forked children
  const rdProcsEl = $<HTMLElement>('#rd-procs')
  const rdThread = makeRow('command thread')
  rdThread.querySelector('i')!.classList.add('on')
  rdThread.querySelector('b')!.textContent = 'running'
  const rdSave = makeRow('bgsave child')
  const rdRewriteRow = makeRow('rewrite child')
  rdProcsEl.append(rdThread, rdSave, rdRewriteRow)

  const syncRedisProcs = (s: {
    saving: boolean
    savingSync: boolean
    loading: boolean
    rewriting: boolean
  }) => {
    // The point of this list: SAVE and LOAD light up the command thread, BGSAVE
    // lights up a child and leaves the thread running. That is the whole answer
    // to "does it lock everything".
    const own = s.loading ? 'loading' : s.savingSync ? 'writing dump' : 'running'
    rdThread.querySelector('i')!.classList.toggle('on', true)
    rdThread.querySelector('b')!.textContent = own
    rdThread.classList.toggle('busy', s.loading || s.savingSync)

    rdSave.querySelector('i')!.classList.toggle('on', s.saving)
    rdSave.querySelector('b')!.textContent = s.saving ? 'writing' : '—'
    rdRewriteRow.querySelector('i')!.classList.toggle('on', s.rewriting)
    rdRewriteRow.querySelector('b')!.textContent = s.rewriting ? 'rewriting' : '—'
  }
  const btnCommand = $<HTMLButtonElement>('#btn-command')
  const btnRewrite = $<HTMLButtonElement>('#btn-rewrite')

  // the dump chips are actions, not a mode: mark the one in flight, clear it when
  // it comes back
  const rdbChips = Array.from(document.querySelectorAll<HTMLButtonElement>('#rdb-ops .regime'))
  const markRdb = (busy: string | null) => {
    for (const b of rdbChips) b.setAttribute('aria-pressed', String(b.dataset.rdb === busy))
  }
  for (const b of rdbChips) {
    b.addEventListener('click', () => {
      markRdb(b.dataset.rdb ?? null)
      const op = b.dataset.rdb
      if (op === 'save') handlers.save()
      else if (op === 'bgsave') handlers.bgsave()
      else if (op === 'load') handlers.load()
      window.setTimeout(() => markRdb(null), 1600)
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
  btnCommand.addEventListener('click', () => handlers.runCommand())
  btnRewrite.addEventListener('click', () => handlers.rewriteAof())
  speedIn.addEventListener('input', () => {
    const v = Number(speedIn.value)
    showSpeed(v)
    handlers.setSpeed(v)
  })

  // one toggle, lit when the scene is in grab-the-cage mode; the scene owns the
  // lit state, so this only asks for the change
  moveBtn.addEventListener('click', () => {
    handlers.setMove(moveBtn.getAttribute('aria-pressed') !== 'true')
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
    // space is "the next unit of work" for whichever database is on screen
    if (e.code === 'Space') {
      e.preventDefault()
      if (db === 'redis') handlers.runCommand()
      else handlers.runQuery()
    } else if (e.key === 'c') {
      handlers.checkpoint()
    } else if (e.key === 'v') {
      handlers.vacuum()
    } else if (e.key === 'f') {
      handlers.compact()
    }
  })

  // The two panels in the shelf open from the words in the bar below them. One
  // at a time: two open panels stacked over the scene is a wall, and the point of
  // the bar is that the scene has the room.
  const panelsInShelf: { btn: HTMLButtonElement; card: HTMLElement }[] = [
    { btn: $<HTMLButtonElement>('#btn-legend'), card: $<HTMLElement>('#legend-card') },
    { btn: $<HTMLButtonElement>('#btn-stories'), card: $<HTMLElement>('#stories-card') },
  ]
  for (const p of panelsInShelf) {
    p.btn.addEventListener('click', () => {
      const open = p.card.hidden
      for (const q of panelsInShelf) {
        q.card.hidden = true
        q.btn.classList.remove('on')
        q.btn.setAttribute('aria-pressed', 'false')
      }
      p.card.hidden = !open
      p.btn.classList.toggle('on', open === true)
      p.btn.setAttribute('aria-pressed', String(open))
    })
  }

  const busy = (el: HTMLElement, on: boolean) => el.classList.toggle('busy', on)

  return {
    setDb,
    /** one place that draws the clock speed, including from story mode */
    showSpeed,
    get db() {
      return db
    },
    setRedisBusy(s: {
      saving: boolean
      savingSync: boolean
      loading: boolean
      rewriting: boolean
    }) {
      syncRedisProcs(s)
    },
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
      // busy backends are already visible in the process list below, so this is
      // just the pool: how many connections are open against the limit
      stConn.textContent =
        s.connections === 0 ? '—' : `${s.connections}/${s.maxConnections}`
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

function setupCards() {
  // NO card folds any more. The legend and the story list are panels opened from
  // the words in the shelf bar, the database cards are opened from the two
  // switches, and the camera is a row in that bar — so a card is either on
  // screen in full or not on screen at all. Kept as a no-op hook for the call
  // site; there is nothing to wire.
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
