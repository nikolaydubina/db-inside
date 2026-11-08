import * as THREE from 'three'
import { PALETTE } from './instance'
import type { RedisInstance, RedisKey, RedisPort } from './redis'
import { QueryChain, pathCurve } from './flow'
import { Ticker, easeInQuad, easeOutCubic, halo, rand, randInt, travel } from './util'

export interface RedisStats {
    ops: number
    opsPerSec: number
    keys: number
    capacity: number
    memPct: number
    hitRate: number
    latency: number
    evictions: number
    aofBytes: number
    rdbBytes: number
    note: string
    connections: number
    busy: boolean
    saving: boolean
    savingSync: boolean
    loading: boolean
    rewriting: boolean
}

interface Command {
    name: string
    write: boolean
    /** share of the traffic */
    weight: number
}

/**
 * The command mix. Redis does not have statements that a planner can rewrite:
 * a command is a name and argv, executed immediately in one pass. What matters
 * is only whether it reads the keyspace or also appends to the AOF.
 */
const COMMANDS: Command[] = [
    { name: 'GET', write: false, weight: 40 },
    { name: 'MGET', write: false, weight: 8 },
    { name: 'SET', write: true, weight: 26 },
    { name: 'INCR', write: true, weight: 8 },
    { name: 'HSET', write: true, weight: 7 },
    { name: 'EXPIRE', write: true, weight: 5 },
    { name: 'DEL', write: true, weight: 6 },
]

const pickCommand = (): Command => {
    const total = COMMANDS.reduce((n, c) => n + c.weight, 0)
    let r = Math.random() * total
    for (const c of COMMANDS) {
        r -= c.weight
        if (r <= 0) return c
    }
    return COMMANDS[0]
}

/**
 * How far above the socket client traffic starts, in cage-local units. Same idea
 * as the postgres side: the client is never drawn, the packet enters the frame
 * already on its way down, ~32 units above the port.
 */
const SKY_ABOVE_PORT = 32

function makePacket(color: number, size: number, parent: THREE.Object3D) {
    const g = new THREE.Group()
    const core = new THREE.Mesh(
        new THREE.BoxGeometry(size, size, size),
        new THREE.MeshStandardMaterial({
            color: 0x0a1118,
            emissive: color,
            emissiveIntensity: 2.4,
            roughness: 0.25,
            metalness: 0.4,
        }),
    )
    g.add(core)
    g.add(halo(color, size * 5, 0.55))
    parent.add(g)
    return g
}

const despawn = (ticker: Ticker, obj: THREE.Object3D, dur = 0.25) => {
    void ticker
        .add(dur, (k) => {
            obj.scale.setScalar(Math.max(0.001, 1 - k))
        })
        .then(() => obj.parent?.remove(obj))
}

/** Window for the throughput figure, in simulated seconds. */
const OPS_WINDOW = 2

export class RedisSim {
    ops = 0
    /** Writes refused because the log could not grow — MISCONF, not data loss. */
    refused = 0
    private hits = 0
    private misses = 0
    private latencies: number[] = []
    /** simulated timestamps of recent ops, for the throughput figure */
    private recent: number[] = []
    private clock = 0
    private inFlight = 0
    private nextArrival = 0.4
    private saveTimer = 6
    /**
     * appendfsync everysec: the buffer is flushed (write + fsync) once a second.
     * That interval IS the durability window — not a drain rate we picked.
     */
    private fsyncTimer = 1
    /**
     * auto-aof-rewrite-percentage and …-min-size, in the units this diagram has:
     * blocks, not bytes. Redis defaults are 100 % growth and 64 MB; the rule is
     * the same, the scale is not.
     */
    private readonly rewriteGrowth = 2
    private readonly rewriteMinBlocks = 6
    /** Log size right after the last rewrite — the baseline the growth is measured from. */
    private blocksAtLastRewrite = 0
    saving = false
    /** SAVE holds the one thread; BGSAVE does not. */
    blocked = false
    /** Start-up: the base file, then the log, and no listener until both are in. */
    loading = false
    rewriting = false
    ambient = true

