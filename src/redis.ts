import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { BACKEND_ORIGIN, BACKEND_SLOTS, BLOCK_PICK_RANGE, PALETTE } from './instance'
import type { Info } from './instance'
import {
    BLOCK_LIFT,
    FLOOR_Y,
    OutlineBox,
    Ticker,
    breathe,
    floorLabel,
    halo,
    label,
    neonEdges,
    radialTexture,
    rand,
    randInt,
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
const BLOCK = { w: 0.46, h: 0.28, d: 0.46 }
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
const AOF_LEN = 22
const RDB = { c0: 4, c1: 13, r0: 2, r1: 8 }

/**
 * How long one block takes to read or write during a load or a save, in
 * simulated seconds. A real 4 kB block is microseconds; this is the scale at
 * which a human can watch a file being written without it lying about the order.
 */
const RDB_BLOCK_TIME = 0.035
const AOF_RECORD_TIME = 0.055

/** The keyspace: a bucket array, and the entries it points at, both floating. */
const DICT = { cols: 32, rows: 7, y: 3.9, cz: -2.2 }
const KEYS = { cols: 26, rows: 7, y: 7.0, cz: -2.2 }

const dictX = (c: number) => (c - (DICT.cols - 1) / 2) * PITCH
const dictZ = (r: number) => DICT.cz + (r - (DICT.rows - 1) / 2) * PITCH
const keyX = (c: number) => (c - (KEYS.cols - 1) / 2) * PITCH
const keyZ = (r: number) => KEYS.cz + (r - (KEYS.rows - 1) / 2) * PITCH

/** The single command loop, and the queue it drains. */
const LOOP = new THREE.Vector3(0, 7.6, 1.4)
const QUEUE = { cells: 10, y: 8.95, z: BACKEND_ORIGIN.z }

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
}

export interface RedisPort {
    id: number
    group: THREE.Group
    ring: THREE.MeshStandardMaterial
    glow: THREE.SpriteMaterial
    busy: boolean
    active: boolean
    pulse: number
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
}

