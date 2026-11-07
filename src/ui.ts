import type { Info } from './instance'
import type { SimStats } from './sim'

export interface HudHandlers {
  runQuery(): void
  checkpoint(): void
  vacuum(): void
  setIndexScan(on: boolean): void
  setOrbit(on: boolean): void
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

  const prBe = $<HTMLElement>('#pr-be')
  const prBeDot = $<HTMLElement>('#pr-be-dot')
  const prCk = $<HTMLElement>('#pr-ck')
  const prCkDot = $<HTMLElement>('#pr-ck-dot')
  const prWl = $<HTMLElement>('#pr-wl')
  const prWlDot = $<HTMLElement>('#pr-wl-dot')
  const prAv = $<HTMLElement>('#pr-av')
  const prAvDot = $<HTMLElement>('#pr-av-dot')

  const inspector = $<HTMLElement>('#inspector')
  const insTitle = $<HTMLElement>('#ins-title')
  const insBody = $<HTMLElement>('#ins-body')
  const insMeta = $<HTMLElement>('#ins-meta')

  const tooltip = $<HTMLElement>('#tooltip')
  const boot = $<HTMLElement>('#boot')

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

      setText(prBe, `${s.busyBackends} / ${s.connections}`)
      prBeDot.classList.toggle('on', s.busyBackends > 0)
      setText(prCk, s.checkpointing ? 'flushing' : 'idle')
      prCkDot.classList.toggle('on', s.checkpointing)
      setText(prWl, s.walBytes > 0 ? 'streaming' : 'idle')
      prWlDot.classList.toggle('on', s.walBytes > 0)
      setText(prAv, s.vacuuming ? 'reclaiming' : 'idle')
      prAvDot.classList.toggle('on', s.vacuuming)
    },
    inspect(info: Info) {
      insTitle.textContent = info.title
      insBody.textContent = info.body
      insMeta.textContent = info.meta ?? ''
      inspector.classList.add('pinned')
    },
    unpin() {
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
function setText(el: HTMLElement, v: string) {
  if (el.textContent !== v) el.textContent = v
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