    constructor(
        private redis: RedisInstance,
        private ticker: Ticker,
    ) {
        // A process that has just been started: the files are on the floor, the
        // memory is empty, the ports are not open. The load is what turns that
        // into a server, and starting from here rather than from a running
        // instance is what makes the restart honest.
        this.blocksAtLastRewrite = this.redis.aofUsed
        this.bootDataset = this.redis.dataset
        this.redis.shutPorts()
        this.redis.wipeMemory()
        this.note = 'starting · files on disk, nothing in memory, no listener'
    }

    /** What the instance held before the first load emptied it. */
    private bootDataset: boolean[] = []

    get stats(): RedisStats {
        const recent = this.recent.filter((t) => this.clock - t <= OPS_WINDOW)
        const span = Math.min(OPS_WINDOW, Math.max(0.5, this.clock))
        const live = this.redis.liveKeys
        return {
            ops: this.ops,
            opsPerSec: recent.length / span,
            keys: live,
            capacity: this.redis.capacity,
            memPct: (live / this.redis.capacity) * 100,
            hitRate: this.hits + this.misses > 0 ? (this.hits / (this.hits + this.misses)) * 100 : 0,
            latency: this.latency,
            evictions: this.redis.evictions,
            aofBytes: this.redis.aofBytes,
            rdbBytes: this.redis.rdbBytes,
            note: this.lockedNote ?? this.note,
            connections: this.redis.ports.filter((p) => p.active).length,
            busy: this.redis.ports.some((p) => p.busy),
            saving: this.saving,
            savingSync: this.blocked,
            loading: this.loading,
            rewriting: this.rewriting,
        }
    }

    private note = 'idle'
    /** A note that owns the status line while a blocking job runs. */
    private lockedNote: string | null = null

    /* --------------------------------- traffic ------------------------------- */

    private pickPort(): RedisPort | null {
        const open = this.redis.ports.filter((p) => p.active && !p.busy)
        if (open.length > 0) return open[randInt(0, open.length - 1)]
        const any = this.redis.ports.filter((p) => p.active)
        return any.length > 0 ? any[randInt(0, any.length - 1)] : null
    }

