import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { BACKEND_ORIGIN, BACKEND_SLOTS, BLOCK_PICK_RANGE, PALETTE } from './instance'
import type { Info } from './instance'
import {
    BLOCK_LIFT,
    FLOOR_Y,
    OutlineBox,
    PULSE_GAIN,
    PULSE_TIME,
    Ticker,
    breathe,
    driftDust,
    dustField,
    floorLabel,
    halo,
    label,
    neonEdges,
    pulseHex,
    radialTexture,
    rand,
    randInt,
    slotLattice,
} from './util'

/**
 * The second database. Same species as the postgres cage next door — same
 * outline cage, same 8 kB-block lattice on the same plate, same ports on the
 * top rim, same painted floor labels — but a different machine underneath:
 * one thread, no planner, and the data itself living in RAM.
 *
 * Where postgres has pages on the floor and a small cache floating above them,
 * redis has almost nothing on the floor and the dataset itself in the air.
 */
export const REDIS_ORIGIN = new THREE.Vector3(-13, 0, -34)

/* ------------------------------- geometry ---------------------------------- */

/** Identical shell to the postgres cage: the two read as the same species. */
const SHELL = { w: 26.0, h: 9.8, d: 16.0 }

/**
 * The footprint of the block field. There is no platform under it: the blocks
 * stand on the global floor grid, so this only says where the field begins and
 * ends. Same rectangle as the postgres disk.
 */
const FIELD = { w: 24, d: 8.5, cz: 3.25 }

const PITCH = 0.5
/** One filesystem block: 4 kB. The only unit a file has. */
const BLOCK = { w: 0.46, h: 0.28, d: 0.46 }
/**
 * One key: a dictEntry, its sds key and its value object. A few hundred bytes at
 * most — twenty times smaller than the 4 kB block it is stored in, which is why a
 * key is drawn as a small cube and not as a block. Sizes here are a fourth of a
 * block's, not 1/20th: below that the keys stop being readable as objects, and
 * the point is the ratio, not the exact scale.
 */
const KEY = { w: 0.16, h: 0.1, d: 0.16 }
/** What a filesystem stores a byte stream in — the only unit a file has. */
const BLOCK_BYTES = 4096
/** Blocks rest ON the floor, lifted by the shared hair so the grid never cuts them. */
const PAGE_Y = FLOOR_Y + BLOCK_LIFT + BLOCK.h / 2
const BLOCK_TOP = PAGE_Y + BLOCK.h / 2
/** Labels are painted on the floor: the same plane as the grid, +3 mm for the glyphs. */
const FLOOR_LABEL_Y = FLOOR_Y + 0.003
/** Gap between the block field's edge and the first glyph of the DISK label. */
const DISK_LABEL_PAD = 0.21

const COLS = 48
const ROWS = 17
const xAt = (c: number) => -11.75 + c * PITCH
const zAt = (r: number) => -0.75 + r * PITCH

/**
 * Persistence, and only persistence, is on the disk: the incremental AOF run
 * at the front edge and the base RDB blob off to one side. Everything else is
 * free space, because the dataset is not here.
 */
const AOF_ROW = 16
const AOF_C0 = 22
/** Blocks the log occupies at boot — it has been running and has not been rewritten yet. */
const AOF_SEED = 13
/**
 * Where a rewrite builds its new file: the row in front of the log, opposite the
 * blocks those writes will end up in. Close enough that the swap is a one-row
 * move you can follow, and far enough that the log's own growth never lands on
 * it (row 14 is 74 blocks away in the growth order).
 */
const STAGING_ROW = AOF_ROW - 2
const RDB = { c0: 4, c1: 13, r0: 2, r1: 8 }

/**
 * How long one block takes to read or write during a load or a save, in
 * simulated seconds. A real 4 kB block is microseconds; this is the scale at
 * which a human can watch a file being written without it lying about the order.
 */
const RDB_BLOCK_TIME = 0.035
const AOF_RECORD_TIME = 0.055

/**
 * Invariant checking for the two files on this floor.
 *
 * Off by default — it walks the whole block field — and on when the page is
 * opened with `?debug`, or when the console sets `__redis.check()` on demand.
 * With it on, every structural change re-checks that the drawn blocks are
 * exactly the blocks the file state says, and throws if they are not: a scene
 * that draws a file it does not have is the bug that is hardest to see by eye.
 */
export let checkInvariants =
    typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug')

export function setInvariantChecks(on: boolean) {
    checkInvariants = on
}

/** The keyspace: a bucket array, and the entries it points at, both floating. */
const DICT = { cols: 32, rows: 7, y: 3.9, cz: -2.2 }
/**
 * Bucket counts the floor can draw. Real dicts double forever; this lattice holds
 * 224 tiles, so the demonstration stops at 128 and says so in the card rather
 * than silently refusing to grow.
 */
const HASH_SIZES = [32, 64, 128] as const
const HASH_MAX = HASH_SIZES[HASH_SIZES.length - 1]
const KEYS = { cols: 26, rows: 7, y: 7.0, cz: -2.2 }

const dictX = (c: number) => (c - (DICT.cols - 1) / 2) * PITCH
const dictZ = (r: number) => DICT.cz + (r - (DICT.rows - 1) / 2) * PITCH
const keyX = (c: number) => (c - (KEYS.cols - 1) / 2) * PITCH
const keyZ = (r: number) => KEYS.cz + (r - (KEYS.rows - 1) / 2) * PITCH

/** The single command loop, and the queue it drains. */
const LOOP = new THREE.Vector3(0, 7.6, 1.4)
const QUEUE = { cells: 10, y: 8.95, z: BACKEND_ORIGIN.z }
/**
 * The channel a publish is addressed to, and the whole of what pub/sub owns.
 *
 * A channel is a NAME, and what the server keeps is a dict from name to the list
 * of sockets on it. It is not a key: no value, no type, no TTL, nothing written to
 * the AOF or the dump. Which is why it is drawn up here beside the loop, off the
 * keyspace plane and off the floor — it belongs to the thread's own bookkeeping,
 * not to the dataset.
 *
 * Stood on edge in the gap between the queue and the loop, half-way in z. Laid
 * flat above the loop it was a lid over it, and the loop is the one thing in this
 * cage that reads as a sun from above: nothing is allowed to sit on it.
 */
const CHANNEL = { name: 'news', at: new THREE.Vector3(0, 8.3, 3.5) }
/**
 * The kernel's readiness set — epoll's registered fds, drawn as one tile per
 * connection on a plate hanging under the loop that consults it. This is the
 * structure that makes "ten thousand connections, one thread" true, and it
 * belongs to the kernel, not to the redis heap, which is why its cage is dashed.
 */
const EPOLL = {
    y: LOOP.y - 1.15,
    z: LOOP.z,
    pitch: 0.34,
    w: 0.24,
    h: 0.06,
    d: 0.2,
}

/** AOF buffer: the bytes not yet written to the file, in memory. */
const AOF_BUF_CELLS = 5
/** Height the aof_buf strip floats at: above the run, below the keyspace. */
const AOF_BUF_Y = 1.7
/** Top speed of a working agent, in units/s — fast, but a flight you can follow. */
const AGENT_SPEED = 16
/** Emissive of an empty queue slot, and of the head of the queue. */
const QUEUE_EMPTY = 0.05
const QUEUE_HEAD = 1.5

const RDB_CENTRE = new THREE.Vector3(
    (xAt(RDB.c0) + xAt(RDB.c1)) / 2,
    BLOCK_TOP,
    (zAt(RDB.r0) + zAt(RDB.r1)) / 2,
)

/**
 * Fill ramp for the blocks on this floor. A filesystem block is all-or-nothing:
 * it either holds its 4 kB or it does not exist at all. So 4 kB is the TOP of
 * this ramp — a block that is present is a full block, and is drawn at the bright
 * end, the way a packed 8 kB page is drawn bright in the postgres cage.
 *
 * The one exception is the last block of a file, which is as full as the file's
 * length left it (see layoutRdb): that one gets the dimmer end of the ramp, so
 * "brightness is how full" still means something here.
 */
const AOF_FILL_DARK = 0x2a1a04
const AOF_FILL_BRIGHT = 0xe09a2e
const RDB_FILL_DARK = 0x06222c
const RDB_FILL_BRIGHT = 0x23c9a6

/** Kind tints stay in the legend's family: RAM is cyan, disk is amber. */
const KIND_COLOR: Record<KeyKind, number> = {
    string: PALETTE.cyan,
    list: PALETTE.teal,
    hash: PALETTE.violet,
    set: PALETTE.magenta,
    zset: PALETTE.ice,
}
/**
 * Where a value stops being compact. A small hash, list or zset lives in ONE
 * flat listpack — a single contiguous allocation that is scanned linearly and
 * costs about its bytes and nothing more. A set of integers lives in an intset,
 * which converts much later. Past the limit redis has no way to add one more
 * element in place: it allocates the real structure and rewrites the whole value
 * in a single operation, on the one thread. These are the default limits.
 */
const LISTPACK_MAX_ENTRIES = 128
const INTSET_MAX_ENTRIES = 512
const encodingLimit = (kind: KeyKind) =>
    kind === 'set' ? INTSET_MAX_ENTRIES : LISTPACK_MAX_ENTRIES
/**
 * Bytes a key and its value take in the dump. Strings are small, collections are
 * not: this is why an RDB block holds a different number of keys every time, and
 * why the file's length tracks the dataset rather than the key count.
 */
const VALUE_BYTES: Record<KeyKind, [number, number]> = {
    string: [48, 700],
    list: [200, 2600],
    hash: [180, 3200],
    set: [140, 2000],
    zset: [220, 2800],
}
export type KeyKind = 'string' | 'list' | 'hash' | 'set' | 'zset'

/**
 * A value too big to be a block in the keyspace plane.
 *
 * These are ordinary keys in the dict — that is exactly what a skewed keyspace
 * is — but their SHAPE is what matters, and a plane of small cubes cannot say
 * "this one is a skiplist with 1.4 million nodes". Each gets its own area at the
 * back of the cage, its own dashed cage, and a drawing that is a SLICE: the
 * shape is the real structure, the count is not.
 */
export type BigKind = 'hash' | 'zset' | 'list'
export const BIG_SPOT: Record<BigKind, THREE.Vector3> = {
    hash: new THREE.Vector3(-8.6, 3.4, -6.2),
    zset: new THREE.Vector3(0, 3.4, -6.2),
    list: new THREE.Vector3(8.6, 3.4, -6.2),
}
/** What each big value really is, for its card. */
export const BIG_REAL: Record<BigKind, { entries: number; mb: number; unit: string }> = {
    hash: { entries: 5_300_000, mb: 412, unit: 'fields' },
    zset: { entries: 1_400_000, mb: 168, unit: 'members' },
    list: { entries: 2_100_000, mb: 96, unit: 'elements' },
}

export interface RedisKey {
    i: number
    row: number
    col: number
    home: THREE.Vector3
    kind: KeyKind
    live: boolean
    /** seconds left, 0 = no expiry */
    ttl: number
    heat: number
    shade: number
    /**
     * What this key and its value cost when the RDB encoder writes them, in
     * bytes. Values are not all the same size, so a block holds a different
     * number of keys depending on what happens to be next in the walk — that is
     * the only variation a dense file has.
     */
    bytes: number
    /** elements in the value; 0 for a string, which has no element count */
    entries: number
    /**
     * True once the value was converted out of its compact encoding. Redis never
     * converts back: a hash that became a hashtable stays one until the key is
     * deleted and rebuilt.
     */
    aux: boolean
    /** set when this key is drawn as its own area instead of a block in the plane */
    big?: BigKind
    /** one of the few keys that take most of the traffic */
    hot?: boolean
}

/** How a value is actually stored, as `OBJECT ENCODING` would report it. */
function encodingOf(key: RedisKey): string {
    switch (key.kind) {
        case 'string':
            // embstr: header and bytes in one allocation (up to 44 B), else raw
            return key.bytes <= 44 ? 'embstr' : 'raw'
        case 'hash':
            return key.aux ? 'hashtable' : 'listpack'
        case 'set':
            return key.aux ? 'hashtable' : 'intset'
        case 'zset':
            return key.aux ? 'skiplist + dict' : 'listpack'
        case 'list':
            return key.aux ? 'quicklist · 2 nodes' : 'quicklist · 1 node'
    }
}

/**
 * How many allocations the value's structure is drawn as. A compact encoding is
 * one block — a single listpack, one contiguous run of bytes. Converted, a hash
 * or a set becomes a bucket array plus per-entry nodes and a zset becomes TWO
 * structures at once (a dict for O(1) by member and a skiplist for the range),
 * so the drawing gives it two blocks: there really are two allocations.
 */
function auxBlocks(key: RedisKey): number {
    if (!key.aux || key.kind === 'string') return 0
    return key.kind === 'zset' ? 2 : 1
}

export interface RedisPort {
    id: number
    group: THREE.Group
    ring: THREE.MeshStandardMaterial
    glow: THREE.SpriteMaterial
    busy: boolean
    active: boolean
    pulse: number
    /**
     * True while this connection is in subscriber mode.
     *
     * A subscribed Redis connection is not a key-space client at all: while it
     * holds subscriptions it may only issue SUBSCRIBE, UNSUBSCRIBE and PING. So
     * this is not a decoration on an ordinary socket — it is a different kind of
     * client, drawn differently and never handed a GET.
     */
    subs: boolean
}

/**
 * World-space points the sim and the camera views aim at. Kept as stable
 * Vector3 instances and rewritten in place by rebaseAnchors(), because views
 * and the sim hold references to them and must follow the cage when it moves.
 */
export const REDIS_ANCHOR = {
    sky: new THREE.Vector3(),
    keys: new THREE.Vector3(),
    dict: new THREE.Vector3(),
    loop: new THREE.Vector3(),
    ports: new THREE.Vector3(),
    aof: new THREE.Vector3(),
    /** the floating aof_buf strip — it drifts, so update() rewrites this live */
    aofBuf: new THREE.Vector3(),
    rdb: new THREE.Vector3(),
    /** the three large values, drawn as their own areas at the back */
    bigHash: new THREE.Vector3(),
    bigZset: new THREE.Vector3(),
    bigList: new THREE.Vector3(),
}

/** local geometry + wherever the cage currently stands = world position */
function rebaseAnchors() {
    const o = REDIS_ORIGIN
    REDIS_ANCHOR.sky.set(6, 26, 2).add(o)
    REDIS_ANCHOR.keys.set(0, KEYS.y + 0.4, KEYS.cz + 0.4).add(o)
    REDIS_ANCHOR.dict.set(0, DICT.y, DICT.cz).add(o)
    REDIS_ANCHOR.loop.copy(LOOP).add(o)
    REDIS_ANCHOR.ports.set(0, BACKEND_ORIGIN.y, BACKEND_ORIGIN.z).add(o)
    REDIS_ANCHOR.aof.set(xAt(AOF_C0), BLOCK_TOP, zAt(AOF_ROW)).add(o)
    REDIS_ANCHOR.aofBuf.set(xAt(AOF_C0), AOF_BUF_Y, zAt(AOF_ROW)).add(o)
    REDIS_ANCHOR.rdb.copy(RDB_CENTRE).add(o)
    REDIS_ANCHOR.bigHash.copy(BIG_SPOT.hash).add(o)
    REDIS_ANCHOR.bigZset.copy(BIG_SPOT.zset).add(o)
    REDIS_ANCHOR.bigList.copy(BIG_SPOT.list).add(o)
}
rebaseAnchors()

const mixHex = (a: number, b: number, t: number) =>
    new THREE.Color(a).lerp(new THREE.Color(b), t).getHex()

export class RedisInstance {
    readonly group = new THREE.Group()
    readonly pickables: THREE.Object3D[] = []

    readonly keys: RedisKey[] = []
    readonly ports: RedisPort[] = []

    /** The 8 kB lattice. Same geometry and spacing as the postgres disk. */
    readonly blockGeo = new RoundedBoxGeometry(BLOCK.w, BLOCK.h, BLOCK.d, 1, 0.02)
    /** One key. Deliberately much smaller than a block — see KEY above. */
    readonly keyGeo = new RoundedBoxGeometry(KEY.w, KEY.h, KEY.d, 1, 0.012)

    private disk!: THREE.InstancedMesh
    private dictMesh!: THREE.InstancedMesh
    private keysMesh!: THREE.InstancedMesh
    /** the second (and for a zset, third) allocation of a converted value */
    private auxMesh!: THREE.InstancedMesh
    /** per-key deploy of a conversion, 0 → 1; the map holds only keys mid-flight */
    private auxAnim = new Map<number, number>()
    /** the few keys the traffic actually goes to */
    private hotKeys: RedisKey[] = []
    private hotHalos: THREE.Sprite[] = []
    /** one material per big value, so a touch can light the whole structure */
    private bigMats: Partial<Record<BigKind, THREE.MeshStandardMaterial>> = {}
    private bigPulse: Record<BigKind, number> = { hash: 0, zset: 0, list: 0 }
    /** the keys drawn as their own areas, by kind */
    private bigKeys: Partial<Record<BigKind, RedisKey>> = {}
    /** the volume of each big area, as built — the cage, the pick and the shot all use it */
    private bigAreas: Partial<Record<BigKind, THREE.Box3>> = {}
    /** base albedo per instance, so a flash can be undone */
    /** decaying pulse per disk instance — the one marker for "this block was touched" */
    private diskBoost = new Map<number, { v: number; hex: number }>()

    /* --------------------------- the dict's two tables --------------------------- */
    /** buckets in the live table; always one of HASH_SIZES */
    private htSize = 32
    /** buckets in the table being filled during a rehash, 0 when not rehashing */
    private ht1Size = 0
    /** the next bucket of ht[0] to migrate; -1 when not rehashing */
    private rehashIdx = -1
    /** which half of the lattice the live table occupies: it alternates per growth */
    private htHalf: 0 | 1 = 0
    /** stable per-tile shade, so repainting does not make the table shimmer */
    private dictShade: number[] = []
    private dictTableLab!: CSS2DObject
    /** seconds to the next rehash cron burst */
    private rehashTimer = 0.6

    /** instance ids of the AOF run, oldest → newest */
    private aofOrder: number[] = []
    /** instance id → position in the log */
    private aofIndex = new Map<number, number>()
    /** AOF blocks the file has reached, and blocks currently drawn */
    private aofHead = 0
    private aofDrawn = 0
    /** The floor is full: the file cannot grow, so appends have nowhere to go. */
    aofFull = false
    private aofEdge!: OutlineBox
    private aofPick!: THREE.Mesh
    /** the "this is a new file" tag over the staging area, shown only while rewriting */
    private stagingLab!: THREE.Object3D

