import type * as THREE from 'three'
import type { Page8K, PostgresInstance } from './instance'
import type { EngineSim } from './sim'

/**
 * Console telemetry for the simulation. Reading the scene off a screenshot is
 * guesswork; this dumps the actual state on a virtual-time tick instead.
 *
 *   __psqlDebug.on()            start logging one line per tick
 *   __psqlDebug.off()
 *   __psqlDebug.snapshot()      current state as a plain object
 *   __psqlDebug.history(40)     the last N ticks as a table
 *   __psqlDebug.every(1)        log every N virtual seconds
 *
 * Open the page with ?debug in the URL to have it on from boot.
 */

export interface TableStat {
    pages: number
    allocated: number
    empty: number
    dead: number
    avgFill: number
}

export interface Snapshot {
    t: number
    speed: number
    fps: number
    draws: number
    tris: number
    queries: number
    hitRate: number
    latency: number
    walBytes: number
    walFill: number
    deadRows: number
    connections: number
    busyBackends: number
    maintenance: string[]
    note: string
    chains: number
    disk: {
        blocks: number
        occupied: number
        free: number
        deadPages: number
        avgFill: number
    }
    tables: Record<string, TableStat>
    buffers: {
        pages: number
        dirty: number
        hot: number
    }
}

interface Deps {
    sim: EngineSim
    inst: PostgresInstance
    renderer: THREE.WebGLRenderer
    speed: () => number
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d

export function installTelemetry({ sim, inst, renderer, speed }: Deps) {
    let enabled = false
    let logEvery = 2
    let acc = 0
    let frames = 0
    let fpsAcc = 0
    let fps = 0
    const history: Snapshot[] = []

    const tableStat = (label: string): TableStat => {
        const blocks = inst.tableBlocks.filter((b) => b.table === label)
        const allocated = blocks.filter((b) => b.fill > 0)
        return {
            pages: blocks.length,
            allocated: allocated.length,
            empty: blocks.length - allocated.length,
            dead: blocks.filter((b) => b.dead).length,
            avgFill: allocated.length
                ? round(allocated.reduce((a: number, b: Page8K) => a + b.fill, 0) / allocated.length, 2)
                : 0,
        }
    }

    function snapshot(): Snapshot {
        const stats = sim.stats
        const occupied = inst.pages8k.filter((p) => !p.free)
        const filled = occupied.filter((p) => p.fill > 0)
        const maintenance: string[] = []
        if (stats.checkpointing) maintenance.push('checkpoint')
        if (stats.vacuuming) maintenance.push('vacuum')
        if (stats.compacting) maintenance.push('vacuum-full')
        if (sim.indexScan) maintenance.push('index-scan')

        const tables: Record<string, TableStat> = {}
        for (const label of ['users', 'products', 'metrics']) tables[label] = tableStat(label)

        return {
            t: round(sim.clockTime, 1),
            speed: speed(),
            fps: round(fps, 0),
            draws: renderer.info.render.calls,
            tris: renderer.info.render.triangles,
            queries: stats.queries,
            hitRate: round(stats.hitRate, 1),
            latency: round(stats.latency, 2),
            walBytes: stats.walBytes,
            walFill: round(inst.walFill, 2),
            deadRows: stats.dead,
            connections: stats.connections,
            busyBackends: stats.busyBackends,
            maintenance,
            note: stats.note,
            chains: sim.activeChains,
            disk: {
                blocks: inst.pages8k.length,
                occupied: occupied.length,
                free: inst.pages8k.length - occupied.length,
                deadPages: inst.pages8k.filter((p) => p.dead).length,
                avgFill: filled.length
                    ? round(filled.reduce((a, p) => a + p.fill, 0) / filled.length, 2)
                    : 0,
            },
            tables,
            buffers: {
                pages: inst.pages.length,
                dirty: inst.pages.filter((p) => p.dirty).length,
                hot: inst.pages.filter((p) => p.heat > 0.2).length,
            },
        }
    }

    function log(s: Snapshot) {
        const tag = `[psql ${s.t}s ${s.speed}x]`
        console.log(
            `${tag} ${s.note}\n` +
            `  q=${s.queries} hit=${s.hitRate}% lat=${s.latency}ms dead=${s.deadRows} ` +
            `conn=${s.connections}(${s.busyBackends} busy) wal=${s.walBytes}B fill=${s.walFill} ` +
            `chains=${s.chains} disk=${s.disk.occupied}/${s.disk.blocks} free=${s.disk.free} ` +
            `deadPages=${s.disk.deadPages} avgFill=${s.disk.avgFill} ` +
            `buf=${s.buffers.dirty}d/${s.buffers.pages} draw=${s.draws} fps=${s.fps}` +
            (s.maintenance.length ? ` [${s.maintenance.join(',')}]` : ''),
        )
    }

    function tick(dt: number, rawDt: number) {
        frames++
        fpsAcc += rawDt
        if (fpsAcc >= 0.5) {
            fps = frames / fpsAcc
            frames = 0
            fpsAcc = 0
        }
        acc += dt
        if (acc < logEvery) return
        acc = 0
        const s = snapshot()
        history.push(s)
        if (history.length > 300) history.shift()
        if (enabled) log(s)
    }

    const api = {
        on(every = 2) {
            logEvery = every
            enabled = true
            log(snapshot())
            return `telemetry on · every ${every}s of virtual time`
        },
        off() {
            enabled = false
            return 'telemetry off'
        },
        every(seconds: number) {
            logEvery = Math.max(0.1, seconds)
            return `inspect every ${logEvery}s`
        },
        snapshot,
        history(n = 20) {
            return history.slice(-n)
        },
        /** quick look at one table's page distribution */
        table(label = 'users') {
            const blocks = inst.tableBlocks.filter((b) => b.table === label)
            const buckets = new Array(10).fill(0)
            for (const b of blocks) buckets[Math.min(9, Math.floor(b.fill * 10))]++
            return {
                label,
                blocks: blocks.length,
                fillHistogram: buckets.map((count, i) => ({ fill: `${i * 10}-${i * 10 + 10}%`, count })),
            }
        },
    }

    return { tick, api }
}