    /** One command: request down, execution, reply back up the same socket. */
    private async runOp() {
        // nothing is served while the files are being read back
        if (this.loading) return
        const pod = this.pickPort()
        if (!pod) return
        const cmd = pickCommand()
        this.inFlight++

        // Everything below is in CAGE-LOCAL units and the paths are parented to
        // the cage, so sliding the cage takes its in-flight traffic with it.
        const cage = this.redis.group
        const portTop = pod.group.position.clone().add(new THREE.Vector3(0, 0.15, 0))
        // the command joins the back of the shared queue the moment it is parsed,
        // before it is executed: that waiting is what the strip shows
        const slot = this.redis.queuePush()
        const queue = this.redis.queueCellTop(slot)
        const loop = this.redis.loopTop()

        // which key: a read hits a live one, a write updates or creates one
        let key: RedisKey | null = null
        let hit = true
        if (cmd.write) {
            key = this.redis.freeKey()
            if (!key) {
                // maxmemory: something has to go before this write fits
                key = this.redis.randomLiveKey()
                if (key) this.evict(key)
            }
            key = key ?? this.redis.randomLiveKey()
        } else {
            key = this.redis.randomLiveKey()
            hit = Math.random() > 0.012
            if (!hit) {
                key = this.redis.randomLiveKey()
                hit = false
            }
        }

        const t0 = performance.now()
        this.redis.pulsePort(pod)

        // The request enters from ABOVE the frame and falls a long way into the
        // socket, exactly as a query does on the postgres side: same packet, same
        // long lean down, same wire drawn behind it. The client is not drawn
        // here either — the packet simply arrives already in flight.
        const packet = makePacket(PALETTE.magenta, 0.42, cage)
        const sky = portTop.clone().setY(portTop.y + SKY_ABOVE_PORT)
        packet.position.copy(sky)
        const inbound = pathCurve([
            sky.clone(),
            sky.clone().setY(portTop.y + SKY_ABOVE_PORT * 0.5).add(new THREE.Vector3(0, 0, 0.8)),
            sky.clone().setY(portTop.y + 3).add(new THREE.Vector3(0, 0, 0.3)),
            portTop.clone(),
        ])
        const wire = new QueryChain(cage)
        const fIn = wire.addCurve(inbound, PALETTE.magenta, { speed: 0.7, opacity: 0.32 })
        await travel(this.ticker, packet, inbound, 0.8, easeInQuad)
        fIn.flash(0.9)
        // the wire stays a beat after the packet lands, then goes: a hammered
        // socket must not silt the scene up with permanent lines
        void this.ticker.wait(0.4).then(() => wire.fadeOut(this.ticker, 0.9))

        // a load that started while this command was in flight takes the thread:
        // the packet is dropped, because the connection it belongs to is gone
        if (this.loading) {
            despawn(this.ticker, packet)
            this.inFlight--
            return
        }

        // The whole way down is one thread, and the hop through the bucket is a
        // real step: hash the key, land on a bucket, follow the chain to the
        // entry. Drawing loop → key directly would skip the only lookup in the
        // whole system — the thing that makes it O(1).
        const chain = new QueryChain(cage)
        const target = key ? this.redis.keyTop(key) : loop.clone()
        const bucket = key ? this.redis.bucketTop(key) : loop.clone()
        chain.add(
            [portTop, queue, loop, bucket, target].map((p) => p.clone()),
            PALETTE.violet,
            { speed: 0.9, opacity: 0.5 },
        )
        despawn(this.ticker, packet)

        await this.ticker.wait(0.22)
        // SAVE writes the dump on this very thread, so a command that arrives
        // meanwhile is parsed, queued — and then waits. It is not a lock: the
        // queue is simply not being drained by anyone.
        while (this.blocked) await this.ticker.wait(0.1)
        this.redis.pulseLoop()
        // the thread takes the head of the queue now — everything behind it moves up
        this.redis.queuePop()

        if (key) {
            this.redis.pulseBucket(key)
            // one bucket of the rehash per operation, exactly as redis does it —
            // the cron makes up the rest
            this.redis.rehashStep(1)
            if (cmd.write && !this.redis.aofCanGrow) {
                // A write that cannot be appended is a write redis will not serve:
                // the client gets an error and memory is not touched, because the
                // alternative is acknowledging something that will not survive a
                // restart. Nothing is ever dropped to make room — the log has to
                // be rewritten to get shorter.
                this.redis.aofFull = true
                this.refused++
                this.redis.flashKey(key, PALETTE.magenta, 0.6)
                this.note = `${cmd.name} · MISCONF errors writing to the AOF file — refused, reads still served`
            } else if (cmd.write) {
                if (!key.live) this.redis.setKeyLive(key, true)
                this.redis.flashKey(key, PALETTE.teal, 0.6)
                // Durability is a separate step from the write, and the two legs
                // are coloured by where the bytes ARE, not by what they will
                // become: cyan into the buffer (memory to memory), amber only on
                // the leg that puts them in the file.
                const bytes = randInt(40, 220)
                const bufTop = this.redis.aofBufferTop()
                const toBuf = new QueryChain(cage)
                toBuf.addCurve(
                    pathCurve([
                        loop.clone(),
                        loop.clone().add(new THREE.Vector3(3.4, -2.4, 3.4)),
                        bufTop.clone(),
                    ]),
                    PALETTE.cyan,
                    { speed: 0.9, opacity: 0.4 },
                )
                await this.ticker.wait(0.14)
                // The command stops HERE. Its bytes are in aof_buf, in memory, and
                // the file has not been touched: with appendfsync everysec the
                // write happens on the periodic flush, up to a second later. That
                // gap is the durability window, so the reply has to be seen as
                // "buffered", not "persisted".
                this.redis.bufferAof(bytes)
                this.note = `${cmd.name} · ${bytes} B into aof_buf — durable at the next fsync`
                toBuf.fadeOut(this.ticker, 0.6)
            } else {
                this.redis.flashKey(key, PALETTE.ice, 0.45)
                this.note = hit ? `${cmd.name} · hash hit, no disk` : `${cmd.name} · miss`
                if (hit) this.hits++
                else this.misses++
            }
            if (cmd.name === 'EXPIRE') key.ttl = rand(5, 40)
            if (cmd.name === 'DEL') {
                this.redis.setKeyLive(key, false)
                this.redis.flashKey(key, PALETTE.magenta, 0.6)
            }
        }

        await this.ticker.wait(0.18)

        // The reply climbs back up the same socket and leaves the frame the way
        // the request came in — a strand to the side of it, not a stub that stops
        // in mid-air above the port.
        const reply = pathCurve([
            target,
            loop.clone(),
            queue.clone(),
            portTop.clone(),
            portTop.clone().add(new THREE.Vector3(0.3, 3, 0.3)),
            portTop.clone().add(new THREE.Vector3(0.5, SKY_ABOVE_PORT * 0.5, 0.8)),
            portTop.clone().add(new THREE.Vector3(0.5, SKY_ABOVE_PORT, 0.6)),
        ])
        const replyChain = new QueryChain(cage)
        replyChain.addCurve(reply, PALETTE.teal, { speed: 0.7, opacity: 0.3 })
        const out = makePacket(PALETTE.teal, 0.26, cage)
        out.position.copy(target)
        await travel(this.ticker, out, reply, 0.8, easeOutCubic)
        despawn(this.ticker, out, 0.3)
        replyChain.fadeOut(this.ticker, 1.0)
        chain.fadeOut(this.ticker, 0.7)

        const dt = performance.now() - t0
        this.latencies.push(0.08 + dt * 0.0004 + rand(0, 0.06))
        if (this.latencies.length > 40) this.latencies.shift()
        this.ops++
        this.recent.push(this.clock)
        if (this.recent.length > 240) this.recent.shift()

        pod.busy = false
        this.inFlight--
    }

