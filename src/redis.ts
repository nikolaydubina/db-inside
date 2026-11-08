import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { BACKEND_ORIGIN, BACKEND_SLOTS, PALETTE } from './instance'
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
/** Blocks rest ON the floor, lifted by the shared hair so the grid never cuts them. */
const PAGE_Y = FLOOR_Y + BLOCK_LIFT + BLOCK.h / 2
const BLOCK_TOP = PAGE_Y + BLOCK.h / 2
/** Labels are painted on the floor: the same plane as the grid, +3 mm for the glyphs. */
const FLOOR_LABEL_Y = FLOOR_Y + 0.003

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

const RDB_CENTRE = new THREE.Vector3(
    (xAt(RDB.c0) + xAt(RDB.c1)) / 2,
    BLOCK_TOP,
    (zAt(RDB.r0) + zAt(RDB.r1)) / 2,
)

/** Kind tints stay in the legend's family: RAM is cyan, disk is amber. */
const KIND_COLOR: Record<KeyKind, number> = {
    string: PALETTE.cyan,
    list: PALETTE.teal,
    hash: PALETTE.violet,
    set: PALETTE.magenta,
    zset: PALETTE.ice,
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
    /** aof_buf: the cubes hover above wherever the end of the file is. */
    private aofBufGroup!: THREE.Group
    private aofBufCells: THREE.Mesh[] = []
    private aofBufMats: THREE.MeshStandardMaterial[] = []
    /** bytes sitting in aof_buf, as a fraction of the strip */
    private aofBuffered = 0

    private queueCells: THREE.Mesh[] = []
    private loopCore!: THREE.MeshStandardMaterial
    private loopRing!: THREE.Mesh
    private bgsaveDrone!: THREE.Group
    private rewriteDrone!: THREE.Group

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
    rewrites = 0

    constructor(private ticker: Ticker) {
        this.group.position.copy(REDIS_ORIGIN)
        this.buildShell()
        this.buildDisk()
        this.buildMemory()
        this.buildPorts()
        this.buildPipeline()
        this.buildAgents()

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
                const used = onAof || onRdb

                this.tmpObj.position.copy(home)
                if (used) {
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

                const hex = onRdb
                    ? mixHex(0x123a4a, PALETTE.teal, 0.62)
                    : onAof
                        ? mixHex(0x8a5c10, PALETTE.amber, 0.72)
                        : 0x000000
                this.diskBase[i] = hex
                if (used) field.setColorAt(i, this.tmpColor.setHex(hex))
                if (onAof) this.aofOrder.push(i)
                i++
            }
        }
        if (field.instanceColor) field.instanceColor.needsUpdate = true

        // The log starts part-written: the file has only reached the first N of
        // these blocks, and the rest are not drawn at all (see layoutAof).
        this.aofHead = Math.round(AOF_LEN * 0.6)
        this.layoutAof()

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
        diskLab.position.set(FIELD.w / 2 + ink.y1, FLOOR_LABEL_Y, FIELD.cz + FIELD.d / 2 + ink.x0)
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
                body: 'The dataset is not on this floor. Two files are: the incremental AOF at the front edge, where every write command is appended, and the base RDB dump on the left — a compact copy produced by forking the server. Everything else is free space the files could grow into. Kill the process and whatever is only in RAM is gone; these two files are what comes back.',
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
        const dictEdge = new OutlineBox(dW, 0.04, dD, PALETTE.cyan, 0.22).centre(0, DICT.y, DICT.cz)
        this.group.add(dictEdge)
        this.register(
            dictEdge,
            {
                title: 'Hash table — the bucket array',
                body: 'The dictionary is what makes Redis O(1): hash the key, land on a bucket, follow its chain. This plane is the bucket array itself, sitting in the process heap. There is no index to choose and no planner to consult — the data structure is the query plan.',
                meta: 'dict · bucket array · in the process heap',
            },
        )
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
        const keysEdge = new OutlineBox(kW, 0.04, kD, PALETTE.cyan, 0.3).centre(0, KEYS.y, KEYS.cz)
        this.group.add(keysEdge)
        this.register(
            keysEdge,
            {
                title: 'Keyspace — the database itself, in RAM',
                body: 'Every block here is one key with its value: strings, hashes, lists, sets, sorted sets. This is the whole database. When the process restarts, whatever was only here is gone — the AOF and the RDB on the floor below are the only things that survive. When maxmemory is reached, keys are evicted from this plane, and eviction is the only thing that ever shrinks it.',
                meta: `${KEYS.cols * KEYS.rows} slots · values live in the process heap`,
            },
        )
        const keysLab = label('KEYS · RAM')
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
        // the shared queue: everything the connections wrote, waiting for the loop
        const cellGeo = new THREE.BoxGeometry(0.36, 0.16, 0.52)
        const cellMat = new THREE.MeshStandardMaterial({
            color: 0x140a1c,
            emissive: PALETTE.violet,
            emissiveIntensity: 0.35,
            roughness: 0.4,
            metalness: 0.4,
        })
        for (let n = 0; n < QUEUE.cells; n++) {
            const cell = new THREE.Mesh(cellGeo, cellMat)
            cell.position.set((n - (QUEUE.cells - 1) / 2) * 0.52, QUEUE.y, QUEUE.z)
            this.group.add(cell)
            this.queueCells.push(cell)
        }
        const qW = QUEUE.cells * 0.52 + 0.14
        const qEdge = new OutlineBox(qW, 0.22, 0.62, PALETTE.violet, 0.3).centre(0, QUEUE.y, QUEUE.z)
        this.group.add(qEdge)
        this.register(
            qEdge,
            {
                title: 'Command queue — shared by every connection',
                body: 'Reads and writes from all clients are parsed into an argv and queued here. The single command thread drains the queue in order, so a command that takes 10 ms delays every client behind it by 10 ms. Redis is fast because each command is short, not because it runs many at once.',
                meta: 'one queue · one consumer · strictly in order',
            },
        )
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
            new THREE.Vector3(7.6, 8.3, KEYS.cz + 0.2),
            PALETTE.teal,
            'BGSAVE',
            {
                title: 'BGSAVE — a forked copy writes the RDB',
                body: 'A snapshot is taken by forking: the child gets a copy-on-write view of the whole keyspace and writes it to a new RDB file while the parent keeps serving. Nothing is locked. The cost is memory — pages the parent modifies while the child is writing are duplicated — and that is why a big instance can need much more than its dataset size to save.',
                meta: 'fork() · copy-on-write · no locking, extra memory',
            },
        )
        this.rewriteDrone = this.makeAgent(
            // over the base file, not over the end of the log: the rewrite writes
            // a fresh base, and the aof_buf strip drifts along the log right where
            // the drone used to sit
            new THREE.Vector3(RDB_CENTRE.x, 2.1, RDB_CENTRE.z),
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

        const ring = new THREE.Mesh(
            new THREE.TorusGeometry(0.5, 0.014, 6, 40),
            new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.55,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
            }),
        )
        ring.rotation.x = Math.PI / 2
        g.add(ring)

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
        const i = this.instanceAt(hit, COLS * ROWS)
        if (i === null) return null
        const r = Math.floor(i / COLS)
        const c = i % COLS
        const onAof = r === AOF_ROW && c >= AOF_C0 && c < AOF_C0 + AOF_LEN
        const onRdb = r >= RDB.r0 && r <= RDB.r1 && c >= RDB.c0 && c <= RDB.c1
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
                title: 'RDB — one dense copy of the keyspace',
                body: 'A binary snapshot: the whole dataset, compacted into one file. Fast to load, much smaller than the AOF, but it only knows about the moment it was taken — everything after it comes from the incremental AOF. These blocks are packed, because unlike the AOF this file is a state, not a history.',
                meta: 'dump.rdb · state, not history · loaded on start',
            }
        return { key: `redis-disk-${i}`, info, box: this.toWorld(box) }
    }

    private keyPick(hit: THREE.Intersection) {
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

    pulseQueue(n: number) {
        const cell = this.queueCells[Math.max(0, Math.min(this.queueCells.length - 1, n))]
        const mat = cell.material as THREE.MeshStandardMaterial
        mat.emissiveIntensity = 2.4
        void this.ticker.add(0.35, (k) => {
            mat.emissiveIntensity = 2.4 - 2.05 * k
        })
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
        const hex = mixHex(0x8a5c10, PALETTE.amber, 0.72)
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

        // the bytes are in aof_buf until the next fsync, not on the disk
        this.aofBuffered = Math.min(1, this.aofBuffered + 0.25)
        const mat = this.aofBufMats[this.bufferCubeIndex()]
        if (mat) {
            void this.ticker.add(0.5, (k) => {
                mat.emissiveIntensity = 1.3 - 0.8 * k
            })
        }

        return block.add(new THREE.Vector3(0, BLOCK.h / 2, 0))
    }

    /** Expanding ring over one block: "this is the block the record went into". */
    private markBlockTop(block: THREE.Vector3) {
        const ring = new THREE.Mesh(this.blockMarkGeo, this.markMat.clone())
        const mat = ring.material as THREE.MeshBasicMaterial
        mat.color.setHex(PALETTE.amber)
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

    rdbCentre(): THREE.Vector3 {
        return RDB_CENTRE.clone()
    }

    /** Rewrite: a new, much shorter file — the end of it moves back. */
    rewriteAof() {
        this.rewrites++
        this.aofHead = Math.max(2, Math.round(this.aofHead * 0.25))
        this.aofBytes = Math.round(this.aofBytes * 0.25)
        this.layoutAof()
        this.pulseAgent(this.rewriteDrone)
    }

    /* --------------------------------- agents -------------------------------- */

    pulseAgent(g: THREE.Group) {
        const s = g.scale.x
        void this.ticker.add(0.6, (k) => {
            const f = 1 + 0.35 * Math.sin(k * Math.PI)
            g.scale.setScalar(s * f)
        })
    }

    bgsave(): void {
        this.saves++
        this.pulseAgent(this.bgsaveDrone)
        // the child walks the keyspace and writes it as one dense blob
        this.keys.forEach((key) => {
            if (!key.live) return
            key.heat = 1
        })
        const mat = this.disk.material as THREE.MeshStandardMaterial
        mat.emissiveIntensity = 1.2
        void this.ticker.add(1.4, (k) => {
            mat.emissiveIntensity = 1.2 - 1.06 * k
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
            // the strip drains on fsync, so what is still in it is what is not
            // durable yet
            if (this.aofBuffered > 0) {
                this.aofBuffered = Math.max(0, this.aofBuffered - dt * 0.18)
            }
            this.aofBufMats.forEach((mat, i) => {
                const live = i <= this.bufferCubeIndex() ? this.aofBuffered : 0
                mat.emissiveIntensity +=
                    (0.5 + live * 0.6 - mat.emissiveIntensity) * Math.min(1, dt * 5)
            })
            // keep the world anchor on the strip: views and the camera aim at it
            REDIS_ANCHOR.aofBuf.copy(g.position).add(REDIS_ORIGIN)
        }

        // agents drift in place, the way the autovacuum drone does
        this.bgsaveDrone.position.y = 8.3 + Math.sin(time * 0.9) * 0.12
        this.rewriteDrone.position.y = 2.1 + Math.sin(time * 0.7 + 1.2) * 0.1
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