    /** The base file's blocks in the order the encoder writes them. */
    private rdbOrder: number[] = []
    /** instance id → position in the file */
    private rdbIndex = new Map<number, number>()
    /** blocks the base file currently occupies, and how full the last one is */
    private rdbLen = 0
    private rdbTail = 1
    /** which keys landed in each block — the encoder is sequential, not aligned */
    private rdbBlocks: number[][] = []
    /** the outline around the base file, regrown as the file's length changes */
    private rdbEdge!: OutlineBox
    /** the volume you point at to read about the dump — gone while it is empty */
    private rdbPick!: THREE.Mesh
    /** per-instance base tint, so the RDB keeps its own shade across relayouts */
    private rdbBase: number[] = []
    /** true while a save or a load is walking the file */
    savingRdb = false
    loading = false
    /**
     * What memory holds right now. The files are older than this: the dump is a
     * past state and the log is the difference, and together they have to
     * reproduce exactly this — that is what durable means.
     */
    get dataset(): boolean[] {
        return this.keys.map((k) => k.live)
    }
    /** aof_buf: the cubes hover above wherever the end of the file is. */
    private aofBufGroup!: THREE.Group
    private aofBufCells: THREE.Mesh[] = []
    private aofBufMats: THREE.MeshStandardMaterial[] = []
    /** bytes sitting in aof_buf, as a fraction of the strip */
    private aofBuffered = 0
    /** records in aof_buf that have not reached the file yet */
    private aofPending = 0
    private aofPendingBytes = 0

    private queueCells: THREE.Mesh[] = []
    private queueMats: THREE.MeshStandardMaterial[] = []
    /** How many commands are waiting right now. 0 = the queue is empty. */
    private queueDepth = 0
    /** epoll's fd tiles, one per connection, and the flash of a completed read */
    private fdMats: THREE.MeshStandardMaterial[] = []
    private fdPulse: number[] = []
    private loopCore!: THREE.MeshStandardMaterial
    private loopRing!: THREE.Mesh
    /** the channel's ring, and how hard it was just hit by a publish */
    private channelRing!: THREE.Mesh
    private channelPulse = 0
    private bgsaveDrone!: THREE.Group
    private rewriteDrone!: THREE.Group
    /**
     * The saving agent belongs to the base file, not to the keyspace: the dump is
     * the thing it is responsible for, so it patrols an ellipse around that run —
     * the same deal the rewrite agent has with the log.
     */
    private readonly rdbHome = new THREE.Vector3(RDB_CENTRE.x, 1.45, RDB_CENTRE.z)
    private readonly rdbIdle = new THREE.Vector3()
    /** where its work currently aims it */
    private readonly rdbAim = new THREE.Vector3().copy(this.rdbHome)
    /**
     * Where the rewrite agent patrols while idle: the middle of the log it is
     * responsible for, not some abstract home point. Its idle orbit and its work
     * both happen over the same file.
     */
    private readonly rewriteHome = new THREE.Vector3(
        xAt(AOF_C0 + 4),
        AOF_BUF_Y + 0.9,
        zAt(AOF_ROW),
    )
    /** Where the agent is heading right now — the only thing its work sets. */
    private readonly rewriteAim = new THREE.Vector3().copy(this.rewriteHome)
    private readonly rewriteIdle = new THREE.Vector3()
    private readonly rewriteStep = new THREE.Vector3()
    /** True while bgrewriteaof is running — the agent drives itself then. */
    rewriting = false

    private tmpColor = new THREE.Color()
    private pulseColor = new THREE.Color()
    private tmpObj = new THREE.Object3D()
    private tmpBox = new THREE.Box3()
    /** the ambient dust in this cage — same field, same drift, as postgres */
    private motes!: THREE.Points

    /** counters the HUD reads */
    evictions = 0
    saves = 0
    aofBytes = 0
    rdbBytes = 0
    rewrites = 0

    constructor(private ticker: Ticker) {
        this.group.position.copy(REDIS_ORIGIN)
        this.buildShell()
        this.buildDisk()
        this.buildMemory()
        this.buildPorts()
        this.buildPubSub()
        this.buildPipeline()
        this.buildReadiness()
        this.buildBigKeys()
        this.buildAgents()

        // the base file is whatever the keyspace encodes to: its length comes
        // from the data, not from a constant
        this.writeRdbNow()

        this.openPort()
        this.openPort()
        this.openPort()
        this.openPort()

        if (checkInvariants) this.assertFrames()
    }

    /* -------------------------------- building ------------------------------- */

    private register(obj: THREE.Object3D, info: Info, outline?: OutlineBox) {
        obj.userData.info = info
        if (outline) obj.userData.outline = outline
        this.pickables.push(obj)
        return obj
    }

    /**
     * A pick built by `frame()` must be picked over exactly the cage it draws.
     *
     * The hover highlight IS that cage, so a pick volume from different numbers
     * does not throw or warn anywhere — it just puts the highlight inside its own
     * outline, which reads as a rendering glitch. `?debug` runs this once the
     * cage is built and refuses to start if a framed pick and its cage disagree.
     *
     * Only framed picks are checked. A file outline (the AOF, the RDB) is a
     * different relationship on purpose: the outline is the file's exact extent,
     * while the pick is deliberately generous so the file is easy to hit — two
     * volumes, describing two different things.
     */
    private assertFrames() {
        const a = new THREE.Box3()
        const b = new THREE.Box3()
        for (const obj of this.pickables) {
            if (!obj.userData.framed) continue
            const cage = obj.userData.outline as THREE.Object3D | undefined
            if (!cage) continue
            a.setFromObject(obj)
            b.setFromObject(cage)
            const d = Math.max(
                Math.abs(a.min.x - b.min.x),
                Math.abs(a.min.y - b.min.y),
                Math.abs(a.min.z - b.min.z),
                Math.abs(a.max.x - b.max.x),
                Math.abs(a.max.y - b.max.y),
                Math.abs(a.max.z - b.max.z),
            )
            if (d > 0.02) {
                const name = (obj.userData.info as Info | undefined)?.title ?? 'unnamed pick'
                throw new Error(
                    `[redis] pick and its cage disagree by ${d.toFixed(3)} — ${name}. ` +
                    'Build both with frame(): one centre, one size.',
                )
            }
        }
    }

    private buildShell() {
        const cage = new OutlineBox(SHELL.w, SHELL.h, SHELL.d, 0x3fa8cc, 0.34)
        cage.fromFloor(0, 0, 0)
        this.group.add(cage)
        this.register(cage, {
            title: 'Redis',
            body: 'One process, one thread executing commands. No planner, no parser tree, no per-connection backend: whatever a connection sends is queued and run in order by the same loop. That is why a slow command stalls everyone, and why a second core buys you almost nothing.',
            meta: 'one process · one command thread · dataset in RAM',
        })

        // Same sticker treatment as the postgres cage: painted on the +x wall, in
        // its top-left corner, at the same text height as the floor labels.
        const inset = 0.45
        const sticker = floorLabel('REDIS', { height: 0.475, color: 'rgba(170, 220, 242, 0.9)' })
        const ink = sticker.userData.ink as { x0: number; x1: number; y0: number; y1: number }
        sticker.rotation.set(0, Math.PI / 2, 0)
        sticker.position.set(
            SHELL.w / 2 + 0.012,
            SHELL.h - inset - ink.y1,
            SHELL.d / 2 - inset + ink.x0,
        )
            ; (sticker.material as THREE.MeshBasicMaterial).side = THREE.FrontSide
        this.group.add(sticker)

        // The air in the room. Both cages are the same volume and stand in the
        // same hall, so both get the same dust from the same definition in
        // util.ts — a cage with clean air reads as a diagram, not a place.
        this.motes = dustField(SHELL.w, SHELL.h, SHELL.d)
        this.group.add(this.motes)
    }

    private buildDisk() {
        // No platform and no slab: the blocks are the disk, and the global floor
        // grid is the only surface under them. Anything raised here would put the
        // file on a pedestal and leave the DISK label floating above the grid it
        // is supposed to be painted on.
        const platePick = new THREE.Mesh(
            new THREE.BoxGeometry(FIELD.w, 0.3, FIELD.d),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        platePick.position.set(0, 0.15, FIELD.cz)
        this.group.add(platePick)

        const mat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            // neutral emissive: albedo carries the meaning (amber = append log,
            // teal = snapshot), and an amber emissive here would tint the RDB olive
            emissive: 0x0a141a,
            emissiveIntensity: 1,
            roughness: 0.5,
            metalness: 0.3,
        })
        const field = new THREE.InstancedMesh(this.blockGeo, mat, COLS * ROWS)
        field.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        field.castShadow = true
        field.receiveShadow = true
        this.group.add(field)
        this.disk = field
        field.userData.infoFor = (hit: THREE.Intersection) => this.diskPick(hit)
        this.pickables.push(field)

        let i = 0
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                const home = new THREE.Vector3(xAt(c), PAGE_Y, zAt(r))
                const onRdb = r >= RDB.r0 && r <= RDB.r1 && c >= RDB.c0 && c <= RDB.c1

