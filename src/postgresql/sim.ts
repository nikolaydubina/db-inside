import * as THREE from 'three'
import { INBUF_CELLS, PALETTE, PostgresInstance } from './instance'
import type { BackendPod } from './instance'
import { QueryChain, pathCurve } from '../core/flow'
import type { FlowSet, Paths } from '../core/flow'
import {
    Ticker,
    easeInOutCubic,
    easeInQuad,
    easeOutCubic,
    halo,
    rand,
    randInt,
    speedTime,
    travel,
} from '../core/util'

export interface SimStats {
    queries: number
    hitRate: number
    latency: number
    walBytes: number

    walSegments: number

    walPending: number
    dead: number
    note: string
    connections: number
    maxConnections: number

    rps: number

    queued: number

    buffered: number
    busyBackends: number
    backendStates: boolean[]
    checkpointing: boolean
    vacuuming: boolean
    compacting: boolean
}

const RPS_WINDOW = 2

function makePacket(color: number, size: number, parent: THREE.Object3D) {
    const g = new THREE.Group()
    const core = new THREE.Mesh(
        new THREE.BoxGeometry(size, size, size),
        new THREE.MeshStandardMaterial({
            color: 0x0a1118,
            emissive: color,
            emissiveIntensity: 2.6,
            roughness: 0.25,
            metalness: 0.4,
        }),
    )
    g.add(core)
    g.add(halo(color, size * 5.2, 0.6))
    parent.add(g)
    return g
}

const despawn = (ticker: Ticker, parent: THREE.Object3D, obj: THREE.Object3D, dur = 0.3) => {
    void ticker
        .add(dur, (k) => {
            obj.scale.setScalar(Math.max(0.001, 1 - k))
            obj.rotation.y += 0.2
        })
        .then(() => parent.remove(obj))
}

type Statement = {
    sql: string
    kind: 'select' | 'insert' | 'delete'

    viaIndex: boolean

    weight: number
}

const STATEMENTS: Statement[] = [
    { sql: 'select … from users where id = $1', kind: 'select', viaIndex: true, weight: 3 },
    { sql: 'select … from products where doc @> $1', kind: 'select', viaIndex: true, weight: 1.6 },
    {
        sql: 'select … from metrics order by ts desc limit 20',
        kind: 'select',
        viaIndex: false,
        weight: 2,
    },
    { sql: 'insert into metrics (…) values (…)', kind: 'insert', viaIndex: false, weight: 1.4 },
    { sql: 'delete from users where id = $1', kind: 'delete', viaIndex: true, weight: 1 },
]

export type Regime = 'default' | 'read' | 'write' | 'burst'

const REGIMES: Record<Regime, { label: string; select: number; write: number; pace: number }> = {
    default: { label: 'default', select: 1, write: 1, pace: 1 },
    read: { label: 'read heavy', select: 4, write: 0.12, pace: 0.85 },
    write: { label: 'write heavy', select: 0.35, write: 7, pace: 0.9 },
    burst: { label: 'burst', select: 1, write: 1, pace: 0.3 },
}

export const REGIME_ORDER: Regime[] = ['default', 'read', 'write', 'burst']
export const regimeLabel = (r: Regime) => REGIMES[r].label

export class EngineSim {
    queries = 0
    accesses = 0
    hits = 0
    walBytes = 0
    live = 0

    indexScan = false

    private flushedBytes = 0

    private bufferedBytes = 0

    private walFlushTimer = 0.6
    private flushing = false

    ambient = true

    regime: Regime = 'default'
    note = 'shared_buffers · 8 kB pages'

    private parked: { pod: BackendPod; packet: THREE.Group }[] = []

    private running = new Set<number>()

    private completions: number[] = []

    lastOp = 'idle'

    lastArrowEnd: THREE.Vector3 | null = null
    lastLatency = 0.12

    private deadTimer = 2.5
    private scanTimer = 5
    private pageTimer = 0.6
    private connTimer = 3.5
    private checkpointing = false
    private vacuuming = false
    private compacting = false
    private compactTimer = 22
    private clock = 0
    private scanning = false
    private chains: QueryChain[] = []

