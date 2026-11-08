import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { BACKEND_ORIGIN, BACKEND_SLOTS, PALETTE } from './instance'
import type { Info } from './instance'
import {
    OutlineBox,
    Ticker,
    breathe,
    floorLabel,
    halo,
    label,
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

/** Identical plate: same footprint as the block field, same lattice. */
const PLATE = { w: 24, d: 8.5, cz: 3.25, top: 0.09 }

const PITCH = 0.5
const BLOCK = { w: 0.46, h: 0.28, d: 0.46 }
const PAGE_Y = 0.25
const BLOCK_TOP = PAGE_Y + BLOCK.h / 2
const FLOOR_LABEL_Y = 0.1

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
    private aofBlade!: THREE.Mesh
    private aofBufCells: THREE.Mesh[] = []

    private queueCells: THREE.Mesh[] = []
    private loopCore!: THREE.MeshStandardMaterial
    private loopRing!: THREE.Mesh
    private bgsaveDrone!: THREE.Group
    private rewriteDrone!: THREE.Group

    private markGeo = new THREE.TorusGeometry(0.34, 0.025, 4, 28)
    private markMat = new THREE.MeshBasicMaterial({
        color: PALETTE.amber,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    })

    private tmpColor = new THREE.Color()
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
        const plate = new THREE.Mesh(
            new RoundedBoxGeometry(PLATE.w, 0.04, PLATE.d, 2, 0.02),
            new THREE.MeshStandardMaterial({
                color: 0x060a0f,
                emissive: 0x081820,
                emissiveIntensity: 0.8,
                roughness: 0.92,
                metalness: 0.2,
            }),
        )
        plate.position.set(0, 0.06, PLATE.cz)
        plate.receiveShadow = true
        this.group.add(plate)

        const plateEdge = new OutlineBox(PLATE.w, 0.04, PLATE.d, 0x2f9fbf, 0.55).centre(
            0,
            0.06,
            PLATE.cz,
        )
        this.group.add(plateEdge)

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
                    const fill = onAof ? 0.55 + 0.4 * ((c - AOF_C0) / AOF_LEN) : 0.96
                    this.tmpObj.scale.set(1, 0.45 + 0.55 * fill, 1)
                } else {
                    // no page here: collapse it so the plate and the slot lattice show
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

        // slot lattice across the free space — the same "room to grow" texture the
        // postgres disk uses for its untouched tail
        const slotPts: number[] = []
        const fx0 = xAt(0) - PITCH / 2
        const fx1 = xAt(COLS - 1) + PITCH / 2
        const fz0 = zAt(0) - PITCH / 2
        const fz1 = zAt(ROWS - 1) + PITCH / 2
        for (let x = fx0; x <= fx1 + 0.001; x += PITCH) slotPts.push(x, PAGE_Y - 0.12, fz0, x, PAGE_Y - 0.12, fz1)
        for (let z = fz0; z <= fz1 + 0.001; z += PITCH) slotPts.push(fx0, PAGE_Y - 0.12, z, fx1, PAGE_Y - 0.12, z)
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

        // the write head of the AOF: it only ever moves forward until a rewrite
        this.aofBlade = new THREE.Mesh(
            new THREE.BoxGeometry(0.05, 0.75, 0.9),
            new THREE.MeshBasicMaterial({
                color: PALETTE.amber,
                transparent: true,
                opacity: 0.9,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
            }),
        )
        this.group.add(this.aofBlade)

        // floor labels, painted on the same ground as the postgres ones
        const diskLab = floorLabel('DISK', { height: 0.475, color: 'rgba(170, 220, 242, 0.9)' })
        diskLab.rotation.z = Math.PI / 2
        const ink = diskLab.userData.ink as { x0: number; x1: number; y0: number; y1: number }
        diskLab.position.set(PLATE.w / 2 + ink.y1, FLOOR_LABEL_Y, PLATE.cz + PLATE.d / 2 + ink.x0)
        this.group.add(diskLab)

        const aofLab = floorLabel('AOF', { height: 0.42, color: 'rgba(255, 190, 110, 0.9)' })
        aofLab.position.set(xAt(AOF_C0) + 0.4, FLOOR_LABEL_Y, zAt(AOF_ROW) - 0.85)
        this.group.add(aofLab)

        const rdbLab = floorLabel('BASE · RDB', { height: 0.42, color: 'rgba(150, 240, 220, 0.9)' })
        rdbLab.position.set(RDB_CENTRE.x, FLOOR_LABEL_Y, zAt(RDB.r1) + 0.75)
        this.group.add(rdbLab)

        const freeLab = floorLabel('FREE SPACE · ALLOCATABLE', {
            height: 0.34,
            color: 'rgba(120, 170, 190, 0.75)',
            opacity: 0.8,
        })
        freeLab.position.set(xAt(28), FLOOR_LABEL_Y, zAt(6))
        this.group.add(freeLab)

        this.register(
            plateEdge,
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
        const bufGeo = new RoundedBoxGeometry(0.3, 0.3, 0.3, 2, 0.03)
        const bufMat = new THREE.MeshStandardMaterial({
            color: 0x1a1206,
            emissive: PALETTE.amber,
            emissiveIntensity: 1.5,
            roughness: 0.35,
            metalness: 0.35,
        })
        const bufGroup = new THREE.Group()
        this.group.add(bufGroup)
        for (let n = 0; n < AOF_BUF_CELLS; n++) {
            const cube = new THREE.Mesh(bufGeo, bufMat)
            cube.position.set(xAt(AOF_C0 + 2) + n * 0.42, 1.35, zAt(AOF_ROW) + 0.1)
            cube.visible = n < 2
            bufGroup.add(cube)
            this.aofBufCells.push(cube)
        }
        const bufEdge = new OutlineBox(AOF_BUF_CELLS * 0.42 + 0.2, 0.42, 0.5, PALETTE.amber, 0.35)
            .centre(xAt(AOF_C0 + 2) + ((AOF_BUF_CELLS - 1) * 0.42) / 2, 1.35, zAt(AOF_ROW) + 0.1)
        this.group.add(bufEdge)
        this.register(
            bufEdge,
            {
                title: 'AOF buffer — bytes not yet on disk',
                body: 'Write commands are appended here first, in memory, and fsynced to the AOF file according to appendfsync: everysec (the default) loses up to a second, always loses nothing but pays a flush per write, no quietly hands durability to the kernel. Same idea as wal_buffers in postgres, one fsync policy instead of a WAL writer.',
                meta: 'aof_buf · appendfsync everysec by default',
            },
        )
        const bufLab = label('AOF BUFFER')
        bufLab.position.set(xAt(AOF_C0 + 2) - 0.2, 1.95, zAt(AOF_ROW) + 0.1)
        this.group.add(bufLab)
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
            new THREE.Vector3(8.4, 2.1, zAt(AOF_ROW) - 0.1),
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

    get aofUsed() {
        return this.aofOrder.length
    }

    /** Append one write: advance the head, light the block, return its top face. */
    appendAof(bytes: number): THREE.Vector3 {
        this.aofBytes += bytes
        const i = this.aofOrder[Math.min(this.aofHead, this.aofOrder.length - 1)]
        const block = new THREE.Vector3()
        this.disk.getMatrixAt(i, this.tmpObj.matrix)
        block.setFromMatrixPosition(this.tmpObj.matrix)

        this.diskBoost.set(i, 1)
        this.disk.setColorAt(i, this.tmpColor.setHex(PALETTE.amber))
        if (this.disk.instanceColor) this.disk.instanceColor.needsUpdate = true

        this.aofBlade.position.set(block.x + 0.3, PAGE_Y + 0.4, block.z)
        this.aofBufCells.forEach((c, n) => (c.visible = n < Math.min(AOF_BUF_CELLS, 1 + (this.aofHead % 3))))

        this.aofHead += 1
        if (this.aofHead >= this.aofOrder.length) {
            // the run is full: a rewrite is what reclaims it, not a wrap
            this.aofHead = this.aofOrder.length - 1
        }
        return block.clone().add(new THREE.Vector3(0, BLOCK.h / 2, 0))
    }

    aofHeadTop(): THREE.Vector3 {
        const i = this.aofOrder[Math.min(this.aofHead, this.aofOrder.length - 1)]
        this.disk.getMatrixAt(i, this.tmpObj.matrix)
        const p = new THREE.Vector3().setFromMatrixPosition(this.tmpObj.matrix)
        return p.add(new THREE.Vector3(0, BLOCK.h / 2, 0))
    }

    aofBufferTop(): THREE.Vector3 {
        return this.aofBufCells[0].position.clone().add(new THREE.Vector3(0, 0.2, 0))
    }

    rdbCentre(): THREE.Vector3 {
        return RDB_CENTRE.clone()
    }

    /** Rewrite: the log goes back to the few records that describe the state. */
    rewriteAof() {
        this.rewrites++
        const old = this.aofHead
        this.aofHead = Math.max(2, Math.round(old * 0.25))
        this.aofBlade.position.x = xAt(AOF_C0 + this.aofHead) + 0.3
        this.aofBytes = Math.round(this.aofBytes * 0.25)
        this.aofOrder.forEach((i, n) => {
            const on = n <= this.aofHead
            this.disk.getMatrixAt(i, this.tmpObj.matrix)
            const p = new THREE.Vector3().setFromMatrixPosition(this.tmpObj.matrix)
            this.tmpObj.position.copy(p)
            this.tmpObj.scale.set(1, on ? 0.45 + 0.55 * 0.9 : 0.001, 1)
            this.tmpObj.updateMatrix()
            this.disk.setMatrixAt(i, this.tmpObj.matrix)
            this.disk.setColorAt(i, this.tmpColor.setHex(on ? mixHex(0x8a5c10, PALETTE.amber, 0.78) : 0x000000))
        })
        this.disk.instanceMatrix.needsUpdate = true
        if (this.disk.instanceColor) this.disk.instanceColor.needsUpdate = true
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
                const next = v - dt * 1.6
                if (next <= 0) {
                    this.diskBoost.delete(i)
                    this.disk.setColorAt(i, this.tmpColor.setHex(this.diskBase[i] || 0x000000))
                } else {
                    this.diskBoost.set(i, next)
                }
                dirty = true
            }
            if (dirty && this.disk.instanceColor) this.disk.instanceColor.needsUpdate = true
        }

        // the write head shimmers so the append point is findable at a glance
        const bladeMat = this.aofBlade.material as THREE.MeshBasicMaterial
        bladeMat.opacity = 0.65 + 0.3 * breathe(time, 3.4)

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