                this.tmpObj.position.copy(home)
                // Every file block starts absent: a block is drawn when the file
                // reaches it, and the log reaches a new one on every append. A
                // block that is not part of a file is collapsed on ALL three axes,
                // so the plate and the slot lattice show and no flattened sliver
                // is left.
                this.tmpObj.scale.setScalar(0.001)
                this.tmpObj.updateMatrix()
                field.setMatrixAt(i, this.tmpObj.matrix)
                // The file blocks get their colour from layoutAof()/layoutRdb(),
                // which know which of them the file has reached. A block that is
                // IN a file is a FULL block: 4 kB is the whole unit here, so it
                // sits at the bright end of the ramp. Small shade variation only,
                // because the records in a block are not all the same size.
                if (onRdb) {
                    this.rdbBase[i] = mixHex(RDB_FILL_DARK, RDB_FILL_BRIGHT, rand(0.94, 1.04))
                }
                i++
            }
        }
        if (field.instanceColor) field.instanceColor.needsUpdate = true

        // Where the log grows: a snake across the free floor, starting at the
        // front edge and running one block per append. This is the answer to
        // "what happens when it reaches the end" — it does not wrap and it does
        // not drop: an append-only file gets LONGER, and this is the order it
        // takes the empty blocks in. Only a rewrite ever makes it shorter.
        this.aofOrder = []
        this.aofIndex.clear()
        let leftToRight = true
        for (let r = AOF_ROW; r >= 0; r--) {
            const cols: number[] = []
            for (let c = 0; c < COLS; c++) {
                if (r === AOF_ROW && c < AOF_C0) continue
                // the base file lives on this floor too: the log grows around it
                if (r >= RDB.r0 && r <= RDB.r1 && c >= RDB.c0 && c <= RDB.c1) continue
                cols.push(c)
            }
            if (!leftToRight) cols.reverse()
            leftToRight = !leftToRight
            for (const c of cols) {
                const id = r * COLS + c
                this.aofIndex.set(id, this.aofOrder.length)
                this.aofOrder.push(id)
            }
        }

        // The log starts part-written: the file has reached the first N of these
        // blocks, and the rest are not drawn at all (see layoutAof). The layout
        // runs once the log's outline exists — fitAofEdge() is what sizes it.
        this.aofHead = AOF_SEED

        // The base file is one sequential write, so its blocks are laid out in the
        // order the encoder emits them — left to right, then right to left. A file
        // is a stream: it does not jump back to the left edge at every row.
        this.rdbOrder = []
        for (let r = RDB.r0; r <= RDB.r1; r++) {
            const row: number[] = []
            for (let c = RDB.c0; c <= RDB.c1; c++) row.push(r * COLS + c)
            if ((r - RDB.r0) % 2 === 1) row.reverse()
            for (const id of row) {
                this.rdbIndex.set(id, this.rdbOrder.length)
                this.rdbOrder.push(id)
            }
        }

        // The log gets an extent outline: a file should be a thing you can point
        // at and read about, not a patch of blocks you have to guess the meaning
        // of. Unlike the base file, its length is not the size of the data — it
        // is the size of the HISTORY, so it grows with every append and only a
        // rewrite takes it back down. The cage is fitted to the blocks the file
        // has actually reached (see fitAofEdge), so "where the file ends" and
        // "where the outline ends" are the same fact.
        const ax0 = xAt(AOF_C0) - PITCH / 2
        const ax1 = xAt(AOF_C0 + AOF_SEED) + PITCH / 2
        const az0 = zAt(AOF_ROW) - PITCH / 2
        const az1 = zAt(AOF_ROW) + PITCH / 2
        const aofEdge = new OutlineBox(
            ax1 - ax0,
            0.5,
            az1 - az0,
            PALETTE.amber,
            0.75,
        ).centre((ax0 + ax1) / 2, PAGE_Y + 0.1, (az0 + az1) / 2)
        this.group.add(aofEdge)
        this.aofEdge = aofEdge

        const aofPick = new THREE.Mesh(
            new THREE.BoxGeometry(ax1 - ax0, 1.4, az1 - az0),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        aofPick.position.set((ax0 + ax1) / 2, PAGE_Y + 0.5, (az0 + az1) / 2)
        this.group.add(aofPick)
        this.aofPick = aofPick
        this.register(
            aofPick,
            {
                title: 'AOF — the append-only file, on disk',
                body: 'This is a log of commands, not a copy of the data: every write appends its bytes after the last byte of the file, so the only unit here is the 4 kB block a filesystem stores it in. The file therefore GROWS — the blocks in front of the head are empty floor it takes as it needs them, and it keeps taking them for as long as writes arrive. It never wraps and never drops: wrapping over old data is what the WAL does next door, with a checkpoint deciding when a segment is free, and there is no such decision here. The only thing that makes this file shorter is a rewrite, which writes a new file containing the minimum commands that reproduce the current dataset and swaps it in. If nothing rewrites it and the floor fills, the disk is full and the appends start failing: redis then rejects the writes and keeps serving reads — the opposite of throwing bytes away quietly.',
                meta: 'appendonlydir · one growing file · shortened only by bgrewriteaof',
            },
            aofEdge,
        )

        // Now that the outline and the pick volume exist, draw the blocks the
        // file has reached: layoutAof() fits both to the file.
        this.layoutAof()

        // The rewrite writes a *different* file, so it needs somewhere to write
        // that the parent is not appending to. That floor is marked while it is
        // in use, and only while it is in use — an empty area labelled "new file"
        // would be a permanent claim about nothing.
        const stagingLab = label('AOF REWRITE · new file')
        stagingLab.position.set(xAt(AOF_C0) + 0.2, 1.1, zAt(STAGING_ROW) - 0.45)
        stagingLab.visible = false
        this.group.add(stagingLab)
        this.stagingLab = stagingLab

        // The base file gets the same treatment as the log: an extent outline, so
        // the file is a thing you can point at and read about rather than a patch
        // of blocks you have to guess the meaning of. Unlike the log, this file's
        // length IS a property of the data — it is rewritten from scratch by every
        // save — so the cage is regrown to hug whatever the file currently covers
        // (see fitRdbEdge).
        const rdbW = (RDB.c1 - RDB.c0 + 1) * PITCH
        const rdbD = (RDB.r1 - RDB.r0 + 1) * PITCH
        const rdbEdge = new OutlineBox(rdbW, 0.5, rdbD, PALETTE.teal, 0.7).centre(
            RDB_CENTRE.x,
            PAGE_Y + 0.1,
            RDB_CENTRE.z,
        )
        this.group.add(rdbEdge)
        this.rdbEdge = rdbEdge

        const rdbPick = new THREE.Mesh(
            new THREE.BoxGeometry(rdbW, 1.4, rdbD),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        rdbPick.position.set(RDB_CENTRE.x, PAGE_Y + 0.5, RDB_CENTRE.z)
        this.group.add(rdbPick)
        this.rdbPick = rdbPick
        this.register(
            rdbPick,
            {
                title: 'RDB — the base file, on disk',
                body: 'This is a dump, not a log: the keyspace is walked once and every key and value is written out as it stands, so loading it rebuilds the data structures rather than replaying commands. That is why it loads fast, why it only knows about the instant it was taken, and why everything after it comes from the AOF. It is written by the forked child (bgsave) and read back at start-up before the log is replayed on top. Its blocks are the same 4 kB the filesystem always hands out, packed tight with no gaps — the file is written fresh every time, so unlike a table file it has no holes to defragment. What varies is its length: that is the size of your data. Writes cost memory, not time: the child needs a copy-on-write view of the whole dataset, so a big instance briefly needs close to twice its size to save.',
                meta: 'dump.rdb · state, not history · written by bgsave, read on start',
            },
            rdbEdge,
        )

        // The slot lattice, over the whole field and from the same builder the
        // postgres disk uses: one grid for both disks, at one pitch, covering
        // every place a block can be — not only the part with no blocks in it.
        this.group.add(
            slotLattice(
                xAt(0) - PITCH / 2,
                xAt(COLS - 1) + PITCH / 2,
                zAt(0) - PITCH / 2,
                zAt(ROWS - 1) + PITCH / 2,
                PITCH,
            ),
        )

        // There is no write-head marker, and deliberately so. A frame, a blade,
        // a highlighted "selected" block — all of them claim something the log
        // does not do: that one block is special, or that it is about to be
        // swapped out. Appending touches exactly one block, and the honest way
        // to show that is the same way an edited page is shown next door: a
        // single pulse, then the block goes back to being an ordinary block.
        // The end of the file is readable from the log itself — the run stops
        // where the blocks stop.

        // floor labels, painted on the same ground as the postgres ones
        const diskLab = floorLabel('DISK', { height: 0.475, color: 'rgba(170, 220, 242, 0.9)' })
        diskLab.rotation.z = Math.PI / 2
        const ink = diskLab.userData.ink as { x0: number; x1: number; y0: number; y1: number }
        diskLab.position.set(
            FIELD.w / 2 + DISK_LABEL_PAD + ink.y1,
            FLOOR_LABEL_Y,
            FIELD.cz + FIELD.d / 2 + ink.x0,
        )
        this.group.add(diskLab)

        const aofLab = floorLabel('AOF', { height: 0.42, color: 'rgba(255, 190, 110, 0.9)' })
        aofLab.position.set(xAt(AOF_C0) + 0.4, FLOOR_LABEL_Y, zAt(AOF_ROW) - 0.85)
        this.group.add(aofLab)

        const rdbLab = floorLabel('BASE · RDB', { height: 0.42, color: 'rgba(150, 240, 220, 0.9)' })
        rdbLab.position.set(RDB_CENTRE.x, FLOOR_LABEL_Y, zAt(RDB.r1) + 0.75)
        this.group.add(rdbLab)

        const freeLab = floorLabel('FREE SPACE', {
            height: 0.34,
            color: 'rgba(120, 170, 190, 0.75)',
            opacity: 0.8,
        })
        freeLab.position.set(xAt(28), FLOOR_LABEL_Y, zAt(6))
        this.group.add(freeLab)

        this.register(
            platePick,
            {
                title: 'Disk — persistence only',
                body: 'The dataset is not on this floor. Two files are: the incremental AOF at the front edge, where every write command is appended, and the base RDB dump on the left — a compact copy produced by forking the server. Everything else is free space the files could grow into. Kill the process and whatever is only in RAM is gone; these two files are what comes back. A block here is all-or-nothing: a filesystem gives out 4 kB at a time, so if a block is in the file at all it is a full block, and it is drawn at the bright end of the scale. The only exception is the last block of a file, which holds whatever the length left over — that one is shorter and dimmer, and that is the only place where "how full" varies.',
                meta: 'appendonlydir · base rdb + incr aof · the rest is unused',
            },
        )
    }

    private buildMemory() {
        /* -------------------------- bucket array -------------------------- */
        const dGeo = new RoundedBoxGeometry(0.3, 0.07, 0.3, 1, 0.015)
        const dMat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            emissive: PALETTE.cyan,
            emissiveIntensity: 0.28,
            roughness: 0.4,
            metalness: 0.35,
        })
        const dict = new THREE.InstancedMesh(dGeo, dMat, DICT.cols * DICT.rows)
        dict.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        this.group.add(dict)
        this.dictMesh = dict

        let i = 0
        for (let r = 0; r < DICT.rows; r++) {
            for (let c = 0; c < DICT.cols; c++) {
                this.tmpObj.position.set(dictX(c), DICT.y, dictZ(r))
                this.tmpObj.scale.setScalar(1)
                this.tmpObj.updateMatrix()
                dict.setMatrixAt(i, this.tmpObj.matrix)
                this.dictShade[i] = rand(0.25, 0.5)
                i++
            }
        }
        if (dict.instanceColor) dict.instanceColor.needsUpdate = true
        // the table's extent and which buckets hold entries are painted from the
        // dict's own state, so the picture cannot claim a size the dict does not have
        this.paintDict()

        const dW = DICT.cols * PITCH
        const dD = DICT.rows * PITCH
        // No permanent outline: the bucket array is not a selected thing, it is
        // just there. Hovering it selects the whole table, and that is when the
        // cage is drawn — by the hover highlight, not by the group itself.
        const dictPick = new THREE.Mesh(
            new THREE.BoxGeometry(dW, 0.6, dD),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        dictPick.position.set(0, DICT.y, DICT.cz)
        this.group.add(dictPick)
        this.register(dictPick, {
            title: 'Hash table — the bucket array, and the rehash',
            body: 'The dictionary is what makes Redis O(1): hash the key, land on a bucket, follow its chain. This plane is the bucket array itself, sitting in the process heap — one contiguous allocation of pointers, and each of those pointers leads to a key entry floating in the plane above. There is no index to choose and no planner to consult — the data structure is the query plan. It also GROWS: when the entries outnumber the buckets, redis allocates a second table at twice the size and migrates buckets into it one at a time — the tiles vanishing on one half and lighting up on the other. Both tables are live meanwhile, and every lookup checks both, which is why the growth is incremental: a stop-the-world rehash of a million keys would be a latency spike, and a billion-key one would be a stall you could not hide. The two halves during a rehash are literal: there really are two arrays allocated at once.',
            meta: 'dict · ht_table[2] · incremental rehash, one bucket per operation',
        })
        const dictLab = label('DICT · BUCKETS')
        dictLab.position.set(-dW / 2 - 0.3, DICT.y + 0.55, DICT.cz - dD / 2)
        this.group.add(dictLab)
        // the size line, rewritten as the tables change
        const tableLab = label('')
        tableLab.position.set(-dW / 2 - 0.3, DICT.y + 0.22, DICT.cz - dD / 2)
        this.group.add(tableLab)
        this.dictTableLab = tableLab
        this.paintDict()

        /* ----------------------------- entries ---------------------------- */
        const kMat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            emissive: PALETTE.cyan,
            emissiveIntensity: 0.16,
            roughness: 0.45,
            metalness: 0.3,
        })
        const keys = new THREE.InstancedMesh(this.keyGeo, kMat, KEYS.cols * KEYS.rows)
        keys.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        this.group.add(keys)
        this.keysMesh = keys
        keys.userData.infoFor = (hit: THREE.Intersection) => this.keyPick(hit)
        this.pickables.push(keys)

        // The other allocation(s) of a converted value. Two slots per key, because
        // a zset converts into two structures at once and the drawing gives it two
        // blocks. Same geometry as a key block: these are allocations of the same
        // order of magnitude, stacked on top of the entry they extend.
        const aux = new THREE.InstancedMesh(this.keyGeo, kMat, KEYS.cols * KEYS.rows * 2)
        aux.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        this.group.add(aux)
        this.auxMesh = aux
        // the converted structures answer for the key they belong to: two
        // instances per key, so the instance id carries the key in its high bits
        aux.userData.infoFor = (hit: THREE.Intersection) => {
            if (hit.distance > BLOCK_PICK_RANGE || hit.instanceId === undefined) return null
            return this.keyInfo(Math.floor(hit.instanceId / 2))
        }
        this.pickables.push(aux)

        i = 0
        for (let r = 0; r < KEYS.rows; r++) {
            for (let c = 0; c < KEYS.cols; c++) {
                const home = new THREE.Vector3(keyX(c), KEYS.y, keyZ(r))
                // about three quarters of the slots hold a key at boot
                const live = Math.random() < 0.74
                const kinds: KeyKind[] = ['string', 'string', 'string', 'hash', 'list', 'set', 'zset']
                const kind = kinds[randInt(0, kinds.length - 1)]
                const size = VALUE_BYTES[kind]
                // A long-running instance is a mix, not a fresh start: most values
                // sit somewhere in the middle of their encoding's range, some
                // already went through the conversion, and a few are one write away
                // from the limit — which is exactly where the conversion happens, so
                // that is where a visitor should be able to see it.
                const limit = encodingLimit(kind)
                const near = Math.random() < 0.18
                const entries =
                    kind === 'string'
                        ? 0
                        : near
                            ? Math.max(1, limit - randInt(1, 4))
                            : Math.max(1, Math.round(limit * rand(0.3, 1.25)))
                const key: RedisKey = {
                    i,
                    row: r,
                    col: c,
                    home,
                    kind,
                    live,
                    ttl: Math.random() < 0.18 ? rand(4, 30) : 0,
                    heat: 0,
                    shade: rand(0.86, 1.1),
                    bytes: randInt(size[0], size[1]),
                    entries,
                    aux: entries > limit,
                }
                this.tmpObj.position.copy(home)
                this.tmpObj.scale.setScalar(live ? 1 : 0.001)
                this.tmpObj.updateMatrix()
                keys.setMatrixAt(i, this.tmpObj.matrix)
                const hex = mixHex(0x06222c, KIND_COLOR[kind], 0.55 * key.shade)
                keys.setColorAt(i, this.tmpColor.setHex(hex))
                this.keys.push(key)
                i++
            }
        }
        if (keys.instanceColor) keys.instanceColor.needsUpdate = true
        // the converted values' extra allocations, in their base colours
        this.paintAux()

        // The skew. A real keyspace is not uniform: a handful of keys take most
        // of the traffic, and a few values are so large that they are their own
        // structure rather than an entry. Both are drawn differently from the
        // ordinary block, and both are ordinary keys in the dict all the same.
        for (const kind of ['hash', 'zset', 'list'] as BigKind[]) {
            const key = this.keys.find((k) => k.live && !k.big && k.kind === kind)
            if (!key) continue
            const real = BIG_REAL[kind]
            key.big = kind
            key.aux = true
            key.entries = real.entries
            // what the FILE pays for it on this floor: the block is 4 kB and the
            // lattice is finite, so a 412 MB value cannot be drawn in it — a few
            // blocks is the sample. The card says the real number.
            key.bytes = 9000 + randInt(0, 3000)
            this.tmpObj.position.copy(key.home)
            this.tmpObj.scale.setScalar(0.001)
            this.tmpObj.updateMatrix()
            keys.setMatrixAt(key.i, this.tmpObj.matrix)
        }
        keys.instanceMatrix.needsUpdate = true

        // the hot keys: small, boring, and the reason there is a cache line's
        // worth of traffic in a million-entry keyspace
        this.hotKeys = this.keys
            .filter((k) => k.live && !k.big && k.kind === 'string')
            .filter((_, n) => n % 7 === 0)
            .slice(0, 4)
        for (const key of this.hotKeys) {
            key.hot = true
            // a hotter base colour, so the plane itself shows which entries the
            // traffic is actually about
            key.shade = 1.62
            keys.setColorAt(key.i, this.tmpColor.setHex(this.keyBase(key)))
        }
        if (keys.instanceColor) keys.instanceColor.needsUpdate = true

        const kW = KEYS.cols * PITCH
        const kD = KEYS.rows * PITCH
        // Same mechanism as the disk: one pick volume for the whole container.
        // The key blocks answer per-instance only from up close (see keyPick),
        // so from a distance you select the keyspace, not a lucky block.
        //
        // DASHED, because the volume is ours: the entries are separate
        // allocations scattered across the heap, and this plane is only where we
        // put them so they can be pointed at. A solid cage is reserved for
        // volumes that really exist — the process, the two files.
        const keysFrame = this.frame(
            new THREE.Vector3(0, KEYS.y, KEYS.cz),
            new THREE.Vector3(kW, 0.9, kD),
            PALETTE.cyan,
            { dashed: true },
        )
        const keysPick = keysFrame.pick
        const keysCage = keysFrame.cage
        this.register(
            keysPick,
            {
                title: 'Keyspace — the database itself, in RAM',
                body: 'Every block here is one key with its value: strings, hashes, lists, sets, sorted sets. This is the whole database. When the process restarts, whatever was only here is gone — the AOF and the RDB on the floor below are the only things that survive. When maxmemory is reached, keys are evicted from this plane, and eviction is the only thing that ever shrinks it. Two things to be clear about, because the drawing is ours: this is the SAME structure as the bucket array below, not a second arena — the buckets are one array of pointers, and each key is a separate little allocation that a bucket points at. And the lattice is only how we place them: in memory those entries are scattered across the heap wherever malloc put them, with no order at all. That is what the dashed cage says: the volume is a drawing, the blocks in it are real. The blocks are also deliberately small: a key is a dictEntry plus its key string plus a value object, a few hundred bytes, while the smallest unit on the floor below is a 4 kB block.',
                meta: `${KEYS.cols * KEYS.rows} slots · one allocation per key · position is representational`,
            },
            keysCage,
        )
        const keysLab = label('KEYS')
        keysLab.position.set(-kW / 2 - 0.4, KEYS.y + 0.95, KEYS.cz - kD / 2)
        this.group.add(keysLab)

        /* --------------------------- AOF buffer --------------------------- */
        // Same treatment as wal_buffers next door: block-sized cubes of memory
        // floating above the run, each with its own edges, bobbing and swaying,
        // drifting along with the end of the file. Deliberately not a box with
        // cubes inside it — these bytes are in RAM only, so they should read as
        // only half in this world.
        //
        // CYAN, not amber. In this scene amber means one thing: these bytes are in
        // the file. aof_buf is the opposite of that, and painting it amber made
        // the same colour claim both states at once. Cyan is the memory tint it
        // shares with wal_buffers, because it IS the same thing: a log tail that
        // has not reached the disk.
        const bufGroup = new THREE.Group()
        this.aofBufGroup = bufGroup
        bufGroup.position.set(this.aofHeadX(), AOF_BUF_Y, zAt(AOF_ROW))
        this.group.add(bufGroup)
        for (let n = 0; n < AOF_BUF_CELLS; n++) {
            const mat = new THREE.MeshStandardMaterial({
                color: 0x0b2a36,
                emissive: PALETTE.cyan,
                // dim at rest: adjacent emissive cubes at full strength bloom
                // into one white slab and stop reading as separate pages
                emissiveIntensity: 0.5,
                roughness: 0.35,
                metalness: 0.45,
                transparent: true,
                opacity: 0.94,
            })
            const cube = new THREE.Mesh(this.blockGeo, mat)
            cube.position.set((n - (AOF_BUF_CELLS - 1) / 2) * PITCH, 0, 0)
            cube.add(neonEdges(this.blockGeo, 0x8fe6ff, 0.55))
            bufGroup.add(cube)
            this.aofBufCells.push(cube)
            this.aofBufMats.push(mat)
        }
        const bufPick = new THREE.Mesh(
            new THREE.BoxGeometry(AOF_BUF_CELLS * PITCH, 0.6, BLOCK.d * 1.3),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        bufPick.position.set(0, 0.1, 0)
        bufGroup.add(bufPick)
        this.register(bufPick, {
            title: 'AOF buffer — bytes not yet on disk',
            body: 'Write commands are appended here first, in the process heap, and fsynced to the AOF file according to appendfsync: everysec (the default) loses up to a second, always loses nothing but pays a flush per write, no quietly hands durability to the kernel. Cyan is the point: this is memory, the bytes are not in the file yet, and they only turn amber when they are copied into the blocks below. The handover is a copy, not a move: write(2) hands the bytes to the kernel page cache and the buffer is reused. Compared with wal_buffers the difference is the contract, not the idea: postgres flushes at commit, redis flushes per appendfsync policy.',
            meta: 'aof_buf · in memory · appendfsync everysec by default',
        })
        // the label hangs UNDER the strip: the space above it belongs to the
        // AOF REWRITE agent, which works directly above the end of the log
        const bufLab = label('AOF BUFFER')
        bufLab.position.set(0, -0.62, 0)
        bufGroup.add(bufLab)
    }

    private buildPorts() {
        for (const [n, x] of BACKEND_SLOTS.entries()) {
            const g = new THREE.Group()
            g.position.set(x, BACKEND_ORIGIN.y, BACKEND_ORIGIN.z)

            const ring = new THREE.MeshStandardMaterial({
                color: 0x0b1a24,
                emissive: PALETTE.cyan,
                emissiveIntensity: 0.9,
                roughness: 0.3,
                metalness: 0.5,
            })
            const ringMesh = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.05, 8, 28), ring)
            ringMesh.rotation.x = Math.PI / 2
            g.add(ringMesh)

            const glow = new THREE.SpriteMaterial({
                map: radialTexture(),
                color: PALETTE.cyan,
                transparent: true,
                opacity: 0.28,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
            })
            const sprite = new THREE.Sprite(glow)
            sprite.scale.setScalar(2.0)
            g.add(sprite)

            const pick = new THREE.Mesh(
                new THREE.BoxGeometry(0.9, 0.5, 0.9),
                new THREE.MeshBasicMaterial({ visible: false }),
            )
            g.add(pick)
            this.register(pick, {
                title: `Connection ${n + 1} — a socket on one thread`,
                body: 'A connection is a file descriptor, not a process. Every connected client registers one entry in the readiness set just below and lands in the same command queue, and the commands are executed one at a time by the same thread. There is no per-connection stack and no per-connection heap worth speaking of — a client struct, a querybuf, a reply buffer, on the order of tens of kilobytes — so the limit here is fds (maxclients, 10000 by default), not processes. Compare the postgres cage next door, where the same socket is a forked process with megabytes of its own address space: 100 connections there, 10000 here, and the difference is exactly that. A violet socket is in subscriber mode instead: while it holds a subscription it may only SUBSCRIBE, UNSUBSCRIBE and PING, so it is never handed an ordinary command — published messages are copied into it and forgotten by the server.',
                meta: 'fd · ~30 kB · maxclients 10000 · shares the single thread',
            })

            this.group.add(g)
            this.ports.push({
                id: n,
                group: g,
                ring,
                glow,
                busy: false,
                active: false,
                pulse: 0,
                subs: false,
            })
            g.visible = false
        }
    }

    /**
     * The channel. One ring, floating in the thread's own air.
     *
     * Everything pub/sub owns is here: a name, and the list of sockets on it. No
     * block on the floor, no page, no record — a publish looks the name up, walks
     * the list and writes to both directions of each socket. Nothing about the
     * message survives the moment.
     */
    private buildPubSub() {
        const ring = new THREE.Mesh(
            new THREE.TorusGeometry(0.4, 0.013, 6, 56),
            new THREE.MeshBasicMaterial({
                color: PALETTE.violet,
                transparent: true,
                opacity: 0.5,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
            }),
        )
        ring.position.copy(CHANNEL.at)
        // left in its own plane: a ring standing on edge, facing the front of the
        // cage, so it is a circle from the house shot and a thin line from above
        this.group.add(ring)
        this.channelRing = ring

        const glow = halo(PALETTE.violet, 1.5, 0.14)
        glow.position.copy(CHANNEL.at)
        this.group.add(glow)

        const lab = label(`CHANNEL · ${CHANNEL.name}`)
        // under the ring, not beside it: to the side it collided with the KEYS
        // label, which lives further back and lands in the same place from the
        // house shot
        lab.position.copy(CHANNEL.at).add(new THREE.Vector3(0, -0.82, 0))
        this.group.add(lab)

        const pick = new THREE.Mesh(
            new THREE.BoxGeometry(0.92, 0.92, 0.42),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        pick.position.copy(CHANNEL.at)
        this.group.add(pick)
        // The cage is the ring's own plane, not the floor's: a vertical ring of
        // radius 0.4 is a square standing on edge, so the box is tall, wide and
        // thin — a flat XZ box would draw a lid over a ring that stands up.
        const cage = new OutlineBox(0.96, 0.96, 0.2, PALETTE.violet, 0.28, {
            dashed: true,
        }).centre(CHANNEL.at.x, CHANNEL.at.y, CHANNEL.at.z)
        this.group.add(cage)
        this.register(
            pick,
            {
                title: `Channel "${CHANNEL.name}" — a name, not a key`,
                body: 'This is all a channel is: a name, and the list of sockets subscribed to it. It lives in its own dict (pubsub_channels), which is looked up exactly like a key would be but shares nothing with the keyspace — no value, no type, no TTL, and no bytes of it are ever written to the AOF or the dump. SUBSCRIBE adds a socket to this list; a message is copied into each socket on it, and that is the whole operation. A subscriber that is not on the list when the message goes out never gets it: there is no queue, no backlog and no acknowledgement.',
                meta: 'pubsub_channels · name → sockets · in memory, nothing on disk',
            },
            cage,
        )
    }

    /** Where a publish is addressed, in cage-local units: the channel. */
    channelPoint(): THREE.Vector3 {
        return CHANNEL.at.clone()
    }

    /** The channel's name, for the status line and for a story's caption. */
    get channelName() {
        return CHANNEL.name
    }

    /** A fan just left the channel. */
    pulseChannel() {
        this.channelPulse = 1
    }

    private buildPipeline() {
        // The shared queue: everything the connections wrote, waiting for the loop.
        // Each slot gets its own material, because the whole point of a queue is
        // that slots differ: occupied ones are commands waiting their turn, empty
        // ones are just room. One shared material could only ever flash the strip
        // as a single object.
        const cellGeo = new THREE.BoxGeometry(0.36, 0.16, 0.52)
        for (let n = 0; n < QUEUE.cells; n++) {
            const mat = new THREE.MeshStandardMaterial({
                color: 0x140a1c,
                emissive: PALETTE.violet,
                emissiveIntensity: QUEUE_EMPTY,
                roughness: 0.4,
                metalness: 0.4,
            })
            const cell = new THREE.Mesh(cellGeo, mat)
            cell.position.set((n - (QUEUE.cells - 1) / 2) * 0.52, QUEUE.y, QUEUE.z)
            this.group.add(cell)
            this.queueCells.push(cell)
            this.queueMats.push(mat)
        }
        const qW = QUEUE.cells * 0.52 + 0.14
        // same rule as the bucket array: the queue is a container, not a marked
        // thing. Its cage appears when you hover it, never before.
        const qPick = new THREE.Mesh(
            new THREE.BoxGeometry(qW, 0.55, 0.62),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        qPick.position.set(0, QUEUE.y, QUEUE.z)
        this.group.add(qPick)
        this.register(qPick, {
            title: 'Command queue — shared by every connection',
            body: 'Reads and writes from all clients are parsed into an argv and queued here. The single command thread drains the queue in order, so a command that takes 10 ms delays every client behind it by 10 ms. Redis is fast because each command is short, not because it runs many at once.',
            meta: 'one queue · one consumer · strictly in order',
        })
        const qLab = label('COMMAND QUEUE')
        qLab.position.set(-qW / 2 - 0.2, QUEUE.y + 0.4, QUEUE.z)
        this.group.add(qLab)

        // the loop: one core, one ring — no parser, no planner, no executor chain
        const core = new THREE.MeshStandardMaterial({
            color: 0x0d2630,
            emissive: PALETTE.ice,
            emissiveIntensity: 1.6,
            roughness: 0.3,
            metalness: 0.4,
        })
        const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 1), core)
        orb.position.copy(LOOP)
        this.group.add(orb)
        this.loopCore = core

        const cage = new THREE.Mesh(
            new THREE.IcosahedronGeometry(0.82, 1),
            new THREE.MeshBasicMaterial({
                color: PALETTE.ice,
                wireframe: true,
                transparent: true,
                opacity: 0.22,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
            }),
        )
        cage.position.copy(LOOP)
        this.group.add(cage)

        const ring = new THREE.Mesh(
            new THREE.TorusGeometry(1.02, 0.016, 6, 64),
            new THREE.MeshBasicMaterial({
                color: PALETTE.ice,
                transparent: true,
                opacity: 0.5,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
            }),
        )
        ring.rotation.x = Math.PI / 2
        ring.position.copy(LOOP)
        this.group.add(ring)
        this.loopRing = ring

        // a halo so it reads as the one hot thing in the cage
        const aurora = new THREE.Sprite(
            new THREE.SpriteMaterial({
                map: radialTexture(),
                color: PALETTE.ice,
                transparent: true,
                opacity: 0.3,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
            }),
        )
        aurora.scale.setScalar(4.4)
        aurora.position.copy(LOOP)
        this.group.add(aurora)

        const loopLab = label('COMMAND LOOP')
        loopLab.position.set(LOOP.x + 1.2, LOOP.y + 0.1, LOOP.z)
        this.group.add(loopLab)
    }

    /**
     * The kernel's readiness set: one tile per fd the loop has registered.
     *
     * A connection in this cage is not a worker, and the missing part of that
     * claim was this set — the loop does not wait on any one socket, it asks the
     * kernel which fds are readable and only then reads. That is why a lit tile
     * can sit there doing nothing for hours, and why the count of tiles is not
     * the count of threads. Dashed cage: the tiles are real fds, the theatre of
     * laying them in a row is ours — inside the kernel they are an array.
     */
    private buildReadiness() {
        const n = BACKEND_SLOTS.length
        const tileGeo = new THREE.BoxGeometry(EPOLL.w, EPOLL.h, EPOLL.d)
        for (let i = 0; i < n; i++) {
            const mat = new THREE.MeshStandardMaterial({
                color: 0x081018,
                emissive: PALETTE.cyan,
                emissiveIntensity: 0.03,
                roughness: 0.4,
                metalness: 0.4,
            })
            const tile = new THREE.Mesh(tileGeo, mat)
            tile.position.set((i - (n - 1) / 2) * EPOLL.pitch, EPOLL.y, EPOLL.z)
            this.group.add(tile)
            this.fdMats.push(mat)
            this.fdPulse.push(0)
        }

        const setW = n * EPOLL.pitch + 0.12
        const setD = EPOLL.d + 0.16
        const setCage = new OutlineBox(setW, 0.4, setD, PALETTE.cyan, 0.2, {
            dashed: true,
        }).centre(0, EPOLL.y, EPOLL.z)
        this.group.add(setCage)

        const setPick = new THREE.Mesh(
            new THREE.BoxGeometry(setW, 0.4, setD),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        setPick.position.set(0, EPOLL.y, EPOLL.z)
        this.group.add(setPick)
        this.register(
            setPick,
            {
                title: 'epoll — the kernel\u2019s readiness set',
                body: 'Every open connection is one fd registered here with a mask of interest, usually just "readable". The single thread does not poll each socket and does not own a thread per client: it calls epoll_wait, the kernel hands back only the fds that have bytes, and each of those is read and parsed in turn. A tile stays lit for as long as its connection exists, whether or not anything is happening on it — a million idle connections cost a million entries and no CPU. The flash is a read that actually happened. This is the reason a connection here is cheap: no process, no stack, no per-connection heap to speak of, just an fd, an entry in this set, and a small querybuf.',
                meta: 'kernel-side · one entry per fd · the loop reads only what is ready',
            },
            setCage,
        )

        // under the plate, not beside the loop: the two labels land in the same
        // screen spot from the wide shots otherwise
        const lab = label('EPOLL · FDS')
        lab.position.set(-setW / 2 - 0.25, EPOLL.y - 0.3, EPOLL.z + 0.45)
        this.group.add(lab)
    }

    /* ------------------------------ big values ------------------------------- */

    /**
     * The three large values.
     *
     * A plane of small cubes can say "there are many keys" and "this one is
     * bigger", but it cannot say what a 5-million-field hash IS — and that shape
     * is the whole answer to "so this is what my big list looks like?". So each
     * big value is drawn as its own structure, in its own dashed cage at the back
     * of the cage: a bucket array with chains, a skiplist with the dict beside it,
     * a chain of quicklist nodes.
     *
     * What is drawn is a SLICE. The shapes are the real ones; the counts are not,
     * and every card says the real number so the drawing can never be mistaken
     * for the size.
     */
    private buildBigKeys() {
        for (const key of this.keys) if (key.big) this.bigKeys[key.big] = key
        this.buildBigHash()
        this.buildBigZset()
        this.buildBigList()
        this.buildHotHalos()
    }

    private bigMaterial(kind: BigKind): THREE.MeshStandardMaterial {
        const mat = new THREE.MeshStandardMaterial({
            color: 0x0d0a16,
            emissive: KIND_COLOR[kind],
            emissiveIntensity: 0.42,
            roughness: 0.4,
            metalness: 0.35,
        })
        this.bigMats[kind] = mat
        return mat
    }

    /**
     * One volume, and everything that has to agree about it.
     *
     * A framed thing in this scene has three descriptions of the same volume: the
     * dashed cage you see, the invisible box you pick, and the box the camera
     * frames. Typed out twice they drift — a pick 0.8 tall inside a cage 0.9 tall
     * makes the hover highlight sit inside its own outline instead of on it.
     *
     * So they are not typed out twice. The cage and the pick are built from the
     * same `size`, both are placed at the same `centre`, and the pick is handed
     * that box AND the cage itself: hovering or focusing draws the cage, never a
     * second box derived from a different number.
     */
    private frame(
        centre: THREE.Vector3,
        size: THREE.Vector3,
        colour: number,
        opts: { dashed?: boolean; opacity?: number } = {},
    ): { cage: OutlineBox; pick: THREE.Mesh; box: THREE.Box3 } {
        const cage = new OutlineBox(size.x, size.y, size.z, colour, opts.opacity ?? 0.26, {
            dashed: opts.dashed,
        }).centre(centre.x, centre.y, centre.z)
        this.group.add(cage)
        const pick = new THREE.Mesh(
            new THREE.BoxGeometry(size.x, size.y, size.z),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        pick.position.copy(centre)
        this.group.add(pick)
        // the highlight IS the cage
        pick.userData.outline = cage
        // and this is one of the volumes where the pick and the cage are the same
        // box by construction, which is what assertFrames() holds us to
        pick.userData.framed = true
        return { cage, pick, box: new THREE.Box3().setFromCenterAndSize(centre, size) }
    }

    /** The dashed cage, the pick box and the label for one big value. */
    private bigFrame(kind: BigKind, w: number, h: number, d: number, cy: number) {
        const at = BIG_SPOT[kind]
        const centre = new THREE.Vector3(at.x, at.y + cy, at.z)
        const size = new THREE.Vector3(w, h, d)
        const { pick, box } = this.frame(centre, size, KIND_COLOR[kind], {
            dashed: true,
            opacity: 0.2,
        })
        // the camera frames exactly this volume, and the card reports it
        this.bigAreas[kind] = box
        const key = this.bigKeys[kind]
        if (key) {
            pick.userData.infoFor = () => this.keyInfo(key.i)
            this.pickables.push(pick)
        }
        const lab = label(`${kind.toUpperCase()} · 1 KEY`)
        lab.position.set(at.x - w / 2 - 0.45, at.y + cy + h / 2 + 0.3, at.z - d / 2 - 0.1)
        this.group.add(lab)
    }

    /** A hashtable: the bucket array, and the chains hanging off it. */
    private buildBigHash() {
        const at = BIG_SPOT.hash
        const mat = this.bigMaterial('hash')
        const cols = 9
        const rows = 3
        const pitch = 0.36
        const bucketGeo = new RoundedBoxGeometry(0.24, 0.07, 0.24, 1, 0.01)
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const tile = new THREE.Mesh(bucketGeo, mat)
                tile.position.set(
                    at.x + (c - (cols - 1) / 2) * pitch,
                    at.y,
                    at.z + (r - (rows - 1) / 2) * pitch,
                )
                this.group.add(tile)
            }
        }
        // one entry per bucket, two in a few, none in others — the chains are the
        // reason the array stays small while the value grows
        const eGeo = new RoundedBoxGeometry(0.15, 0.15, 0.15, 1, 0.01)
        for (let c = 0; c < cols; c++) {
            const links = c % 4 === 1 ? 2 : c % 5 === 2 ? 0 : 1
            for (let k = 0; k < links; k++) {
                const e = new THREE.Mesh(eGeo, mat)
                e.position.set(
                    at.x + (c - (cols - 1) / 2) * pitch,
                    at.y + 0.28 + k * 0.17,
                    at.z + ((rows - 1) / 2) * pitch + 0.26,
                )
                this.group.add(e)
            }
        }
        this.bigFrame('hash', cols * pitch + 0.5, 1.6, rows * pitch + 1.2, 0.34)
    }

    /** A sorted set: a skiplist tower, and the dict beside it. */
    private buildBigZset() {
        const at = BIG_SPOT.zset
        const mat = this.bigMaterial('zset')
        const pitch = 0.42
        // Heights per column, as a skiplist really builds them: every node is at
        // the bottom level, and each one is promoted a few levels with probability
        // 1/4. The result is what makes the picture mean something — a link two
        // levels up skips over whole runs of the list, which is the entire idea.
        const heights = [5, 1, 2, 1, 4, 1, 3, 1, 2, 1, 5]
        const cols = heights.length
        const levels = 5
        const nodeGeo = new RoundedBoxGeometry(0.17, 0.17, 0.17, 1, 0.01)
        for (let lv = 0; lv < levels; lv++) {
            const y = at.y + lv * 0.32
            let prev = NaN
            for (let c = 0; c < cols; c++) {
                if (heights[c] <= lv) continue
                const x = at.x + (c - (cols - 1) / 2) * pitch
                const node = new THREE.Mesh(nodeGeo, mat)
                node.position.set(x, y, at.z)
                this.group.add(node)
                if (!Number.isNaN(prev) && x - prev > 0.1) {
                    const link = new THREE.Mesh(new THREE.BoxGeometry(x - prev - 0.14, 0.02, 0.02), mat)
                    link.position.set((prev + x) / 2, y, at.z)
                    this.group.add(link)
                }
                prev = x
            }
        }
        // the other half of the value: a dict for "score of this member"
        const dictGeo = new RoundedBoxGeometry(0.2, 0.06, 0.2, 1, 0.01)
        for (let c = 0; c < 6; c++) {
            const tile = new THREE.Mesh(dictGeo, mat)
            tile.position.set(at.x - 0.75 + c * 0.3, at.y - 0.55, at.z + 0.95)
            this.group.add(tile)
        }
        this.bigFrame('zset', 5.0, 2.7, 2.5, 0.5)
    }

    /** A long list: a chain of quicklist nodes, each a small listpack. */
    private buildBigList() {
        const at = BIG_SPOT.list
        const mat = this.bigMaterial('list')
        const nodes = 5
        const nodeGeo = new RoundedBoxGeometry(0.72, 0.22, 0.34, 1, 0.02)
        const sliceGeo = new THREE.BoxGeometry(0.19, 0.23, 0.35)
        let x = at.x - 2.3
        for (let n = 0; n < nodes; n++) {
            const node = new THREE.Mesh(nodeGeo, mat)
            node.position.set(x, at.y, at.z)
            this.group.add(node)
            // the listpack inside the node, drawn as the pack of elements it is
            for (let k = -1; k <= 1; k++) {
                const slice = new THREE.Mesh(sliceGeo, mat)
                slice.position.set(x + k * 0.21, at.y, at.z)
                this.group.add(slice)
            }
            if (n < nodes - 1) {
                // the third gap is drawn long: that is where the drawing stops and
                // the real chain runs on for tens of thousands more nodes
                const skip = n === 2 ? 1.5 : 0
                const link = new THREE.Mesh(new THREE.BoxGeometry(0.34 + skip, 0.03, 0.03), mat)
                link.position.set(x + 0.53 + skip / 2, at.y, at.z)
                this.group.add(link)
                x += 1.02 + skip
            }
        }
        this.bigFrame('list', 7.4, 1.4, 1.9, 0.1)
    }

    /**
     * Hot keys. Nothing about them is special in memory — that IS the point:
     * a 200-byte string can carry most of the traffic in a keyspace of millions,
     * and every request for it goes through the same one thread.
     */
    private buildHotHalos() {
        for (const [i, key] of this.hotKeys.entries()) {
            const sprite = new THREE.Sprite(
                new THREE.SpriteMaterial({
                    map: radialTexture(),
                    color: PALETTE.ice,
                    transparent: true,
                    opacity: 0.26,
                    depthWrite: false,
                    blending: THREE.AdditiveBlending,
                }),
            )
            sprite.scale.setScalar(0.62)
            sprite.position.copy(key.home).add(new THREE.Vector3(0, KEY.h * 0.7, 0))
            sprite.userData.hot = i
            this.group.add(sprite)
            this.hotHalos.push(sprite)
        }
    }

    private buildAgents() {
        this.bgsaveDrone = this.makeAgent(
            this.rdbHome.clone(),
            PALETTE.teal,
            'BGSAVE',
            {
                title: 'BGSAVE — a forked child writes the dump',
                body: 'The snapshot is taken by forking: the child gets a copy-on-write view of the whole keyspace and writes it to a new RDB file while the parent keeps serving. Nothing is locked, not even for an instant, and the queue keeps draining — watch it while this runs. The cost is memory, not time: every page the parent modifies before the child has written it gets duplicated, so a big instance can briefly need close to twice its dataset. SAVE is the same work without the fork, and that one does stop the server.',
                meta: 'fork() · copy-on-write · no locking, extra memory',
            },
        )
        this.rewriteDrone = this.makeAgent(
            // it rests over the base file: a rewrite produces exactly that, a new
            // base written from the current state
            this.rewriteHome.clone(),
            PALETTE.amber,
            'AOF REWRITE',
            {
                title: 'AOF rewrite — write the log down to its current state',
                body: 'The AOF records commands, so it grows without bound: a key set a thousand times is a thousand commands. Rewriting walks the keyspace and writes the minimum set of commands that reproduces it, into a new file, then swaps it in. Same idea as a postgres checkpoint letting old WAL be recycled, except here the log itself is rewritten.',
                meta: 'bgrewriteaof · new file, then atomic swap',
            },
        )
    }

    private makeAgent(pos: THREE.Vector3, color: number, text: string, info: Info): THREE.Group {
        const g = new THREE.Group()
        g.position.copy(pos)

        const body = new THREE.Mesh(
            new THREE.OctahedronGeometry(0.3, 0),
            new THREE.MeshStandardMaterial({
                color: 0x0a141a,
                emissive: color,
                emissiveIntensity: 1.8,
                roughness: 0.3,
                metalness: 0.45,
            }),
        )
        g.add(body)
        g.add(halo(color, 2.0, 0.28))

        // No ring around the agent. A flat torus lying in the XZ plane reads as a
        // cage drawn around it — the same "this thing is selected" signal the
        // scene uses for hover — and it was on permanently. The body and the halo
        // are enough to find it; the pick box below is what makes it selectable.

        const tag = label(text)
        tag.position.set(0.5, 0.15, 0)
        g.add(tag)

        const pick = new THREE.Mesh(
            new THREE.BoxGeometry(1.1, 0.9, 1.1),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        g.add(pick)
        this.register(pick, info)

        this.group.add(g)
        return g
    }

    /* --------------------------------- picking ------------------------------- */

    private instanceAt(hit: THREE.Intersection, count: number): number | null {
        if (hit.instanceId === undefined || hit.instanceId < 0 || hit.instanceId >= count) return null
        return hit.instanceId
    }

    /**
     * Pick boxes are built in cage-local units, because that is where the blocks
     * live. The pointer outlines them and the camera flies to them in world
     * space, so they have to be lifted through the cage's own transform — the
     * cage is not at the origin any more.
     */
    private toWorld(box: THREE.Box3): THREE.Box3 {
        this.group.updateMatrixWorld()
        return box.applyMatrix4(this.group.matrixWorld)
    }

    private diskPick(hit: THREE.Intersection) {
        // Nothing inside a container answers for itself until you are close enough
        // to mean it: from across the room a click is about the file, not about
        // one 4 kB block. Same range rule as the postgres disk.
        if (hit.distance > BLOCK_PICK_RANGE) return null
        const i = this.instanceAt(hit, COLS * ROWS)
        if (i === null) return null
        const r = Math.floor(i / COLS)
        const c = i % COLS
        const aofSeq = this.aofIndex.get(i)
        const onAof = aofSeq !== undefined && aofSeq <= this.aofHead
        const rdbSeq = this.rdbIndex.get(i)
        const onRdb = rdbSeq !== undefined && rdbSeq < this.rdbLen
        if (!onAof && !onRdb) return null

        const home = new THREE.Vector3(xAt(c), PAGE_Y, zAt(r))
        const box = new THREE.Box3().setFromCenterAndSize(
            home.clone().add(new THREE.Vector3(0, BLOCK.h / 2, 0)),
            new THREE.Vector3(BLOCK.w, BLOCK.h, BLOCK.d),
        )
        const info: Info = onAof
            ? {
                title: `AOF — record ${(aofSeq ?? 0) + 1} of ${this.aofUsed}`,
                body: 'One command, appended in order after the last byte of the file. Replay is re-execution: start from the base file and run every record after it, and you are back where the server was. That is why AOF is safe but slow to load, and why records must be deterministic — a command that depends on the clock or on random data is rewritten before it is logged. The file only ever gets longer; a record is never overwritten and never reused.',
                meta: 'appendonly.aof · replayed in order on start',
            }
            : {
                title: `RDB — block ${(rdbSeq ?? 0) + 1} of ${this.rdbLen}`,
                body: 'One 4 kB block of the dump — a binary serialisation of the keyspace, written in one pass with no padding, so every block but the last is completely full. Because values differ in size, the number of keys that end up in a block does not: this one holds ' + `${this.rdbBlocks[rdbSeq ?? 0]?.length ?? 0}. ` + 'The block size never varies, only how much of the file is used.',
                meta: 'dump.rdb · state, not history · loaded on start',
            }
        return { key: `redis-disk-${i}`, info, box: this.toWorld(box) }
    }

    private keyPick(hit: THREE.Intersection) {
        // same rule: a key is only selectable from close up, otherwise you are
        // pointing at the keyspace as a whole
        if (hit.distance > BLOCK_PICK_RANGE) return null
        const i = this.instanceAt(hit, this.keys.length)
        if (i === null) return null
        return this.keyInfo(i)
    }

    /** The inspector payload for one key, shared by its entry block and its structures. */
    private keyInfo(i: number) {
        const key = this.keys[i]
        if (!key || !key.live) return null
        if (key.big) return this.bigInfo(key)
        const box = new THREE.Box3().setFromCenterAndSize(
            key.home.clone().add(new THREE.Vector3(0, this.keyStack(key) / 2, 0)),
            new THREE.Vector3(KEY.w, this.keyStack(key), KEY.d),
        )
        const enc = encodingOf(key)
        const limit = encodingLimit(key.kind)
        const what = key.kind === 'hash' ? 'fields' : key.kind === 'set' ? 'members' : 'elements'
        const ttl = key.ttl > 0 ? ` · ttl ≈ ${key.ttl.toFixed(0)} s` : ''
        const isString = key.kind === 'string'
        return {
            key: `redis-key-${i}`,
            info: {
                title: `key #${i} — ${key.kind} · ${enc}`,
                body:
                    'One key and its value, living in the process heap. Reads are a hash plus a pointer chase: no buffer pool, no page read, no disk. This is also why a key that is bigger than memory cannot exist here at all, and why one slow O(N) command on a big value blocks every other client. ' +
                    (isString
                        ? `A string keeps no element count, so it never converts: ${key.bytes} B is stored ${enc}, ${key.bytes <= 44 ? 'inline behind the object header in the same allocation' : 'as a separate malloc behind the header'}, and any write replaces the whole value.`
                        : key.aux
                            ? `The encoding is ${enc}. Past ${limit} ${what} the flat buffer could not take one more element in place, so redis read the whole value, freed it, and allocated the real structure in a single operation — ` +
                            (key.kind === 'zset'
                                ? 'two of them, in fact: a dict answering "which score for this member" and a skiplist answering "which members are between these two". That is why this key block carries two blocks above it; there really are two allocations up there.'
                                : key.kind === 'list'
                                    ? 'the next listpack node, chained onto the first. A list never changes encoding, it just grows node by node — the block above is that second node.'
                                    : 'a bucket array with one entry and one chain pointer per element. The block above the key is that structure.') +
                            ' It never converts back: the bigger encoding is kept until the key is deleted.'
                            : `Still compact, at ${key.entries} of ${limit} ${what}: the whole value is ONE ${enc} — a single contiguous allocation, scanned linearly. It costs about its bytes and nothing more, which is why a small ${key.kind} is so cheap. One more write past ${limit} and the entire value is rewritten into the real structure, in one go, on the single thread — the conversion is the one write here that is O(n).`),
                meta: isString
                    ? `${key.bytes} B · encoding ${enc}${ttl} · in RAM`
                    : `${key.entries} ${what} · encoding ${enc}${ttl} · in RAM`,
            } as Info,
            box: this.toWorld(box),
        }
    }

    /**
     * The card for one large value.
     *
     * Same rule as the encoding cards: the drawing is a SLICE, so the card carries
     * the real number and says so. What it can show honestly is the shape — and
     * the shape is the answer to what a big list or a big sorted set really is.
     */
    private bigInfo(key: RedisKey) {
        const kind = key.big as BigKind
        const real = BIG_REAL[kind]
        const body: Record<BigKind, string> = {
            hash: 'A hashtable: one bucket array, and one chain per bucket. This is ONE key — five million fields, hundreds of megabytes — and every one of them is behind that single entry in the dict. That is why HGETALL on it is not a slow query but a stall: the command runs on the one thread, walks all of it, and every other client waits. DEL of this key is the same problem. What is drawn here is the shape and not the count: nine buckets, a few chains; the real array is a few million pointers long and doubles with a rehash.',
            zset: 'A sorted set is TWO structures at once, and this is why: a skiplist for the range queries, and a dict beside it answering "what is the score of this member" in O(1). The tower is the whole trick — each level skips over more of the list, so ZRANGEBYSCORE finds its starting point in a few hops instead of a walk. One and a half million members, one key. The drawing shows five levels and seven nodes; the real tower has the same shape with a few million nodes under it.',
            list: 'A long list is not one array: it is a quicklist, a doubly linked chain of nodes, and each node holds a small listpack. Two million elements, one key. That shape is the reason LPUSH and RPUSH are O(1) while LINDEX in the middle is O(n): the middle is a walk along the chain, through nodes that are not next to each other in memory. The long gap in this chain is where the drawing stops — the real one runs on for tens of thousands of nodes.',
        }
        return {
            key: `redis-key-${key.i}`,
            info: {
                title: `key #${key.i} — ${kind} · ${encodingOf(key)} · a big value`,
                body: body[kind],
                meta: `1 key · ${real.entries.toLocaleString('en-US')} ${real.unit} · ~${real.mb} MB · drawn as a slice`,
            } as Info,
            box: this.toWorld(this.bigBox(kind)),
        }
    }

    /* ---------------------------------- ports -------------------------------- */

    openPort(): RedisPort | null {
        const pod = this.ports.find((p) => !p.active)
        if (!pod) return null
        pod.active = true
        pod.group.visible = true
        // a new connection starts as an ordinary client: nothing is subscribed
        // until it says SUBSCRIBE
        this.setSubscribed(pod, false)
        return pod
    }

    closePort(): boolean {
        const open = this.ports.filter((p) => p.active)
        if (open.length <= 1) return false
        const pod = open[open.length - 1]
        pod.active = false
        pod.busy = false
        pod.group.visible = false
        // closing a socket ends its subscriptions: the channel no longer has it
        this.setSubscribed(pod, false)
        return true
    }

    /**
     * Put a socket into subscriber mode, or take it out.
     *
     * Violet, because that is the colour the queue and the loop already speak:
     * a published message is handed around by the thread and never becomes a
     * value, a key or a record in a file. What changes on the socket is only its
     * colour — the connection itself is the same coupling to the same fd set.
     */
    setSubscribed(pod: RedisPort, on: boolean) {
        if (pod.subs === on) return
        pod.subs = on
        const hex = on ? PALETTE.violet : PALETTE.cyan
        pod.ring.emissive.setHex(hex)
        pod.glow.color.setHex(hex)
    }

    /** The sockets a PUBLISH has to reach: every open connection in subscriber mode. */
    subscribers(): RedisPort[] {
        return this.ports.filter((p) => p.active && p.subs)
    }

    /** Nobody is listening any more: every socket back to an ordinary client. */
    clearSubscribers() {
        for (const pod of this.ports) this.setSubscribed(pod, false)
    }

    pulsePort(pod: RedisPort) {
        pod.pulse = 1
        pod.busy = true
        // the loop read this fd: one entry of the readiness set fired
        this.fdPulse[pod.id] = 1
    }

    /**
     * Bytes were written TO this fd — the other direction of the same readiness
     * entry. A subscriber's socket only ever receives, so it must not be marked
     * busy: nothing is being read from it and the command thread is not in it.
     */
    pulseSend(pod: RedisPort) {
        pod.pulse = 1
        this.fdPulse[pod.id] = 1
    }

    /**
     * No listener at all. A process that has not finished loading is not
     * accepting connections, and that is the whole visible difference between a
     * start (nothing runs until the files are in) and a save (nothing stops).
     */
    shutPorts() {
        for (const pod of this.ports) {
            pod.active = false
            pod.busy = false
            pod.pulse = 0
            pod.group.visible = false
            // subscriptions die with the listener: nothing is left to deliver to
            this.setSubscribed(pod, false)
        }
    }

    openPorts(n: number) {
        for (let i = 0; i < n; i++) this.openPort()
    }

    portTop(pod: RedisPort): THREE.Vector3 {
        return pod.group.position.clone().add(new THREE.Vector3(0, 0.12, 0))
    }

    /* ---------------------------------- queue -------------------------------- */

    queueCellTop(n: number): THREE.Vector3 {
        const cell = this.queueCells[Math.max(0, Math.min(this.queueCells.length - 1, n))]
        return cell.position.clone().add(new THREE.Vector3(0, 0.2, 0))
    }

    queueTop(): THREE.Vector3 {
        return new THREE.Vector3(0, QUEUE.y + 0.3, QUEUE.z)
    }

    loopTop(): THREE.Vector3 {
        return LOOP.clone().add(new THREE.Vector3(0, 0.9, 0))
    }

    pulseLoop() {
        this.loopCore.emissiveIntensity = 3.4
    }

    /**
     * A command arrived and joined the back of the queue. Returns its slot, which
     * is where the request's own path should point.
     *
     * The occupied slots always sit at the head end, oldest first: slot 0 is the
     * command the thread will take next, and a new arrival takes the slot behind
     * the last one. That is what makes the strip read as a queue and not as a
     * row of lights.
     */
    queuePush(): number {
        this.queueDepth = Math.min(this.queueCells.length, this.queueDepth + 1)
        const n = this.queueDepth - 1
        this.paintQueue(2.4, n)
        return n
    }

    /** The thread took the head of the queue; everything behind it moves up one. */
    queuePop(): void {
        if (this.queueDepth <= 0) return
        this.queueDepth -= 1
        // flash the slot that just became the head: that is the queue advancing
        this.paintQueue(2.0, 0)
    }

    /** How many commands are waiting — the HUD can show it. */
    get queueLength() {
        return this.queueDepth
    }

    /**
     * Lit from the head backwards, fading with depth: the front command is the
     * brightest because it is next, and empty slots stay almost dark.
     * `spike` flashes one slot for a beat (arrival, or the new head).
     */
    private paintQueue(spike = 0, spikeIndex = -1) {
        this.queueMats.forEach((mat, i) => {
            if (i >= this.queueDepth) {
                mat.emissiveIntensity = QUEUE_EMPTY
                return
            }
            const depthFade = this.queueDepth <= 1 ? 1 : 1 - (i / this.queueDepth) * 0.55
            mat.emissiveIntensity = QUEUE_HEAD * depthFade
        })
        if (spike > 0 && spikeIndex >= 0) {
            const mat = this.queueMats[spikeIndex]
            if (!mat) return
            const base = mat.emissiveIntensity
            void this.ticker
                .add(0.35, (k) => {
                    // the slot may have been drained while the flash was running;
                    // writing the old value back would leave a served command lit
                    if (spikeIndex >= this.queueDepth) return
                    mat.emissiveIntensity = base + (spike - base) * (1 - k)
                })
                // and re-derive the whole strip from the depth, so a flash can
                // never be the last word on what is in the queue
                .then(() => this.paintQueue())
        }
    }

    /* ---------------------------------- keys --------------------------------- */

    get capacity() {
        return this.keys.length
    }

    get liveKeys() {
        return this.keys.reduce((n, k) => n + (k.live ? 1 : 0), 0)
    }

    randomLiveKey(): RedisKey | null {
        const live = this.keys.filter((k) => k.live)
        if (live.length === 0) return null
        return live[randInt(0, live.length - 1)]
    }

    /** First dead slot — a key created rather than updated. */
    freeKey(): RedisKey | null {
        return this.keys.find((k) => !k.live) ?? null
    }

    keyTop(key: RedisKey): THREE.Vector3 {
        if (key.big) {
            const at = BIG_SPOT[key.big]
            return new THREE.Vector3(at.x, at.y + 0.5, at.z)
        }
        return key.home.clone().add(new THREE.Vector3(0, KEY.h / 2 + 0.04, 0))
    }

    /** Height of what this key occupies on screen: its block, plus the structures above it. */
    private keyStack(key: RedisKey): number {
        return KEY.h * (1 + auxBlocks(key)) + 0.02 * auxBlocks(key)
    }

    keyBox(key: RedisKey): THREE.Box3 {
        if (key.big) return this.toWorld(this.bigBox(key.big))
        const h = this.keyStack(key)
        return this.toWorld(
            new THREE.Box3().setFromCenterAndSize(
                key.home.clone().add(new THREE.Vector3(0, h / 2, 0)),
                new THREE.Vector3(KEY.w, h, KEY.d),
            ),
        )
    }

    /** The volume one big value occupies, cage-local — its dashed cage, in a box. */
    private bigBox(kind: BigKind): THREE.Box3 {
        return (this.bigAreas[kind] ?? new THREE.Box3()).clone()
    }

    /**
     * The colour a key block rests at. Kind is the tint, `shade` is the per-slot
     * jitter that keeps a plane of identical cubes from reading as one mass.
     */
    private keyBase(key: RedisKey): number {
        return mixHex(0x06222c, KIND_COLOR[key.kind], 0.55 * key.shade)
    }

    /**
     * Draw the allocations a converted value has: nothing for a compact encoding,
     * one block for a hashtable, two for the skiplist + dict pair of a zset. They
     * stack upward from the entry, so "this value got heavier" is a column height
     * you can see across the plane.
     */
    private paintAuxKey(key: RedisKey) {
        // a big value is its own area, not a stack on a plane block
        const n = key.big ? 0 : auxBlocks(key)
        const deploy = this.auxAnim.get(key.i) ?? 1
        for (let b = 0; b < 2; b++) {
            const on = key.live && b < n
            const s = on ? deploy : 0.001
            this.tmpObj.position.copy(key.home)
            this.tmpObj.position.y += KEY.h * (b + 1) + 0.02 * (b + 1)
            this.tmpObj.scale.set(s, s, s)
            this.tmpObj.updateMatrix()
            this.auxMesh.setMatrixAt(key.i * 2 + b, this.tmpObj.matrix)
            this.auxMesh.setColorAt(key.i * 2 + b, this.tmpColor.setHex(this.keyBase(key)))
        }
        this.auxMesh.instanceMatrix.needsUpdate = true
        if (this.auxMesh.instanceColor) this.auxMesh.instanceColor.needsUpdate = true
    }

    private paintAux() {
        for (const key of this.keys) this.paintAuxKey(key)
    }

    /**
     * A live key of this kind, preferring one still in its compact encoding: those
     * are the ones a write can still convert, which is the event worth showing.
     */
    liveOfKind(kind: KeyKind): RedisKey | null {
        const live = this.keys.filter((k) => k.live && k.kind === kind)
        if (live.length === 0) return null
        const compact = live.filter((k) => !k.aux)
        if (compact.length === 0) return live[randInt(0, live.length - 1)]
        // Half the time, aim at the value closest to its limit. That is a choice of
        // the simulation, not a claim about redis — nothing in redis prefers a full
        // key, it simply appends to whatever the client named. Without the bias a
        // conversion is a rare accident of traffic and you would never see one.
        if (Math.random() < 0.5) {
            return compact.reduce((a, b) => (b.entries > a.entries ? b : a))
        }
        return compact[randInt(0, compact.length - 1)]
    }

    /**
     * A free slot reused for a value of this type. A created key starts small —
     * one element — so its encoding budget starts over with it.
     */
    setKeyKind(key: RedisKey, kind: KeyKind) {
        const range = VALUE_BYTES[kind]
        key.kind = kind
        key.entries = kind === 'string' ? 0 : 1
        key.aux = false
        key.bytes = randInt(range[0], range[1])
        this.keysMesh.setColorAt(key.i, this.tmpColor.setHex(this.keyBase(key)))
        if (this.keysMesh.instanceColor) this.keysMesh.instanceColor.needsUpdate = true
        this.paintAuxKey(key)
    }

    /**
     * One element written into a collection.
     *
     * Returns true when this element pushed the value past its encoding limit. That
     * is the one write in redis that is O(n): the flat listpack is read, freed, and
     * the real structure is allocated and filled — on the only thread there is, so
     * every other client waits for it. Redis never converts back down; a value
     * keeps the bigger encoding until the key is deleted.
     */
    growKey(key: RedisKey): boolean {
        if (key.kind === 'string' || !key.live) return false
        key.entries++
        if (key.aux) return false
        if (key.entries <= encodingLimit(key.kind)) return false
        key.aux = true
        // the converted structure is bigger than the flat buffer it replaced: a
        // pointer and a node per element, and a second index for a zset
        key.bytes += 400 + key.entries * (key.kind === 'zset' ? 48 : 24)
        this.auxAnim.set(key.i, 0)
        this.flashKey(key, KIND_COLOR[key.kind], 0.9)
        this.paintAuxKey(key)
        return true
    }

    /** `OBJECT ENCODING` for a key, for the inspector. */
    encoding(key: RedisKey): string {
        return encodingOf(key)
    }

    /* -------------------------------- the skew ------------------------------- */

    /** A hot key to send a read at — most traffic goes to a few of them. */
    hotKey(): RedisKey | null {
        const live = this.hotKeys.filter((k) => k.live)
        if (live.length === 0) return null
        return live[randInt(0, live.length - 1)]
    }

    /** One of the large values, if the same kind is asked for. */
    bigKey(kind?: BigKind): RedisKey | null {
        const all = Object.values(this.bigKeys) as RedisKey[]
        const live = all.filter((k) => k && k.live && (!kind || k.big === kind))
        if (live.length === 0) return null
        return live[randInt(0, live.length - 1)]
    }

    /** Keys drawn as their own area — the panel counts them. */
    get bigCount() {
        return (Object.values(this.bigKeys) as RedisKey[]).filter((k) => k && k.live).length
    }

    get hotCount() {
        return this.hotKeys.filter((k) => k.live).length
    }

    /**
     * Who a write can push out. Never a big or a hot key: both are the point of
     * this floor, and evicting one would delete the thing being explained. Real
     * redis would evict whatever the policy picked — including them.
     */
    evictionVictim(): RedisKey | null {
        const live = this.keys.filter((k) => k.live && !k.big && !k.hot)
        if (live.length === 0) return null
        return live[randInt(0, live.length - 1)]
    }

    setKeyLive(key: RedisKey, live: boolean) {
        key.live = live
        key.heat = live ? 1 : 0
        if (key.big) {
            // drawn as its own area, never as a block in the plane
            this.flashKey(key, KIND_COLOR[key.kind], 0.5)
            return
        }
        const s = live ? 1 : 0.001
        this.tmpObj.position.copy(key.home)
        this.tmpObj.scale.set(s, s, s)
        this.tmpObj.updateMatrix()
        this.keysMesh.setMatrixAt(key.i, this.tmpObj.matrix)
        this.keysMesh.instanceMatrix.needsUpdate = true
        // the value's other allocations go with it
        this.paintAuxKey(key)
        this.flashKey(key, live ? KIND_COLOR[key.kind] : PALETTE.magenta, 0.5)
    }

    /* ---------------------------------- dict --------------------------------- */

    /** Which bucket this entry lands in, for a table of `size` buckets. */
    private bucketOf(i: number, size: number): number {
        // the multiplicative hash, truncated to a uint32 like the real one
        return ((i * 2654435761) >>> 0) % size
    }

    /**
     * The bucket a tile stands for. The live table occupies one half of the
     * lattice and a growing table the other, so a growth is a physical expansion
     * instead of the buckets jumping to a different place when it finishes.
     */
    private tileBucket(half: 0 | 1, id: number): number {
        const row = Math.floor(id / DICT.cols)
        const col = id % DICT.cols
        const rowIn = half === 0 ? row : DICT.rows - 1 - row
        return rowIn * DICT.cols + col
    }

    /** Buckets that hold at least one live key, for a table of `size` buckets. */
    private usedBuckets(size: number): Set<number> {
        const s = new Set<number>()
        for (const k of this.keys) if (k.live) s.add(this.bucketOf(k.i, size))
        return s
    }

    get hashSize() {
        return this.htSize
    }

    /**
     * Where a key's bucket sits — the tile the lookup actually lands on.
     *
     * During a rehash a key can be in either table, and redis checks both in
     * order: a key that has already been migrated is found in the new table, the
     * rest still in the old one. So the path lands where the key really is, which
     * is the whole reason the rehash is drawn bucket by bucket.
     */
    bucketTop(key: RedisKey): THREE.Vector3 {
        let half = this.htHalf
        let bucket = this.bucketOf(key.i, this.htSize)
        if (this.rehashIdx >= 0) {
            const moved = this.bucketOf(key.i, this.ht1Size)
            if (moved < this.rehashIdx) {
                half = this.htHalf === 0 ? 1 : 0
                bucket = moved
            }
        }
        const tile = this.tileBucket(half, bucket)
        return new THREE.Vector3(
            dictX(tile % DICT.cols),
            DICT.y + 0.05,
            dictZ(Math.floor(tile / DICT.cols)),
        )
    }

    get rehashing() {
        return this.rehashIdx >= 0
    }

    /**
     * Paint the bucket array from the dict's own state.
     *
     * An allocated bucket is drawn dim, a bucket holding at least one key bright,
     * and a bucket that belongs to neither table is not allocated at all and is
     * collapsed. During a rehash the old table loses buckets from the front while
     * the new one gains them, in exactly the order rehashStep() migrates them.
     */
    private paintDict() {
        const N = DICT.cols * DICT.rows
        const usedOld = this.usedBuckets(this.htSize)
        const usedNew = this.ht1Size > 0 ? this.usedBuckets(this.ht1Size) : null
        const liveHalf = this.htHalf
        const otherHalf = (liveHalf === 0 ? 1 : 0) as 0 | 1
        const empty = mixHex(0x0d3a48, PALETTE.cyan, 0.14)

        for (let id = 0; id < N; id++) {
            const bOld = this.tileBucket(liveHalf, id)
            const bNew = this.tileBucket(otherHalf, id)
            let live = false
            let used = false
            if (this.ht1Size > 0) {
                // rehashing: the old table shrinks from the front, the new grows
                if (bOld < this.htSize && bOld >= this.rehashIdx) {
                    live = true
                    used = usedOld.has(bOld)
                } else if (bNew < this.rehashIdx) {
                    live = true
                    used = usedNew?.has(bNew) ?? false
                }
            } else if (bOld < this.htSize) {
                live = true
                used = usedOld.has(bOld)
            }

            this.tmpObj.position.set(dictX(id % DICT.cols), DICT.y, dictZ(Math.floor(id / DICT.cols)))
            this.tmpObj.scale.setScalar(live ? 1 : 0.001)
            this.tmpObj.updateMatrix()
            this.dictMesh.setMatrixAt(id, this.tmpObj.matrix)
            const hex = used
                ? mixHex(0x0d3a48, PALETTE.cyan, 0.5 * (this.dictShade[id] ?? 0.4) + 0.25)
                : empty
            this.dictMesh.setColorAt(id, this.tmpColor.setHex(hex))
        }
        this.dictMesh.instanceMatrix.needsUpdate = true
        if (this.dictMesh.instanceColor) this.dictMesh.instanceColor.needsUpdate = true

        // the size line: what the dict is, not what it might become
        const text =
            this.ht1Size > 0
                ? `ht[0] ${this.htSize} → ht[1] ${this.ht1Size} · ${this.rehashIdx}/${this.htSize}`
                : `ht[0] ${this.htSize} buckets`
        const el = this.dictTableLab?.element as HTMLElement | undefined
        if (el && el.textContent !== text) el.textContent = text
    }

    /**
     * Load factor 1: the next insert grows the table. Real dicts check this on
     * every add; so does this one.
     */
    private maybeGrow() {
        if (this.rehashIdx >= 0 || this.htSize >= HASH_MAX) return
        if (this.liveKeys <= this.htSize) return
        const next = HASH_SIZES.find((s) => s > this.htSize)
        if (!next) return
        this.ht1Size = next
        this.rehashIdx = 0
        this.paintDict()
        this.trace(`dict grow · ${this.htSize} → ${next} buckets`)
    }

    /**
     * One step of the incremental rehash.
     *
     * redis migrates one bucket per command, plus a cron burst of a hundred
     * buckets per millisecond. Commands arrive here a couple per second, so a
     * single bucket per command would take minutes on screen: the step size is
     * raised, the RULE is not. What matters is that the table is never rebuilt in
     * one go — both tables are live and every lookup checks both.
     */
    rehashStep(buckets = 1) {
        if (this.rehashIdx < 0) return
        this.rehashIdx = Math.min(this.htSize, this.rehashIdx + buckets)
        if (this.rehashIdx >= this.htSize) {
            // done: the table that was growing is now the dict
            this.htSize = this.ht1Size
            this.ht1Size = 0
            this.rehashIdx = -1
            this.htHalf = this.htHalf === 0 ? 1 : 0
            this.trace(`dict rehashed · ht[0] ${this.htSize} buckets`)
        }
        this.paintDict()
    }

    /** The bucket a key hashes to — shown by lighting one dict tile. */
    pulseBucket(key: RedisKey) {
        const bucket = this.bucketOf(key.i, this.htSize)
        const tile = this.tileBucket(this.htHalf, bucket)
        this.dictMesh.setColorAt(tile, this.tmpColor.setHex(pulseHex(PALETTE.ice, 0.4)))
        if (this.dictMesh.instanceColor) this.dictMesh.instanceColor.needsUpdate = true
        void this.ticker.add(PULSE_TIME, (k) => {
            this.dictMesh.setColorAt(
                tile,
                this.tmpColor.setHex(pulseHex(PALETTE.ice, 0.4)).multiplyScalar(1 + (PULSE_GAIN - 1) * (1 - k)),
            )
            if (this.dictMesh.instanceColor) this.dictMesh.instanceColor.needsUpdate = true
        })
        // repaint from state rather than restoring a remembered colour
        void this.ticker.wait(PULSE_TIME).then(() => this.paintDict())
    }

    flashKey(key: RedisKey, hex: number, dur = PULSE_TIME) {
        // a big value is not a block in the plane: the touch lights its structure
        if (key.big) {
            this.pulseBig(key.big)
            return
        }
        this.keysMesh.setColorAt(key.i, this.tmpColor.setHex(pulseHex(hex)))
        if (this.keysMesh.instanceColor) this.keysMesh.instanceColor.needsUpdate = true
        void this.ticker.add(dur, (k) => {
            if (k < 1) return
            const base = mixHex(0x06222c, KIND_COLOR[key.kind], 0.55 * key.shade)
            this.keysMesh.setColorAt(key.i, this.tmpColor.setHex(base))
            if (this.keysMesh.instanceColor) this.keysMesh.instanceColor.needsUpdate = true
        })
    }

    /**
     * One big value was touched. The whole structure lights at once, because that
     * is the honest picture: a command against a value like this walks all of it,
     * on the one thread, and every other client waits.
     */
    pulseBig(kind: BigKind) {
        this.bigPulse[kind] = 1
    }

    /* ----------------------------------- AOF --------------------------------- */

    /** How many blocks the log occupies right now. */
    get aofUsed() {
        return this.aofHead + 1
    }

    /** Is there an empty block in front of the file for the next record? */
    get aofCanGrow() {
        return this.aofHead < this.aofOrder.length - 1
    }

    /** Where a block of the log sits, by its position in the file. */
    private aofBlockPos(k: number): THREE.Vector3 {
        const id = this.aofOrder[Math.max(0, Math.min(this.aofOrder.length - 1, k))]
        return new THREE.Vector3(xAt(id % COLS), PAGE_Y, zAt(Math.floor(id / COLS)))
    }

    private aofHeadX(): number {
        return this.aofBlockPos(this.aofHead).x
    }

    /**
     * Only the blocks the file has actually reached are drawn.
     *
     * A block past the end of the log is not "dark", not "empty" and not a flat
     * plate — it does not exist yet, so it is collapsed to nothing on all three
     * axes. Flattening only the height was the bug: it left a full-footprint
     * sliver behind, which reads as a block that is there but switched off.
     *
     * The range drawn is `0..aofHead`, and anything drawn beyond it is erased:
     * that is what a rewrite looks like from the floor's point of view.
     */
    private layoutAof() {
        const hex = mixHex(AOF_FILL_DARK, AOF_FILL_BRIGHT, 1)
        const drawTo = this.aofHead
        const eraseTo = Math.max(this.aofDrawn, drawTo)
        for (let k = 0; k <= eraseTo; k++) {
            const i = this.aofOrder[k]
            if (i === undefined) break
            const on = k <= drawTo
            this.tmpObj.position.set(
                xAt(i % COLS),
                on ? PAGE_Y : PAGE_Y,
                zAt(Math.floor(i / COLS)),
            )
            const s = on ? 1 : 0.001
            this.tmpObj.scale.set(s, s, s)
            this.tmpObj.updateMatrix()
            this.disk.setMatrixAt(i, this.tmpObj.matrix)
            this.disk.setColorAt(i, this.tmpColor.setHex(on ? hex : 0x000000))
        }
        this.aofDrawn = drawTo
        this.disk.instanceMatrix.needsUpdate = true
        if (this.disk.instanceColor) this.disk.instanceColor.needsUpdate = true
        this.fitAofEdge()
        this.assertInvariants('layoutAof')
    }

    /**
     * A command's bytes go into aof_buf in memory. Nothing touches the file yet.
     *
     * This is the point of the buffer: with `appendfsync everysec` redis does not
     * write (let alone fsync) per command — it copies into the buffer and lets the
     * periodic flush carry everything to the file at once. So the bytes on this
     * strip are exactly the ones a crash would lose.
     */
    bufferAof(bytes: number) {
        this.aofPending++
        this.aofPendingBytes += bytes
        this.aofBuffered = Math.min(1, this.aofBuffered + bytes / BLOCK_BYTES)
        const mat = this.aofBufMats[this.bufferCubeIndex()]
        if (mat) {
            void this.ticker.add(PULSE_TIME, (k) => {
                mat.emissiveIntensity = 1.3 - 0.8 * k
            })
        }
    }

    /** Records currently sitting in aof_buf, i.e. not durable yet. */
    get aofPendingRecords() {
        return this.aofPending
    }

    /**
     * Write one buffered record into the file: the log gains a block, and that
     * block pulses once.
     *
     * Returns where it landed, or null when the floor is full — a log that cannot
     * grow has nowhere to put the bytes, and that is a write error, not a silent
     * loss.
     */
    private writeAofBlock(bytes: number): THREE.Vector3 | null {
        // the record goes after the last byte of the file, so at most it starts a
        // new block; it never rewrites one that is already there
        if (this.aofHead >= this.aofOrder.length - 1) {
            this.aofFull = true
            return null
        }
        this.aofBytes += bytes
        this.aofHead += 1
        this.layoutAof()

        const i = this.aofOrder[this.aofHead]
        const block = this.aofBlockPos(this.aofHead)

        // One pulse per block written, on the one block that changed — the same
        // pulse an edited page gets on the postgres disk, and the same pulse a
        // cube of aof_buf gets when a record lands in it.
        this.pulseDiskBlock(i, PALETTE.amber)

        return block.add(new THREE.Vector3(0, BLOCK.h / 2, 0))
    }

    /**
     * Fit the outline and the pick volume to the blocks the file has reached.
     *
     * The log snakes across the floor, so its footprint is the bounding box of
     * everything drawn so far — one row at first, more as it grows, and smaller
     * again after a rewrite. The cage is the file's length, drawn.
     */
    private fitAofEdge() {
        const drawTo = this.aofHead
        if (drawTo < 0 || this.aofOrder.length === 0) {
            this.aofEdge.visible = false
            this.aofPick.visible = false
            return
        }
        let minC = COLS
        let maxC = -1
        let minR = ROWS
        let maxR = -1
        for (let k = 0; k <= drawTo; k++) {
            const id = this.aofOrder[k]
            if (id === undefined) break
            const c = id % COLS
            const r = Math.floor(id / COLS)
            minC = Math.min(minC, c)
            maxC = Math.max(maxC, c)
            minR = Math.min(minR, r)
            maxR = Math.max(maxR, r)
        }
        if (maxC < 0) {
            this.aofEdge.visible = false
            this.aofPick.visible = false
            return
        }
        const x0 = xAt(minC) - PITCH / 2
        const x1 = xAt(maxC) + PITCH / 2
        const z0 = zAt(minR) - PITCH / 2
        const z1 = zAt(maxR) + PITCH / 2
        this.aofEdge.visible = true
        this.aofEdge
            .resize(x1 - x0, 0.5, z1 - z0)
            .centre((x0 + x1) / 2, PAGE_Y + 0.1, (z0 + z1) / 2)
        this.aofPick.visible = true
        this.aofPick.scale.set(x1 - x0, 1, z1 - z0)
        this.aofPick.position.set((x0 + x1) / 2, PAGE_Y + 0.5, (z0 + z1) / 2)
        // keep the anchor on the middle of the file: views frame it
        REDIS_ANCHOR.aof.set((x0 + x1) / 2, BLOCK_TOP, (z0 + z1) / 2).add(REDIS_ORIGIN)
    }

    /**
     * One block was touched: it lights for PULSE_TIME and settles back.
     *
     * The same pulse as a page on the postgres disk and a cube of either buffer —
     * there is no per-container marker in this scene, because "this was just read
     * or written" is the same statement everywhere.
     */
    private pulseDiskBlock(id: number, hex: number) {
        this.diskBoost.set(id, { v: 1, hex: pulseHex(hex) })
    }

    aofHeadTop(): THREE.Vector3 {
        const p = this.aofBlockPos(this.aofHead)
        return p.add(new THREE.Vector3(0, BLOCK.h / 2, 0))
    }

    aofBufferTop(): THREE.Vector3 {
        // cage-local, like every other point the redis sim aims at
        const m = this.aofBufCells[this.bufferCubeIndex()]
        if (!m || !this.aofBufGroup) return this.aofHeadTop()
        const v = this.aofBufGroup.position.clone().add(m.position)
        return v.setY(v.y + BLOCK.h * 0.7)
    }

    /** The cube the next record lands in, mirroring wal_buffers next door. */
    private bufferCubeIndex() {
        return Math.min(
            this.aofBufCells.length - 1,
            Math.floor(this.aofBuffered * this.aofBufCells.length),
        )
    }

    /**
     * appendfsync: everything in aof_buf is written to the file and fsynced.
     *
     * With the default `everysec` this runs once a second, and that interval IS
     * the durability window — a crash can lose the last second of acknowledged
     * writes and not one byte more. `always` would drain on every command (no
     * window, but an fsync per write); `no` would leave the pages to the kernel
     * (a window nobody controls).
     *
     * The buffer is a staging area, not a queue that can overflow: what it holds
     * is copied into the file and then reused. Nothing is discarded by a flush.
     */
    flushAofBuffer(): { head: THREE.Vector3; records: number } | null {
        const records = this.aofPending
        const bytes = this.aofPendingBytes
        if (records === 0) return null

        this.aofPending = 0
        this.aofPendingBytes = 0
        this.aofBuffered = 0

        // one block per buffered record: this file is a stream of commands, and a
        // 4 kB block holds a whole number of them, never a fraction
        let head: THREE.Vector3 | null = null
        for (let i = 0; i < records; i++) {
            head = this.writeAofBlock(bytes / records) ?? head
        }
        this.pulseBuffered()
        return head ? { head, records } : null
    }

    /** A single lift of the strip as it empties: "these bytes just became durable". */
    private pulseBuffered() {
        const base = this.aofBufGroup?.position.clone()
        if (!base) return
        void this.ticker.add(0.4, (k) => {
            const g = this.aofBufGroup
            if (!g) return
            g.position.y = base.y + Math.sin(k * Math.PI) * 0.18
        })
    }

    rdbCentre(): THREE.Vector3 {
        return RDB_CENTRE.clone()
    }

    /* ------------------------------ base file (RDB) --------------------------- */

    /**
     * The encoder is one sequential pass over the keyspace: each record is
     * written directly after the last, with no padding and no alignment. So every
     * 4 kB block but the last is completely full, and which keys land in a block
     * depends on the size of the values in front of them.
     *
     * This is the whole answer to "different block sizes or uniform": the blocks
     * are uniform — a filesystem only stores 4 kB — the file is densely packed
     * (it is written fresh each time, so there is nothing to defragment, unlike a
     * database file with free space inside it), and what varies is the file's
     * LENGTH, because it tracks the data and not the key count.
     */
    private packRdb(live: boolean[]): { blocks: number[][]; tail: number } {
        const blocks: number[][] = []
        let cur: number[] = []
        let used = 0
        this.keys.forEach((key) => {
            if (!live[key.i]) return
            if (used + key.bytes > BLOCK_BYTES && cur.length > 0) {
                blocks.push(cur)
                cur = []
                used = 0
            }
            cur.push(key.i)
            used += key.bytes
        })
        if (cur.length > 0) blocks.push(cur)
        return { blocks, tail: used / BLOCK_BYTES }
    }

    /** Write the base file from the current dataset, with no animation (boot). */
    private writeRdbNow() {
        const live = this.keys.map((k) => k.live)
        const { blocks, tail } = this.packRdb(live)
        this.rdbBlocks = blocks.slice(0, this.rdbOrder.length)
        this.rdbLen = this.rdbBlocks.length
        this.rdbTail = tail
        this.rdbBytes = this.keys.reduce((n, k) => n + (k.live ? k.bytes : 0), 0)
        this.layoutRdb()
    }

    /**
     * Only the blocks the file has reached are drawn, and the last one is drawn
     * part-full: that is the one place a block is not the whole 4 kB. A block
     * past the end of the file does not exist, so it is collapsed on all three
     * axes — the same rule as the log.
     */
    private layoutRdb() {
        this.rdbOrder.forEach((id, seq) => {
            const on = seq < this.rdbLen
            const fill = on && seq === this.rdbLen - 1 ? Math.max(0.12, this.rdbTail) : 1
            const row = Math.floor(id / COLS)
            const col = id % COLS
            this.tmpObj.position.set(
                xAt(col),
                FLOOR_Y + BLOCK_LIFT + (BLOCK.h * fill) / 2,
                zAt(row),
            )
            this.tmpObj.scale.set(on ? 1 : 0.001, on ? fill : 0.001, on ? 1 : 0.001)
            this.tmpObj.updateMatrix()
            this.disk.setMatrixAt(id, this.tmpObj.matrix)
            const base = on ? this.rdbHexAt(id, seq) : 0x000000
            this.disk.setColorAt(id, this.tmpColor.setHex(base))
        })
        this.disk.instanceMatrix.needsUpdate = true
        if (this.disk.instanceColor) this.disk.instanceColor.needsUpdate = true
        this.fitRdbEdge()
    }

    /** The colour of one block of the base file: bright, except the partial tail. */
    private rdbHexAt(id: number, seq: number): number {
        const tint = this.rdbBase[id] ?? RDB_FILL_BRIGHT
        return seq === this.rdbLen - 1
            ? mixHex(RDB_FILL_DARK, tint, Math.max(0.12, this.rdbTail))
            : tint
    }

    /**
     * The colour a block has when nothing is pulsing on it — the file decides.
     *
     * This is DERIVED, never remembered. A remembered copy of "the colour this
     * block should fall back to" only stays true for the file that wrote it: the
     * disk's blocks belong to two files whose lengths both change, so a pulse that
     * decays toward a remembered colour leaves the other file's blocks black.
     */
    private restingHex(id: number): number {
        const aofSeq = this.aofIndex.get(id)
        if (aofSeq !== undefined && aofSeq <= this.aofHead) {
            return mixHex(AOF_FILL_DARK, AOF_FILL_BRIGHT, 1)
        }
        const rdbSeq = this.rdbIndex.get(id)
        if (rdbSeq !== undefined && rdbSeq < this.rdbLen) return this.rdbHexAt(id, rdbSeq)
        return 0x000000
    }

    /**
     * Regrow the cage around the base file to exactly the blocks it covers now.
     *
     * The file is written in whole rows of ten (see rdbOrder), so the used blocks
     * are the first `len` of that order: whole rows plus a partial last one. The
     * cage is fitted to the blocks that are actually in the file and grows and
     * shrinks with it — a cage over the whole region would claim space the file
     * does not occupy, which is the one thing a dump's length is not free to do.
     */
    private fitRdbEdge() {
        const cols = RDB.c1 - RDB.c0 + 1
        const full = Math.floor(this.rdbLen / cols)
        const rem = this.rdbLen % cols
        const rows = full + (rem > 0 ? 1 : 0)
        if (rows === 0) {
            this.rdbEdge.visible = false
            // an empty dump is not a thing to point at: the cage shows the file's
            // length, and with no blocks there is no file to describe
            this.rdbPick.visible = false
            return
        }
        this.rdbEdge.visible = true
        this.rdbPick.visible = true
        // the first row of the file always runs left to right, so a file shorter
        // than one row covers a prefix of that row
        let x0 = RDB.c0
        let x1 = RDB.c1
        if (full === 0) x1 = RDB.c0 + rem - 1
        const bx0 = xAt(x0) - PITCH / 2
        const bx1 = xAt(x1) + PITCH / 2
        const bz0 = zAt(RDB.r0) - PITCH / 2
        const bz1 = zAt(RDB.r0 + rows - 1) + PITCH / 2
        this.rdbEdge
            .resize(bx1 - bx0, 0.5, bz1 - bz0)
            .centre((bx0 + bx1) / 2, PAGE_Y + 0.1, (bz0 + bz1) / 2)
    }

    /** How many blocks the base file occupies right now — the panel shows it. */
    get rdbBlocksUsed() {
        return this.rdbLen
    }

    /** Where a block of the base file sits, by its position in the file. */
    private rdbBlockPos(seq: number): THREE.Vector3 {
        const id = this.rdbOrder[Math.max(0, Math.min(this.rdbOrder.length - 1, seq))]
        const row = Math.floor(id / COLS)
        const col = id % COLS
        return new THREE.Vector3(xAt(col), PAGE_Y, zAt(row))
    }

    /**
     * SAVE and BGSAVE, in the shape they actually have:
     *
     *   1. the keyspace is walked and encoded, in one pass
     *   2. a new file is written from its first block, replacing the old one
     *
     * BGSAVE does this in a forked child: the parent keeps serving the whole
     * time and nothing is locked. What it costs is memory — every page the parent
     * modifies while the child writes has to be copied. SAVE does the same work
     * on the only thread there is, so nothing is served until it finishes. The
     * shape on screen is identical; what differs is whether the loop is still
     * draining the queue, and the panel is where that shows.
     */
    async runRdbSave(): Promise<void> {
        if (this.savingRdb) return
        this.savingRdb = true
        // the snapshot is the keyspace at fork time, not at completion
        const base = this.keys.map((k) => k.live)
        const { blocks, tail } = this.packRdb(base)
        this.pulseAgent(this.bgsaveDrone)

        // 1. read the keyspace
        this.rdbAim.set(keyX(0), KEYS.y + 0.8, KEYS.cz)
        await this.ticker.wait(0.28)
        await this.ticker.add(1.0, (k) => {
            const col = Math.min(KEYS.cols - 1, Math.floor(k * KEYS.cols))
            for (const key of this.keys) {
                if (base[key.i] && Math.abs(key.col - col) <= 1) {
                    key.heat = Math.max(key.heat, 0.85)
                }
            }
            this.rdbAim.set(keyX(col), KEYS.y + 0.8, KEYS.cz)
        })

        // 2. write the new file: it starts empty and fills block by block
        const n = Math.min(blocks.length, this.rdbOrder.length)
        this.rdbBlocks = blocks.slice(0, n)
        this.rdbLen = 0
        this.rdbTail = 1
        this.layoutRdb()
        this.rdbAim.copy(this.rdbBlockPos(0))
        await this.ticker.wait(0.3)

        let shown = 0
        await this.ticker.add(Math.max(0.5, n * RDB_BLOCK_TIME), (k) => {
            const upto = Math.max(1, Math.min(n, Math.ceil(k * n)))
            this.rdbLen = upto
            this.rdbTail = upto === n ? tail : 1
            this.layoutRdb()
            for (let b = shown; b < upto; b++) this.pulseDiskBlock(this.rdbOrder[b], PALETTE.teal)
            shown = Math.max(shown, upto)
            this.rdbAim.copy(this.rdbBlockPos(upto - 1))
        })

        this.rdbBytes = this.keys.reduce((sum, k) => sum + (base[k.i] ? k.bytes : 0), 0)
        this.saves++
        this.pulseAgent(this.bgsaveDrone)
        this.savingRdb = false
        this.assertInvariants('bgsave')
    }

    /**
     * Startup, in the order redis does it:
     *
     *   1. the base dump is read into memory, one sequential pass over the file
     *   2. the AOF is replayed after it, record by record, re-executing each one
     *   3. only then does it listen
     *
     * All of it runs on the thread that would otherwise serve commands, so no
     * connection is accepted until the last record is in. This is the one
     * operation here that really does block everything — a save blocks nothing.
     */
    async runLoad(target: boolean[]): Promise<void> {
        if (this.loading) return
        this.loading = true
        // the process starts with nothing in memory; the files are the only copy
        this.wipeMemory()
        this.pulseAgent(this.bgsaveDrone)

        // 1. the base file, block by block: each block brings back exactly the
        //    keys the encoder put in it
        const n = this.rdbLen
        let shown = 0
        if (n > 0) {
            await this.ticker.add(Math.max(0.4, n * RDB_BLOCK_TIME), (k) => {
                const upto = Math.max(1, Math.min(n, Math.ceil(k * n)))
                for (let b = shown; b < upto; b++) {
                    this.pulseDiskBlock(this.rdbOrder[b], PALETTE.teal)
                    // a block comes back whole — but only the keys that were still
                    // in the dataset when the process stopped. The rest were
                    // deleted later in the log and are never replayed.
                    for (const i of this.rdbBlocks[b] ?? []) if (target[i]) this.reviveKey(i)
                }
                shown = Math.max(shown, upto)
            })
        }

        // 2. the log after it: every record re-executed in order, which is why a
        //    long log is slow to start and why the records must be deterministic
        const m = this.aofUsed
        // the keys the log has that the dump did not: the writes since the save
        const tail: number[] = []
        target.forEach((on, i) => {
            if (on && !this.keys[i].live) tail.push(i)
        })
        let replayed = 0
        let restored = 0
        if (m > 0) {
            await this.ticker.add(Math.max(0.35, m * AOF_RECORD_TIME), (k) => {
                const upto = Math.max(1, Math.min(m, Math.ceil(k * m)))
                for (let r = replayed; r < upto; r++) {
                    this.pulseDiskBlock(this.aofOrder[r], PALETTE.amber)
                    if (restored < tail.length) this.reviveKey(tail[restored++])
                }
                replayed = Math.max(replayed, upto)
            })
        }
        while (restored < tail.length) this.reviveKey(tail[restored++])

        this.loading = false
        this.assertInvariants('load')
    }

    /** Nothing is in memory yet: a process that has not loaded has no data. */
    wipeMemory() {
        this.hideAllKeys()
    }

    private hideAllKeys() {
        for (const key of this.keys) {
            if (!key.live) continue
            key.live = false
            key.heat = 0
            this.tmpObj.position.copy(key.home)
            this.tmpObj.scale.setScalar(0.001)
            this.tmpObj.updateMatrix()
            this.keysMesh.setMatrixAt(key.i, this.tmpObj.matrix)
        }
        this.keysMesh.instanceMatrix.needsUpdate = true
    }

    /** One key comes back from the files — no flash, it was never "written". */
    private reviveKey(i: number) {
        const key = this.keys[i]
        if (!key || key.live) return
        key.live = true
        key.heat = 0.9
        if (key.big) return
        this.tmpObj.position.copy(key.home)
        this.tmpObj.scale.setScalar(1)
        this.tmpObj.updateMatrix()
        this.keysMesh.setMatrixAt(i, this.tmpObj.matrix)
        this.keysMesh.instanceMatrix.needsUpdate = true
    }

    /**
     * bgrewriteaof, in the three steps it actually performs.
     *
     * The direction of data matters here, because it is the thing people get
     * wrong: nothing is read out of the old file and nothing moves into memory.
     * The child reads the KEYSPACE — the data in RAM — and writes a new file
     * containing the minimum set of commands that reproduces that state. Then it
     * renames the new file over the old one and unlinks the old.
     *
     *   1. fork — the child gets a copy-on-write view and WALKS the keyspace
     *      column by column; nothing is locked, the parent keeps serving
     *   2. write — the new file lands on free floor beside the log, because it is
     *      a different file: the old one is still there and still being appended
     *      to while this happens
     *   3. swap — rename(2). The new file takes the log's place, and it is
     *      shorter, so the end of the log moves back to its length
     *
     * Writes that land while this runs are not lost: they go to the rewrite
     * buffer and are replayed into the new file before the swap, so the head can
     * come out further along than the target. That is why the head is adjusted by
     * the number of blocks dropped, not set to a constant.
     */
    async runRewrite(): Promise<void> {
        if (this.rewriting) return
        this.rewriting = true
        this.pulseAgent(this.rewriteDrone)

        const oldHead = this.aofHead
        // the new file is as long as the STATE is, not as long as the history
        const target = Math.max(2, Math.round(oldHead * 0.25))

        // 1. it flies to the keyspace, then sweeps it: the wave is the scan, not
        //    decoration. The aim point moves, the lerp in update() does the flight,
        //    so there is no cut between "idle" and "scanning".
        this.rewriteAim.set(keyX(0), KEYS.y + 0.8, KEYS.cz)
        await this.ticker.wait(0.35)
        await this.ticker.add(1.15, (k) => {
            const col = Math.min(KEYS.cols - 1, Math.floor(k * KEYS.cols))
            for (const key of this.keys) {
                if (key.live && Math.abs(key.col - col) <= 1) key.heat = Math.max(key.heat, 0.9)
            }
            this.rewriteAim.set(keyX(col), KEYS.y + 0.8, KEYS.cz)
        })

        // 2. it drops to the staging area — free floor in front of the log, not
        //    the log itself — and writes the new file there, block by block
        this.stagingLab.visible = true
        this.rewriteAim.copy(this.stagingSlot(0)).setY(1.4)
        await this.ticker.wait(0.45)
        let staged = 0
        await this.ticker.add(Math.max(0.9, target * 0.16), (k) => {
            const upto = Math.max(1, Math.min(target, Math.round(k * target)))
            for (let j = staged; j < upto; j++) {
                this.setStaged(j, true)
                this.pulseDiskBlock(this.stagingId(j), PALETTE.amber)
            }
            staged = Math.max(staged, upto)
            this.rewriteAim.copy(this.stagingSlot(upto - 1)).setY(1.4)
        })

        // 3. swap: rename(2). The blocks of the new file move into the log's own
        //    places and the history past them is unlinked — so what disappears is
        //    the OLD records, not the new ones. Nothing was read back out of the
        //    old file to do this, and nothing moved into memory: the data came
        //    from RAM and went to disk.
        const smooth = (t: number) => t * t * (3 - 2 * t)
        await this.ticker.add(0.5, (k) => {
            for (let j = 0; j < staged; j++) {
                // staggered so the file arrives as a run, not as one slab
                const t = smooth(Math.max(0, Math.min(1, k * 1.5 - j * 0.05)))
                const pos = this.stagingSlot(j).lerp(this.aofBlockPos(j), t)
                this.placeDiskBlock(this.stagingId(j), pos, true)
            }
            this.rewriteAim.copy(this.aofBlockPos(Math.min(staged - 1, target - 1))).setY(1.4)
        })

        // the length the new file leaves the log with — writes that landed during
        // the rewrite are already in it, which is why this is a subtraction and
        // not the target itself
        const newHead = Math.max(target, this.aofHead - (oldHead - target))

        // 4. the records past the new length are unlinked. They fade instead of
        //    blinking out, because "this history is gone" is the actual event, and
        //    a frame where blocks simply stop existing reads as a rendering bug.
        if (oldHead > newHead) {
            await this.ticker.add(0.32, (k) => {
                const sc = Math.max(0.001, 1 - k)
                for (let j = newHead + 1; j <= oldHead; j++) {
                    const id = this.aofOrder[j]
                    if (id === undefined) continue
                    this.tmpObj.position.copy(this.aofBlockPos(j))
                    this.tmpObj.scale.set(sc, sc, sc)
                    this.tmpObj.updateMatrix()
                    this.disk.setMatrixAt(id, this.tmpObj.matrix)
                }
                this.disk.instanceMatrix.needsUpdate = true
            })
        }

        for (let j = 0; j < staged; j++) this.setStaged(j, false)
        this.stagingLab.visible = false
        this.rewrites++
        this.aofHead = newHead
        this.aofBytes = Math.round(this.aofBytes * 0.25)
        this.aofFull = false
        this.layoutAof()
        this.trace(`rewrite swap · head ${oldHead} → ${this.aofHead}, ${staged} blocks became the file`)
        this.pulseDiskBlock(this.aofOrder[this.aofHead], PALETTE.amber)
        this.pulseAgent(this.rewriteDrone)
        this.rewriting = false
        this.assertInvariants('bgrewriteaof')
    }

    /**
     * Where a rewrite builds its new file: the row in front of the log, directly
     * opposite the blocks those writes will become.
     *
     * It is a *different* file, so it does not go on top of the one it replaces —
     * the child needs somewhere to write that the parent is not appending to, and
     * only the rename makes the two the same file. One row of separation keeps the
     * swap a short move you can follow instead of a jump across the floor.
     */
    private stagingSlot(k: number): THREE.Vector3 {
        return new THREE.Vector3(xAt(AOF_C0 + k), PAGE_Y, zAt(STAGING_ROW))
    }

    /** Draw or erase one block of the file being staged. */
    private setStaged(k: number, on: boolean) {
        this.placeDiskBlock(this.stagingId(k), this.stagingSlot(k), on)
    }

    private stagingId(k: number) {
        return STAGING_ROW * COLS + AOF_C0 + k
    }

    /** Draw or erase one instance of the block field at an explicit position. */
    private placeDiskBlock(id: number, pos: THREE.Vector3, on: boolean) {
        this.tmpObj.position.copy(pos)
        const s = on ? 1 : 0.001
        this.tmpObj.scale.set(s, s, s)
        this.tmpObj.updateMatrix()
        this.disk.setMatrixAt(id, this.tmpObj.matrix)
        this.disk.setColorAt(
            id,
            this.tmpColor.setHex(on ? mixHex(AOF_FILL_DARK, AOF_FILL_BRIGHT, 1) : 0x000000),
        )
        this.disk.instanceMatrix.needsUpdate = true
        if (this.disk.instanceColor) this.disk.instanceColor.needsUpdate = true
    }

    /* ------------------------------- invariants ------------------------------ */

    /**
     * Check the picture against the numbers.
     *
     * The floor is one instanced mesh with no idea what is in it, and the files
     * are a handful of indices. If the two ever disagree, the scene draws a file
     * that does not exist — and by eye that looks like "blocks appeared and then
     * vanished" rather than like a bug. Each check below is a statement that has
     * to hold; the returned strings name the ones that do not.
     */
    verify(): string[] {
        const bad: string[] = []
        const s = this.disk.instanceMatrix.array
        /** instance scale (the matrices here are uniform scale + translation) */
        const scale = (id: number) => s[id * 16 + 5]
        const pos = (id: number) =>
            new THREE.Vector3(s[id * 16 + 12], s[id * 16 + 13], s[id * 16 + 14])

        const aofDrawn = new Set<number>()
        // 1. the log is exactly the blocks the file has reached
        for (let k = 0; k <= this.aofHead; k++) {
            const id = this.aofOrder[k]
            if (id === undefined) {
                bad.push(`log block ${k} has no floor slot`)
                continue
            }
            if (Math.abs(scale(id) - 1) > 2e-3) {
                bad.push(`log block ${k} (id ${id}) should be drawn, scale is ${scale(id).toFixed(3)}`)
            }
            const want = this.aofBlockPos(k)
            if (pos(id).distanceTo(want) > 1e-3) {
                bad.push(`log block ${k} sits at ${pos(id).toArray().map((n) => n.toFixed(2))}, expected ${want.toArray().map((n) => n.toFixed(2))}`)
            }
            aofDrawn.add(id)
        }
        // 2. the floor just past the end of the file is empty
        for (let k = this.aofHead + 1; k <= Math.min(this.aofHead + 4, this.aofOrder.length - 1); k++) {
            const id = this.aofOrder[k]
            if (scale(id) > 1e-2) bad.push(`log block ${k} is drawn, but the file ends at ${this.aofHead}`)
        }
        // 3. the base file is exactly its blocks, the last one partial
        for (let k = 0; k < this.rdbLen; k++) {
            const id = this.rdbOrder[k]
            if (scale(id) < 0.1) bad.push(`base block ${k} (id ${id}) is missing`)
        }
        for (let k = this.rdbLen; k < Math.min(this.rdbLen + 3, this.rdbOrder.length); k++) {
            const id = this.rdbOrder[k]
            if (scale(id) > 1e-2) bad.push(`base block ${k} is drawn, but the file ends at ${this.rdbLen - 1}`)
        }
        // 4. the two files never share a block
        for (let k = 0; k < this.rdbLen; k++) {
            if (aofDrawn.has(this.rdbOrder[k])) bad.push(`block ${k} of the base file is also in the log`)
        }
        // 5. a drawn block is never black. Black is "no file here", so a block that
        //    is in a file and painted black is a block the scene says exists and
        //    shows as absent — which is what a pulse decaying toward a stale colour
        //    did to the whole base file.
        const col = this.disk.instanceColor?.array
        if (col) {
            const lit = (id: number) => col[id * 3] + col[id * 3 + 1] + col[id * 3 + 2]
            let blackAof = 0
            let blackRdb = 0
            for (let k = 0; k <= this.aofHead; k++) {
                const id = this.aofOrder[k]
                if (id !== undefined && scale(id) > 0.5 && lit(id) < 1e-4) blackAof++
            }
            for (let k = 0; k < this.rdbLen; k++) {
                const id = this.rdbOrder[k]
                if (scale(id) > 0.1 && lit(id) < 1e-4) blackRdb++
            }
            if (blackAof > 0) bad.push(`${blackAof} block(s) of the log are drawn but black`)
            if (blackRdb > 0) bad.push(`${blackRdb} block(s) of the base file are drawn but black`)
        }
        // 5. the log's cage is the log's footprint
        if (this.aofHead >= 0 && this.aofOrder.length > 0) {
            let minC = COLS
            let maxC = -1
            let minR = ROWS
            let maxR = -1
            for (let k = 0; k <= this.aofHead; k++) {
                const id = this.aofOrder[k]
                if (id === undefined) continue
                const c = id % COLS
                const r = Math.floor(id / COLS)
                minC = Math.min(minC, c)
                maxC = Math.max(maxC, c)
                minR = Math.min(minR, r)
                maxR = Math.max(maxR, r)
            }
            const wantW = (maxC - minC + 1) * PITCH
            const wantD = (maxR - minR + 1) * PITCH
            if (Math.abs(this.aofEdge.w - wantW) > 1e-3) {
                bad.push(`log cage width ${this.aofEdge.w.toFixed(2)} ≠ the file's ${wantW.toFixed(2)}`)
            }
            if (Math.abs(this.aofEdge.d - wantD) > 1e-3) {
                bad.push(`log cage depth ${this.aofEdge.d.toFixed(2)} ≠ the file's ${wantD.toFixed(2)}`)
            }
        }
        // 6. nothing is left staged. During a rewrite the staged blocks are the
        //    point; after one, any of them still drawn belong to no file, and that
        //    is exactly what reads as "blocks appeared and then vanished".
        if (!this.rewriting) {
            for (let k = 0; k < 16; k++) {
                if (scale(this.stagingId(k)) > 1e-2) {
                    bad.push(`staging block ${k} is still drawn after the rewrite finished`)
                }
            }
        }
        return bad
    }

    /** Throw loudly in development, print in production — never silently. */
    private assertInvariants(where: string) {
        if (!checkInvariants) return
        const bad = this.verify()
        if (bad.length === 0) return
        const msg = `[redis] invariants broken after ${where}:\n  ${bad.join('\n  ')}`
        console.error(msg)
        throw new Error(msg)
    }

    /** A trace line for the rewrite, only when invariants are being checked. */
    private trace(msg: string) {
        if (checkInvariants) console.log(`[redis] ${msg}`)
    }

    /* --------------------------------- agents -------------------------------- */

    pulseAgent(g: THREE.Group) {
        const s = g.scale.x
        void this.ticker.add(0.6, (k) => {
            const f = 1 + 0.35 * Math.sin(k * Math.PI)
            g.scale.setScalar(s * f)
        })
    }

    /* --------------------------------- update -------------------------------- */

    update(dt: number, time: number) {
        // ports breathe while idle and burn while serving
        for (const pod of this.ports) {
            const target = pod.active ? (pod.busy ? 2.6 : 0.9) : 0
            pod.ring.emissiveIntensity += (target - pod.ring.emissiveIntensity) * Math.min(1, dt * 8)
            pod.glow.opacity = 0.16 + 0.34 * (pod.ring.emissiveIntensity / 2.6)
            if (pod.pulse > 0) {
                pod.pulse = Math.max(0, pod.pulse - dt * 1.6)
                if (pod.pulse === 0) pod.busy = false
            }
        }

        // the readiness set: a tile is lit while its connection is registered,
        // and flashes on the frame the loop actually read from that socket. An
        // unlit tile is not a closed connection in general — it is a slot this
        // floor has, which is where the analogy is ours and not the kernel's.
        this.fdMats.forEach((mat, i) => {
            this.fdPulse[i] = Math.max(0, this.fdPulse[i] - dt * 2.2)
            const pod = this.ports[i]
            const base = pod && pod.active ? 0.55 + 0.18 * breathe(time, 1.3, i) : 0.03
            mat.emissiveIntensity = base + this.fdPulse[i] * 2.4
        })

        // the loop is the one thing that is always visibly working
        this.loopCore.emissiveIntensity +=
            (1.35 + 0.35 * breathe(time, 2.2) - this.loopCore.emissiveIntensity) * Math.min(1, dt * 6)
        this.loopRing.rotation.z += dt * 0.5

        // the channel breathes like everything else in the thread's air, and
        // answers a publish with one ring of light
        this.channelPulse = Math.max(0, this.channelPulse - dt * 1.5)
        const ringMat = this.channelRing.material as THREE.MeshBasicMaterial
        ringMat.opacity = 0.3 + 0.12 * breathe(time, 1.1) + this.channelPulse * 0.5
        this.channelRing.scale.setScalar(1 + this.channelPulse * 0.16)

        // and the air moves, exactly as it does in the other cage
        driftDust(this.motes, dt, time)

        // a big value that was touched burns for a beat and settles back
        for (const kind of ['hash', 'zset', 'list'] as BigKind[]) {
            this.bigPulse[kind] = Math.max(0, this.bigPulse[kind] - dt * 2.2)
            const mat = this.bigMats[kind]
            if (!mat) continue
            mat.emissiveIntensity = 0.42 + 0.1 * breathe(time, 1.4, kind.length) + this.bigPulse[kind] * 2.2
        }

        // hot keys glow softly, and stop glowing when they are gone
        this.hotHalos.forEach((s, i) => {
            const key = this.hotKeys[i]
            const on = !!key && key.live
            s.visible = on
            if (on) s.material.opacity = 0.16 + 0.12 * breathe(time, 1.6, i)
        })

        // the dict's cron: while a rehash is running it migrates a burst of
        // buckets on a timer, and once the load factor passes 1 it starts one
        this.rehashTimer -= dt
        if (this.rehashTimer <= 0) {
            this.rehashTimer = 0.25
            this.rehashStep(2)
            this.maybeGrow()
        }

        // A conversion lands: the new structure grows in over a few frames rather
        // than appearing whole, so the eye catches which key just paid for it.
        if (this.auxAnim.size > 0) {
            for (const [i, v] of this.auxAnim) {
                const next = Math.min(1, v + dt * 3.4)
                if (next >= 1) this.auxAnim.delete(i)
                else this.auxAnim.set(i, next)
                this.paintAuxKey(this.keys[i])
            }
        }

        // keys cool down after being touched
        let dirtyKeys = false
        for (const key of this.keys) {
            if (key.heat <= 0) continue
            key.heat = Math.max(0, key.heat - dt * 1.5)
            const base = mixHex(0x06222c, KIND_COLOR[key.kind], 0.55 * key.shade)
            const c = this.tmpColor.setHex(base).lerp(new THREE.Color(PALETTE.ice), key.heat * 0.65)
            this.keysMesh.setColorAt(key.i, c)
            dirtyKeys = true
        }
        if (dirtyKeys && this.keysMesh.instanceColor) this.keysMesh.instanceColor.needsUpdate = true

        // A block that was just touched settles back over PULSE_TIME. One marker
        // for every block in the scene: lit once, then ordinary again.
        if (this.diskBoost.size > 0) {
            let dirty = false
            for (const [i, pulse] of this.diskBoost) {
                const next = pulse.v - dt / PULSE_TIME
                if (next <= 0) {
                    this.diskBoost.delete(i)
                    this.disk.setColorAt(i, this.tmpColor.setHex(this.restingHex(i)))
                } else {
                    pulse.v = next
                    this.disk.setColorAt(
                        i,
                        this.tmpColor
                            .setHex(this.restingHex(i))
                            .lerp(this.pulseColor.setHex(pulse.hex), next)
                            // and past white: the bloom pass only picks up what is
                            // over 1.0, which is what makes a pulse look like
                            // light rather than like lighter paint
                            .multiplyScalar(1 + (PULSE_GAIN - 1) * next),
                    )
                }
                dirty = true
            }
            if (dirty && this.disk.instanceColor) this.disk.instanceColor.needsUpdate = true
        }

        // the write head shimmers so the append point is findable at a glance
        // (removed: the append point is only ever visible as a pulse on the block
        // that changed, never as a standing marker)

        // aof_buf floats above the end of the file, bobbing and swaying like it is
        // only half in this world — because it is not on disk yet. Same treatment
        // as wal_buffers, and it drifts along as the file grows.
        if (this.aofBufGroup) {
            const g = this.aofBufGroup
            // the append point moves along the row and then wraps into the next
            // one, so the strip follows the head on both axes, not just x
            const head = this.aofBlockPos(this.aofHead)
            g.position.x += (head.x - g.position.x) * Math.min(1, dt * 2.4)
            g.position.y = AOF_BUF_Y + Math.sin(time * 1.3) * 0.08
            g.position.z += (head.z - g.position.z) * Math.min(1, dt * 2.4)
            this.aofBufCells.forEach((m, i) => {
                const ph = i * 1.15
                m.position.y = Math.sin(time * 1.9 + ph) * 0.09
                m.rotation.z = Math.sin(time * 1.15 + ph) * 0.16
                m.rotation.y = Math.sin(time * 0.75 + ph * 0.7) * 0.4
                m.scale.setScalar(1 + Math.sin(time * 2.4 + ph) * 0.035)
            })
            // The strip cycles: it fills with writes and empties on the next
            // flush (see flushAofBuffer). Nothing is dropped here — what drains
            // it is write() + fsync, once a second by default.
            this.aofBufMats.forEach((mat, i) => {
                const live = i <= this.bufferCubeIndex() ? this.aofBuffered : 0
                mat.emissiveIntensity +=
                    (0.5 + live * 0.6 - mat.emissiveIntensity) * Math.min(1, dt * 5)
            })
            // keep the world anchor on the strip: views and the camera aim at it
            REDIS_ANCHOR.aofBuf.copy(g.position).add(REDIS_ORIGIN)
        }

        // bgsave orbits the base file it is responsible for when it has nothing
        // to do; while it is working it flies to the keyspace and then along the
        // file it is writing, at a bounded speed so the walk stays followable
        if (this.savingRdb) {
            this.rewriteStep.copy(this.rdbAim).sub(this.bgsaveDrone.position)
            const dist = this.rewriteStep.length()
            if (dist > 1e-4) {
                const step = Math.min(dist, AGENT_SPEED * dt)
                this.bgsaveDrone.position.addScaledVector(this.rewriteStep.multiplyScalar(1 / dist), step)
            }
        } else {
            // same slow ellipse as the rewrite agent, and the same lerp, so the
            // hand-off between patrolling and working is one continuous flight
            const a = time * 0.34
            this.rdbIdle.set(
                this.rdbHome.x + Math.cos(a) * 3.2,
                this.rdbHome.y + Math.sin(time * 0.75) * 0.2,
                this.rdbHome.z + Math.sin(a) * 1.9,
            )
            this.bgsaveDrone.position.lerp(this.rdbIdle, Math.min(1, dt * 1.2))
            this.bgsaveDrone.rotation.y += dt * 0.6
        }

        // the agent patrols the log when it has nothing to do, exactly the way the
        // autovacuum drone patrols the disk: a slow ellipse, fed through a lerp so
        // it can never jump. While it works, its position is instead pulled toward
        // whatever runRewrite is aiming at — same lerp, same smoothness, so the
        // hand-off between phases is one continuous flight.
        if (this.rewriting) {
            // Fly toward the aim at a bounded speed rather than lerping at a fixed
            // rate: a fixed rate moves fastest when the gap is widest, which reads
            // as a cut exactly when the flight should be most legible.
            this.rewriteStep.copy(this.rewriteAim).sub(this.rewriteDrone.position)
            const dist = this.rewriteStep.length()
            if (dist > 1e-4) {
                const step = Math.min(dist, AGENT_SPEED * dt)
                this.rewriteDrone.position.addScaledVector(this.rewriteStep.multiplyScalar(1 / dist), step)
            }
            this.rewriteDrone.rotation.y += dt * 2.2
        } else {
            const a = time * 0.28
            this.rewriteIdle.set(
                this.rewriteHome.x + Math.cos(a) * 6.4,
                this.rewriteHome.y + Math.sin(time * 0.8) * 0.32,
                this.rewriteHome.z + Math.sin(a) * 1.9,
            )
            this.rewriteDrone.position.lerp(this.rewriteIdle, Math.min(1, dt * 1.2))
            this.rewriteDrone.rotation.y += dt * 0.7
        }
    }

    /** Tight bounds for the camera: the cage plus everything floating in it. */
    bounds(): THREE.Box3 {
        this.tmpBox.setFromObject(this.group)
        return this.tmpBox.clone()
    }

    /**
     * Slide the cage across the floor. Everything outside the group that aims
     * at it — the command paths, the camera views — reads REDIS_ANCHOR, so the
     * anchors are rewritten in place rather than left behind.
     */
    setOrigin(pos: THREE.Vector3) {
        REDIS_ORIGIN.copy(pos)
        this.group.position.copy(pos)
        rebaseAnchors()
    }
}
