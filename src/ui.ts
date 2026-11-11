import type { Info } from './postgresql/instance'
import {
    POSTGRESQL_REGIME_NAME,
    POSTGRESQL_REGIME_ORDER,
    PostgresqlRegime,
    postgresqlRegimeLabel,
} from './postgresql/sim'
import type { SimStats } from './postgresql/sim'
import { fmtBytes } from './core/util'
import { Db, dbFromName } from './core/db'

export interface HudHandlers {
    runQuery(): void
    checkpoint(): void
    vacuum(): void
    compact(): void

    runCommand(): void

    save(): void

    bgsave(): void

    load(): void

    rewriteAof(): void
    setSpeed(v: number): void
    setRegime(r: PostgresqlRegime): void

    setMove(on: boolean): void

    setZen(on: boolean): void

    onDbPanel(db: Db | null): void
    unpin(): void
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!

export function initHud(handlers: HudHandlers) {
    const btnQuery = $<HTMLButtonElement>('#btn-query')
    const btnCheckpoint = $<HTMLButtonElement>('#btn-checkpoint')
    const btnVacuum = $<HTMLButtonElement>('#btn-vacuum')
    const btnCompact = $<HTMLButtonElement>('#btn-compact')
    const speedIn = $<HTMLInputElement>('#speed')
    const speedVal = $<HTMLElement>('#speed-val')
    const moveBtn = $<HTMLButtonElement>('#btn-move')
    const zenBtn = $<HTMLButtonElement>('#btn-zen')

    const showSpeed = (v: number) => {
        speedVal.textContent = v === 0 ? 'stopped' : `${v}×`

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

    const panels: Record<Db, HTMLElement> = {
        [Db.Postgres]: $<HTMLElement>('#db-postgres'),
        [Db.Redis]: $<HTMLElement>('#db-redis'),
    }
    const panelColumn = $<HTMLElement>('.panel.right')
    let db: Db | null = null

    const dbButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.dbtn'))

    const setDb = (next: Db | null) => {
        db = next
        for (const name of [Db.Postgres, Db.Redis]) panels[name].hidden = name !== next
        panelColumn.hidden = next === null
        document.body.classList.toggle('db-open', next !== null)
        for (const b of dbButtons) b.classList.toggle('active', dbFromName(b.dataset.db) === next)
    }
    for (const b of dbButtons) {
        b.addEventListener('click', () => {
            const name = dbFromName(b.dataset.db) ?? Db.Postgres
            const next = db === name ? null : name
            setDb(next)
            handlers.onDbPanel(next)
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
    const insTitleText = $<HTMLElement>('#ins-title-text')
    const insClose = $<HTMLElement>('#ins-close')
    const insBody = $<HTMLElement>('#ins-body')
    const insStats = $<HTMLElement>('#ins-stats')
    const insMeta = $<HTMLElement>('#ins-meta')

    let statsFn: Info['stats'] | null = null
    let lastStats = 0
    const renderStats = () => {
        if (!statsFn) {
            insStats.hidden = true
            insStats.replaceChildren()
            return
        }
        const rows = statsFn()
        insStats.hidden = rows.length === 0
        const frag = document.createDocumentFragment()
        for (const row of rows) {
            const dt = document.createElement('dt')
            dt.textContent = row.label
            const dd = document.createElement('dd')
            dd.textContent = row.value
            frag.append(dt, dd)
        }
        insStats.replaceChildren(frag)
    }
    const tooltip = $<HTMLElement>('#tooltip')
    const boot = $<HTMLElement>('#boot')

    setupCards()

    insClose.addEventListener('click', () => handlers.unpin())

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

    moveBtn.addEventListener('click', () => {
        handlers.setMove(moveBtn.getAttribute('aria-pressed') !== 'true')
    })

    zenBtn.addEventListener('click', () => {
        handlers.setZen(zenBtn.getAttribute('aria-pressed') !== 'true')
    })

    const regimeOpts = $<HTMLElement>('#regime-opts')
    const regimeButtons: HTMLButtonElement[] = []
    const markRegime = (r: PostgresqlRegime) => {
        for (const b of regimeButtons)
            b.setAttribute('aria-pressed', String(b.dataset.regime === POSTGRESQL_REGIME_NAME[r]))
    }
    for (const r of POSTGRESQL_REGIME_ORDER) {
        const b = document.createElement('button')
        b.className = 'regime'
        b.dataset.regime = POSTGRESQL_REGIME_NAME[r]
        b.textContent = postgresqlRegimeLabel(r)
        b.setAttribute('aria-pressed', String(r === PostgresqlRegime.Default))
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
            if (db === Db.Redis) handlers.runCommand()
            else handlers.runQuery()
        } else if (e.key === 'c') {
            handlers.checkpoint()
        } else if (e.key === 'v') {
            handlers.vacuum()
        } else if (e.key === 'f') {
            handlers.compact()
        }
    })

    const panelsInShelf: { btn: HTMLButtonElement; card: HTMLElement }[] = [
        { btn: $<HTMLButtonElement>('#btn-legend'), card: $<HTMLElement>('#legend-card') },
        { btn: $<HTMLButtonElement>('#btn-stories'), card: $<HTMLElement>('#stories-card') },
    ]
    for (const p of panelsInShelf) {
        p.btn.addEventListener('click', () => {
            const open = p.card.hidden
            closePanels()
            p.card.hidden = !open
            p.btn.classList.toggle('on', open === true)
            p.btn.setAttribute('aria-pressed', String(open))
        })
    }

    const closePanels = () => {
        for (const q of panelsInShelf) {
            q.card.hidden = true
            q.btn.classList.remove('on')
            q.btn.setAttribute('aria-pressed', 'false')
        }
    }

    const busy = (el: HTMLElement, on: boolean) => el.classList.toggle('busy', on)

    return {
        setDb,
        closePanels,
        showSpeed,
        setZen(on: boolean) {
            zenBtn.setAttribute('aria-pressed', String(on))
        },
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
        setRegime(r: PostgresqlRegime) {
            markRegime(r)
            handlers.setRegime(r)
        },
        setStats(s: SimStats) {
            stQueries.textContent = String(s.queries)
            stRps.textContent = `${s.rps.toFixed(1)} rps`

            stConn.textContent = s.connections === 0 ? '—' : `${s.connections}/${s.maxConnections}`
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
            insTitleText.textContent = info.title
            insBody.textContent = info.body
            insMeta.textContent = info.meta ?? ''
            statsFn = info.stats ?? null
            renderStats()
            inspector.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        },
        refreshStats() {
            if (inspector.hidden || !statsFn) return
            const now = performance.now()
            if (now - lastStats < 220) return
            lastStats = now
            renderStats()
        },
        unpin() {
            statsFn = null
            insStats.hidden = true
            inspector.hidden = true
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

function setupCards() {}

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
