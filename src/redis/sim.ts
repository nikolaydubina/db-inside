import * as THREE from 'three'
import { BACKEND_ORIGIN, PALETTE } from '../postgresql/instance'
import type { BigKind, KeyKind, RedisInstance, RedisKey, RedisPort } from './redis'
import { BIG_REAL } from './redis'
import { HEAP_PAGE } from './layout'
import { QueryChain, pathCurve } from '../core/flow'
import { Ticker, easeInQuad, easeOutCubic, halo, rand, randInt, travel } from '../core/util'

/**
 * The legs a ridden packet can be on.
 *
 * A published message uses the first three; a cued command adds its address
 * chain — bucket, page, value — and the reply, so a story can stop the clock on
 * any leg its caption is about. One mechanism, two kinds of ride.
 */
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

/**
 * One stop on a read's route: where the packet stands, what that stop is called,
 * and — for a carried structure — which of its cells the read is touching.
 *
 * `lit` is the walk's hop index and the last hop's index, so the cursor can be
 * spread over the whole drawn structure instead of crawling through its first few
 * cells; `true` means the read landed on ONE bucket, chosen by the structure
 * itself, which is what a field or member lookup does.
 */
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
    /** values drawn as their own areas instead of as entries in the plane */
    bigKeys: number
    /** keys that take most of the traffic */
    hotKeys: number
    /** sockets in subscriber mode */
    subscribers: number
    /** PUBLISH commands executed so far */
    fanouts: number
}

interface Command {
    name: string
    write: boolean
    /** share of the traffic */
    weight: number
    /**
     * The value type this command needs. A write that names a type has to land
     * on a key of that type — that is the difference between SET (which replaces
     * whatever is there) and HSET (which appends a field to a hash, and is
     * allowed to be the element that converts it).
     */
    kind?: KeyKind
    /**
     * PUBLISH: the one command that reaches no key.
     *
     * It is not a write to the keyspace and not a read from it — the message is
     * copied to whoever is listening and then forgotten, so there is nothing to
     * look up and nothing to append. Marked here because every other branch in
     * the command path assumes there is a key at the end of it.
     */
    fanout?: boolean
    /**
     * Walk the value one link at a time: the packet stops where each pointer
     * lands, waits, and goes on. A quicklist walk IS a sequence of unrelated
     * addresses, so one smooth curve would say the opposite of the truth.
     */
    walk?: boolean
    /**
     * Which kind of read this is, for a value that has more than one: a POINT
     * lookup (ZSCORE, HGET — one bucket, one entry) or a WALK (a range scan, an
     * HGETALL — every bucket and chain). The route and the caption both hinge on
     * the difference, so it travels with the command instead of being guessed
     * from the key alone.
     */
    probe?: 'point' | 'walk' | 'object'
    /**
     * This command was asked for by a story, so its packet is a subject: a camera
     * may follow it from the socket to the reply. Ambient traffic is never a cue.
     */
    cue?: boolean
}

/**
 * The command mix. Redis does not have statements that a planner can rewrite:
 * a command is a name and argv, executed immediately in one pass. What matters
 * is only whether it reads the keyspace or also appends to the AOF.
 */
/**
 * PUBLISH, kept as its own constant because two things need it by name: the
 * command mix, and whoever asks for one on cue — a story step, the panel button.
 */
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

/**
 * How far above the socket client traffic starts, in cage-local units. Same idea
 * as the postgres side: the client is never drawn, the packet enters the frame
 * already on its way down, ~32 units above the port.
 */
const SKY_ABOVE_PORT = 32

/**
 * How wide a packet is drawn: one heap page.
 *
 * Packets used to be 0.42 and 0.26 — bigger than the blocks they landed on, so a
 * read arriving at a page looked like something that could not fit in it. The scene's
 * unit is the 4 kB block, and a marker for "the read is here" belongs in that grid.
 */
const PACKET = HEAP_PAGE

/** Clearance between a packet's underside and the surface it stops on. */
const PACKET_GAP = 0.05

function makePacket(color: number, size: number, parent: THREE.Object3D) {
    // A small packet is a marker seen from close up, not a light source. At full
    // strength with a 5x halo a 0.04-unit marker still filled a third of the frame
    // and hid the page it was standing on, which is the opposite of the point of
    // zooming in. Same shape, dimmer, with a halo that stays near the core.
    const small = size < 0.19
    const g = new THREE.Group()
    // The marker lives INSIDE the packet, in a group of its own.
    //
    // The packet is the thing things attach to — a read carries the value's
    // structure with it — so the packet's own scale stays 1. Shrinking the packet
    // itself made everything parented to it shrink too, which is why a carried
    // cage vanished as the camera went in. What shrinks is the marker.
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
    // a small marker is a position, not a lamp: at 0.9 emission with a 2.2x halo its
    // glow was lighting the inside of the glass page and reading as a bright column
    // standing in it — there was no such object, it was the marker's own bloom
    marker.add(halo(color, size * (small ? 2.2 : 2.6), small ? 0.18 : 0.4))
    g.userData.marker = marker
    parent.add(g)
    return g
}

/**
 * Paint a packet that is already in flight.
 *
 * The same bytes are a magenta COMMAND while they cross the wire and a violet
 * MESSAGE once the thread is copying them to listeners. It is one object doing
 * both, so it is recoloured rather than replaced — replacing it is what made the
 * route look like three unrelated things.
 */