    constructor(
        private inst: PostgresInstance,
        private ticker: Ticker,

        _scene: THREE.Scene,
        private paths: Paths,
        private flows: FlowSet,
    ) {}

    private get scene(): THREE.Object3D {
        return this.inst.group
    }

    get activeChains() {
        return this.chains.length
    }

    get rps() {
        const from = this.clock - RPS_WINDOW
        let n = 0
        for (const t of this.completions) if (t > from) n++
        return n / RPS_WINDOW
    }

    get clockTime() {
        return this.clock
    }

    get stats(): SimStats {
        const hitRate = this.accesses === 0 ? 0 : (this.hits / this.accesses) * 100
        const max = this.inst.maxBackendCount
        return {
            queries: this.queries,
            hitRate,
            latency: this.lastLatency,
            walBytes: this.walBytes,
            walSegments: this.inst.walFilledSegments,
            walPending: Math.max(0, this.walBytes - this.flushedBytes),
            dead: this.inst.deadTuples,
            note:
                this.queued > 0
                    ? `${this.queued} request${this.queued === 1 ? '' : 's'} blocked in socket buffers · backpressure, nothing dropped`
                    : this.note,
            connections: this.inst.activeBackendCount,
            maxConnections: max,
            rps: this.rps,
            queued: this.queued,
            buffered: this.inst.backends.reduce((n, b) => n + b.inbuf, 0),
            busyBackends: this.inst.busyBackendCount,
            backendStates: this.inst.backendStates,
            checkpointing: this.checkpointing,
            vacuuming: this.vacuuming,
            compacting: this.compacting,
        }
    }

    private execTo(from: THREE.Vector3, target: THREE.Vector3) {
        return pathCurve([
            from.clone(),
            from.clone().add(new THREE.Vector3(0.55, -0.75, -0.9)),
            new THREE.Vector3(from.x * 0.35, 6.6, 0.4),
            target.clone().add(new THREE.Vector3(0, 1.2, 0)),
            target,
        ])
    }

    private readonly walFlushArc = (from: THREE.Vector3, head: THREE.Vector3) =>
        pathCurve([
            from,
            from.clone().add(new THREE.Vector3(0, 0.85, 0.15)),
            head.clone().add(new THREE.Vector3(0, 1.15, 0)),
            head,
        ])

    get queued() {
        return this.parked.length
    }

    private pickPod(): BackendPod | null {
        const pods = this.inst.backends
        const open = pods.filter((b) => b.active)
        const free = open.filter((b) => !b.busy && b.pending === 0)
        if (free.length > 0) {
            const pod = free[randInt(0, free.length - 1)]
            pod.pending++
            return pod
        }
        if (open.length < pods.length) {
            const fresh = this.inst.openBackend()
            if (!fresh) return null
            fresh.pending++
            return fresh
        }
        let best = open[0]
        for (const b of open) if (b.inbuf + b.pending < best.inbuf + best.pending) best = b
        best.pending++
        return best
    }

    private async serve(pod: BackendPod) {
        try {
            for (;;) {
                await this.querySequence(pod)
                this.completions.push(this.clock)
                if (pod.inbuf <= 0) break
                pod.inbuf--
            }
        } catch {
            pod.inbuf = 0
        } finally {
            this.running.delete(pod.id)
            pod.busy = false
            this.inst.releaseBackend(pod)
            this.live--
        }
    }

    async runQuery() {
        const pod = this.pickPod()
        if (!pod) return
        void this.send(pod)
    }

    private async send(pod: BackendPod) {
        const origin = pod.group.position.clone()
        const inPort = new THREE.Vector3(origin.x, 10.35, origin.z - 0.34)
        const packet = makePacket(PALETTE.magenta, 0.42, this.scene)
        packet.position.set(inPort.x, 42, inPort.z)
        this.inst.pulseBackend(pod)
        const inbound = pathCurve([
            packet.position.clone(),
            new THREE.Vector3(inPort.x, 26, inPort.z + 0.8),
            new THREE.Vector3(inPort.x, 13.4, inPort.z + 0.3),
            inPort,
        ])
        const wire = new QueryChain(this.scene)
        const fIn = wire.addCurve(inbound, PALETTE.magenta, { speed: 0.7, opacity: 0.32 })
        await travel(this.ticker, packet, inbound, speedTime(inbound), easeInQuad)
        fIn.flash(0.9)
        void this.ticker.wait(0.4).then(() => wire.fadeOut(this.ticker, 0.9))
        this.arrive(pod, packet)
    }

