import * as THREE from 'three'
import { PALETTE } from './instance'
import type { RedisInstance, RedisKey, RedisPort } from './redis'
import { QueryChain, pathCurve } from './flow'
import { Ticker, halo, rand, randInt, travel } from './util'

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
    note: string
    connections: number
    busy: boolean
    saving: boolean
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

/** Where client traffic enters, in cage-local units. */
const SKY_LOCAL = new THREE.Vector3(6, 26, 2)

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
    private hits = 0
    private misses = 0
    private latencies: number[] = []
    /** simulated timestamps of recent ops, for the throughput figure */
    private recent: number[] = []
    private clock = 0
    private inFlight = 0
    private nextArrival = 0.4
    private saveTimer = 6
    private rewriteTimer = 18
    saving = false
    rewriting = false
    ambient = true

    constructor(
        private redis: RedisInstance,
        private ticker: Ticker,
    ) { }

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
            note: this.note,
            connections: this.redis.ports.filter((p) => p.active).length,
            busy: this.redis.ports.some((p) => p.busy),
            saving: this.saving,
            rewriting: this.rewriting,
        }
    }

    private note = 'idle'

    /* --------------------------------- traffic ------------------------------- */

    private pickPort(): RedisPort | null {
        const open = this.redis.ports.filter((p) => p.active && !p.busy)
        if (open.length > 0) return open[randInt(0, open.length - 1)]
        const any = this.redis.ports.filter((p) => p.active)
        return any.length > 0 ? any[randInt(0, any.length - 1)] : null
    }

    /** One command: request down, execution, reply back up the same socket. */
    private async runOp() {
        const pod = this.pickPort()
        if (!pod) return
        const cmd = pickCommand()
        this.inFlight++

        // Everything below is in CAGE-LOCAL units and the paths are parented to
        // the cage, so sliding the cage takes its in-flight traffic with it.
        const cage = this.redis.group
        const portTop = pod.group.position.clone().add(new THREE.Vector3(0, 0.15, 0))
        const cell = randInt(0, 9)
        const queue = this.redis.queueCellTop(cell)
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
        this.redis.pulseQueue(cell)

        const sky = SKY_LOCAL.clone().add(
            new THREE.Vector3(rand(-3, 3), rand(0, 3), rand(-2, 2)),
        )

        // the request: a packet falls from the client into the socket
        const packet = makePacket(PALETTE.magenta, 0.16, cage)
        const fall = pathCurve([
            sky,
            sky.clone().add(new THREE.Vector3(-0.4, -4.5, 0.4)),
            portTop.clone().add(new THREE.Vector3(0, 2.4, 0.5)),
            portTop,
        ])
        await travel(this.ticker, packet, fall, 0.5)
        this.redis.pulseQueue(cell)

        // the whole way down is one thread: queue → loop → the key itself
        const chain = new QueryChain(cage)
        const target = key ? this.redis.keyTop(key) : loop.clone()
        chain.add(
            [portTop, queue, loop, target].map((p) => p.clone()),
            PALETTE.violet,
            { speed: 0.9, opacity: 0.5 },
        )
        despawn(this.ticker, packet)

        await this.ticker.wait(0.22)
        this.redis.pulseLoop()

        if (key) {
            this.redis.pulseBucket(key)
            if (cmd.write) {
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
                const head = this.redis.appendAof(bytes)
                const toFile = new QueryChain(cage)
                toFile.addCurve(
                    pathCurve([
                        bufTop.clone(),
                        bufTop.clone().add(new THREE.Vector3(0.4, -0.5, 0.6)),
                        head.clone(),
                    ]),
                    PALETTE.amber,
                    { speed: 1.1, opacity: 0.55 },
                )
                toFile.fadeOut(this.ticker, 0.6)
                toBuf.fadeOut(this.ticker, 0.6)
                this.note = `${cmd.name} · ${bytes} B appended in block ${this.redis.aofUsed}`
            } else {
                this.redis.markKey(key, PALETTE.ice)
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

        // the reply climbs straight back up the same socket
        const reply = pathCurve([
            target,
            loop.clone(),
            queue.clone(),
            portTop.clone(),
            portTop.clone().add(new THREE.Vector3(0, 5.5, 0)),
        ])
        const replyChain = new QueryChain(cage)
        replyChain.addCurve(reply, PALETTE.teal, { speed: 1.1, opacity: 0.45 })
        replyChain.fadeOut(this.ticker, 0.7)
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
        this.saving = true
        this.redis.bgsave()
        this.note = `bgsave · ${this.redis.liveKeys} keys forked into dump.rdb`
        void this.ticker.wait(1.6).then(() => {
            this.saving = false
        })
    }

    rewriteAof() {
        this.rewriting = true
        this.redis.rewriteAof()
        this.note = 'bgrewriteaof · log rewritten to the current state'
        void this.ticker.wait(1.4).then(() => {
            this.rewriting = false
        })
    }

    /* ---------------------------------- update ------------------------------- */

    update(dt: number) {
        this.clock += dt

        if (this.ambient) {
            this.nextArrival -= dt
            if (this.nextArrival <= 0 && this.inFlight < 5) {
                this.nextArrival = rand(0.22, 0.62)
                void this.runOp()
            }
        }

        // the expire cycle is a background chore, not a command
        this.expireCycle()

        if (this.ambient) {
            this.saveTimer -= dt
            if (this.saveTimer <= 0) {
                this.saveTimer = 24
                this.bgsave()
            }
            this.rewriteTimer -= dt
            if (this.rewriteTimer <= 0) {
                this.rewriteTimer = 40
                this.rewriteAof()
            }
        }
    }

    /** Mean observed latency over the last few ops, in ms. */
    get latency() {
        if (this.latencies.length === 0) return 0
        return this.latencies.reduce((n, v) => n + v, 0) / this.latencies.length
    }
}
