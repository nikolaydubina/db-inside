import * as THREE from 'three'
import { BACKEND_ORIGIN, PALETTE } from '../postgresql/instance'
import type { BigKind, KeyKind, RedisInstance, RedisKey, RedisPort } from './redis'
import { BIG_REAL } from './redis'
import { HEAP_PAGE } from './layout'
import { QueryChain, pathCurve } from '../core/flow'
import { Ticker, halo, rand, randInt, speedTime as legTime, travel } from '../core/util'

export type RidePhase =
    | 'socket'
    | 'channel'
    | 'delivered'
    | 'bucket'
    | 'page'
    | 'entry'
    | 'value'
    | 'inner'
    | 'field'
    | 'node'
    | 'hop'
    | 'reply'
    | null

type RouteStop = {
    p: THREE.Vector3
    stop: RidePhase
    lit?: { n: number; of: number } | true
}

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

    bigKeys: number

    hotKeys: number

    subscribers: number

    fanouts: number
}

interface Command {
    name: string
    write: boolean

    weight: number

    kind?: KeyKind

    fanout?: boolean

    walk?: boolean

    probe?: 'point' | 'walk' | 'object'

    cue?: boolean
}

const PUBLISH: Command = { name: 'PUBLISH', write: false, weight: 7, fanout: true }