    private arrive(pod: BackendPod, packet: THREE.Group) {
        if (pod.pending > 0) pod.pending--
        if (this.canAdmit(pod)) this.admit(pod, packet)
        else this.parked.push({ pod, packet })
    }

    private canAdmit(pod: BackendPod) {
        if (!this.running.has(pod.id)) return true
        return pod.inbuf < INBUF_CELLS - 1
    }

    private admit(pod: BackendPod, packet: THREE.Group) {
        const queued = this.running.has(pod.id) ? pod.inbuf + 1 : 0
        const entry = this.inst.backendBufferEntry(pod, queued)
        const drop = pathCurve([packet.position.clone(), entry])
        void travel(this.ticker, packet, drop, speedTime(drop)).then(() =>
            despawn(this.ticker, this.scene, packet, 0.15),
        )
        this.inst.pulseBackend(pod)
        if (!this.running.has(pod.id)) {
            this.running.add(pod.id)
            pod.busy = true
            this.live++
            void this.serve(pod)
        } else {
            pod.inbuf++
        }
    }

    private async querySequence(pod: BackendPod) {
        const stmt = this.pickStatement()
        const kind = stmt.kind
        const hit = kind === 'select' && Math.random() < (stmt.viaIndex ? 0.9 : 0.78)
        this.indexScan = stmt.viaIndex
        this.inst.indexScan = stmt.viaIndex
        if (stmt.viaIndex) this.flows.indexToBuffer.flash(0.5)
        this.queries++

        const origin = pod.group.position.clone()
        const outPort = new THREE.Vector3(origin.x, 10.35, origin.z + 0.34)
        const chain = new QueryChain(this.scene)
        this.chains.push(chain)

        const bufferExit = this.inst.backendBufferExit(pod)
        const pipe = pod.pipeline.nodes
        const parse = pipe.parse.group.position.clone()
        const plan = pipe.plan.group.position.clone()
        const exec = pipe.exec.group.position.clone()
        const packet = makePacket(PALETTE.magenta, 0.42, this.scene)
        packet.position.copy(bufferExit)

        try {
            const toParse = pathCurve([
                bufferExit,
                new THREE.Vector3(origin.x, 8.4, 5.3),
                new THREE.Vector3(parse.x + 0.75, 8.62, 5.0),
                parse.clone(),
            ])
            const fToParse = chain.addCurve(toParse, PALETTE.cyan, {
                speed: 0.55,
                opacity: 0.36,
            })
            await travel(this.ticker, packet, toParse, speedTime(toParse))
            this.inst.pulseNode(pod, 'parse', 0.8)
            fToParse.flash(0.8)

            const parseCurve = pathCurve([
                parse,
                parse
                    .clone()
                    .lerp(plan, 0.5)
                    .add(new THREE.Vector3(0.45, 0.18, 0)),
                plan,
            ])
            const fParse = chain.addCurve(parseCurve, PALETTE.cyan, {
                speed: 0.55,
                opacity: 0.4,
            })
            await travel(this.ticker, packet, parseCurve, speedTime(parseCurve))
            this.inst.pulseNode(pod, 'plan', 0.9)
            fParse.flash(0.8)
            await this.ticker.wait(0.08)

            const planCurve = pathCurve([
                plan,
                plan
                    .clone()
                    .lerp(exec, 0.5)
                    .add(new THREE.Vector3(0.45, 0.18, 0)),
                exec,
            ])
            const fPlan = chain.addCurve(planCurve, PALETTE.cyan, {
                speed: 0.55,
                opacity: 0.4,
            })
            await travel(this.ticker, packet, planCurve, speedTime(planCurve))
            this.inst.pulseNode(pod, 'exec', 1)
            fPlan.flash(0.8)

            const writes = kind === 'insert' || kind === 'delete'
            if (writes) {
                const walBytesFor = kind === 'insert' ? 384 : 320
                const walTo = this.inst.pathEnd('walBuf')
                const walFrom = exec.clone()
                const walCurve = pathCurve([
                    walFrom,
                    walFrom.clone().add(new THREE.Vector3(0.35, -0.7, -0.9)),
                    walTo.clone().add(new THREE.Vector3(0, 1.0, 0)),
                    walTo,
                ])
                const walPack = makePacket(PALETTE.amber, 0.2, this.scene)
                walPack.position.copy(walFrom)
                void travel(this.ticker, walPack, walCurve, speedTime(walCurve)).then(() => {
                    this.inst.appendWal(0.3)
                    this.walBytes += walBytesFor
                    this.bufferedBytes += walBytesFor
                    despawn(this.ticker, this.scene, walPack, 0.22)
                })
                this.flows.execToWal.flash(0.7)
            }

            let pageIdx = this.inst.pickBufferPage()

            if (kind === 'insert' || kind === 'delete') {
                const execCurve = this.execTo(exec, this.paths.bufferTop.clone())
                const fExec = chain.addCurve(execCurve, PALETTE.teal, {
                    speed: 0.5,
                    opacity: 0.4,
                })
                await travel(this.ticker, packet, execCurve, speedTime(execCurve))
                fExec.flash(0.75)

                const slot = this.inst.writeIntoBuffer(kind)
                if (slot) {
                    const to = this.inst.pageTop(slot.page)
                    const from = packet.position.clone()
                    const down = pathCurve([
                        from,
                        from
                            .clone()
                            .lerp(to, 0.5)
                            .add(new THREE.Vector3(0, 1.4, 0)),
                        to,
                    ])
                    const fDown = chain.addCurve(
                        down,
                        kind === 'insert' ? 0xc7ff5a : PALETTE.magenta,
                        { speed: 0.5, opacity: 0.45 },
                    )
                    await travel(this.ticker, packet, down, speedTime(down))
                    fDown.flash(0.85)
                    this.inst.setPageActive(
                        slot.idx,
                        kind === 'insert' ? 0xc7ff5a : PALETTE.magenta,
                        1.2,
                    )
                    const owner = slot.page.block?.table
                    this.lastOp = `${kind} → buffer slot ${slot.idx}${owner ? ` (${owner})` : ''} · dirty`
                    this.lastArrowEnd = to.clone()
                }
                despawn(this.ticker, this.scene, packet, 0.2)

                this.accesses++
                this.hits += kind === 'insert' ? 0 : 0
                this.lastLatency = rand(0.3, 1.4)
                this.note =
                    kind === 'insert'
                        ? 'insert · buffer page dirtied, still only in RAM until the checkpointer writes it back'
                        : 'delete · buffer page dirtied, dead tuples stay in the page until VACUUM'
                if (kind === 'delete') this.inst.markDeadTuples(1)
            } else if (hit) {
                const page = this.inst.pages[pageIdx]
                const toPage = this.inst.pageTop(page)
                const execCurve = this.execTo(exec, toPage)
                const fExec = chain.addCurve(execCurve, PALETTE.teal, {
                    speed: 0.5,
                    opacity: 0.44,
                })
                await travel(this.ticker, packet, execCurve, speedTime(execCurve))
                fExec.flash(0.8)
                this.inst.setPageActive(pageIdx, PALETTE.teal, 1.3)
                this.lastArrowEnd = toPage.clone()
                this.note = `${stmt.viaIndex ? 'index scan' : 'seq scan'} · buffer hit, page already in RAM ≈ 0.1 ms`
                despawn(this.ticker, this.scene, packet, 0.22)
                this.hits++
                this.accesses++
                this.lastLatency = rand(0.04, 0.18)
            } else {
                pageIdx = this.inst.pickBufferPage()
                const page = this.inst.pages[pageIdx]
                const slotTop = this.inst.pageTop(page)

                const execCurve = this.execTo(exec, slotTop)
                const fExec = chain.addCurve(execCurve, PALETTE.teal, {
                    speed: 0.5,
                    opacity: 0.4,
                })
                await travel(this.ticker, packet, execCurve, speedTime(execCurve))
                fExec.flash(0.7)

                const target = this.inst.pickBlockForRead()
                const toBlock = target ? this.inst.blockTop(target) : this.paths.diskTop.clone()

                const down = pathCurve([
                    slotTop,
                    slotTop
                        .clone()
                        .lerp(toBlock, 0.4)
                        .add(new THREE.Vector3(0, 0.6, 0)),
                    toBlock.clone().add(new THREE.Vector3(0, 1.6, 0)),
                    toBlock,
                ])
                const fDown = chain.addCurve(down, PALETTE.amber, {
                    speed: 0.5,
                    opacity: 0.42,
                })
                await travel(this.ticker, packet, down, speedTime(down), easeInOutCubic)
                fDown.flash(0.9)
                this.lastArrowEnd = toBlock.clone()
                if (target) {
                    this.inst.touchBlocks([target], PALETTE.amber, 0.55, 1.15)
                    this.lastOp = `read ${target.table ?? 'free'}[${target.row},${target.col}]`
                }

                const up = pathCurve([
                    toBlock,
                    toBlock.clone().add(new THREE.Vector3(0, 1.9, 0)),
                    new THREE.Vector3(2.2, 4.7, 1.2),
                    slotTop.clone().add(new THREE.Vector3(0, 2.4, 0)),
                    slotTop,
                ])
                const fUp = chain.addCurve(up, PALETTE.amber, {
                    speed: 0.5,
                    opacity: 0.42,
                })
                const packetCore = packet.children[0] as THREE.Mesh
                ;(packetCore.material as THREE.MeshStandardMaterial).emissive.setHex(PALETTE.amber)
                this.inst.liftFromDisk(pageIdx)
                await travel(this.ticker, packet, up, speedTime(up))
                fUp.flash(0.8)
                this.inst.setPageActive(pageIdx, PALETTE.amber, 1.2)
                void this.inst.swapBufferPage(pageIdx, target ? target.fill : 0.5, target)
                void this.ticker.add(0.7, (k) => {
                    page.base.lerpColors(
                        new THREE.Color(PALETTE.amber),
                        new THREE.Color(PALETTE.cyan),
                        k,
                    )
                })
                despawn(this.ticker, this.scene, packet, 0.25)
                this.accesses++
                this.lastLatency = rand(0.4, 1.9)
                this.note = `${stmt.viaIndex ? 'index scan' : 'seq scan'} · buffer miss, page fetched from disk ≈ 1 ms`
                this.inst.markDeadTuples(1)
            }

            if (writes) await this.walDurable()

            const rows = makePacket(PALETTE.teal, 0.3, this.scene)
            rows.position.copy(exec)
            const toPort = pathCurve([
                exec,
                new THREE.Vector3(origin.x * 0.95, 9.2, origin.z - 2.0),
                outPort.clone(),
            ])
            const fRows = chain.addCurve(toPort, PALETTE.ice, {
                speed: 0.55,
                opacity: 0.44,
            })
            await travel(this.ticker, rows, toPort, speedTime(toPort))
            this.inst.pulseBackend(pod)
            fRows.flash(0.85)
            despawn(this.ticker, this.scene, rows, 0.2)

            const outbound = pathCurve([
                outPort,
                new THREE.Vector3(outPort.x + 0.3, 13.4, outPort.z + 0.3),
                new THREE.Vector3(outPort.x + 0.5, 26, outPort.z + 0.8),
                new THREE.Vector3(outPort.x + 0.5, 42, outPort.z + 0.6),
            ])
            chain.addCurve(outbound, PALETTE.teal, { speed: 0.7, opacity: 0.3 })
            const out = makePacket(PALETTE.teal, 0.26, this.scene)
            await travel(this.ticker, out, outbound, speedTime(outbound), easeOutCubic)
            despawn(this.ticker, this.scene, out, 0.3)
        } finally {
            chain.fadeOut(this.ticker, 1.25)
        }
    }