const recolorPacket = (obj: THREE.Object3D, hex: number) => {
    obj.traverse((o) => {
        const mat = (o as THREE.Mesh).material as
            | THREE.MeshStandardMaterial
            | THREE.SpriteMaterial
            | undefined
        if (!mat) return
        // the core carries an emissive body; a sprite halo carries only a tint
        if ((mat as THREE.MeshStandardMaterial).emissive) {
            ; (mat as THREE.MeshStandardMaterial).emissive.setHex(hex)
        } else if ((mat as THREE.SpriteMaterial).color) {
            ; (mat as THREE.SpriteMaterial).color.setHex(hex)
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
            bigKeys: this.redis.bigCount,
            hotKeys: this.redis.hotCount,
            subscribers: this.redis.subscribers().length,
            fanouts: this.fanouts,
        }
    }

    private note = 'idle'
    /** PUBLISH commands run, so a caption can be measured rather than assumed */
    private fanouts = 0
    /** seconds to the next subscribe → publish → unsubscribe episode */
    private pubsubTimer = rand(5, 9)
    private episode = false
    /** a story drives pub/sub itself and does not want episodes in its way */
    private scriptedPubSub = false
    /**
     * The packet a following camera is on — and which ride that is.
     *
     * A publish is a chain of packets: one falls in from the client, then one copy
     * per listener leaves, and the camera has to stay with the same message across
     * the hand-off. The token is what says "this is still the same ride", so a
     * second publish starting while the first is in flight cannot steal the
     * camera mid-route.
     */
    private focusPacket: THREE.Object3D | null = null
    private focusRide = 0
    private rideToken = 0
    /**
     * Which leg of the route the ridden message is on: 'socket' once it has landed,
     * 'channel' when the thread is about to copy it, 'delivered' when the first copy
     * is in a listener's output buffer.
     *
     * A story freezes the clock on one of these, so the message stops where the
     * caption is about and the next step continues the same object. Without it the
     * route runs to the end in a few seconds and every step after the first is a
     * description of something that has already gone.
     */
    /** the big value currently riding along with a read, if any */
    private carried: BigKind | null = null
    /** is the value object itself in the read's hands right now */
    private objectRead = false

    private ridePhase: RidePhase = null
    /**
     * How big a packet is drawn, as a multiple of its natural size.
     *
     * A packet is 0.42 units and a heap page is 0.23, so at the default size the
     * marker a read is standing on is nearly twice the block it is standing on —
     * which makes a zoom into a page impossible: the glow fills the frame and you
     * cannot see what it landed on. Steps that go close ask for smaller packets;
     * the story sets it back on the way out.
     */
    private packetScale = 1
    /** what the story asked for; the depth below scales it down from here */
    private packetBase = 1
    /** the big value whose cage is riding with the packet, if any */
    /**
     * The point the leg the ride is on was supposed to END at, in cage-local
     * space — the same space the route was drawn in.
     *
     * Without it a story can only say which NAME the clock stopped under, which is
     * how a caption about the value's own bucket array froze the packet on the
     * value object two stops earlier and looked fine. With it, a stop is a place:
     * the packet's distance from the point it claims to be standing on is a number
     * anyone can read back and check.
     */
    private rideStopPoint: THREE.Vector3 | null = null
    /**
     * The last few phase writes, each with the packet's position at that moment.
     *
     * The phase is shared state: the ride a story watches, the reply hand-off and
     * the safety valve all write it. So "the clock stopped in the wrong place" is
     * really "which write did it, and where was the packet then" — a question a
     * screenshot cannot answer and a log can.
     */
    private rideTrace: Array<{ t: number; phase: RidePhase; ride: number; at: number[] | null }> =
        []
    /** when the focused packet went missing, in real ms — the safety valve */
    private focusLostAt = 0
    /** has the ridden packet come down into camera range yet */
    private focusNear = false
    /** A note that owns the status line while a blocking job runs. */
    private lockedNote: string | null = null
    /**
     * A slow walk is in progress. One at a time, on purpose: six concurrent
     * traversals draw six overlapping trails and the picture stops describing a
     * route. The queue is exactly the right model for the other five — they wait.
     */
    private walking = false

    /* --------------------------------- traffic ------------------------------- */

    private pickPort(): RedisPort | null {
        // a socket in subscriber mode is not a key-space client: it may only
        // SUBSCRIBE, UNSUBSCRIBE and PING, so ordinary traffic never comes from it
        const open = this.redis.ports.filter((p) => p.active && !p.busy && !p.subs)
        if (open.length > 0) return open[randInt(0, open.length - 1)]
        const any = this.redis.ports.filter((p) => p.active && !p.subs)
        return any.length > 0 ? any[randInt(0, any.length - 1)] : null
    }

    /**
     * The address chain one command walks, in cage-local points.
     *
     * bucket → entry → its page → [structure → its page …]
     *
     * Every read reaches the heap: a bucket holds an address, the entry it lands
     * on is an allocation, and for a compact value the payload is inside that
     * same allocation — so two dereferences and one page. A converted value adds
     * its own structure (the block stacked on the entry, or the dashed cage at
     * the back), which is a second allocation on a second page. Walking a big
     * list, hash or sorted set then alternates between the structure and the pages
     * its nodes were allocated on, because that is what following a chain of
     * pointers through RAM is: the next node is never next to this one. A
     * converted hash or zset also consults its OWN bucket array, which is a second
     * hash table and not the keyspace dict.
     *
     * Every point carries the name of the stop it is. The name used to be derived
     * from the leg's index — `i === 0 ? 'bucket' : i === 1 ? 'page' : i === 2 ?
     * 'value' : 'page'` — which is only true of the three-stop route: a big hash
     * point read has six stops, so the value's OWN bucket array was announced as
     * 'page'. A story that stopped the clock there froze the packet two stops
     * early, on the value object in the heap, under a caption about the bucket
     * array inside the cage. Deriving the label from the point fixes the class of
     * bug rather than one instance of it: the drawing cannot drift under the prose
     * while the two are read off the same list.
     */
    private keyRoute(
        key: RedisKey,
        probe: 'point' | 'walk' | 'object' = 'walk'
    ): RouteStop[] {
        const r = this.redis
        const walk: RouteStop[] = [{ p: r.bucketTop(key), stop: 'bucket' }]
        if (key.big) {
            // the entry is a heap allocation like any other: the first hop lands
            // on its page, and only then does the value's structure come into it
            walk.push({ p: r.keyPageTop(key), stop: 'page' })
            walk.push({ p: r.valuePoint(key), stop: 'value' })
            const inner = r.innerDictPoint(key)
            // A lookup hashes the field and lands on ONE bucket; a range scan walks
            // the buckets in order. Same drawn structure, different path through it,
            // and the cursor inside the cage is what tells them apart — which is why
            // only the lookup lights a single bucket here. Lighting one for the scan
            // too put the cursor on a bucket it then jumped back from.
            if (inner) walk.push({ p: inner, stop: 'inner', lit: probe === 'point' ? true : undefined })
            if (probe === 'point') {
                // one field or member: the value's OWN dict lands on a single
                // bucket, and the entry behind that bucket is one allocation
                walk.push({ p: r.nodePoint(key, 1), stop: 'field', lit: true })
                walk.push({ p: r.hopPoint(key, 0), stop: 'hop' })
            } else {
                const hops = key.kind === 'string' ? 1 : key.kind === 'hash' ? 2 : 3
                // Page to page, and never back to the structure.
                //
                // The route used to be node → page → node → page, bouncing to the
                // drawn cage between every hop. That drew a return trip to a place
                // the walk never goes back to: a quicklist node or a skiplist node
                // is ONE allocation on ONE page, and the "next" pointer it follows
                // is a field inside the node we already have — reading it costs no
                // access at all. Bouncing also double-counted: the cage was visited
                // once per hop while the only new address per hop is the next page.
                // So a walk is a run of pages, each one a node's allocation.
                //
                // And every hop moves the cursor ONE STEP inside the structure, so
                // the walk is drawn where it happens: the cells behind stay lit and
                // the one under the read pulses. `of` is the last hop's index, so the
                // cursor reaches the far end of the drawn structure on the last one.
                for (let n = 0; n <= hops; n++) {
                    walk.push({ p: r.hopPoint(key, n), stop: 'node', lit: { n, of: hops } })
                }
            }
        } else if (probe === 'object') {
            // The order is the point: the bucket points at a PAGE, the type is
            // only known by reading the header that lives there, and that same
            // allocation holds the payload for an inline encoding. So the object
            // section comes after the page, not before it.
            walk.push({ p: r.keyPageTop(key), stop: 'page' })
            walk.push({ p: r.objectPoint(), stop: 'value' })
            // A raw value is not finished at the header: what the header holds is an
            // ADDRESS, so there is one more page to visit — the allocation the bytes
            // are in. This is the only read of a value that is not a big collection
            // that costs a second page, and the sister story is about that hop.
            if (key.raw) walk.push({ p: r.hopPoint(key, 0), stop: 'hop' })
        } else if (key.aux) {
            // page first: the entry is an allocation, so the bucket points AT the
            // page, and only from there do the entry and its value pointer read
            walk.push({ p: r.keyPageTop(key), stop: 'page' })
            walk.push({ p: r.keyTop(key), stop: 'entry' })
            // the converted structure is a SECOND allocation, so a second page
            walk.push({ p: r.valuePoint(key), stop: 'value' })
            walk.push({ p: r.hopPoint(key, 0), stop: 'hop' })
            if (key.kind === 'zset' || key.kind === 'hash')
                walk.push({ p: r.hopPoint(key, 1), stop: 'hop' })
        } else {
            // every read lands on a page before anything is known: the type and
            // the encoding live in the object header that sits there. The cube is
            // what that allocation holds, so it comes after the page.
            walk.push({ p: r.keyPageTop(key), stop: 'page' })
            walk.push({ p: r.keyTop(key), stop: 'value' })
        }
        // A stop is a point ON the surface it names; the packet is drawn half a box
        // above it, plus a gap.
        //
        // Centred on the face, a page-sized box is EXACTLY the block: its sides are
        // coplanar with the block's sides and the two shimmer against each other as
        // the camera moves, and the read reads as sunk into the block rather than
        // resting on it. Lifting is also what makes "the read is here" honest — the
        // packet is not made of the page, it is standing on it.
        const hover = PACKET / 2 + PACKET_GAP
        for (const w of walk) w.p.y += hover
        return walk
    }

    /** One command: request down, execution, reply back up the same socket. */
    private async runOp(force?: Command, forceKey?: RedisKey) {
        // nothing is served while the files are being read back
        if (this.loading) return
        const pod = this.pickPort()
        if (!pod) return
        const cmd = force ?? pickCommand()
        this.inFlight++

        // Everything below is in CAGE-LOCAL units and the paths are parented to
        // the cage, so sliding the cage takes its in-flight traffic with it.
        const cage = this.redis.group
        const portTop = pod.group.position.clone().add(new THREE.Vector3(0, 0.15, 0))
        // the command joins the back of the shared queue the moment it is parsed,
        // before it is executed: that waiting is what the strip shows
        const slot = this.redis.queuePush()
        const queue = this.redis.queueCellTop(slot)
        const loop = this.redis.loopPoint()

        // which key: a read hits a live one, a write updates or creates one
        let key: RedisKey | null = forceKey ?? null
        let hit = true
        if (key) {
            // a forced key (a story's cue): nothing to choose, just run there
        } else if (cmd.fanout) {
            // nothing to look up: the message is addressed to a channel, and the
            // channel's members are sockets, not values
        } else if (cmd.write) {
            // A typed command appends to a value that can hold it — that is the
            // path a conversion happens on — and now and then starts a new one, the
            // way real traffic does. A command with no type (EXPIRE, DEL) needs a
            // live key and must never be aimed at a free slot.
            const reuse =
                cmd.kind === undefined
                    ? (this.redis.randomLiveSmallKey() ?? this.redis.randomLiveKey())
                    : Math.random() >= 0.3
                        ? this.redis.liveOfKind(cmd.kind)
                        : null
            key = reuse ?? this.redis.freeKey()
            if (!key) {
                // maxmemory: something has to go before this write fits
                const victim = this.redis.evictionVictim()
                if (victim) this.evict(victim)
                key = this.redis.freeKey()
            }
            // a dead slot reused by a typed write becomes that type; the value
            // starts at one element, so its encoding budget starts over with it
            if (key && !key.live && cmd.kind) this.redis.setKeyKind(key, cmd.kind)
        } else {
            // The skew lives in the traffic, not only in the picture: most reads go
            // to a handful of small keys, a few go to a value so big that serving
            // one of them walks millions of entries. Everything else is an even
            // walk through the keyspace.
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

        // The request enters from ABOVE the frame and falls a long way into the
        // socket, exactly as a query does on the postgres side: same packet, same
        // long lean down, same wire drawn behind it. The client is not drawn
        // here either — the packet simply arrives already in flight.
        const packet = this.packet(PALETTE.magenta, PACKET)
        const sky = portTop.clone().setY(portTop.y + SKY_ABOVE_PORT)
        packet.position.copy(sky)
        // A ride starts in the sky, before the bytes have reached the socket — not
        // at the fan, which is where a published message is already half-way
        // through. A cued command rides the same mechanism: one live packet, one
        // identity, and the camera holds on to whichever leg it is on.
        const ride = cmd.fanout || cmd.cue ? this.beginRide(packet, !!cmd.cue) : 0
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
        // the bytes are in that socket's input buffer now, and stay there until the
        // one thread comes round to them — the first leg a ride can be ridden on.
        //
        // OWNED ride only: `ride` is a token that stays truthy after a takeover,
        // so an abandoned request finishing its fall would announce 'socket' while
        // the packet a story is watching was still 42 units up in the sky. The
        // phase is shared state, so whoever writes it must own the camera.
        if (this.ownsRide(ride)) {
            this.setPhase('socket', portTop.clone())
        }
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

        // What the command loop does with a command: it hashes the key to a
        // BUCKET, follows that pointer to the entry, and takes the entry's value
        // pointer — to the value's own structure when it has one, or nowhere at
        // all when the payload is inline in the object header. A walk of a big
        // value then alternates between its structure and the heap pages its
        // nodes were allocated on, once per node: that bounce IS the pointer
        // chase, and it is the difference between a 2-hop read and a traversal.
        // The reply climbs back from wherever the walk stopped.
        const chain = new QueryChain(cage)
        // every stop carries its own name, so the leg a ride is on and the words a
        // caption uses for it come from one list instead of two that could drift
        const route: RouteStop[] = key
            ? this.keyRoute(key, cmd.probe)
            : [{ p: this.redis.channelPoint(), stop: null }]
        const chainPts: THREE.Vector3[] = [
            portTop.clone(),
            queue.clone(),
            loop.clone(),
            ...route.map((s) => s.p),
        ]

        // The bytes are in that socket's input buffer now, and they stay there
        // until the one thread comes round to them. That is a real pause in a
        // single-threaded server, and it is the instant a story stops the clock on
        // to talk about a command arriving — so it lasts long enough to be an
        // instant rather than a single frame, and only for a ridden message.
        if (this.ownsRide(ride)) {
            this.setPhase('socket', portTop.clone())
            await this.ticker.wait(0.3)
        }

        if (cmd.fanout) {
            // ONE packet, the whole route: socket → queue → loop → channel, and
            // then it becomes the message each listener receives. It used to stop
            // at the socket and be replaced by a line nobody rode, then by copies
            // that appeared out of the channel — three objects for one message, and
            // no way to follow the thing the caption was about.
            const route = pathCurve([
                portTop.clone(),
                queue.clone(),
                loop.clone(),
                this.redis.channelPoint(),
            ])
            chain.addCurve(route, PALETTE.violet, { speed: 0.9, opacity: 0.45 })
            await travel(this.ticker, packet, route, 0.85)
            // SAVE writes the dump on this very thread, so a command that arrives
            // meanwhile is parsed, queued — and then waits. It is not a lock: the
            // queue is simply not being drained by anyone.
            while (this.blocked) await this.ticker.wait(0.1)
            this.redis.pulseLoop()
            this.redis.queuePop()
            // the direction the message ARRIVED in. The fan has to leave along it:
            // a burst of arcs setting off the other way is a corner at the node,
            // and reads as two unrelated lines that happen to meet there.
            await this.fanout(ride, packet, route.getTangent(1).normalize())
        } else if (cmd.walk && key) {
            // One leg at a time. The packet stops at every node the walk lands on
            // and at the page that node was allocated on, so the cost of the walk
            // is visible as a count instead of disappearing into one 0.8s swoop.
            this.walking = true
            let from = loop.clone()
            try {
                for (const legStop of route) {
                    const leg = pathCurve([from.clone(), legStop.p.clone()])
                    chain.addCurve(leg, PALETTE.violet, { speed: 0.9, opacity: 0.55 })
                    await travel(this.ticker, packet, leg, 0.4)
                    // Announced on ARRIVAL, not on departure. The phase is the leg
                    // the packet is STANDING on, so a story that freezes a leg
                    // freezes with the packet at that stop — set at the start of
                    // the leg, the caption named a place the packet had not
                    // reached, and the freeze landed on the stop before it.
                    if (this.ownsRide(ride)) {
                        this.setPhase(legStop.stop, legStop.p.clone())
                    }
                    // The structure is picked up HERE, at the stop that reads the
                    // object header — not when the walk began.
                    //
                    // Attached at the start, a read was carrying a LIST through the
                    // bucket and the page legs, before anything had told it that the
                    // value was a list at all: the drawing asserted the type it had
                    // not read yet, and put the structure in hand before the access
                    // that produces it. The bucket is 8 bytes, the page holds the
                    // entry, the header says `quicklist` — and only then is there
                    // anything to carry.
                    if (key?.big && !this.carried && legStop.stop === 'value' && this.ownsRide(ride)) {
                        this.carried = key.big
                        this.redis.rideBig(key.big, packet)
                    }
                    // A compact value has nothing to carry a structure for: what the
                    // read finds is the object itself, so THAT is what it picks up,
                    // at the stop that reads the header — and it goes with the ride.
                    if (cmd.probe === 'object' && key && !key.big && !key.aux && legStop.stop === 'value') {
                        this.objectRead = true
                        // the layout that is true of this value, and the part the read has
                        // just found. For an inline value that is the value itself — header
                        // and bytes are one allocation, and the bytes are what was asked
                        // for. For a raw one nothing lights yet: what the header holds is
                        // an address, and the bytes are not on this page.
                        this.redis.rideObject(packet, key.raw ? 'pointer' : 'inline')
                        this.redis.lightObject(key.raw ? 'none' : 'payload')
                    }
                    // the pointer led somewhere: the bytes are on this page, and they are
                    // what the read came for
                    if (cmd.probe === 'object' && key?.raw && legStop.stop === 'hop') {
                        this.redis.lightObject('payload')
                    }
                    // and the cursor moves inside it, one step per hop
                    if (key?.big && legStop.lit !== undefined) {
                        if (legStop.lit === true) this.redis.setBigStep(key.big, 0)
                        else this.redis.setBigStep(key.big, legStop.lit.n, legStop.lit.of)
                    }
                    await this.ticker.wait(0.22)
                    from = legStop.p
                }
            } finally {
                // ALWAYS, on every way out. A story freezes the clock in the middle
                // of a walk, so "when the walk finishes" is a promise this code
                // cannot keep: the last card can be left, the story closed, a ride
                // taken over — and the cage stayed parented to the packet, sitting
                // inside it forever. The release belongs with the walk's exit, not
                // after its last leg.
                this.dropCarried()
                this.walking = false
            }
            // NOT despawned: this packet is the thing that flies home. The reply
            // below recolours it and sends it back, which is what makes the read one
            // continuous object instead of a box that vanishes and a green one that
            // appears at the same instant.
            await this.ticker.wait(0.2)
            while (this.blocked) await this.ticker.wait(0.1)
            this.redis.pulseLoop()
            // the thread takes the head of the queue now — everything behind it moves up
            this.redis.queuePop()
        } else {
            chain.add(chainPts, PALETTE.violet, { speed: 0.9, opacity: 0.5 })
            despawn(this.ticker, packet)

            await this.ticker.wait(0.22)
            while (this.blocked) await this.ticker.wait(0.1)
            this.redis.pulseLoop()
            // the thread takes the head of the queue now — everything behind it moves up
            this.redis.queuePop()
        }

        let converted = false
        let bigRead = false
        if (key) {
            this.redis.pulseBucket(key)
            this.redis.pulsePage(key)
            this.redis.flashKey(key, PALETTE.ice, 0.3)
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
                // This write may be the one element too many. If so the value is
                // rewritten into its real structure right here, on this thread,
                // and nothing else runs until it is done — the only O(n) write in
                // the whole command set, and the only one that costs this much.
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
                    // the one read that is not O(1): a big value is walked on the
                    // single thread, and that is the whole cost model of a skew
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

        // The reply climbs back up the same socket and leaves the frame the way
        // the request came in — a strand to the side of it, not a stub that stops
        // in mid-air above the port. It starts where the request stopped: the
        // entry for a compact value, the value's structure for a converted one,
        // the far end of a walk for a big one. A publish has no key, so its count
        // starts at the channel.
        const replyFrom = cmd.fanout
            ? this.redis.channelPoint()
            : (chainPts[chainPts.length - 1] ?? loop)
        // The reply is the SAME object that went in, turned green where it stands.
        //
        // It used to be a second packet spawned at the last stop while the first was
        // despawned: the box disappeared, a green one appeared one frame later, and
        // the camera — riding a proxy — had nothing to follow across the join. Now
        // the packet that carried the structure becomes the answer, grows back to its
        // normal size as the depth drops to 0, and flies home itself.
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
        // the packet leaves the frame from here on its own: a ride that followed it
        // would be a shot of empty sky, so the two legs are drawn and flown apart
        const replyOut = pathCurve([
            portTop.clone(),
            portTop.clone().add(new THREE.Vector3(0.3, 3, 0.3)),
            portTop.clone().add(new THREE.Vector3(0.5, SKY_ABOVE_PORT * 0.5, 0.8)),
            portTop.clone().add(new THREE.Vector3(0.5, SKY_ABOVE_PORT, 0.6)),
        ])
        const replyChain = new QueryChain(cage)
        replyChain.addCurve(replyIn, PALETTE.teal, { speed: 0.7, opacity: 0.3 })
        replyChain.addCurve(replyOut, PALETTE.teal, { speed: 0.7, opacity: 0.25 })
        // The camera keeps the packet it already has: no proxy, no hand-off. The ride
        // ends at the socket, where the camera stops following and the bytes go on
        // out of frame on their own.
        //
        // Ownership has to be captured BEFORE the leg: endRide clears the focus, and
        // asking afterwards always answers "no".
        const owned = this.ownsRide(ride)
        await travel(this.ticker, out, replyIn, 0.55, easeOutCubic)
        this.endRide(ride)
        // Announced on ARRIVAL, like every other leg. 'reply' means the answer has
        // reached the socket — that is the instant a card about the return is about.
        // Announced when the reply SET OFF, a story froze with the answer in mid-air:
        // the clock stopped, nothing moved again, and the return leg the card
        // described never happened. It is set after endRide on purpose, so the phase
        // survives the ride ending and the freeze can still see it.
        if (owned) this.setPhase('reply', portTop.clone())
        await travel(this.ticker, out, replyOut, 0.45, easeOutCubic)
        despawn(this.ticker, out, 0.3)
        replyChain.fadeOut(this.ticker, 1.0)
        chain.fadeOut(this.ticker, 0.7)

        const dt = performance.now() - t0
        // A conversion or a big-value read is a real pause, not a flicker: the
        // latency sample has to carry it, or the only O(n) work in the command set
        // would look free.
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

    /**
     * Take the camera's attention for this publish, if nobody has it.
     *
     * Called with the inbound packet, before it has reached the socket: the ride a
     * story wants to show starts in the sky and ends leaving another socket, so the
     * hand-off from the incoming message to the outgoing copies has to be one
     * continuous subject.
     */
    private beginRide(packet: THREE.Object3D, takeover = false): number {
        // A cue may TAKE the camera from a ride that is still finishing: the
        // previous reply is on its way out while the next request is already
        // falling in, and waiting for it would leave the camera on nothing.
        if (this.focusRide !== 0 && !takeover) return 0
        this.focusRide = ++this.rideToken
        this.focusPacket = packet
        this.focusLostAt = 0
        this.focusNear = false
        // A new ride begins in the SKY, on no leg at all. Leaving the previous
        // ride's phase in place made the two disagree: the phase named the stop the
        // old packet had reached while `at` was the new packet still falling from
        // 32 units up, which read as "frozen at the socket" with the socket 33
        // units below.
        this.ridePhase = null
        this.rideStopPoint = null
        return this.focusRide
    }

    /** Does this command still own the camera? A later cue may have taken it. */
    private ownsRide(ride: number) {
        return ride !== 0 && ride === this.focusRide
    }

    /**
     * The ride is over: the message has left the cage and there is nothing left to
     * follow. Only the ride that still owns the camera may end it.
     */
    private endRide(ride: number) {
        if (ride === 0 || ride !== this.focusRide) return
        this.focusRide = 0
        this.focusPacket = null
        this.focusLostAt = 0
        this.focusNear = false
        this.ridePhase = null
        this.rideStopPoint = null
        this.dropCarried()
        this.redis.focusPageAt(null)
    }

    /**
     * Which cell of the structure in its hands the read is touching, if any.
     *
     * The animation inside a cage is a claim about the algorithm — three buckets
     * scanned for this lookup, four quicklist nodes read for this range — so it is
     * reported as numbers, the same way the phase and the stop gap are.
     */
    readCursor(): { kind: string; step: number; steps: number } | null {
        if (!this.carried) return null
        return { kind: this.carried, ...this.redis.bigStepOf(this.carried) }
    }

    /**
     * Put a carried structure back where it lives.
     *
     * Called from every end of a walk and every end of a ride, because those are
     * different events: a ride can be taken over, a story can close mid-walk, and
     * the packet can be replaced by the reply's proxy — none of which reaches the
     * end of the loop in the walk branch.
     */
    private dropCarried() {
        // whatever the read was holding goes with it: a structure, or the value
        // object it found on a page
        if (this.objectRead) {
            this.redis.rideObject(null)
            this.redis.lightObject('none')
            this.objectRead = false
        }
        if (!this.carried) return
        this.redis.rideBig(this.carried, null)
        this.carried = null
    }

    /** Which leg of the route the ridden message is on, if any. */
    phase(): RidePhase {
        return this.ridePhase
    }

    /**
     * A packet whose marker the sim controls.
     *
     * The group is what other things attach to, so it stays at scale 1; the size
     * lives on the marker inside it (see makePacket). Every spawn goes through here
     * so an ambient packet is born at the current size and not at the default one.
     */
    private packet(color: number, size: number) {
        const p = makePacket(color, size, this.redis.group)
        const marker = p.userData.marker as THREE.Group | undefined
        marker?.scale.setScalar(this.packetScale)
        return p
    }

    /**
     * Draw packets at this multiple of their natural size.
     *
     * A story that zooms into a heap block needs the marker on it to be smaller
     * than the block, or the shot is a pink screen. Applied to the packet already
     * in the air as well, so the change lands on the frame the step opens.
     */
    setPacketScale(v: number) {
        this.packetBase = v > 0 ? v : 1
        this.packetScale = this.packetBase
    }

    /**
     * How far inside the machine the ride has got: 0 outside, 1 in a heap page.
     *
     * This is what a zoom follows. A packet is a marker for "the read is here",
     * and "here" means two very different scales: a request crossing the cage is
     * a unit-sized object between structures, and the same request standing on a
     * heap page is a marker inside a 0.23-unit block whose contents are 0.13. So
     * the camera comes in and the marker shrinks together, both following this
     * number, and it goes back out on the way to the reply.
     */
    rideDepth(): number {
        // No zoom, and no shrink with it.
        //
        // The camera used to dive into the page a read landed on, the marker shrink
        // with it, and the block turn to glass so you could see inside. Each of those
        // needed the others: depth from the phase, a shallow flag for the way home, a
        // size smoothed on real time because the clock is frozen while it settles, a
        // tolerance so a stop hovering over a page still counted as being on it. That
        // is a lot of machinery for one claim — and the claim is already unmissable
        // without it: the structure appears at the stop that reads the object header,
        // rides along with the packet, and turns from violet to green on the way home.
        return 0
    }

    /**
     * Write the phase AND record it.
     *
     * The one place a leg is announced. Anything that wants to say where the ride
     * is goes through here, so every claim in the scene is also a line in the
     * trace — including the ones that turn out to be wrong.
     */
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

    /**
     * Debug: what the ride machinery currently believes, in numbers.
     *
     * `gap` is the one that matters: how far the ridden object actually is from
     * the point the leg it claims to be on ends at, in cage units. A story that
     * froze on the wrong stop shows up as a `gap` of whole units instead of ~0,
     * so a wrong instant is measured rather than argued about.
     */
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
            /** a walk is in progress: the thread is inside one command */
            walking: this.walking,
            /** where the ridden object is, in the space the route was drawn in */
            at: at ? round(at.toArray()) : null,
            /** where the leg it is on was supposed to end */
            stopAt: this.rideStopPoint ? round(this.rideStopPoint.toArray()) : null,
            gap:
                at && this.rideStopPoint
                    ? +at.distanceTo(this.rideStopPoint).toFixed(2)
                    : null,
            /** which cell of the carried structure the read is on, if any */
            cursor: this.readCursor(),
            /** the last handful of writes, oldest first */
            trace: this.rideTrace.slice(-16),
        }
    }

    /**
     * The packet a camera may ride, with an identity and a live position.
     *
     * A packet is an object in the scene like a page or a key: it has a world
     * position and it moves. What it also needs is a NAME, because a camera holds
     * on to an identity — without one, "the packet" becomes "the place a packet
     * was when somebody measured a box", and the shot is stale the frame after.
     *
     * Null until the packet is nearly at a socket: a request falls in from 32
     * units up, and a camera that locks on at the top of that fall spends several
     * seconds watching an empty sky with a dot in it.
     */
    packetSubject(): { id: string; object: THREE.Object3D } | null {
        const p = this.focusPacket
        if (!p || !p.parent) return null
        // The reply used to be hidden from the camera above this height, back when
        // the ride followed the outgoing packet itself: it climbed 32 units and the
        // shot became sky. The reply now rides a PROXY that stops at the socket and
        // the visible packet leaves on its own — nothing to trail into the sky — so
        // the gate only succeeded in making the camera lose the return leg, which
        // is the one step about it.
        if (!this.focusNear) {
            // cage-local y: the packet is a child of the cage, and the sockets sit
            // at BACKEND_ORIGIN.y. Two units out, not four: the shot is about the
            // packet reaching a socket, so the camera takes over just before it
            // does, not while it is still falling through empty air.
            if (p.position.y > BACKEND_ORIGIN.y + 2) return null
            this.focusNear = true
        }
        return { id: `ride ${this.focusRide}`, object: p }
    }

    private evict(key: RedisKey) {
        this.redis.evictions++
        this.redis.flashKey(key, PALETTE.magenta, 0.7)
        this.redis.setKeyLive(key, false)
        this.note = 'maxmemory · evicted a key'
    }

    /* --------------------------------- pub/sub ------------------------------- */

    /**
     * PUBLISH, drawn as the only thing it is: a fan that does not stop at the
     * socket.
     *
     * The route reaches the CHANNEL first — a name in its own dict, not a key —
     * and the channel holds the list of sockets. The thread walks that list and
     * copies the message into each one, so the arc leaves the channel and lands
     * on a socket; then it carries on out of the frame, because the socket is not
     * where a message ends up, the client is.
     *
     * No key is hashed, no value is touched, no bytes reach the AOF or the dump.
     * The reply to the publisher is a count, and that is not a formality: the only
     * thing PUBLISH can tell its caller is HOW MANY clients it reached. A channel
     * with nobody on it is not an error — it is a successful publish to zero
     * clients.
     */
    private async fanout(ride = 0, message?: THREE.Object3D, arrival?: THREE.Vector3) {
        const cage = this.redis.group
        const from = this.redis.channelPoint()
        const subs = this.redis.subscribers()
        this.redis.pulseChannel()
        if (subs.length === 0) {
            // nobody to copy it to: the packet the client's command became has
            // nowhere to go, and that is a successful publish to zero clients
            if (message) despawn(this.ticker, message, 0.2)
            this.endRide(ride)
            this.note = `PUBLISH ${this.redis.channelName} · nobody on the channel — delivered to 0 clients, and nothing was stored`
            return 0
        }

        const fan = new QueryChain(cage)
        const arcs = subs.map((pod) => {
            const top = this.redis.portTop(pod)
            // Bow each arc outward, NEVER above the socket it is heading for: a bow
            // that peaks higher than the socket makes the message come down into it
            // from outside and then turn round to leave — arriving and leaving at
            // 180° to each other, which is exactly what a wrong-side entry looks
            // like. Under the rim, it climbs to the socket and keeps going out.
            const away = new THREE.Vector3(top.x - from.x, 0, top.z - from.z)
            const mid = from.clone().add(top).multiplyScalar(0.5)
            mid.y = Math.min(from.y, top.y) + 0.35
            mid.addScaledVector(away.normalize(), 0.9)
            // G0.25: the first step out of the channel continues the direction the
            // message came in on, and only then turns.
            const lead = from.clone().addScaledVector(arrival ?? new THREE.Vector3(0, 1, 0), 1.1)
            const toSocket = pathCurve([from.clone(), lead, mid, top])
            // and the way out continues the way in: the socket is a point on the
            // route, not a corner in it
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

        // One packet per socket, a beat apart: the thread writes them one after
        // another, and every one of them is a copy — the message is never shared.
        // The copies exist from here: this is the moment the list is walked, so it
        // is also the moment a story can stop on.
        if (this.ownsRide(ride)) this.setPhase('channel', null)
        for (let i = 0; i < arcs.length; i++) {
            const arc = arcs[i]
            // The message that came down the route IS the first copy. It only
            // changes colour here, at the moment it stops being a command on the
            // wire and becomes a value the thread is handing to sockets. The rest
            // are made at the channel, because that is exactly what a copy is.
            const packet =
                i === 0 && message ? message : this.packet(PALETTE.violet, PACKET)
            if (i === 0 && message) recolorPacket(packet, PALETTE.violet)
            // it leaves from the channel, wherever it was made
            packet.position.copy(from)
            // the first copy is the one a following camera rides: the others are
            // the same moment repeated, and watching all of them at once is what
            // the wide shot is for
            if (ride !== 0 && ride === this.focusRide && i === 0) this.focusPacket = packet
            void travel(this.ticker, packet, arc.toSocket, 0.42).then(() => {
                // the first copy has reached a listener's output buffer
                if (i === 0 && this.ownsRide(ride)) this.setPhase('delivered', null)
                // its ring answers. The connection is not a key-space client and
                // does not become busy.
                this.redis.pulseSend(arc.pod)
                despawn(this.ticker, packet, 0.15)
                const away = this.packet(PALETTE.violet, PACKET * 0.8)
                away.position.copy(arc.top)
                if (ride !== 0 && ride === this.focusRide && i === 0) this.focusPacket = away
                void travel(this.ticker, away, arc.out, 0.6).then(() =>
                    despawn(this.ticker, away, 0.2),
                )
            })
            await this.ticker.wait(0.1)
        }
        fan.fadeOut(this.ticker, 1.2)
        this.fanouts++
        this.note = `PUBLISH ${this.redis.channelName} · fan-out to ${subs.length} subscriber${subs.length === 1 ? '' : 's'} — no key read, nothing appended, nothing stored`
        // hold the ride until the last copy has actually left the frame
        await this.ticker.wait(0.8)
        this.endRide(ride)
        return subs.length
    }

    /**
     * SUBSCRIBE — the other half, and the only way a socket turns violet.
     *
     * The command is a command like any other: it arrives on a socket, waits in
     * the shared queue and is executed by the one thread. What it does is small
     * and total: the thread adds that fd to the channel's list. From that moment
     * the socket is a listener — and only from that moment, which is why the
     * colour changes here and not at connect time.
     */
    private async subscribe(pod: RedisPort, note = true) {
        // `loading` guards ambient traffic, which must not compete with the dump
        // being read at boot. A story that asks for a SUBSCRIBE has to get one: the
        // boot is over by the time anybody is reading a caption, and a cue swallowed
        // by this guard left the story waiting forever for a listener.
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
        void travel(this.ticker, packet, route, 0.55)

        await this.ticker.wait(0.4)
        this.redis.pulseLoop()
        this.redis.queuePop()
        await this.ticker.wait(0.2)
        this.redis.pulseChannel()
        // the list now has this socket on it
        this.redis.setSubscribed(pod, true)
        if (note) {
            this.note = `SUBSCRIBE ${this.redis.channelName} · socket ${pod.id + 1} joined the list — the channel holds its fd, not a copy of anything`
        }
        despawn(this.ticker, packet, 0.2)

        // the reply climbs back up the same socket and leaves the frame: the client
        // is told which channel it is on, and everything it hears will arrive here
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
        void travel(this.ticker, back, reply, 0.7).then(() => despawn(this.ticker, back, 0.2))
        await this.ticker.wait(0.5)
        this.redis.pulseSend(pod)
        chain.fadeOut(this.ticker, 0.9)
        this.inFlight--
    }

    /**
     * UNSUBSCRIBE — the same route backwards, and the socket is an ordinary client
     * again. The channel keeps no memory of it: with the last subscriber gone the
     * entry is as good as deleted, because there is nothing in it but the list.
     */
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
        void travel(this.ticker, packet, route, 0.5)
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

    /**
     * How the violet gets there. A client connects to listen and sends SUBSCRIBE;
     * this picks the next ordinary socket and says it — a story's cue, not
     * ambient traffic, because subscriptions are rare and started by hand.
     *
     * Always leaves one ordinary client behind: a subscriber cannot issue GET, so
     * a floor of nothing but listeners would have no traffic left to draw.
     */
    subscribeNext(): boolean {
        const ordinary = this.redis.ports.filter((p) => p.active && !p.subs)
        if (ordinary.length <= 1) return false
        void this.subscribe(ordinary[ordinary.length - 1])
        return true
    }

    /**
     * One whole life of a subscription, in the background: a client or two joins
     * the channel, a few messages go out, and then they leave.
     *
     * Channels are not a permanent fixture of a server — a pub/sub workload is
     * clients arriving to watch something and going away again — and a floor that
     * is violet all the time would say it was. So the default regime has nobody
     * listening at rest, and episodes come and go on their own.
     */
    private async pubsubEpisode() {
        if (this.episode || this.loading) return
        this.episode = true
        try {
            const ordinary = this.redis.ports.filter((p) => p.active && !p.subs)
            // never all of them: a subscriber cannot issue GET
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

    /**
     * Channels are quiet unless something drives them. A story drives them itself
     * and needs a floor with nobody on it, so it suspends the background episodes
     * and clears the listeners; exiting hands them back.
     */
    suspendPubSub() {
        this.scriptedPubSub = true
        this.redis.clearSubscribers()
    }

    resumePubSub() {
        this.scriptedPubSub = false
        this.pubsubTimer = rand(6, 12)
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
        // A fresh instance has nobody on the channel: subscriptions are something
        // clients come and do, not a state the server starts in.
        this.redis.clearSubscribers()
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

    /**
     * One PUBLISH on cue — the pub/sub story and the panel ask for exactly this
     * and nothing else. Ambient traffic publishes anyway, but a story cannot
     * wait for a 7 % slice of the mix to come round.
     */
    publish() {
        if (this.loading || this.inFlight >= 6) return
        void this.runOp(PUBLISH)
    }

    /**
     * A read aimed at one of the big values — the traversal story's cue.
     *
     * Ambient traffic reaches a big value 8 % of the time; a caption about
     * walking a quicklist cannot wait for that slice to come round. The key is
     * forced, the command is a range read, and everything else — socket, queue,
     * the one thread, the route — is the ordinary path, so the step shows the
     * real chain rather than a picture of one.
     */
    readBig(kind: BigKind, op: 'point' | 'walk' = 'walk'): boolean {
        if (this.loading || this.inFlight >= 6) return false
        // One cued read at a time, for the whole life of the ride — not just while
        // it is walking. A sustain tap lands every second and a request takes about
        // five to fall into its socket at story speed, so "refuse only while
        // walking" let every tap TAKE THE CAMERA from a request still on its way in:
        // the previous one was abandoned before it ever began its walk, and a step
        // waiting to freeze on the last leg of that walk waited forever. The comment
        // below said the next cue waits; this is what makes that true.
        if (this.walking || this.focusRide !== 0) return false
        const key = this.redis.bigKey(kind) ?? this.reviveBig(kind)
        if (!key) return false
        const name =
            kind === 'zset'
                ? op === 'point' ? 'ZSCORE' : 'ZRANGEBYSCORE'
                : kind === 'hash'
                    ? op === 'point' ? 'HGET' : 'HGETALL'
                    : 'LRANGE'
        void this.runOp({ name, write: false, weight: 1, walk: true, probe: op, cue: true }, key)
        return true
    }

    /**
     * A read of a compact value, drawn through the object section — the inline
     * story's cue. Same as any GET: one bucket, one object, one page.
     */
    readInline(): boolean {
        if (this.loading || this.inFlight >= 6 || this.walking || this.focusRide !== 0)
            return false
        const key = this.redis.compactKeyLeft()
        if (!key) return false
        void this.runOp({ name: 'GET', write: false, weight: 1, walk: true, probe: 'object', cue: true }, key)
        return true
    }

    /**
     * The same read against the large string — the sister story's cue.
     *
     * Identical path, identical stops, one more of them: the header on the first
     * page says `raw`, and the bytes are in a second allocation, so the read goes on
     * to a page an inline value never touches.
     */
    readRaw(): boolean {
        if (this.loading || this.inFlight >= 6 || this.walking || this.focusRide !== 0)
            return false
        const key = this.redis.rawKeyLeft()
        if (!key) return false
        void this.runOp({ name: 'GET', write: false, weight: 1, walk: true, probe: 'object', cue: true }, key)
        return true
    }

    /**
     * A story needs its subject to exist. If the big value was deleted by traffic
     * before the story started, it is put back — the drawing has a cage for it
     * either way, and a caption about an absent key is a caption about nothing.
     */
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

        // No glass page any more: nothing opens, so there is nothing to close either.
        // The read is legible from the structure that appears at the value stop and
        // rides with the packet.
        this.redis.focusPageAt(null)

        // A ride survives the hand-off from the inbound packet to the outgoing
        // copies, so a packet disappearing is NOT the end of it — the fan replaces
        // it within the same publish. This is only the safety valve for a ride that
        // died some other way, so the camera cannot be stuck on a stale box forever.
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

        // the expire cycle is a background chore, not a command
        if (!this.loading) this.expireCycle()

        // channels come and go: somebody subscribes, a few messages go out, they
        // leave. Paused while a story drives the same machinery by hand.
        if (this.ambient && !this.loading && !this.scriptedPubSub) {
            this.pubsubTimer -= dt
            if (this.pubsubTimer <= 0) {
                this.pubsubTimer = rand(14, 24)
                void this.pubsubEpisode()
            }
        }

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