    private evict(key: RedisKey) {
        this.redis.evictions++
        this.redis.flashKey(key, PALETTE.magenta, 0.7)
        this.redis.setKeyLive(key, false)
        this.note = 'maxmemory · evicted a key'
    }

    /* ---------------------------------- events ------------------------------- */

    /** The active expire cycle: keys whose ttl has run out are dropped. */
    private expireCycle() {
        for (const key of this.redis.keys) {
            if (!key.live || key.ttl <= 0) continue
            key.ttl -= 0.25
            if (key.ttl > 0) continue
            key.ttl = 0
            this.redis.flashKey(key, PALETTE.amber, 0.5)
            this.redis.setKeyLive(key, false)
            this.note = 'active expire · ttl reached'
        }
    }

    bgsave() {
        if (this.saving || this.blocked || this.loading) return
        this.saving = true
        const keys = this.redis.liveKeys
        this.note = `bgsave · fork, ${keys} keys to dump.rdb — nothing is locked`
        // the parent keeps serving throughout: the queue is still drained, the
        // ports still answer. Only the child is busy.
        void this.redis.runRdbSave().then(() => {
            this.saving = false
            this.note = `bgsave · dump.rdb written, ${this.rdbKb()} kB in ${this.redis.rdbBlocksUsed} blocks`
        })
    }

    /**
     * SAVE, the other half of the pair: the same file, written by the same
     * thread that executes commands. Everything stops for the duration — this is
     * the only way a snapshot costs latency, and the reason BGSAVE exists.
     */
    save() {
        if (this.saving || this.blocked || this.loading) return
        this.blocked = true
        this.lockedNote = 'save · the command thread is writing dump.rdb: nothing is served'
        void this.redis.runRdbSave().then(() => {
            this.blocked = false
            this.lockedNote = null
            this.note = `save · done, ${this.rdbKb()} kB; the queue drains again`
        })
    }