/** local geometry + wherever the cage currently stands = world position */
function rebaseAnchors() {
    const o = REDIS_ORIGIN
    REDIS_ANCHOR.sky.set(6, 26, 2).add(o)
    REDIS_ANCHOR.keys.set(0, KEYS.y + 0.4, KEYS.cz + 0.4).add(o)
    REDIS_ANCHOR.dict.set(0, DICT.y, DICT.cz).add(o)
    REDIS_ANCHOR.loop.copy(LOOP).add(o)
    REDIS_ANCHOR.ports.set(0, BACKEND_ORIGIN.y, BACKEND_ORIGIN.z).add(o)
    REDIS_ANCHOR.aof.set(xAt(AOF_C0 + AOF_LEN / 2), BLOCK_TOP, zAt(AOF_ROW)).add(o)
    REDIS_ANCHOR.aofBuf.set(xAt(AOF_C0), AOF_BUF_Y, zAt(AOF_ROW)).add(o)
    REDIS_ANCHOR.rdb.copy(RDB_CENTRE).add(o)
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

    private disk!: THREE.InstancedMesh
    private dictMesh!: THREE.InstancedMesh
    private keysMesh!: THREE.InstancedMesh
    /** base albedo per instance, so a flash can be undone */
    private diskBase: number[] = []
    /** decaying flash boost per disk instance */
    private diskBoost = new Map<number, number>()

    /** instance ids of the AOF run, oldest → newest */
    private aofOrder: number[] = []
    private aofHead = 0

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

    private queueCells: THREE.Mesh[] = []
    private queueMats: THREE.MeshStandardMaterial[] = []
    /** How many commands are waiting right now. 0 = the queue is empty. */
    private queueDepth = 0
    private loopCore!: THREE.MeshStandardMaterial
    private loopRing!: THREE.Mesh
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
        xAt(AOF_C0 + AOF_LEN / 2),
        AOF_BUF_Y + 0.9,
        zAt(AOF_ROW),
    )
    /** Where the agent is heading right now — the only thing its work sets. */
    private readonly rewriteAim = new THREE.Vector3().copy(this.rewriteHome)
    private readonly rewriteIdle = new THREE.Vector3()
    private readonly rewriteStep = new THREE.Vector3()
    /** True while bgrewriteaof is running — the agent drives itself then. */
    rewriting = false

    private markGeo = new THREE.TorusGeometry(0.34, 0.025, 4, 28)
    /** Smaller ring for a disk block, so the pulse never spills onto its neighbour. */
    private blockMarkGeo = new THREE.TorusGeometry(0.3, 0.02, 4, 24)
    private markMat = new THREE.MeshBasicMaterial({
        color: PALETTE.amber,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    })

    private tmpColor = new THREE.Color()
    private amberColor = new THREE.Color(PALETTE.amber)
    private tmpObj = new THREE.Object3D()
    private tmpBox = new THREE.Box3()

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
        this.buildPipeline()
        this.buildAgents()

        // the base file is whatever the keyspace encodes to: its length comes
        // from the data, not from a constant
        this.writeRdbNow()

        this.openPort()
        this.openPort()
        this.openPort()
        this.openPort()
    }

    /* -------------------------------- building ------------------------------- */

    private register(obj: THREE.Object3D, info: Info, outline?: OutlineBox) {
        obj.userData.info = info
        if (outline) obj.userData.outline = outline
        this.pickables.push(obj)
        return obj
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
                const onAof = r === AOF_ROW && c >= AOF_C0 && c < AOF_C0 + AOF_LEN
                const onRdb = r >= RDB.r0 && r <= RDB.r1 && c >= RDB.c0 && c <= RDB.c1

                this.tmpObj.position.copy(home)
                if (onAof) {
                    // One shape for every block in this scene, the same one the page
                    // field uses. A file is written in whole filesystem blocks, so
                    // nothing here is a short plate or a half-height block.
                    this.tmpObj.scale.set(1, 1, 1)
                } else {
                    // nothing is here: collapse it on ALL three axes, so the plate
                    // and the slot lattice show and no flattened sliver is left
                    this.tmpObj.scale.setScalar(0.001)
                }
                this.tmpObj.updateMatrix()
                field.setMatrixAt(i, this.tmpObj.matrix)

                // The RDB blocks get their colour from layoutRdb() once the keys
                // are known — the file's length is a function of the data. A
                // block that is in the file is a FULL block: 4 kB is the whole
                // unit here, so it sits at the bright end of the ramp. Small
                // shade variation only, because the records in a block are not
                // all the same size.
                const hex = onAof ? mixHex(AOF_FILL_DARK, AOF_FILL_BRIGHT, 1) : 0x000000
                this.diskBase[i] = hex
                if (onAof) field.setColorAt(i, this.tmpColor.setHex(hex))
                if (onRdb) {
                    this.rdbBase[i] = mixHex(RDB_FILL_DARK, RDB_FILL_BRIGHT, rand(0.94, 1.04))
                }
                if (onAof) this.aofOrder.push(i)
                i++
            }
        }
        if (field.instanceColor) field.instanceColor.needsUpdate = true

        // The log starts part-written: the file has only reached the first N of
        // these blocks, and the rest are not drawn at all (see layoutAof).
        this.aofHead = Math.round(AOF_LEN * 0.6)
        this.layoutAof()

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

        // The AOF run gets an extent outline, exactly the way the WAL run does
        // next door: a cage marks where the file LIVES on the floor, not what
        // happens to be written in it. It therefore never grows or shrinks with
        // the head — the file has a footprint, and this is it.
        const ax0 = xAt(AOF_C0) - PITCH / 2
        const ax1 = xAt(AOF_C0 + AOF_LEN - 1) + PITCH / 2
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

        const aofPick = new THREE.Mesh(
            new THREE.BoxGeometry(ax1 - ax0, 1.4, az1 - az0),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        aofPick.position.set((ax0 + ax1) / 2, PAGE_Y + 0.5, (az0 + az1) / 2)
        this.group.add(aofPick)
        this.register(
            aofPick,
            {
                title: 'AOF — the append-only file, on disk',
                body: 'This run is one file. It is not page-structured: Redis appends the bytes of each write command after the last byte of the file, so the only unit here is the 4 kB block a filesystem stores it in. Only the blocks the file has reached are drawn; the rest of the run is room it will grow into. The block being appended pulses once and is an ordinary block again — nothing is selected, nothing is rewritten in place. The newest bytes are still in aof_buf, the floating cyan strip above, until fsync: with appendfsync everysec they can be up to a second behind, which is the whole trade. A rewrite writes a new, shorter file and swaps it in, which is why the end of this run can move backwards.',
                meta: 'appendonlydir · byte stream on a filesystem · fsync per appendfsync',
            },
            aofEdge,
        )

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
        this.register(
            rdbPick,
            {
                title: 'RDB — the base file, on disk',
                body: 'This is a dump, not a log: the keyspace is walked once and every key and value is written out as it stands, so loading it rebuilds the data structures rather than replaying commands. That is why it loads fast, why it only knows about the instant it was taken, and why everything after it comes from the AOF. It is written by the forked child (bgsave) and read back at start-up before the log is replayed on top. Its blocks are the same 4 kB the filesystem always hands out, packed tight with no gaps — the file is written fresh every time, so unlike a table file it has no holes to defragment. What varies is its length: that is the size of your data. Writes cost memory, not time: the child needs a copy-on-write view of the whole dataset, so a big instance briefly needs close to twice its size to save.',
                meta: 'dump.rdb · state, not history · written by bgsave, read on start',
            },
            rdbEdge,
        )

        // slot lattice across the free space — the same "room to grow" texture the
        // postgres disk uses for its untouched tail
        const slotPts: number[] = []
        const fx0 = xAt(0) - PITCH / 2
        const fx1 = xAt(COLS - 1) + PITCH / 2
        const fz0 = zAt(0) - PITCH / 2
        const fz1 = zAt(ROWS - 1) + PITCH / 2
        for (let x = fx0; x <= fx1 + 0.001; x += PITCH) slotPts.push(x, FLOOR_Y, fz0, x, FLOOR_Y, fz1)
        for (let z = fz0; z <= fz1 + 0.001; z += PITCH) slotPts.push(fx0, FLOOR_Y, z, fx1, FLOOR_Y, z)
        const slotGeo = new THREE.BufferGeometry()
        slotGeo.setAttribute('position', new THREE.Float32BufferAttribute(slotPts, 3))
        this.group.add(
            new THREE.LineSegments(
                slotGeo,
                new THREE.LineBasicMaterial({
                    color: 0x1d4a5e,
                    transparent: true,
                    opacity: 0.5,
                    depthWrite: false,
                }),
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
                dict.setColorAt(i, this.tmpColor.setHex(mixHex(0x0d3a48, PALETTE.cyan, rand(0.25, 0.5))))
                i++
            }
        }
        if (dict.instanceColor) dict.instanceColor.needsUpdate = true

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
            title: 'Hash table — the bucket array',
            body: 'The dictionary is what makes Redis O(1): hash the key, land on a bucket, follow its chain. This plane is the bucket array itself, sitting in the process heap. There is no index to choose and no planner to consult — the data structure is the query plan.',
            meta: 'dict · bucket array · in the process heap',
        })
        const dictLab = label('DICT · BUCKETS')
        dictLab.position.set(-dW / 2 - 0.3, DICT.y + 0.55, DICT.cz - dD / 2)
        this.group.add(dictLab)

        /* ----------------------------- entries ---------------------------- */
        const kMat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            emissive: PALETTE.cyan,
            emissiveIntensity: 0.16,
            roughness: 0.45,
            metalness: 0.3,
        })
        const keys = new THREE.InstancedMesh(this.blockGeo, kMat, KEYS.cols * KEYS.rows)
        keys.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        this.group.add(keys)
        this.keysMesh = keys
        keys.userData.infoFor = (hit: THREE.Intersection) => this.keyPick(hit)
        this.pickables.push(keys)

        i = 0
        for (let r = 0; r < KEYS.rows; r++) {
            for (let c = 0; c < KEYS.cols; c++) {
                const home = new THREE.Vector3(keyX(c), KEYS.y, keyZ(r))
                // about three quarters of the slots hold a key at boot
                const live = Math.random() < 0.74
                const kinds: KeyKind[] = ['string', 'string', 'string', 'hash', 'list', 'set', 'zset']
                const kind = kinds[randInt(0, kinds.length - 1)]
                const size = VALUE_BYTES[kind]
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

        const kW = KEYS.cols * PITCH
        const kD = KEYS.rows * PITCH
        // Same mechanism as the disk: one pick volume for the whole container.
        // The key blocks answer per-instance only from up close (see keyPick),
        // so from a distance you select the keyspace, not a lucky block.
        const keysPick = new THREE.Mesh(
            new THREE.BoxGeometry(kW, 0.8, kD),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        keysPick.position.set(0, KEYS.y, KEYS.cz)
        this.group.add(keysPick)
        this.register(keysPick, {
            title: 'Keyspace — the database itself, in RAM',
            body: 'Every block here is one key with its value: strings, hashes, lists, sets, sorted sets. This is the whole database. When the process restarts, whatever was only here is gone — the AOF and the RDB on the floor below are the only things that survive. When maxmemory is reached, keys are evicted from this plane, and eviction is the only thing that ever shrinks it.',
            meta: `${KEYS.cols * KEYS.rows} slots · values live in the process heap`,
        })
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
                body: 'A connection is a file descriptor, not a process. Every connected client lands in the same event loop and the same command queue below, and the commands are executed one at a time. Postgres forks a backend per connection; redis serves them all from one thread. That is the whole scaling story, and the reason the I/O threads exist only for read and write syscalls.',
                meta: 'socket · multiplexed · shares the single command thread',
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
            })
            g.visible = false
        }
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
        const onAof = r === AOF_ROW && c >= AOF_C0 && c < AOF_C0 + AOF_LEN
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
                title: `AOF — record ${c - AOF_C0 + 1} of ${AOF_LEN}`,
                body: 'One command, appended in order. Replay is re-execution: start from the base file and run every record after it, and you are back where the server was. That is why AOF is safe but slow to load, and why records must be deterministic — a command that depends on the clock or on random data is rewritten before it is logged.',
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
        const key = this.keys[i]
        if (!key.live) return null
        const box = new THREE.Box3().setFromCenterAndSize(
            key.home.clone().add(new THREE.Vector3(0, BLOCK.h / 2, 0)),
            new THREE.Vector3(BLOCK.w, BLOCK.h, BLOCK.d),
        )
        return {
            key: `redis-key-${i}`,
            info: {
                title: `key #${i} — ${key.kind}`,
                body: 'One key and its value, living in the process heap. Reads are a hash plus a pointer chase: no buffer pool, no page read, no disk. This is also why a key that is bigger than memory cannot exist here at all, and why one slow O(N) command on a big value blocks every other client.',
                meta: key.ttl > 0 ? `ttl ≈ ${key.ttl.toFixed(0)} s · in RAM` : 'no ttl · in RAM',
            } as Info,
            box: this.toWorld(box),
        }
    }

    /* ---------------------------------- ports -------------------------------- */

    openPort(): RedisPort | null {
        const pod = this.ports.find((p) => !p.active)
        if (!pod) return null
        pod.active = true
        pod.group.visible = true
        return pod
    }

    closePort(): boolean {
        const open = this.ports.filter((p) => p.active)
        if (open.length <= 1) return false
        const pod = open[open.length - 1]
        pod.active = false
        pod.busy = false
        pod.group.visible = false
        return true
    }

    pulsePort(pod: RedisPort) {
        pod.pulse = 1
        pod.busy = true
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
        return key.home.clone().add(new THREE.Vector3(0, BLOCK.h / 2 + 0.06, 0))
    }

    keyBox(key: RedisKey): THREE.Box3 {
        return this.toWorld(
            new THREE.Box3().setFromCenterAndSize(
                key.home.clone().add(new THREE.Vector3(0, BLOCK.h / 2, 0)),
                new THREE.Vector3(BLOCK.w, BLOCK.h, BLOCK.d),
            ),
        )
    }

    setKeyLive(key: RedisKey, live: boolean) {
        key.live = live
        key.heat = live ? 1 : 0
        const s = live ? 1 : 0.001
        this.tmpObj.position.copy(key.home)
        this.tmpObj.scale.set(s, s, s)
        this.tmpObj.updateMatrix()
        this.keysMesh.setMatrixAt(key.i, this.tmpObj.matrix)
        this.keysMesh.instanceMatrix.needsUpdate = true
        this.flashKey(key, live ? KIND_COLOR[key.kind] : PALETTE.magenta, 0.5)
    }

    /** The bucket a key hashes to — shown by lighting one dict tile. */
    pulseBucket(key: RedisKey) {
        const bucket = (key.row * KEYS.cols + key.col) % (DICT.cols * DICT.rows)
        this.dictMesh.setColorAt(bucket, this.tmpColor.setHex(PALETTE.ice))
        if (this.dictMesh.instanceColor) this.dictMesh.instanceColor.needsUpdate = true
        void this.ticker.add(0.45, (k) => {
            const base = mixHex(0x0d3a48, PALETTE.cyan, 0.35)
            this.dictMesh.setColorAt(bucket, this.tmpColor.setHex(base).lerp(new THREE.Color(PALETTE.ice), 1 - k))
            if (this.dictMesh.instanceColor) this.dictMesh.instanceColor.needsUpdate = true
        })
    }

    flashKey(key: RedisKey, hex: number, dur = 0.5) {
        this.keysMesh.setColorAt(key.i, this.tmpColor.setHex(hex))
        if (this.keysMesh.instanceColor) this.keysMesh.instanceColor.needsUpdate = true
        void this.ticker.add(dur, (k) => {
            if (k < 1) return
            const base = mixHex(0x06222c, KIND_COLOR[key.kind], 0.55 * key.shade)
            this.keysMesh.setColorAt(key.i, this.tmpColor.setHex(base))
            if (this.keysMesh.instanceColor) this.keysMesh.instanceColor.needsUpdate = true
        })
    }

    /** An expanding ring on a key: "the lookup landed here". */
    markKey(key: RedisKey, hex = PALETTE.ice) {
        const ring = new THREE.Mesh(this.markGeo, this.markMat.clone())
        const mat = ring.material as THREE.MeshBasicMaterial
        mat.color.setHex(hex)
        ring.rotation.x = -Math.PI / 2
        ring.position.copy(this.keyTop(key))
        ring.scale.setScalar(0.5)
        this.group.add(ring)
        void this.ticker.add(0.55, (k) => {
            ring.scale.setScalar(0.5 + k * 1.1)
            mat.opacity = 0.85 * (1 - k)
            if (k >= 1) this.group.remove(ring)
        })
    }

    /* ----------------------------------- AOF --------------------------------- */

    /** How many blocks the log occupies right now. */
    get aofUsed() {
        return this.aofHead + 1
    }

    private aofHeadX(): number {
        return xAt(AOF_C0 + Math.min(this.aofHead, this.aofOrder.length - 1))
    }

    /**
     * Only the blocks the file has actually reached are drawn.
     *
     * A block past the end of the log is not "dark", not "empty" and not a flat
     * plate — it does not exist yet, so it is collapsed to nothing on all three
     * axes. Flattening only the height was the bug: it left a full-footprint
     * sliver behind, which reads as a block that is there but switched off.
     */
    private layoutAof() {
        const hex = mixHex(AOF_FILL_DARK, AOF_FILL_BRIGHT, 1)
        this.aofOrder.forEach((i, k) => {
            const on = k <= this.aofHead
            this.disk.getMatrixAt(i, this.tmpObj.matrix)
            this.tmpObj.position.setFromMatrixPosition(this.tmpObj.matrix)
            const s = on ? 1 : 0.001
            this.tmpObj.scale.set(s, s, s)
            this.tmpObj.updateMatrix()
            this.disk.setMatrixAt(i, this.tmpObj.matrix)
            const base = on ? hex : 0x000000
            this.diskBase[i] = base
            this.disk.setColorAt(i, this.tmpColor.setHex(base))
        })
        this.disk.instanceMatrix.needsUpdate = true
        if (this.disk.instanceColor) this.disk.instanceColor.needsUpdate = true
    }

    /** Append one write: the log gains a block, and that block pulses once. */
    appendAof(bytes: number): THREE.Vector3 {
        this.aofBytes += bytes
        // the record goes after the last byte of the file, so at most it starts a
        // new block; it never rewrites one that is already there
        this.aofHead = Math.min(this.aofHead + 1, this.aofOrder.length - 1)
        this.layoutAof()

        const i = this.aofOrder[this.aofHead]
        this.disk.getMatrixAt(i, this.tmpObj.matrix)
        const block = new THREE.Vector3().setFromMatrixPosition(this.tmpObj.matrix)

        // One pulse per append, on the one block that changed — the same pulse an
        // edited page gets on the postgres disk. No frame, no standing second
        // colour: after ~0.4 s it is an ordinary block again.
        this.diskBoost.set(i, 1)
        this.disk.setColorAt(i, this.tmpColor.setHex(PALETTE.amber))
        if (this.disk.instanceColor) this.disk.instanceColor.needsUpdate = true
        this.markBlockTop(block)

        // the bytes are in aof_buf until the next flush, not on the device yet
        this.aofBuffered = Math.min(1, this.aofBuffered + bytes / BLOCK_BYTES)
        const mat = this.aofBufMats[this.bufferCubeIndex()]
        if (mat) {
            void this.ticker.add(0.5, (k) => {
                mat.emissiveIntensity = 1.3 - 0.8 * k
            })
        }

        return block.add(new THREE.Vector3(0, BLOCK.h / 2, 0))
    }

    /** Expanding ring over one block: "this is the block the record went into". */
    private markBlockTop(block: THREE.Vector3, hex = PALETTE.amber) {
        const ring = new THREE.Mesh(this.blockMarkGeo, this.markMat.clone())
        const mat = ring.material as THREE.MeshBasicMaterial
        mat.color.setHex(hex)
        ring.rotation.x = -Math.PI / 2
        ring.position.set(block.x, PAGE_Y + BLOCK.h / 2 + 0.02, block.z)
        ring.scale.setScalar(0.3)
        this.group.add(ring)
        void this.ticker
            .add(0.55, (k) => {
                ring.scale.setScalar(0.3 + k * 0.85)
                mat.opacity = 0.9 * (1 - k)
            })
            .then(() => {
                this.group.remove(ring)
                mat.dispose()
            })
    }

    aofHeadTop(): THREE.Vector3 {
        const i = this.aofOrder[Math.min(this.aofHead, this.aofOrder.length - 1)]
        this.disk.getMatrixAt(i, this.tmpObj.matrix)
        const p = new THREE.Vector3().setFromMatrixPosition(this.tmpObj.matrix)
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
     * appendfsync: everything in aof_buf is written out and flushed. With the
     * default `everysec` this runs once a second, which is exactly the durability
     * window — a crash can lose the last second of acknowledged writes and not
     * one byte more. `always` would drain on every command, `no` would leave the
     * dirty pages to the kernel.
     *
     * The buffer is a staging area, not a queue that can overflow: what it holds
     * is copied into the file and then reused. Nothing is discarded by a flush.
     */
    flushAofBuffer() {
        if (this.aofBuffered <= 0) return
        this.aofBuffered = 0
        this.pulseBuffered()
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
            const base = on
                ? seq === this.rdbLen - 1
                    ? // the tail block is the only one that is not full, and it is
                    // the only one that should look it
                    mixHex(RDB_FILL_DARK, this.rdbBase[id] ?? RDB_FILL_BRIGHT, fill)
                    : (this.rdbBase[id] ?? RDB_FILL_BRIGHT)
                : 0x000000
            this.disk.setColorAt(id, this.tmpColor.setHex(base))
        })
        this.disk.instanceMatrix.needsUpdate = true
        if (this.disk.instanceColor) this.disk.instanceColor.needsUpdate = true
        this.fitRdbEdge()
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
            return
        }
        this.rdbEdge.visible = true
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
            for (let b = shown; b < upto; b++) this.markBlockTop(this.rdbBlockPos(b), PALETTE.teal)
            shown = Math.max(shown, upto)
            this.rdbAim.copy(this.rdbBlockPos(upto - 1))
        })

        this.rdbBytes = this.keys.reduce((sum, k) => sum + (base[k.i] ? k.bytes : 0), 0)
        this.saves++
        this.pulseAgent(this.bgsaveDrone)
        this.savingRdb = false
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
                    this.markBlockTop(this.rdbBlockPos(b), PALETTE.teal)
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
                    this.markBlockTop(
                        new THREE.Vector3(xAt(AOF_C0 + r), PAGE_Y, zAt(AOF_ROW)),
                        PALETTE.amber,
                    )
                    if (restored < tail.length) this.reviveKey(tail[restored++])
                }
                replayed = Math.max(replayed, upto)
            })
        }
        while (restored < tail.length) this.reviveKey(tail[restored++])

        this.loading = false
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
        this.tmpObj.position.copy(key.home)
        this.tmpObj.scale.setScalar(1)
        this.tmpObj.updateMatrix()
        this.keysMesh.setMatrixAt(i, this.tmpObj.matrix)
        this.keysMesh.instanceMatrix.needsUpdate = true
    }

    /**
     * bgrewriteaof, in the three steps it actually performs:
     *
     *   1. fork — the child gets a copy-on-write view and WALKS the keyspace
     *      column by column; nothing is locked, the parent keeps serving
     *   2. it writes a NEW file holding the minimum command set that reproduces
     *      that state, which is shorter than the log it replaces — so the end of
     *      the log walks backwards and the records past it are simply not there
     *   3. swap — the old file is unlinked and the new one takes over
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

        // 2. it drops onto the log it is rewriting before it starts walking it back
        this.rewriteAim.set(xAt(AOF_C0 + oldHead), 1.4, zAt(AOF_ROW))
        await this.ticker.wait(0.5)

        // 3. the new file is written: the agent walks the log back, and every
        //    record it passes is one the new file does not need
        await this.ticker.add(0.95, (k) => {
            const idx = Math.round(oldHead - (oldHead - target) * k)
            this.rewriteAim.set(xAt(AOF_C0 + idx), 1.4, zAt(AOF_ROW))
            for (let j = idx + 1; j <= oldHead; j++) this.hideAofBlock(j)
        })

        // 3. swap: the shorter file takes over, minus nothing for writes that
        //    arrived during the rewrite — those survive in the buffer merge
        this.rewrites++
        this.aofHead = Math.max(target, this.aofHead - (oldHead - target))
        this.aofBytes = Math.round(this.aofBytes * 0.25)
        this.layoutAof()
        this.disk.getMatrixAt(this.aofOrder[this.aofHead], this.tmpObj.matrix)
        this.markBlockTop(this.tmpObj.position.setFromMatrixPosition(this.tmpObj.matrix))
        this.pulseAgent(this.rewriteDrone)
        this.rewriting = false
    }

    /** One block the rewrite dropped: it is not in the new file at all. */
    private hideAofBlock(k: number) {
        const i = this.aofOrder[k]
        if (i === undefined) return
        this.disk.getMatrixAt(i, this.tmpObj.matrix)
        this.tmpObj.position.setFromMatrixPosition(this.tmpObj.matrix)
        this.tmpObj.scale.setScalar(0.001)
        this.tmpObj.updateMatrix()
        this.disk.setMatrixAt(i, this.tmpObj.matrix)
        this.diskBase[i] = 0x000000
        this.disk.setColorAt(i, this.tmpColor.setHex(0x000000))
        this.disk.instanceMatrix.needsUpdate = true
        if (this.disk.instanceColor) this.disk.instanceColor.needsUpdate = true
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
                pod.group.position.y = BACKEND_ORIGIN.y + pod.pulse * 0.12
                if (pod.pulse === 0) pod.busy = false
            }
        }

        // the loop is the one thing that is always visibly working
        this.loopCore.emissiveIntensity +=
            (1.35 + 0.35 * breathe(time, 2.2) - this.loopCore.emissiveIntensity) * Math.min(1, dt * 6)
        this.loopRing.rotation.z += dt * 0.5

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

        // AOF blocks settle back after a flash
        if (this.diskBoost.size > 0) {
            let dirty = false
            for (const [i, v] of this.diskBoost) {
                // quick enough to read as a pulse rather than a state: the block
                // is lit on the write and back to its own colour in ~0.4 s
                const next = v - dt * 2.6
                if (next <= 0) {
                    this.diskBoost.delete(i)
                    this.disk.setColorAt(i, this.tmpColor.setHex(this.diskBase[i] || 0x000000))
                } else {
                    this.diskBoost.set(i, next)
                    this.disk.setColorAt(
                        i,
                        this.tmpColor
                            .setHex(this.diskBase[i] || 0x000000)
                            .lerp(this.amberColor, next),
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
            g.position.x += (this.aofHeadX() - g.position.x) * Math.min(1, dt * 2.4)
            g.position.y = AOF_BUF_Y + Math.sin(time * 1.3) * 0.08
            g.position.z = zAt(AOF_ROW)
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