    get arrivalGap() {
        return REGIMES[this.regime].pace
    }

    setRegime(r: Regime) {
        if (r === this.regime) return
        this.regime = r
        this.note = `workload · ${REGIMES[r].label}`
    }

    private pickStatement(): Statement {
        const mix = REGIMES[this.regime]
        const weightOf = (s: Statement) => s.weight * (s.kind === 'select' ? mix.select : mix.write)
        let total = 0
        for (const s of STATEMENTS) total += weightOf(s)
        let r = Math.random() * total
        for (const s of STATEMENTS) {
            r -= weightOf(s)
            if (r <= 0) return s
        }
        return STATEMENTS[0]
    }

    private async walDurable(timeout = 3) {
        let waited = 0
        while (this.inst.walBuffered > 0.02 && waited < timeout) {
            await this.ticker.wait(0.08)
            waited += 0.08
        }
    }

    async flush() {
        if (this.flushing) return
        this.flushing = true
        try {
            this.note = 'commit · XLogFlush waiting for the WAL tail to reach disk'
            await this.inst.flushWal()
            this.flushedBytes = this.walBytes
            this.note = 'commit returned · everything up to this LSN is durable'
        } finally {
            this.flushing = false
        }
    }

    async checkpoint() {
        if (this.checkpointing) return
        this.checkpointing = true
        this.note = 'checkpoint · flushing dirty pages + fsync wal'
        try {
            const dirty = this.inst.pages.filter((p) => p.dirty && p.block)
            await this.inst.dirtyPages(12)
            await this.inst.flushWal()
            this.flushedBytes = this.walBytes

            const segs = this.inst.walFilledSegments
            for (let i = 0; i < segs; i++) {
                this.inst.flashWalSegment(i)
                await this.ticker.wait(0.05)
            }
            await this.ticker.wait(0.4)

            const leaving = dirty.length > 0 ? dirty : this.inst.pages.slice(0, 7)
            for (const page of leaving.slice(0, 7)) {
                const target = page.block
                const copy = makePacket(PALETTE.amber, 0.26, this.scene)
                const start = this.inst.pageTop(page)
                copy.position.copy(start)
                const dest = target ? this.inst.blockTop(target) : this.paths.diskTop.clone()
                const curve = pathCurve([
                    start,
                    start
                        .clone()
                        .lerp(dest, 0.45)
                        .add(new THREE.Vector3(0, 1.6, 0)),
                    dest,
                ])
                void travel(this.ticker, copy, curve, speedTime(curve)).then(() => {
                    if (target) {
                        this.inst.touchBlocks([target], PALETTE.amber, 0.55, 1.15)
                        this.lastOp = `checkpoint write ${target.table ?? 'free'}[${target.row},${target.col}]`
                    }
                    this.inst.flashDisk()
                    despawn(this.ticker, this.scene, copy, 0.2)
                })
                await this.ticker.wait(0.06)
            }

            await this.ticker.wait(0.85)
            this.inst.flashDisk()
            this.inst.cleanAllPages()
            this.inst.recycleWal()
            this.inst.walBuffered = 0
            this.bufferedBytes = 0
            this.note = 'checkpoint complete · dirty pages + WAL durable, segments recycled'
        } finally {
            this.checkpointing = false
        }
    }