    /**
     * A restart, with the files kept: everything in memory is gone, and it all has
     * to come back off the disk — the base first, then the log replayed on top —
     * before a single connection is accepted.
     */
    private async reload(target: boolean[]) {
        if (this.loading) return
        this.loading = true
        const had = target.filter(Boolean).length
        this.redis.shutPorts()
        this.lockedNote = `load · reading dump.rdb, then replaying ${this.redis.aofUsed} AOF records — not listening`
        await this.redis.runLoad(target)
        this.redis.openPorts(4)
        this.loading = false
        this.lockedNote = null
        this.nextArrival = 0.2
        this.note = `ready · ${this.redis.liveKeys} keys loaded from disk (${had} were in memory)`
    }

    /** The first start, from the state the page was built in. */
    boot() {
        return this.reload(this.bootDataset)
    }

    /** A restart on demand, from whatever is in memory right now. */
    loadFromDisk() {
        return this.reload(this.redis.dataset)
    }

    /** The dump's size as the panel should read it. */
    private rdbKb() {
        return (this.redis.rdbBytes / 1024).toFixed(1)
    }

    /** One command by hand, straight down the socket — the panel's run button. */
    runCommand() {
        if (this.loading) {
            this.note = 'load · not listening yet, the connection is refused'
            return
        }
        if (this.inFlight >= 6) return
        void this.runOp()
    }

    rewriteAof() {
        if (this.rewriting || this.loading) return
        this.rewriting = true
        const before = this.redis.aofUsed
        this.note = `bgrewriteaof · child scanning the keyspace (log is ${before} blocks)`
        // the instance runs the whole sequence (scan, write, swap); the sim just
        // reports it, and holds the flag until the swap has actually happened
        void this.redis.runRewrite().then(() => {
            this.rewriting = false
            this.blocksAtLastRewrite = this.redis.aofUsed
            this.note = `bgrewriteaof · ${before} → ${this.redis.aofUsed} blocks`
        })
    }

    /**
     * The rewrite does not run on a stopwatch. Redis measures growth since the
     * last rewrite and rewrites when the log has grown past a percentage of it
     * (default 100 %), provided it is also past a minimum size. That is why a
     * quiet instance never rewrites and a busy one rewrites repeatedly.
     */
    private shouldRewrite(): boolean {
        const used = this.redis.aofUsed
        return used >= Math.max(this.rewriteMinBlocks, this.blocksAtLastRewrite * this.rewriteGrowth)
    }

    /* ---------------------------------- update ------------------------------- */

    update(dt: number) {
        this.clock += dt

        if (this.ambient && !this.loading) {
            this.nextArrival -= dt
            if (this.nextArrival <= 0 && this.inFlight < 5) {
                this.nextArrival = rand(0.22, 0.62)
                void this.runOp()
            }
        }

        // the expire cycle is a background chore, not a command
        if (!this.loading) this.expireCycle()

        // appendfsync everysec: whatever is in aof_buf is written to the file and
        // fsynced. This is the only moment redis touches the disk for a write —
        // the leg from the buffer down to the block is drawn here, not on the
        // command, because on the command it would be a lie.
        this.fsyncTimer -= dt
        if (this.fsyncTimer <= 0) {
            this.fsyncTimer = 1
            const flushed = this.redis.flushAofBuffer()
            if (flushed) {
                const cage = this.redis.group
                const leg = new QueryChain(cage)
                const from = this.redis.aofBufferTop()
                leg.addCurve(
                    pathCurve([
                        from.clone(),
                        from.clone().add(new THREE.Vector3(0.4, -0.5, 0.6)),
                        flushed.head.clone(),
                    ]),
                    PALETTE.amber,
                    { speed: 1.1, opacity: 0.55 },
                )
                leg.fadeOut(this.ticker, 0.6)
                this.note = `appendfsync · ${flushed.records} record${flushed.records > 1 ? 's' : ''} written and fsynced`
            }
        }

        if (this.ambient && !this.loading) {
            this.saveTimer -= dt
            if (this.saveTimer <= 0) {
                this.saveTimer = 24
                this.bgsave()
            }
            if (!this.rewriting && this.shouldRewrite()) this.rewriteAof()
        }
    }

    /** Mean observed latency over the last few ops, in ms. */
    get latency() {
        if (this.latencies.length === 0) return 0
        return this.latencies.reduce((n, v) => n + v, 0) / this.latencies.length
    }
}