const COMMANDS: Command[] = [
    { name: 'GET', write: false, weight: 34 },
    { name: 'MGET', write: false, weight: 7 },
    { name: 'SET', write: true, weight: 20, kind: 'string' },
    { name: 'INCR', write: true, weight: 7, kind: 'string' },
    { name: 'HSET', write: true, weight: 8, kind: 'hash' },
    { name: 'SADD', write: true, weight: 6, kind: 'set' },
    { name: 'LPUSH', write: true, weight: 5, kind: 'list' },
    { name: 'ZADD', write: true, weight: 5, kind: 'zset' },
    { name: 'EXPIRE', write: true, weight: 4 },
    { name: 'DEL', write: true, weight: 5 },
    PUBLISH,
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

const SKY_ABOVE_PORT = 32

const PACKET = HEAP_PAGE

const PACKET_GAP = 0.05

function makePacket(color: number, size: number, parent: THREE.Object3D) {
    const small = size < 0.19
    const g = new THREE.Group()

    const marker = new THREE.Group()
    g.add(marker)
    const core = new THREE.Mesh(
        new THREE.BoxGeometry(size, size, size),
        new THREE.MeshStandardMaterial({
            color: 0x0a1118,
            emissive: color,
            emissiveIntensity: small ? 0.45 : 2.4,
            roughness: 0.25,
            metalness: 0.4,
        }),
    )
    marker.add(core)

    marker.add(halo(color, size * (small ? 2.2 : 2.6), small ? 0.18 : 0.4))
    g.userData.marker = marker
    parent.add(g)
    return g
}

const recolorPacket = (obj: THREE.Object3D, hex: number) => {
    obj.traverse((o) => {
        const mat = (o as THREE.Mesh).material as
            THREE.MeshStandardMaterial | THREE.SpriteMaterial | undefined
        if (!mat) return

        if ((mat as THREE.MeshStandardMaterial).emissive) {
            ;(mat as THREE.MeshStandardMaterial).emissive.setHex(hex)
        } else if ((mat as THREE.SpriteMaterial).color) {
            ;(mat as THREE.SpriteMaterial).color.setHex(hex)
        }
    })
}

const despawn = (ticker: Ticker, obj: THREE.Object3D, dur = 0.25) => {
    void ticker
        .add(dur, (k) => {
            obj.scale.setScalar(Math.max(0.001, 1 - k))
        })
        .then(() => obj.parent?.remove(obj))
}

const OPS_WINDOW = 2

export class RedisSim {
    ops = 0

    refused = 0
    private hits = 0
    private misses = 0
    private latencies: number[] = []

    private recent: number[] = []
    private clock = 0
    private inFlight = 0
    private nextArrival = 0.4
    private saveTimer = 6

    private fsyncTimer = 1

    private readonly rewriteGrowth = 2
    private readonly rewriteMinBlocks = 6

    private blocksAtLastRewrite = 0
    saving = false

    blocked = false

    loading = false
    rewriting = false
    ambient = true

    constructor(
        private redis: RedisInstance,
        private ticker: Ticker,
    ) {
        this.blocksAtLastRewrite = this.redis.aofUsed
        this.bootDataset = this.redis.dataset
        this.redis.shutPorts()
        this.redis.wipeMemory()
        this.note = 'starting · files on disk, nothing in memory, no listener'
    }

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
            hitRate:
                this.hits + this.misses > 0 ? (this.hits / (this.hits + this.misses)) * 100 : 0,
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
            bigKeys: this.redis.bigCount,
            hotKeys: this.redis.hotCount,
            subscribers: this.redis.subscribers().length,
            fanouts: this.fanouts,
        }
    }

    private note = 'idle'

    private fanouts = 0

    private pubsubTimer = rand(5, 9)
    private episode = false

    private scriptedPubSub = false

    private focusPacket: THREE.Object3D | null = null
    private focusRide = 0
    private rideToken = 0

    private focusCue = false

    private focusName = ''

    private carried: BigKind | null = null

    private objectRead = false

    private ridePhase: RidePhase = null

    private packetScale = 1

    private packetBase = 1

    private rideStopPoint: THREE.Vector3 | null = null

    private rideTrace: Array<{ t: number; phase: RidePhase; ride: number; at: number[] | null }> =
        []

    private focusLostAt = 0

    private focusNear = false

    private lockedNote: string | null = null

    private walking = false

    private pickPort(): RedisPort | null {
        const open = this.redis.ports.filter((p) => p.active && !p.busy && !p.subs)
        if (open.length > 0) return open[randInt(0, open.length - 1)]
        const any = this.redis.ports.filter((p) => p.active && !p.subs)
        return any.length > 0 ? any[randInt(0, any.length - 1)] : null
    }

    private keyRoute(key: RedisKey, probe: 'point' | 'walk' | 'object' = 'walk'): RouteStop[] {
        const r = this.redis
        const walk: RouteStop[] = [{ p: r.bucketTop(key), stop: 'bucket' }]
        if (key.big) {
            walk.push({ p: r.keyPageTop(key), stop: 'page' })
            walk.push({ p: r.valuePoint(key), stop: 'value' })
            const inner = r.innerDictPoint(key)

            if (inner)
                walk.push({ p: inner, stop: 'inner', lit: probe === 'point' ? true : undefined })
            if (probe === 'point') {
                walk.push({ p: r.nodePoint(key, 1), stop: 'field', lit: true })
                walk.push({ p: r.hopPoint(key, 0), stop: 'hop' })
            } else {
                const hops = key.kind === 'string' ? 1 : key.kind === 'hash' ? 2 : 3

                for (let n = 0; n <= hops; n++) {
                    walk.push({ p: r.hopPoint(key, n), stop: 'node', lit: { n, of: hops } })
                }
            }
        } else if (probe === 'object') {
            walk.push({ p: r.keyPageTop(key), stop: 'page' })
            walk.push({ p: r.objectPoint(), stop: 'value' })

            if (key.raw) walk.push({ p: r.hopPoint(key, 0), stop: 'hop' })
        } else if (key.aux) {
            walk.push({ p: r.keyPageTop(key), stop: 'page' })
            walk.push({ p: r.keyTop(key), stop: 'entry' })

            walk.push({ p: r.valuePoint(key), stop: 'value' })
            walk.push({ p: r.hopPoint(key, 0), stop: 'hop' })
            if (key.kind === 'zset' || key.kind === 'hash')
                walk.push({ p: r.hopPoint(key, 1), stop: 'hop' })
        } else {
            walk.push({ p: r.keyPageTop(key), stop: 'page' })
            walk.push({ p: r.keyTop(key), stop: 'value' })
        }

        const hover = PACKET / 2 + PACKET_GAP
        for (const w of walk) w.p.y += hover
        return walk
    }

    private async runOp(force?: Command, forceKey?: RedisKey) {
        if (this.loading) return
        const pod = this.pickPort()
        if (!pod) return
        const cmd = force ?? pickCommand()
        this.inFlight++

        const cage = this.redis.group
        const portTop = pod.group.position.clone().add(new THREE.Vector3(0, 0.15, 0))

        const slot = this.redis.queuePush()
        const queue = this.redis.queueCellTop(slot)
        const loop = this.redis.loopPoint()

        let key: RedisKey | null = forceKey ?? null
        let hit = true
        if (key) {
        } else if (cmd.fanout) {
        } else if (cmd.write) {
            const reuse =
                cmd.kind === undefined
                    ? (this.redis.randomLiveSmallKey() ?? this.redis.randomLiveKey())
                    : Math.random() >= 0.3
                      ? this.redis.liveOfKind(cmd.kind)
                      : null
            key = reuse ?? this.redis.freeKey()
            if (!key) {
                const victim = this.redis.evictionVictim()
                if (victim) this.evict(victim)
                key = this.redis.freeKey()
            }

            if (key && !key.live && cmd.kind) this.redis.setKeyKind(key, cmd.kind)
        } else {
            const roll = Math.random()
            key =
                roll < 0.08
                    ? (this.redis.bigKey() ?? this.redis.randomLiveKey())
                    : roll < 0.58
                      ? (this.redis.hotKey() ?? this.redis.randomLiveKey())
                      : this.redis.randomLiveKey()
            hit = Math.random() > 0.012
            if (!hit) {
                key = this.redis.randomLiveKey()
                hit = false
            }
        }

        const t0 = performance.now()
        this.redis.pulsePort(pod)

        const packet = this.packet(PALETTE.magenta, PACKET)
        const sky = portTop.clone().setY(portTop.y + SKY_ABOVE_PORT)
        packet.position.copy(sky)

        const ride = cmd.fanout || cmd.cue ? this.beginRide(packet, !!cmd.cue, cmd.name) : 0
        const inbound = pathCurve([
            sky.clone(),
            sky
                .clone()
                .setY(portTop.y + SKY_ABOVE_PORT * 0.5)
                .add(new THREE.Vector3(0, 0, 0.8)),
            sky
                .clone()
                .setY(portTop.y + 3)
                .add(new THREE.Vector3(0, 0, 0.3)),
            portTop.clone(),
        ])
        const wire = new QueryChain(cage)
        const fIn = wire.addCurve(inbound, PALETTE.magenta, { speed: 0.7, opacity: 0.32 })
        await travel(this.ticker, packet, inbound, legTime(inbound))
        fIn.flash(0.9)

        if (this.ownsRide(ride)) {
            this.setPhase('socket', portTop.clone())
        }

        void this.ticker.wait(0.4).then(() => wire.fadeOut(this.ticker, 0.9))

        if (this.loading) {
            despawn(this.ticker, packet)
            this.inFlight--
            return
        }

        const chain = new QueryChain(cage)

        const route: RouteStop[] = key
            ? this.keyRoute(key, cmd.probe)
            : [{ p: this.redis.channelPoint(), stop: null }]
        const chainPts: THREE.Vector3[] = [
            portTop.clone(),
            queue.clone(),
            loop.clone(),
            ...route.map((s) => s.p),
        ]

        if (this.ownsRide(ride)) {
            this.setPhase('socket', portTop.clone())
            await this.ticker.wait(0.3)
        }

        if (cmd.fanout) {
            const route = pathCurve([
                portTop.clone(),
                queue.clone(),
                loop.clone(),
                this.redis.channelPoint(),
            ])
            chain.addCurve(route, PALETTE.violet, { speed: 0.9, opacity: 0.45 })
            await travel(this.ticker, packet, route, legTime(route))

            while (this.blocked) await this.ticker.wait(0.1)
            this.redis.pulseLoop()
            this.redis.queuePop()

            await this.fanout(ride, packet, route.getTangent(1).normalize())
        } else if (cmd.walk && key) {
            this.walking = true
            let from = loop.clone()
            try {
                for (const legStop of route) {
                    const leg = pathCurve([from.clone(), legStop.p.clone()])
                    chain.addCurve(leg, PALETTE.violet, { speed: 0.9, opacity: 0.55 })
                    await travel(this.ticker, packet, leg, legTime(leg))

                    if (this.ownsRide(ride)) {
                        this.setPhase(legStop.stop, legStop.p.clone())
                    }

                    if (
                        key?.big &&
                        !this.carried &&
                        legStop.stop === 'value' &&
                        this.ownsRide(ride)
                    ) {
                        this.carried = key.big
                        this.redis.rideBig(key.big, packet)
                    }

                    if (
                        cmd.probe === 'object' &&
                        key &&
                        !key.big &&
                        !key.aux &&
                        legStop.stop === 'value'
                    ) {
                        this.objectRead = true

                        this.redis.rideObject(packet, key.raw ? 'pointer' : 'inline')
                        this.redis.lightObject(key.raw ? 'none' : 'payload')
                    }

                    if (cmd.probe === 'object' && key?.raw && legStop.stop === 'hop') {
                        this.redis.lightObject('payload')
                    }

                    if (key?.big && legStop.lit !== undefined) {
                        if (legStop.lit === true) this.redis.setBigStep(key.big, 0)
                        else this.redis.setBigStep(key.big, legStop.lit.n, legStop.lit.of)
                    }
                    await this.ticker.wait(0.22)
                    from = legStop.p
                }
            } finally {
                this.dropCarried()
                this.walking = false
            }

            await this.ticker.wait(0.2)
            while (this.blocked) await this.ticker.wait(0.1)
            this.redis.pulseLoop()

            this.redis.queuePop()
        } else {
            chain.add(chainPts, PALETTE.violet, { speed: 0.9, opacity: 0.5 })
            despawn(this.ticker, packet)

            await this.ticker.wait(0.22)
            while (this.blocked) await this.ticker.wait(0.1)
            this.redis.pulseLoop()

            this.redis.queuePop()
        }

        let converted = false
        let bigRead = false
        if (key) {
            this.redis.pulseBucket(key)
            this.redis.pulsePage(key)
            this.redis.flashKey(key, PALETTE.ice, 0.3)

            this.redis.rehashStep(1)
            if (cmd.write && !this.redis.aofCanGrow) {
                this.redis.aofFull = true
                this.refused++
                this.redis.flashKey(key, PALETTE.magenta, 0.6)
                this.note = `${cmd.name} · MISCONF errors writing to the AOF file — refused, reads still served`
            } else if (cmd.write) {
                if (!key.live) this.redis.setKeyLive(key, true)
                this.redis.flashKey(key, PALETTE.teal, 0.6)
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
                this.redis.bufferAof(bytes)
                this.note = `${cmd.name} · ${bytes} B into aof_buf — durable at the next fsync`
                toBuf.fadeOut(this.ticker, 0.6)

                const wasEnc = this.redis.encoding(key)
                converted = this.redis.growKey(key)
                if (converted) {
                    this.note = `${cmd.name} · ${key.entries} elements overflow ${wasEnc} — now ${this.redis.encoding(key)}, rewritten in one pass with nothing else running`
                    await this.ticker.wait(0.5)
                }
            } else {
                this.redis.flashKey(key, PALETTE.ice, 0.45)
                this.note = hit ? `${cmd.name} · hash hit, no disk` : `${cmd.name} · miss`
                if (key.big) {
                    const real = BIG_REAL[key.big]
                    bigRead = true
                    this.note = `${cmd.name} · one value, ${real.entries.toLocaleString('en-US')} ${real.unit} — walked on the single thread`
                    await this.ticker.wait(0.35)
                }
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

        const replyFrom = cmd.fanout
            ? this.redis.channelPoint()
            : (chainPts[chainPts.length - 1] ?? loop)
        const home = packet.parent ? packet : null
        if (home) recolorPacket(home, PALETTE.teal)
        const out = home ?? this.packet(PALETTE.teal, PACKET)
        if (!home) out.position.copy(replyFrom)
        const replyIn = pathCurve([
            out.position.clone(),
            loop.clone(),
            queue.clone(),
            portTop.clone(),
        ])
        const replyOut = pathCurve([
            portTop.clone(),
            portTop.clone().add(new THREE.Vector3(0.3, 3, 0.3)),
            portTop.clone().add(new THREE.Vector3(0.5, SKY_ABOVE_PORT * 0.5, 0.8)),
            portTop.clone().add(new THREE.Vector3(0.5, SKY_ABOVE_PORT, 0.6)),
        ])
        const replyChain = new QueryChain(cage)
        replyChain.addCurve(replyIn, PALETTE.teal, { speed: 0.7, opacity: 0.3 })
        replyChain.addCurve(replyOut, PALETTE.teal, { speed: 0.7, opacity: 0.25 })
        const owned = this.ownsRide(ride)
        await travel(this.ticker, out, replyIn, legTime(replyIn))
        this.endRide(ride)
        if (owned) this.setPhase('reply', portTop.clone())
        await travel(this.ticker, out, replyOut, legTime(replyOut))
        despawn(this.ticker, out, 0.3)
        replyChain.fadeOut(this.ticker, 1.0)
        chain.fadeOut(this.ticker, 0.7)

        const dt = performance.now() - t0
        this.latencies.push(
            0.08 + dt * 0.0004 + rand(0, 0.06) + (converted ? 1.7 : 0) + (bigRead ? 2.6 : 0),
        )
        if (this.latencies.length > 40) this.latencies.shift()
        this.ops++
        this.recent.push(this.clock)
        if (this.recent.length > 240) this.recent.shift()

        pod.busy = false
        this.inFlight--
    }

    private beginRide(packet: THREE.Object3D, takeover = false, name = ''): number {
        if (this.focusRide !== 0 && !takeover) return 0
        this.focusRide = ++this.rideToken
        this.focusPacket = packet
        this.focusCue = takeover
        this.focusName = name
        this.focusLostAt = 0
        this.focusNear = false
        this.ridePhase = null
        this.rideStopPoint = null
        return this.focusRide
    }

    private ownsRide(ride: number) {
        return ride !== 0 && ride === this.focusRide
    }

    private endRide(ride: number) {
        if (ride === 0 || ride !== this.focusRide) return
        this.focusRide = 0
        this.focusPacket = null
        this.focusCue = false
        this.focusName = ''
        this.focusLostAt = 0
        this.focusNear = false
        this.ridePhase = null
        this.rideStopPoint = null
        this.dropCarried()
        this.redis.focusPageAt(null)
    }

    readCursor(): { kind: string; step: number; steps: number } | null {
        if (!this.carried) return null
        return { kind: this.carried, ...this.redis.bigStepOf(this.carried) }
    }

    private dropCarried() {
        if (this.objectRead) {
            this.redis.rideObject(null)
            this.redis.lightObject('none')
            this.objectRead = false
        }
        if (!this.carried) return
        this.redis.rideBig(this.carried, null)
        this.carried = null
    }

    phase(): RidePhase {
        return this.ridePhase
    }

    private packet(color: number, size: number) {
        const p = makePacket(color, size, this.redis.group)
        const marker = p.userData.marker as THREE.Group | undefined
        marker?.scale.setScalar(this.packetScale)
        return p
    }

    setPacketScale(v: number) {
        this.packetBase = v > 0 ? v : 1
        this.packetScale = this.packetBase
    }

    rideDepth(): number {
        return 0
    }

    private setPhase(phase: RidePhase, stop: THREE.Vector3 | null = null) {
        this.ridePhase = phase
        this.rideStopPoint = stop
        if (phase === null) return
        const p = this.focusPacket
        const at =
            p && p.parent
                ? this.redis.group.worldToLocal(p.getWorldPosition(new THREE.Vector3()))
                : null
        this.rideTrace.push({
            t: +this.clock.toFixed(2),
            phase,
            ride: this.focusRide,
            at: at ? at.toArray().map((n) => +n.toFixed(2)) : null,
        })
        if (this.rideTrace.length > 60) this.rideTrace.shift()
    }

    rideState() {
        const p = this.focusPacket
        const at =
            p && p.parent
                ? this.redis.group.worldToLocal(p.getWorldPosition(new THREE.Vector3()))
                : null
        const round = (v: number[]) => v.map((n) => +n.toFixed(2))
        return {
            ride: this.focusRide,
            hasPacket: !!p?.parent,
            lost: this.focusLostAt,
            phase: this.ridePhase,
            walking: this.walking,
            at: at ? round(at.toArray()) : null,
            stopAt: this.rideStopPoint ? round(this.rideStopPoint.toArray()) : null,
            gap: at && this.rideStopPoint ? +at.distanceTo(this.rideStopPoint).toFixed(2) : null,
            cursor: this.readCursor(),
            trace: this.rideTrace.slice(-16),
        }
    }

    packetSubject(): { id: string; object: THREE.Object3D } | null {
        if (this.ridePhase === 'reply') return null
        if (!this.focusCue) return null
        const p = this.focusPacket
        if (!p || !p.parent) return null
        if (!this.focusNear) {
            if (p.position.y > BACKEND_ORIGIN.y + 2) return null
            this.focusNear = true
        }
        return { id: `ride ${this.focusRide} · ${this.focusName}`, object: p }
    }

    private evict(key: RedisKey) {
        this.redis.evictions++
        this.redis.flashKey(key, PALETTE.magenta, 0.7)
        this.redis.setKeyLive(key, false)
        this.note = 'maxmemory · evicted a key'
    }

    private async fanout(ride = 0, message?: THREE.Object3D, arrival?: THREE.Vector3) {
        const cage = this.redis.group
        const from = this.redis.channelPoint()
        const subs = this.redis.subscribers()
        this.redis.pulseChannel()
        if (subs.length === 0) {
            if (message) despawn(this.ticker, message, 0.2)
            this.endRide(ride)
            this.note = `PUBLISH ${this.redis.channelName} · nobody on the channel — delivered to 0 clients, and nothing was stored`
            return 0
        }

        const fan = new QueryChain(cage)
        const arcs = subs.map((pod) => {
            const top = this.redis.portTop(pod)
            const away = new THREE.Vector3(top.x - from.x, 0, top.z - from.z)
            const mid = from.clone().add(top).multiplyScalar(0.5)
            mid.y = Math.min(from.y, top.y) + 0.35
            mid.addScaledVector(away.normalize(), 0.9)
            const lead = from.clone().addScaledVector(arrival ?? new THREE.Vector3(0, 1, 0), 1.1)
            const toSocket = pathCurve([from.clone(), lead, mid, top])
            const leave = top.clone().addScaledVector(toSocket.getTangent(1).normalize(), 1.2)
            const out = pathCurve([
                top.clone(),
                leave,
                top.clone().add(new THREE.Vector3(0.35, 4, 0.4)),
                top.clone().add(new THREE.Vector3(0.7, 12, 0.7)),
            ])
            fan.addCurve(toSocket, PALETTE.violet, { speed: 1.6, opacity: 0.45 })
            fan.addCurve(out, PALETTE.violet, { speed: 1.2, opacity: 0.3 })
            return { pod, toSocket, out, top }
        })

        if (this.ownsRide(ride)) this.setPhase('channel', null)
        for (let i = 0; i < arcs.length; i++) {
            const arc = arcs[i]
            const packet = i === 0 && message ? message : this.packet(PALETTE.violet, PACKET)
            if (i === 0 && message) recolorPacket(packet, PALETTE.violet)
            packet.position.copy(from)
            if (ride !== 0 && ride === this.focusRide && i === 0) this.focusPacket = packet
            void travel(this.ticker, packet, arc.toSocket, legTime(arc.toSocket)).then(() => {
                if (i === 0 && this.ownsRide(ride)) this.setPhase('delivered', null)
                this.redis.pulseSend(arc.pod)
                despawn(this.ticker, packet, 0.15)
                const away = this.packet(PALETTE.violet, PACKET * 0.8)
                away.position.copy(arc.top)
                if (ride !== 0 && ride === this.focusRide && i === 0) this.focusPacket = away
                void travel(this.ticker, away, arc.out, legTime(arc.out)).then(() =>
                    despawn(this.ticker, away, 0.2),
                )
            })
            await this.ticker.wait(0.1)
        }
        fan.fadeOut(this.ticker, 1.2)
        this.fanouts++
        this.note = `PUBLISH ${this.redis.channelName} · fan-out to ${subs.length} subscriber${subs.length === 1 ? '' : 's'} — no key read, nothing appended, nothing stored`

        await this.ticker.wait(0.8)
        this.endRide(ride)
        return subs.length
    }

    private async subscribe(pod: RedisPort, note = true) {
        if ((this.loading && !this.scriptedPubSub) || pod.subs) return
        this.inFlight++
        const cage = this.redis.group
        const portTop = this.redis.portTop(pod)
        const slot = this.redis.queuePush()
        const queue = this.redis.queueCellTop(slot)
        const loop = this.redis.loopPoint()
        const channel = this.redis.channelPoint()

        const route = pathCurve([portTop, queue.clone(), loop.clone(), channel.clone()])
        const chain = new QueryChain(cage)
        chain.addCurve(route, PALETTE.violet, { speed: 0.9, opacity: 0.4 })
        const packet = this.packet(PALETTE.violet, PACKET)
        packet.position.copy(portTop)
        void travel(this.ticker, packet, route, legTime(route))

        await this.ticker.wait(0.4)
        this.redis.pulseLoop()
        this.redis.queuePop()
        await this.ticker.wait(0.2)
        this.redis.pulseChannel()
        this.redis.setSubscribed(pod, true)
        if (note) {
            this.note = `SUBSCRIBE ${this.redis.channelName} · socket ${pod.id + 1} joined the list — the channel holds its fd, not a copy of anything`
        }
        despawn(this.ticker, packet, 0.2)

        const reply = pathCurve([
            channel.clone(),
            loop.clone(),
            queue.clone(),
            portTop.clone(),
            portTop.clone().add(new THREE.Vector3(0.35, 4, 0.4)),
            portTop.clone().add(new THREE.Vector3(0.7, 12, 0.7)),
        ])
        const back = this.packet(PALETTE.teal, PACKET * 0.8)
        back.position.copy(channel)
        void travel(this.ticker, back, reply, legTime(reply)).then(() =>
            despawn(this.ticker, back, 0.2),
        )
        await this.ticker.wait(0.5)
        this.redis.pulseSend(pod)
        chain.fadeOut(this.ticker, 0.9)
        this.inFlight--
    }

    private async unsubscribe(pod: RedisPort, note = true) {
        if (this.loading || !pod.subs) return
        this.inFlight++
        const cage = this.redis.group
        const portTop = this.redis.portTop(pod)
        const slot = this.redis.queuePush()
        const queue = this.redis.queueCellTop(slot)
        const loop = this.redis.loopPoint()
        const channel = this.redis.channelPoint()

        const route = pathCurve([portTop, queue.clone(), loop.clone(), channel.clone()])
        const chain = new QueryChain(cage)
        chain.addCurve(route, PALETTE.violet, { speed: 0.9, opacity: 0.32 })
        const packet = this.packet(PALETTE.violet, PACKET)
        packet.position.copy(portTop)
        void travel(this.ticker, packet, route, legTime(route))
        await this.ticker.wait(0.45)
        this.redis.pulseLoop()
        this.redis.queuePop()
        this.redis.setSubscribed(pod, false)
        this.redis.pulseChannel()
        if (note) {
            this.note = `UNSUBSCRIBE ${this.redis.channelName} · socket ${pod.id + 1} left the list — an ordinary client again`
        }
        despawn(this.ticker, packet, 0.2)
        await this.ticker.wait(0.3)
        this.redis.pulseSend(pod)
        chain.fadeOut(this.ticker, 0.8)
        this.inFlight--
    }

    subscribeNext(): boolean {
        const ordinary = this.redis.ports.filter((p) => p.active && !p.subs)
        if (ordinary.length <= 1) return false
        void this.subscribe(ordinary[ordinary.length - 1])
        return true
    }

    private async pubsubEpisode() {
        if (this.episode || this.loading) return
        this.episode = true
        try {
            const ordinary = this.redis.ports.filter((p) => p.active && !p.subs)
            const n = Math.max(0, Math.min(randInt(1, 2), ordinary.length - 1))
            const joiners = ordinary.slice(0, n)
            for (const pod of joiners) {
                await this.subscribe(pod)
                await this.ticker.wait(0.5)
            }
            if (joiners.length > 0) {
                const beats = randInt(2, 4)
                for (let i = 0; i < beats; i++) {
                    await this.fanout()
                    await this.ticker.wait(0.9)
                }
            }
        } finally {
            const listeners = this.redis.subscribers()
            for (const pod of listeners) {
                await this.unsubscribe(pod)
                await this.ticker.wait(0.4)
            }
            this.episode = false
        }
    }

    suspendPubSub() {
        this.scriptedPubSub = true
        this.redis.clearSubscribers()
    }

    resumePubSub() {
        this.scriptedPubSub = false
        this.pubsubTimer = rand(6, 12)
    }

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

        void this.redis.runRdbSave().then(() => {
            this.saving = false
            this.note = `bgsave · dump.rdb written, ${this.rdbKib()} KiB in ${this.redis.rdbBlocksUsed} blocks`
        })
    }

    save() {
        if (this.saving || this.blocked || this.loading) return
        this.blocked = true
        this.lockedNote = 'save · the command thread is writing dump.rdb: nothing is served'
        void this.redis.runRdbSave().then(() => {
            this.blocked = false
            this.lockedNote = null
            this.note = `save · done, ${this.rdbKib()} KiB; the queue drains again`
        })
    }

    private async reload(target: boolean[]) {
        if (this.loading) return
        this.loading = true
        const had = target.filter(Boolean).length
        this.redis.shutPorts()
        this.lockedNote = `load · reading dump.rdb, then replaying ${this.redis.aofUsed} AOF records — not listening`
        await this.redis.runLoad(target)
        this.redis.openPorts(4)

        this.redis.clearSubscribers()
        this.loading = false
        this.lockedNote = null
        this.nextArrival = 0.2
        this.note = `ready · ${this.redis.liveKeys} keys loaded from disk (${had} were in memory)`
    }

    boot() {
        return this.reload(this.bootDataset)
    }

    loadFromDisk() {
        return this.reload(this.redis.dataset)
    }

    private rdbKib() {
        return (this.redis.rdbBytes / 1024).toFixed(1)
    }

    runCommand() {
        if (this.loading) {
            this.note = 'load · not listening yet, the connection is refused'
            return
        }
        if (this.inFlight >= 6) return
        void this.runOp()
    }

    publish() {
        if (this.loading || this.inFlight >= 6) return
        void this.runOp({ ...PUBLISH, cue: true })
    }

    readBig(kind: BigKind, op: 'point' | 'walk' = 'walk'): boolean {
        if (this.loading || this.inFlight >= 6) return false
        if (this.walking || this.focusRide !== 0) return false
        const key = this.redis.bigKey(kind) ?? this.reviveBig(kind)
        if (!key) return false
        const name =
            kind === 'zset'
                ? op === 'point'
                    ? 'ZSCORE'
                    : 'ZRANGEBYSCORE'
                : kind === 'hash'
                  ? op === 'point'
                      ? 'HGET'
                      : 'HGETALL'
                  : 'LRANGE'
        void this.runOp({ name, write: false, weight: 1, walk: true, probe: op, cue: true }, key)
        return true
    }

    readInline(): boolean {
        if (this.loading || this.inFlight >= 6 || this.walking || this.focusRide !== 0) return false
        const key = this.redis.compactKeyLeft()
        if (!key) return false
        void this.runOp(
            { name: 'GET', write: false, weight: 1, walk: true, probe: 'object', cue: true },
            key,
        )
        return true
    }

    readRaw(): boolean {
        if (this.loading || this.inFlight >= 6 || this.walking || this.focusRide !== 0) return false
        const key = this.redis.rawKeyLeft()
        if (!key) return false
        void this.runOp(
            { name: 'GET', write: false, weight: 1, walk: true, probe: 'object', cue: true },
            key,
        )
        return true
    }

    private reviveBig(kind: BigKind): RedisKey | null {
        const key = this.redis.keys.find((k) => k.big === kind)
        if (!key) return null
        this.redis.setKeyLive(key, true)
        return key
    }

    rewriteAof() {
        if (this.rewriting || this.loading) return
        this.rewriting = true
        const before = this.redis.aofUsed
        this.note = `bgrewriteaof · child scanning the keyspace (log is ${before} blocks)`

        void this.redis.runRewrite().then(() => {
            this.rewriting = false
            this.blocksAtLastRewrite = this.redis.aofUsed
            this.note = `bgrewriteaof · ${before} → ${this.redis.aofUsed} blocks`
        })
    }

    private shouldRewrite(): boolean {
        const used = this.redis.aofUsed
        return (
            used >= Math.max(this.rewriteMinBlocks, this.blocksAtLastRewrite * this.rewriteGrowth)
        )
    }

    update(dt: number) {
        this.clock += dt

        this.redis.focusPageAt(null)

        if (this.focusRide !== 0) {
            if (this.focusPacket?.parent) this.focusLostAt = 0
            else if (this.focusLostAt === 0) this.focusLostAt = performance.now()
            else if (performance.now() - this.focusLostAt > 4000) {
                this.focusRide = 0
                this.focusPacket = null
                this.focusLostAt = 0
                this.ridePhase = null
                this.rideStopPoint = null
            }
        }

        if (this.ambient && !this.loading) {
            this.nextArrival -= dt
            if (this.nextArrival <= 0 && this.inFlight < 5) {
                this.nextArrival = rand(0.22, 0.62)
                void this.runOp()
            }
        }

        if (!this.loading) this.expireCycle()

        if (this.ambient && !this.loading && !this.scriptedPubSub) {
            this.pubsubTimer -= dt
            if (this.pubsubTimer <= 0) {
                this.pubsubTimer = rand(14, 24)
                void this.pubsubEpisode()
            }
        }

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

    get latency() {
        if (this.latencies.length === 0) return 0
        return this.latencies.reduce((n, v) => n + v, 0) / this.latencies.length
    }
}