    async compact() {
        if (this.compacting) return
        this.compacting = true
        this.note = 'vacuum full · rewriting a table into a packed new file'
        try {
            const res = await this.inst.compact()
            this.note = `vacuum full · ${res.table} rewritten, ${res.pages} pages packed, tail freed`
        } finally {
            this.compacting = false
        }
    }

    async vacuum() {
        if (this.vacuuming) return
        this.vacuuming = true
        try {
            const n = await this.inst.vacuum()
            this.note = n
                ? `vacuum · ${n} dead tuple${n > 1 ? 's' : ''} reclaimed for reuse`
                : 'vacuum · nothing to reclaim, heap is clean'
        } finally {
            this.vacuuming = false
        }
    }

    update(dt: number) {
        for (const [line, path] of this.flows.live) line.follow(path)
        for (const f of this.flows.all) f.update(dt)

        this.chains = this.chains.filter((c) => {
            c.update(dt)
            return !c.disposed
        })

        this.clock += dt
        const perPod = new Map<number, number>()
        for (let i = 0; i < this.parked.length; i++) {
            const p = this.parked[i]
            if (this.canAdmit(p.pod)) {
                this.admit(p.pod, p.packet)
                this.parked.splice(i--, 1)
                continue
            }
            const n = perPod.get(p.pod.id) ?? 0
            perPod.set(p.pod.id, n + 1)
            const target = p.pod.group.position.clone().add(new THREE.Vector3(0, 1.9 + n * 0.6, 0))
            p.packet.position.lerp(target, Math.min(1, dt * 5))
            p.packet.rotation.y += dt * 1.6
        }

        for (const b of this.inst.backends) {
            if (b.active && b.inbuf > 0 && !this.running.has(b.id)) {
                this.running.add(b.id)
                b.busy = true
                this.live++
                void this.serve(b)
            }
        }
        if (this.completions.length > 0) {
            const from = this.clock - RPS_WINDOW
            while (this.completions.length > 0 && this.completions[0] <= from)
                this.completions.shift()
        }
        this.inst.update(dt, this.clock)

        if (this.ambient) {
            this.connTimer -= dt
            if (this.connTimer <= 0) {
                this.connTimer = rand(3.5, 8.5)
                const active = this.inst.activeBackendCount
                if (active < 2) this.inst.openBackend()
                else if (active < 6 && Math.random() < 0.6) this.inst.openBackend()
                else if (active > 2) this.inst.closeBackend()
            }
        }

        this.deadTimer -= dt
        if (this.deadTimer <= 0) {
            this.deadTimer = rand(3.2, 6.5)
            this.inst.markDeadTuples(randInt(1, 2))
        }

        if (this.inst.walBuffered > 0.02) {
            this.walFlushTimer -= dt
            if (this.walFlushTimer <= 0) {
                this.walFlushTimer = rand(1.3, 1.9)
                const from = this.inst.walBufferTop()
                const head = this.inst.walHeadTop()
                const flushingBytes = this.bufferedBytes
                const pack = makePacket(PALETTE.ice, 0.22, this.scene)
                pack.position.copy(from)
                const arc = this.walFlushArc(from, head)
                void travel(this.ticker, pack, arc, speedTime(arc)).then(() => {
                    if (this.inst.flushWalBuffers() > 0) {
                        this.flushedBytes += flushingBytes
                        this.bufferedBytes = Math.max(0, this.bufferedBytes - flushingBytes)
                    }
                    despawn(this.ticker, this.scene, pack, 0.18)
                })
            }
        } else {
            this.walFlushTimer = 1.2
        }

        this.compactTimer -= dt
        if (this.compactTimer <= 0 && !this.compacting) {
            this.compactTimer = rand(30, 55)
            this.note = 'pg_repack · rebuilding a table online, pages packed'
            this.compacting = true
            void this.inst.compact().then((res) => {
                this.note = `pg_repack · ${res.table} packed into ${res.pages} pages`
                this.compacting = false
            })
        }

        this.scanTimer -= dt
        if (this.scanTimer <= 0 && !this.scanning) {
            this.scanTimer = rand(6.5, 11)
            this.scanning = true
            const viaIndex = Math.random() < 0.5
            const flow = viaIndex ? this.flows.indexToBuffer : this.flows.heapToBuffer
            flow.flash(0.7)
            if (viaIndex && Math.random() < 0.5) this.flows.ginToBuffer.flash(0.6)
            const run = viaIndex ? this.inst.scanIndex() : this.inst.scanHeap()
            void run.then(() => {
                this.scanning = false
            })
        }

        this.pageTimer -= dt
        if (this.pageTimer <= 0) {
            this.pageTimer = rand(0.45, 1.3)
            const p = this.inst.pages[randInt(0, this.inst.pages.length - 1)]
            p.heat = Math.max(p.heat, rand(0.12, 0.4))
        }
    }
}
