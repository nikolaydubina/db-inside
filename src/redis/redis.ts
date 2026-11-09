import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { BACKEND_ORIGIN, BACKEND_SLOTS, BLOCK_PICK_RANGE, PALETTE } from '../postgresql/instance'
import type { Info } from '../postgresql/instance'
import { BigValues, BIG_SPOT } from './values'
import type { BigKind } from './values'
import { verifyDisk } from './verify'
import { DictTable } from './dict'
import { auxBlocks, encodingOf, mixHex, rebaseAnchors } from './types'
import { BIG_REAL, REDIS_ANCHOR } from './types'
import type { KeyKind, RedisKey, RedisPort } from './types'
export { BIG_SPOT }
export type { BigKind }
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
    fmtBytes,
    halo,
    label,
    neonEdges,
    pulseHex,
    radialTexture,
    rand,
    randInt,
    registerLineMaterial,
    setLabelEnabled,
    slotLattice,
} from '../core/util'
import {
    CELL,
    CHANNEL,
    FIELD,
    KEY,
    LOOP,
    PITCH,
    RDB,
    SHELL,
    BLOCK,
    checkInvariants,
    AGENT_SPEED,
    AOF_BUF_CELLS,
    AOF_BUF_Y,
    AOF_C0,
    AOF_FILL_BRIGHT,
    AOF_FILL_DARK,
    AOF_RECORD_TIME,
    AOF_ROW,
    AOF_SEED,
    BLOCK_BYTES,
    BLOCK_TOP,
    COLS,
    DICT,
    DISK_LABEL_PAD,
    EPOLL,
    FLOOR_LABEL_Y,
    HEAP,
    HEAP_OCCUPANCY,
    HEAP_PAGE,
    KEYS,
    KIND_COLOR,
    PAGE_Y,
    QUEUE,
    QUEUE_EMPTY,
    QUEUE_HEAD,
    RDB_BLOCK_TIME,
    RDB_CENTRE,
    RDB_FILL_BRIGHT,
    RDB_FILL_DARK,
    REDIS_ORIGIN,
    ROWS,
    STAGING_ROW,
    VALUE_BYTES,
    dictX,
    dictZ,
    encodingLimit,
    heapOccupancyMask,
    heapX,
    heapZ,
    xAt,
    zAt,
} from './layout'
export * from './layout'
export type { KeyKind, RedisKey, RedisPort } from './types'
export { BIG_REAL, REDIS_ANCHOR } from './types'

const OBJECT_PAD = 0.06
const OBJECT_ACROSS = 1.0

export class RedisInstance {
    readonly group = new THREE.Group()
    readonly pickables: THREE.Object3D[] = []

    readonly keys: RedisKey[] = []
    readonly ports: RedisPort[] = []

    readonly blockGeo = new RoundedBoxGeometry(BLOCK.w, BLOCK.h, BLOCK.d, 1, 0.02)
    readonly keyGeo = new RoundedBoxGeometry(KEY.w, KEY.h, KEY.d, 1, 0.012)

    private disk!: THREE.InstancedMesh
    private dictMesh!: THREE.InstancedMesh

    private heapMesh!: THREE.InstancedMesh

    private heapMask?: Uint8Array

    private heapPages: number[] = []
    private keysMesh!: THREE.InstancedMesh

    private pageGhost: THREE.Mesh | null = null
    private ghostPage: number | null = null

    private showcasePage: number = 0

    private inlineKey: RedisKey | null = null

    private rawKey: RedisKey | null = null

    private objectCage: THREE.Group | null = null

    private objectRow: Record<'inline' | 'pointer', THREE.Group> | null = null

    private objectArea: Record<'inline' | 'pointer', THREE.Box3> | null = null

    private objectOutline: Record<'inline' | 'pointer', THREE.Object3D | null> | null = null

    private objectHeaderMat: THREE.MeshStandardMaterial | null = null
    private objectPayloadMat: THREE.MeshStandardMaterial | null = null

    private objectHome = new THREE.Vector3()
    private objectStop = new THREE.Vector3()

    private auxMesh!: THREE.InstancedMesh

    private auxAnim = new Map<number, number>()

    private hotKeys: RedisKey[] = []

    private bigKeys: Partial<Record<BigKind, RedisKey>> = {}

    private readonly values: BigValues

    private diskBoost = new Map<number, { v: number; hex: number }>()

    private readonly dict = new DictTable()

    private dictShade: number[] = []
    private dictTableLab!: CSS2DObject

    private pointerWeb?: LineSegments2

    private rehashTimer = 0.6

    private aofOrder: number[] = []

    private aofIndex = new Map<number, number>()

    private aofHead = 0
    private aofDrawn = 0

    aofFull = false
    private aofEdge!: OutlineBox
    private aofPick!: THREE.Mesh

    private stagingLab!: CSS2DObject

    private rdbOrder: number[] = []

    private rdbIndex = new Map<number, number>()

    private rdbLen = 0
    private rdbTail = 1

    private rdbBlocks: number[][] = []

    private rdbEdge!: OutlineBox

    private rdbPick!: THREE.Mesh

    private rdbBase: number[] = []

    savingRdb = false
    loading = false

    get dataset(): boolean[] {
        return this.keys.map((k) => k.live)
    }

    private aofBufGroup!: THREE.Group
    private aofBufCells: THREE.Mesh[] = []
    private aofBufMats: THREE.MeshStandardMaterial[] = []

    private aofBuffered = 0

    private aofPending = 0
    private aofPendingBytes = 0

    private queueCells: THREE.Mesh[] = []
    private queueMats: THREE.MeshStandardMaterial[] = []

    private queueDepth = 0

    private fdMats: THREE.MeshStandardMaterial[] = []
    private fdPulse: number[] = []
    private loopCore!: THREE.MeshStandardMaterial
    private loopRing!: THREE.Mesh

    private channelRing!: THREE.Mesh
    private channelPulse = 0
    private bgsaveDrone!: THREE.Group
    private rewriteDrone!: THREE.Group

    private readonly rdbHome = new THREE.Vector3(RDB_CENTRE.x, 1.45, RDB_CENTRE.z)
    private readonly rdbIdle = new THREE.Vector3()

    private readonly rdbAim = new THREE.Vector3().copy(this.rdbHome)

    private readonly rewriteHome = new THREE.Vector3(xAt(AOF_C0 + 4), AOF_BUF_Y + 0.9, zAt(AOF_ROW))

    private readonly rewriteAim = new THREE.Vector3().copy(this.rewriteHome)
    private readonly rewriteIdle = new THREE.Vector3()
    private readonly rewriteStep = new THREE.Vector3()

    rewriting = false

    private tmpColor = new THREE.Color()
    private pulseColor = new THREE.Color()
    private tmpObj = new THREE.Object3D()
    private tmpBox = new THREE.Box3()

    private motes!: THREE.Points

    evictions = 0
    saves = 0
    aofBytes = 0
    rdbBytes = 0
    rewrites = 0

    constructor(private ticker: Ticker) {
        this.values = new BigValues({
            group: this.group,
            frame: (centre, size, colour, opts) => this.frame(centre, size, colour, opts),
            addPick: (pick) => {
                this.pickables.push(pick)
            },
            keyInfo: (i) => this.keyInfo(i),
            bigKeys: this.bigKeys,
        })
        this.group.position.copy(REDIS_ORIGIN)
        this.buildShell()
        this.buildDisk()
        this.buildMemory()
        this.buildPorts()
        this.buildPubSub()
        this.buildPipeline()
        this.buildInlineObject()
        this.buildReadiness()
        this.values.build(this.keys, this.hotKeys)
        this.buildAgents()

        this.writeRdbNow()

        this.openPort()
        this.openPort()
        this.openPort()
        this.openPort()

        if (checkInvariants) this.assertFrames()
    }

    private register(obj: THREE.Object3D, info: Info, outline?: OutlineBox) {
        obj.userData.info = info
        if (outline) obj.userData.outline = outline
        this.pickables.push(obj)
        return obj
    }

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

        pick.userData.outline = cage

        pick.userData.framed = true
        return { cage, pick, box: new THREE.Box3().setFromCenterAndSize(centre, size) }
    }

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

        const inset = 0.45
        const sticker = floorLabel('REDIS', { height: 0.475, color: 'rgba(170, 220, 242, 0.9)' })
        const ink = sticker.userData.ink as { x0: number; x1: number; y0: number; y1: number }
        sticker.rotation.set(0, Math.PI / 2, 0)
        sticker.position.set(
            SHELL.w / 2 + 0.012,
            SHELL.h - inset - ink.y1,
            SHELL.d / 2 - inset + ink.x0,
        )
        ;(sticker.material as THREE.MeshBasicMaterial).side = THREE.FrontSide
        this.group.add(sticker)

        this.motes = dustField(SHELL.w, SHELL.h, SHELL.d)
        this.group.add(this.motes)
    }

    private buildDisk() {
        const platePick = new THREE.Mesh(
            new THREE.BoxGeometry(FIELD.w, 0.3, FIELD.d),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        platePick.position.set(0, 0.15, FIELD.cz)
        this.group.add(platePick)

        const mat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
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
                this.tmpObj.scale.setScalar(0.001)
                this.tmpObj.updateMatrix()
                field.setMatrixAt(i, this.tmpObj.matrix)
                if (onRdb) {
                    this.rdbBase[i] = mixHex(RDB_FILL_DARK, RDB_FILL_BRIGHT, rand(0.94, 1.04))
                }
                i++
            }
        }
        if (field.instanceColor) field.instanceColor.needsUpdate = true

        this.aofOrder = []
        this.aofIndex.clear()
        let leftToRight = true
        for (let r = AOF_ROW; r >= 0; r--) {
            const cols: number[] = []
            for (let c = 0; c < COLS; c++) {
                if (r === AOF_ROW && c < AOF_C0) continue
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

        this.aofHead = AOF_SEED
        this.aofBytes = this.aofUsed * BLOCK_BYTES

        this.rdbOrder = []
        for (let r = RDB.r0; r <= RDB.r1; r++) {
            const cols: number[] = []
            for (let c = RDB.c0; c <= RDB.c1; c++) cols.push(c)
            if ((r - RDB.r0) % 2 === 1) cols.reverse()
            for (const c of cols) {
                const id = r * COLS + c
                this.rdbIndex.set(id, this.rdbOrder.length)
                this.rdbOrder.push(id)
            }
        }

        const ax0 = xAt(AOF_C0) - CELL / 2
        const ax1 = xAt(AOF_C0 + AOF_SEED) + CELL / 2
        const az0 = zAt(AOF_ROW) - CELL / 2
        const az1 = zAt(AOF_ROW) + CELL / 2
        const aofEdge = new OutlineBox(ax1 - ax0, CELL, az1 - az0, PALETTE.amber, 0.75).centre(
            (ax0 + ax1) / 2,
            PAGE_Y,
            (az0 + az1) / 2,
        )
        this.group.add(aofEdge)
        this.aofEdge = aofEdge

        const aofPick = new THREE.Mesh(
            new THREE.BoxGeometry(1, 1.4, 1),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        aofPick.position.set((ax0 + ax1) / 2, PAGE_Y + 0.5, (az0 + az1) / 2)
        this.group.add(aofPick)
        this.aofPick = aofPick
        this.register(
            aofPick,
            {
                title: 'Append-Only File (AOF)',
                body: 'This is a log of commands, not a copy of the data: every write appends its bytes after the last byte of the file, so the only unit here is the 4 KiB block a filesystem stores it in. The file therefore GROWS — the blocks in front of the head are empty floor it takes as it needs them, and it keeps taking them for as long as writes arrive. It never wraps and never drops: wrapping over old data is what the WAL does next door, with a checkpoint deciding when a segment is free, and there is no such decision here. The only thing that makes this file shorter is a rewrite, which writes a new file containing the minimum commands that reproduce the current dataset and swaps it in. If nothing rewrites it and the floor fills, the disk is full and the appends start failing: redis then rejects the writes and keeps serving reads — the opposite of throwing bytes away quietly.',
                meta: 'appendonlydir · one growing file · shortened only by bgrewriteaof',
                stats: () => {
                    const blocks = this.aofUsed
                    const total = blocks * BLOCK_BYTES
                    const fill = total > 0 ? Math.min(1, this.aofBytes / total) : 0
                    return [
                        { label: 'blocks', value: `${blocks} × 4 KiB` },
                        { label: 'total', value: fmtBytes(total) },
                        { label: 'file length', value: fmtBytes(this.aofBytes) },
                        { label: 'filled', value: `${Math.round(fill * 100)}%` },
                        {
                            label: 'pending',
                            value: `${this.aofPending} rec · ${fmtBytes(this.aofPendingBytes)}`,
                        },
                    ]
                },
            },
            aofEdge,
        )

        this.layoutAof()

        const stagingLab = label('AOF REWRITE · new file')
        stagingLab.position.set(xAt(AOF_C0) + 0.2, 1.1, zAt(STAGING_ROW) - 0.45)
        setLabelEnabled(stagingLab, false)
        this.group.add(stagingLab)
        this.stagingLab = stagingLab

        const rdbW = (RDB.c1 - RDB.c0 + 1) * CELL
        const rdbD = (RDB.r1 - RDB.r0 + 1) * CELL
        const rdbEdge = new OutlineBox(rdbW, CELL, rdbD, PALETTE.teal, 0.7).centre(
            RDB_CENTRE.x,
            PAGE_Y,
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
                title: 'RDB — the base file',
                body: 'This is a dump, not a log: the keyspace is walked once and every key and value is written out as it stands, so loading it rebuilds the data structures rather than replaying commands. That is why it loads fast, why it only knows about the instant it was taken, and why everything after it comes from the AOF. It is written by the forked child (bgsave) and read back at start-up before the log is replayed on top. Its blocks are the same 4 KiB the filesystem always hands out, packed tight with no gaps — the file is written fresh every time, so unlike a table file it has no holes to defragment. What varies is its length: that is the size of your data. Writes cost memory, not time: the child needs a copy-on-write view of the whole dataset, so a big instance briefly needs close to twice its size to save.',
                meta: 'dump.rdb · state, not history · written by bgsave, read on start',
                stats: () => {
                    const blocks = this.rdbLen
                    const total = blocks * BLOCK_BYTES
                    const fill = total > 0 ? Math.min(1, this.rdbBytes / total) : 0
                    const keys = this.rdbBlocks.slice(0, blocks).reduce((n, b) => n + b.length, 0)
                    return [
                        { label: 'blocks', value: `${blocks} × 4 KiB` },
                        { label: 'total', value: fmtBytes(total) },
                        { label: 'file length', value: fmtBytes(this.rdbBytes) },
                        { label: 'filled', value: `${Math.round(fill * 100)}%` },
                        { label: 'keys', value: String(keys) },
                    ]
                },
            },
            rdbEdge,
        )

        this.group.add(
            slotLattice(
                xAt(0) - CELL / 2,
                xAt(COLS - 1) + CELL / 2,
                zAt(0) - CELL / 2,
                zAt(ROWS - 1) + CELL / 2,
                CELL,
                CELL,
            ),
        )

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
        freeLab.position.set(xAt(56), FLOOR_LABEL_Y, zAt(12))
        this.group.add(freeLab)

        this.register(platePick, {
            title: 'Disk — persistence only',
            body: 'The dataset is not on this floor. Two files are: the incremental AOF at the front edge, where every write command is appended, and the base RDB dump on the left — a compact copy produced by forking the server. Everything else is free space the files could grow into. Kill the process and whatever is only in RAM is gone; these two files are what comes back. A block here is all-or-nothing: a filesystem gives out 4 KiB at a time, so if a block is in the file at all it is a full block, and it is drawn at the bright end of the scale. The only exception is the last block of a file, which holds whatever the length left over — that one is shorter and dimmer, and that is the only place where "how full" varies.',
            meta: 'appendonlydir · base rdb + incr aof · the rest is unused',
            stats: () => {
                const cells = COLS * ROWS
                const total = cells * BLOCK_BYTES
                const usedCells = this.aofUsed + this.rdbLen
                const usedBytes = this.aofBytes + this.rdbBytes
                return [
                    { label: 'cells', value: `${cells} × 4 KiB` },
                    { label: 'total', value: fmtBytes(total) },
                    { label: 'files', value: `${usedCells} cells · ${fmtBytes(usedBytes)}` },
                    { label: 'free', value: fmtBytes(Math.max(0, total - usedBytes)) },
                ]
            },
        })
    }

    private buildMemory() {
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
        this.paintDict()

        const dW = DICT.cols * PITCH
        const dD = DICT.rows * PITCH
        const dictPick = new THREE.Mesh(
            new THREE.BoxGeometry(dW, 0.6, dD),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        dictPick.position.set(0, DICT.y, DICT.cz)
        this.group.add(dictPick)
        this.register(dictPick, {
            title: 'Hash table — the bucket array, and the rehash',
            body: 'The dictionary is what makes Redis O(1): hash the key, land on a bucket, follow its chain. This plane is the bucket array itself, sitting in the process heap — one contiguous allocation of pointers, and each of those pointers leads to a key entry floating in the plane above. A bucket is one pointer — 8 B on a 64-bit build — so the array costs capacity × 8 B; the keys and their dictEntry chains are the separate allocations above. Measured against the data this is nothing: the whole array is 1 KiB, so the 412 MiB hash at the back of the cage is about 420,000 arrays of this size. Each tile here is a bucket and nothing else, and the faint line leaving it is the pointer — the bytes are always at the far end. The two 16×8 halves are the two tables: 32 buckets is 16×2, 64 is 16×4, 128 is 16×8. There is no index to choose and no planner to consult — the data structure is the query plan. It also GROWS: when the entries outnumber the buckets, redis allocates a second table at twice the size and migrates buckets into it one at a time — the tiles vanishing on one half and lighting up on the other. Both tables are live meanwhile, and every lookup checks both, which is why the growth is incremental: a stop-the-world rehash of a million keys would be a latency spike, and a billion-key one would be a stall you could not hide. The two halves during a rehash are literal: there really are two tables allocated at once.',
            meta: 'dict · ht_table[2] · 8 B per bucket · incremental rehash',
            stats: () => this.dictStats(),
        })
        const dictLab = label('DICT · BUCKETS')
        dictLab.position.set(-dW / 2 - 0.3, DICT.y + 0.55, DICT.cz - dD / 2)
        this.group.add(dictLab)
        const tableLab = label('')
        tableLab.position.set(-dW / 2 - 0.3, DICT.y + 0.22, DICT.cz - dD / 2)
        this.group.add(tableLab)
        this.dictTableLab = tableLab
        this.paintDict()

        const pageCount = HEAP.cols * HEAP.rows
        this.heapMask = heapOccupancyMask(pageCount, HEAP_OCCUPANCY)
        this.heapPages = []
        for (let p = 0; p < pageCount; p++) if (this.heapMask[p] === 1) this.heapPages.push(p)
        const heapGeo = new RoundedBoxGeometry(HEAP_PAGE, HEAP_PAGE, HEAP_PAGE, 1, 0.01)
        const heapMat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            emissive: PALETTE.cyan,
            emissiveIntensity: 0.05,
            roughness: 0.5,
            metalness: 0.3,
        })
        const heap = new THREE.InstancedMesh(heapGeo, heapMat, pageCount)
        heap.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        for (let r = 0; r < HEAP.rows; r++) {
            for (let c = 0; c < HEAP.cols; c++) {
                const id = r * HEAP.cols + c
                this.tmpObj.position.set(heapX(c), HEAP.y, heapZ(r))
                this.tmpObj.scale.setScalar(1)
                this.tmpObj.updateMatrix()
                heap.setMatrixAt(id, this.tmpObj.matrix)
            }
        }
        this.group.add(heap)
        this.heapMesh = heap
        heap.userData.infoFor = (hit: THREE.Intersection) => this.heapPageInfo(hit)
        this.pickables.push(heap)

        const ghostGeo = new THREE.BoxGeometry(HEAP_PAGE * 1.04, HEAP_PAGE * 1.04, HEAP_PAGE * 1.04)
        const ghost = new THREE.Mesh(
            ghostGeo,
            new THREE.MeshStandardMaterial({
                color: 0x0a2f38,
                emissive: PALETTE.ice,
                emissiveIntensity: 0.3,
                transparent: true,
                opacity: 0.14,
                depthWrite: false,
            }),
        )
        ghost.add(
            new THREE.LineSegments(
                new THREE.EdgesGeometry(ghostGeo),
                new THREE.LineBasicMaterial({
                    color: PALETTE.ice,
                    transparent: true,
                    opacity: 0.5,
                }),
            ),
        )
        ghost.visible = false
        ghost.renderOrder = 2
        this.group.add(ghost)
        this.pageGhost = ghost

        const kMat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            emissive: PALETTE.cyan,
            emissiveIntensity: 0.16,
            roughness: 0.45,
            metalness: 0.3,
        })
        const keys = new THREE.InstancedMesh(this.keyGeo, kMat, KEYS.cols * KEYS.rows)
        keys.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        this.keysMesh = keys

        const aux = new THREE.InstancedMesh(this.keyGeo, kMat, KEYS.cols * KEYS.rows * 2)
        aux.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        this.auxMesh = aux

        i = 0
        for (let r = 0; r < KEYS.rows; r++) {
            for (let c = 0; c < KEYS.cols; c++) {
                const page = this.heapPages[i % this.heapPages.length]
                const home = new THREE.Vector3(
                    heapX(page % HEAP.cols),
                    HEAP.y,
                    heapZ(Math.floor(page / HEAP.cols)),
                )
                const live = Math.random() < 0.74
                const kinds: KeyKind[] = [
                    'string',
                    'string',
                    'string',
                    'hash',
                    'list',
                    'set',
                    'zset',
                ]
                const kind = kinds[randInt(0, kinds.length - 1)]
                const size = VALUE_BYTES[kind]
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
                    page,
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
        this.paintAux()

        for (const kind of ['hash', 'zset', 'list'] as BigKind[]) {
            const key = this.keys.find((k) => k.live && !k.big && k.kind === kind)
            if (!key) continue
            const real = BIG_REAL[kind]
            key.big = kind
            key.aux = true
            key.entries = real.entries
            key.bytes = 9000 + randInt(0, 3000)
            this.tmpObj.position.copy(key.home)
            this.tmpObj.scale.setScalar(0.001)
            this.tmpObj.updateMatrix()
            keys.setMatrixAt(key.i, this.tmpObj.matrix)
        }
        keys.instanceMatrix.needsUpdate = true

        this.hotKeys = this.keys
            .filter((k) => k.live && !k.big && k.kind === 'string')
            .filter((_, n) => n % 7 === 0)
            .slice(0, 4)
        for (const key of this.hotKeys) {
            key.hot = true
            key.shade = 1.62
            keys.setColorAt(key.i, this.tmpColor.setHex(this.keyBase(key)))
        }
        if (keys.instanceColor) keys.instanceColor.needsUpdate = true

        const strings = this.keys.filter((k) => k.live && !k.big && !k.hot && k.kind === 'string')
        this.inlineKey = strings[0] ?? null
        this.rawKey = strings.find((k) => k !== this.inlineKey) ?? null
        if (this.inlineKey) {
            this.inlineKey.live = true
            this.inlineKey.bytes = 24
            this.inlineKey.raw = false
        }
        if (this.rawKey) {
            this.rawKey.live = true
            this.rawKey.bytes = 2048
            this.rawKey.raw = true
        }

        this.paintHeap()

        const hW = (HEAP.cols - 1) * CELL + HEAP_PAGE
        const hD = (HEAP.rows - 1) * CELL + HEAP_PAGE
        const heapLab = label('HEAP')
        heapLab.position.set(-hW / 2 - 0.42, HEAP.y + 0.34, HEAP.cz - hD / 2)
        this.group.add(heapLab)

        const webGeo = new LineSegmentsGeometry()
        const webMat = new LineMaterial({
            vertexColors: true,
            linewidth: 0.6,
            transparent: true,
            opacity: 0.16,
            depthWrite: false,
            fog: true,
        })
        registerLineMaterial(webMat, 0.6)
        const web = new LineSegments2(webGeo, webMat)
        web.frustumCulled = false
        web.renderOrder = 1
        this.group.add(web)
        this.pointerWeb = web
        this.rebuildPointerWeb()

        const bufGroup = new THREE.Group()
        this.aofBufGroup = bufGroup
        bufGroup.position.set(this.aofHeadX(), AOF_BUF_Y, zAt(AOF_ROW))
        this.group.add(bufGroup)
        for (let n = 0; n < AOF_BUF_CELLS; n++) {
            const mat = new THREE.MeshStandardMaterial({
                color: 0x0b2a36,
                emissive: PALETTE.cyan,
                emissiveIntensity: 0.5,
                roughness: 0.35,
                metalness: 0.45,
                transparent: true,
                opacity: 0.94,
            })
            const cube = new THREE.Mesh(this.blockGeo, mat)
            cube.position.set((n - (AOF_BUF_CELLS - 1) / 2) * CELL, 0, 0)
            cube.add(neonEdges(this.blockGeo, 0x8fe6ff, 0.55))
            bufGroup.add(cube)
            this.aofBufCells.push(cube)
            this.aofBufMats.push(mat)
        }
        const bufPick = new THREE.Mesh(
            new THREE.BoxGeometry(AOF_BUF_CELLS * CELL, 0.6, BLOCK.d * 1.3),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        bufPick.position.set(0, 0.1, 0)
        bufGroup.add(bufPick)
        this.register(bufPick, {
            title: 'AOF buffer — bytes not yet on disk',
            body: 'Write commands are appended here first, in the process heap, and fsynced to the AOF file according to appendfsync: everysec (the default) loses up to a second, always loses nothing but pays a flush per write, no quietly hands durability to the kernel. Cyan is the point: this is memory, the bytes are not in the file yet, and they only turn amber when they are copied into the blocks below. The handover is a copy, not a move: write(2) hands the bytes to the kernel page cache and the buffer is reused. Compared with wal_buffers the difference is the contract, not the idea: postgres flushes at commit, redis flushes per appendfsync policy.',
            meta: 'aof_buf · in memory · appendfsync everysec by default',
            stats: () => {
                const total = AOF_BUF_CELLS * BLOCK_BYTES
                const fill = Math.max(0, Math.min(1, this.aofBuffered))
                return [
                    { label: 'cubes', value: `${AOF_BUF_CELLS} × 4 KiB` },
                    { label: 'total', value: fmtBytes(total) },
                    {
                        label: 'occupied',
                        value: `${fmtBytes(fill * total)} · ${Math.round(fill * 100)}%`,
                    },
                    {
                        label: 'pending',
                        value: `${this.aofPending} rec · ${fmtBytes(this.aofPendingBytes)}`,
                    },
                ]
            },
        })
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
                meta: 'fd · ~30 KiB · maxclients 10000 · shares the single thread',
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
        this.group.add(ring)
        this.channelRing = ring

        const glow = halo(PALETTE.violet, 1.5, 0.14)
        glow.position.copy(CHANNEL.at)
        this.group.add(glow)

        const lab = label(`CHANNEL · ${CHANNEL.name}`)

        lab.position.copy(CHANNEL.at).add(new THREE.Vector3(0, -0.82, 0))
        this.group.add(lab)

        const pick = new THREE.Mesh(
            new THREE.BoxGeometry(0.92, 0.92, 0.42),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        pick.position.copy(CHANNEL.at)
        this.group.add(pick)
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

    channelPoint(): THREE.Vector3 {
        return CHANNEL.at.clone()
    }

    get channelName() {
        return CHANNEL.name
    }

    pulseChannel() {
        this.channelPulse = 1
    }

    private buildPipeline() {
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

        const loopPick = new THREE.Mesh(
            new THREE.SphereGeometry(0.9, 16, 12),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        loopPick.position.copy(LOOP)
        this.group.add(loopPick)
        this.register(loopPick, {
            title: 'COMMAND LOOP — one thread, every command',
            body: 'This is the whole of redis: one thread in an event loop. epoll, on the plate below, hands it only the sockets that have bytes; it reads and parses what is there into an argv, runs the command against the in-memory dicts, appends a write to aof_buf and queues the reply on that socket\u2019s output buffer \u2014 then goes straight back to waiting. Because exactly one thread ever touches the keyspace, nothing needs a lock and every command is atomic on its own: no client can see a hash half-rehashed or a list read halfway through a push. The price is the queue above. While a command runs nothing else does, so one slow O(n) call \u2014 KEYS *, a huge HGETALL, a long Lua script \u2014 stalls every connection behind it. What redis sells is multiplexing, not parallelism: since 6.0 extra IO threads may read, parse and write, but execution is still this one thread.',
            meta: 'one thread · epoll → read → parse → execute → reply · no locks',
        })
    }

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

        const lab = label('EPOLL · FDS')
        lab.position.set(-setW / 2 - 0.25, EPOLL.y - 0.3, EPOLL.z + 0.45)
        this.group.add(lab)
    }

    private buildInlineObject() {
        const page = this.heapPages[0] ?? 0
        this.showcasePage = page
        const at = new THREE.Vector3(
            heapX(page % HEAP.cols),
            HEAP.y,
            heapZ(Math.floor(page / HEAP.cols)),
        )
        this.objectHome.copy(at).add(new THREE.Vector3(0, HEAP_PAGE * 1.35, 0))
        this.objectStop.copy(this.objectHome)

        const cage = new THREE.Group()
        cage.position.copy(this.objectHome)
        cage.visible = false
        this.group.add(cage)
        this.objectCage = cage

        const pick = new THREE.Mesh(
            new THREE.BoxGeometry(HEAP_PAGE, HEAP_PAGE, HEAP_PAGE),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        pick.position.copy(at)
        pick.userData.noOutline = true
        this.group.add(pick)
        this.register(pick, {
            title: 'Value object — 16 bytes, and sometimes the payload is inside',
            body: 'Every value in this cage is one of these: a fixed header holding the type, the encoding, an lru clock and a refcount — 16 bytes on a 64-bit build — plus a payload. What the encoding decides is where the payload lives. Integer and short-string values keep it in the same allocation: an `int`-encoded value stores the number itself in the header’s pointer field, an `embstr` (up to 44 bytes) is header and bytes in one malloc, and the shared integers 0–9999 are a single global object that every such key points at. Those reads stop here — the entry’s page is the whole story, which is why an ordinary GET of a small value touches no second allocation at all. The lower row is the other case: `raw` strings and converted collections hold an address, and the bytes are a separate allocation on another page. That is the hop the big-value stories draw.',
            meta: 'robj · type + encoding + lru + refcount · int/embstr inline · raw/converted pointer · drawn in the read’s hands, like the big structures',
        })

        const headerMat = new THREE.MeshStandardMaterial({
            color: 0x0b1a24,
            emissive: PALETTE.ice,
            emissiveIntensity: 0.22,
            roughness: 0.4,
            metalness: 0.35,
        })
        const payloadMat = new THREE.MeshStandardMaterial({
            color: 0x0b2a26,
            emissive: PALETTE.teal,
            emissiveIntensity: 0.45,
            roughness: 0.35,
            metalness: 0.3,
        })
        const headerGeo = new THREE.BoxGeometry(0.36, 0.24, 0.32)
        const payloadGeo = new THREE.BoxGeometry(0.3, 0.2, 0.26)

        const rows: Record<'inline' | 'pointer', THREE.Group> = {
            inline: new THREE.Group(),
            pointer: new THREE.Group(),
        }
        for (const [name, inline] of [
            ['inline', true],
            ['pointer', false],
        ] as const) {
            const row = rows[name]
            cage.add(row)
            const header = new THREE.Mesh(headerGeo, headerMat)
            header.position.set(-0.66, 0, 0)
            row.add(header)
            const px = inline ? -0.33 : 0.42
            const payload = new THREE.Mesh(payloadGeo, payloadMat)
            payload.position.set(px, 0, 0)
            row.add(payload)
            if (!inline) {
                const from = -0.66 + headerGeo.parameters.width / 2
                const to = px - payloadGeo.parameters.width / 2
                const link = new THREE.Mesh(
                    new THREE.BoxGeometry(to - from, 0.015, 0.015),
                    new THREE.MeshBasicMaterial({
                        color: PALETTE.ice,
                        transparent: true,
                        opacity: 0.45,
                    }),
                )
                link.position.set((from + to) / 2, 0, 0)
                row.add(link)
            }
        }
        this.objectCage = cage
        this.objectRow = rows
        this.objectHeaderMat = headerMat
        this.objectPayloadMat = payloadMat
        this.objectArea = { inline: new THREE.Box3(), pointer: new THREE.Box3() }
        this.objectOutline = { inline: null, pointer: null }
        for (const name of ['inline', 'pointer'] as const) {
            const box = this.rowArea(rows[name]).expandByScalar(OBJECT_PAD)
            this.objectArea[name] = box
            const size = box.getSize(new THREE.Vector3())
            const centre = box.getCenter(new THREE.Vector3())
            const outline = new OutlineBox(size.x, size.y, size.z, PALETTE.ice, 0.26, {
                dashed: true,
            })
            outline.centre(centre.x, centre.y, centre.z)
            cage.add(outline)
            this.objectOutline[name] = outline
        }
        const BLOCK_SCALE = 0.25
        for (const name of ['inline', 'pointer'] as const) {
            const row = rows[name]
            const centre = this.objectArea[name].getCenter(new THREE.Vector3())
            row.scale.setScalar(BLOCK_SCALE)
            row.position.copy(centre).multiplyScalar(1 - BLOCK_SCALE)
        }
    }

    private rowArea(row: THREE.Group): THREE.Box3 {
        const area = new THREE.Box3()
        row.traverse((o) => {
            const m = o as THREE.Mesh
            if (!m.isMesh) return
            m.geometry.computeBoundingBox()
            const b = m.geometry.boundingBox?.clone()
            if (b) area.union(b.translate(m.position))
        })
        return area.translate(row.position)
    }

    private buildAgents() {
        this.bgsaveDrone = this.makeAgent(this.rdbHome.clone(), PALETTE.teal, 'BGSAVE', {
            title: 'BGSAVE — a forked child writes the dump',
            body: 'The snapshot is taken by forking: the child gets a copy-on-write view of the whole keyspace and writes it to a new RDB file while the parent keeps serving. Nothing is locked, not even for an instant, and the queue keeps draining — watch it while this runs. The cost is memory, not time: every page the parent modifies before the child has written it gets duplicated, so a big instance can briefly need close to twice its dataset. SAVE is the same work without the fork, and that one does stop the server.',
            meta: 'fork() · copy-on-write · no locking, extra memory',
        })
        this.rewriteDrone = this.makeAgent(this.rewriteHome.clone(), PALETTE.amber, 'AOF REWRITE', {
            title: 'AOF rewrite — write the log down to its current state',
            body: 'The AOF records commands, so it grows without bound: a key set a thousand times is a thousand commands. Rewriting walks the keyspace and writes the minimum set of commands that reproduces it, into a new file, then swaps it in. Same idea as a postgres checkpoint letting old WAL be recycled, except here the log itself is rewritten.',
            meta: 'bgrewriteaof · new file, then atomic swap',
        })
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

    private instanceAt(hit: THREE.Intersection, count: number): number | null {
        if (hit.instanceId === undefined || hit.instanceId < 0 || hit.instanceId >= count)
            return null
        return hit.instanceId
    }

    private toWorld(box: THREE.Box3): THREE.Box3 {
        this.group.updateMatrixWorld()
        return box.applyMatrix4(this.group.matrixWorld)
    }

    private diskPick(hit: THREE.Intersection) {
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
                  body:
                      'One 4 KiB block of the dump — a binary serialisation of the keyspace, written in one pass with no padding, so every block but the last is completely full. Because values differ in size, the number of keys that end up in a block does not: this one holds ' +
                      `${this.rdbBlocks[rdbSeq ?? 0]?.length ?? 0}. ` +
                      'The block size never varies, only how much of the file is used.',
                  meta: 'dump.rdb · state, not history · loaded on start',
              }
        return { key: `redis-disk-${i}`, info, box: this.toWorld(box) }
    }

    private heapInfo() {
        const pageCount = HEAP.cols * HEAP.rows
        const hW = (HEAP.cols - 1) * CELL + HEAP_PAGE
        const hD = (HEAP.rows - 1) * CELL + HEAP_PAGE
        const box = new THREE.Box3().setFromCenterAndSize(
            new THREE.Vector3(0, HEAP.y, HEAP.cz),
            new THREE.Vector3(hW, Math.max(BLOCK.h, HEAP_PAGE) + 0.06, hD),
        )
        return {
            key: 'redis-heap',
            info: {
                title: 'Memory — the heap, a volume of its own',
                body: "This is the heap: the RAM the dataset occupies, drawn as its own volume, separate from the dashed keyspace above. It is one contiguous arena of 4 KiB page cubes, and it is drawn at a working occupancy — 80% of its pages in use, the free fifth scattered between them. That is the same convention as the postgres disk: a mostly packed volume with fragmentation, not an empty grid and not a solid slab. The pattern comes from a seeded run-allocator model — pages are handed out in runs and freed runs leave holes — not from a repeating rule; the 80% and the run-and-hole shape are the claim, the exact page indices are a model. The pages are scattered by that history, not packed from the start, and nothing reorders them — the OS does not compact RAM. The dashed keyspace above is the representational view of the same bytes: it is not this volume and does not contain it. The bucket array between them holds pointers; the bytes those pointers lead to are counted here. The three dashed areas at the back are the payloads of the big values; their ~676 MiB is counted in resident but cannot be drawn as pages in this arena. The arena itself is a slice of the process address space, not all of the machine's RAM.",
                meta: `heap · ${pageCount} × 4 KiB · ${fmtBytes(pageCount * 4096)} arena · scattered pages · separate volume`,
                stats: () => {
                    const pageBytes = 4096
                    const arena = pageCount * pageBytes
                    const small = this.keys.filter((k) => k.live && !k.big)
                    const smallBytes = small.reduce((n, k) => n + k.bytes, 0)
                    const bigBytes = (Object.keys(this.bigKeys) as BigKind[]).reduce(
                        (n, k) => n + (this.bigKeys[k]?.live ? BIG_REAL[k].mib * 1024 * 1024 : 0),
                        0,
                    )
                    const inUse = this.heapMask
                        ? this.heapMask.reduce((n, v) => n + (v ? 1 : 0), 0)
                        : 0
                    const pct = Math.round((inUse / pageCount) * 100)
                    return [
                        { label: 'pages', value: `${pageCount} × 4 KiB` },
                        { label: 'arena', value: fmtBytes(arena) },
                        { label: 'in use', value: `${inUse} · ${pct}%` },
                        { label: 'free', value: `${pageCount - inUse} · ${100 - pct}%` },
                        { label: 'dataset', value: fmtBytes(smallBytes) },
                        { label: 'big values', value: `≈ ${fmtBytes(bigBytes)}` },
                        { label: 'resident', value: `≈ ${fmtBytes(smallBytes + bigBytes)}` },
                    ]
                },
            } as Info,
            box: this.toWorld(box),
        }
    }

    private occupyHeapPage() {
        if (!this.heapMask) return
        const pageCount = HEAP.cols * HEAP.rows
        const free: number[] = []
        for (let i = 0; i < pageCount; i++) if (this.heapMask[i] === 0) free.push(i)
        if (free.length === 0) return
        const page = free[randInt(0, free.length - 1)]
        this.heapMask[page] = 1
        this.fadeHeapPage(page, true)
    }

    private releaseHeapPage() {
        if (!this.heapMask) return
        const pageCount = HEAP.cols * HEAP.rows
        const used: number[] = []
        for (let i = 0; i < pageCount; i++) if (this.heapMask[i] === 1) used.push(i)
        if (used.length <= 1) return
        const page = used[randInt(0, used.length - 1)]
        this.heapMask[page] = 0
        this.fadeHeapPage(page, false)
    }

    private fadeHeapPage(page: number, on: boolean) {
        const row = Math.floor(page / HEAP.cols)
        const col = page % HEAP.cols
        const from = on ? 0.001 : 1
        const to = on ? 1 : 0.001
        const hex = on ? mixHex(0x06222c, PALETTE.cyan, 0.82) : mixHex(0x04141c, PALETTE.cyan, 0.07)
        this.heapMesh.setColorAt(page, this.tmpColor.setHex(hex))
        if (this.heapMesh.instanceColor) this.heapMesh.instanceColor.needsUpdate = true
        void this.ticker
            .add(0.32, (k) => {
                const s = from + (to - from) * Math.min(1, k)
                this.tmpObj.position.set(heapX(col), HEAP.y, heapZ(row))
                this.tmpObj.scale.setScalar(Math.max(0.001, s))
                this.tmpObj.updateMatrix()
                this.heapMesh.setMatrixAt(page, this.tmpObj.matrix)
                this.heapMesh.instanceMatrix.needsUpdate = true
            })
            .then(() => this.paintHeap())
    }
    private heapPageInfo(hit: THREE.Intersection) {
        if (hit.distance > BLOCK_PICK_RANGE) return this.heapInfo()
        const pageCount = HEAP.cols * HEAP.rows
        const id = this.instanceAt(hit, pageCount)
        if (id === null) return null
        const used = this.heapMask?.[id] === 1
        const row = Math.floor(id / HEAP.cols)
        const col = id % HEAP.cols
        const box = new THREE.Box3().setFromCenterAndSize(
            new THREE.Vector3(heapX(col), HEAP.y, heapZ(row)),
            new THREE.Vector3(HEAP_PAGE, HEAP_PAGE, HEAP_PAGE),
        )
        const inUse = this.heapMask ? this.heapMask.reduce((n, v) => n + (v ? 1 : 0), 0) : 0
        return {
            key: `redis-heap-${id}`,
            info: {
                title: `heap page #${id} — ${used ? 'in use' : 'free'} · 4 KiB`,
                body: used
                    ? 'One 4 KiB page of the process heap, and it is allocated. The keys and values are allocated on pages like this one: the bucket array holds pointers, the dictEntry holds the key and value pointers, and the bytes at the end of those pointers live in memory of this kind. A page is the operating system unit; jemalloc hands out larger runs and carves them into size classes, so several small objects can share one page, and a large value is spread over many. Nothing about this page is a file and nothing about it is a cache: it is the dataset.'
                    : 'One 4 KiB page of the process heap, and nothing is allocated on it. The arena includes it, but no object lives here — it is free space left where an allocation once was or has never been used. Nothing compacts it into the used region: the OS does not defragment RAM, and the allocator only reuses a page when the next allocation fits.',
                meta: `heap page · 4 KiB · ${used ? 'allocated' : 'free'} · ${inUse}/${pageCount} pages in use`,
            } as Info,
            box: this.toWorld(box),
        }
    }

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

    private bigInfo(key: RedisKey) {
        const kind = key.big as BigKind
        const real = BIG_REAL[kind]
        const body: Record<BigKind, string> = {
            hash: 'A hashtable: one bucket array, and one chain per bucket. This is ONE key — five million fields, hundreds of megabytes — and every one of them is behind that single entry in the dict. That is why HGETALL on it is not a slow query but a stall: the command runs on the one thread, walks all of it, and every other client waits. DEL of this key is the same problem. What is drawn here is the shape and not the count: nine buckets, a few chains; the real array is a few million pointers long and doubles with a rehash.',
            zset: 'A sorted set is TWO structures at once, and this is why: a skiplist for the range queries, and a dict beside it answering "what is the score of this member" in O(1). The tower is the whole trick — each level skips over more of the list, so ZRANGEBYSCORE finds its starting point in a few hops instead of a walk. One and a half million members, one key. The drawing shows five levels and seven nodes; the real tower has the same shape with a few million nodes under it.',
            list: 'A long list is not one array: it is a quicklist, a doubly linked chain of nodes, and each node holds a small listpack. Two million elements, one key. That shape is the reason LPUSH and RPUSH are O(1) while LINDEX in the middle is O(n): the middle is a walk along the chain, through nodes that are not next to each other in memory. The long gap in this chain is where the drawing stops — the real one runs on for tens of thousands of nodes. And the dashed cage itself is a PROJECTION, not an address: the chain is drawn at the back of the cage so its shape can be read, but its nodes are allocated in the heap below, one page each. Following the chain is following those pages; only the elements inside one node sit next to each other.',
        }
        const shape: Record<BigKind, { label: string; value: string }[]> = {
            hash: [
                { label: 'buckets', value: '8,388,608 × 8 B' },
                { label: 'bucket array', value: '64 MiB · contiguous' },
                { label: 'per field', value: '24 B entry + 2 SDS' },
                { label: 'allocations', value: '≈ 15.9 M · scattered' },
            ],
            zset: [
                { label: 'dict buckets', value: '2,097,152 × 8 B' },
                { label: 'dict array', value: '16 MiB · contiguous' },
                { label: 'skiplist', value: '1.4 M nodes · avg 1.33 levels' },
                { label: 'allocations', value: '≈ 4.2 M · scattered' },
            ],
            list: [
                { label: 'nodes', value: '≈ 16,384 listpacks' },
                { label: 'node', value: '≤ 8 KiB · contiguous' },
                { label: 'layout', value: 'doubly linked chain' },
                { label: 'allocations', value: '≈ 16 k · not one buffer' },
            ],
        }
        return {
            key: `redis-key-${key.i}`,
            info: {
                title: `key #${key.i} — ${kind} · ${encodingOf(key)} · a big value`,
                body: body[kind],
                meta: `1 key · ${real.entries.toLocaleString('en-US')} ${real.unit} · ~${real.mib} MiB · drawn as a slice`,
                stats: () => shape[kind],
            } as Info,
            box: this.toWorld(this.bigBox(kind)),
        }
    }

    openPort(): RedisPort | null {
        const pod = this.ports.find((p) => !p.active)
        if (!pod) return null
        pod.active = true
        pod.group.visible = true
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
        this.setSubscribed(pod, false)
        return true
    }

    setSubscribed(pod: RedisPort, on: boolean) {
        if (pod.subs === on) return
        pod.subs = on
        const hex = on ? PALETTE.violet : PALETTE.cyan
        pod.ring.emissive.setHex(hex)
        pod.glow.color.setHex(hex)
    }

    subscribers(): RedisPort[] {
        return this.ports.filter((p) => p.active && p.subs)
    }

    clearSubscribers() {
        for (const pod of this.ports) this.setSubscribed(pod, false)
    }

    pulsePort(pod: RedisPort) {
        pod.pulse = 1
        pod.busy = true
        this.fdPulse[pod.id] = 1
    }

    pulseSend(pod: RedisPort) {
        pod.pulse = 1
        this.fdPulse[pod.id] = 1
    }

    shutPorts() {
        for (const pod of this.ports) {
            pod.active = false
            pod.busy = false
            pod.pulse = 0
            pod.group.visible = false
            this.setSubscribed(pod, false)
        }
    }

    openPorts(n: number) {
        for (let i = 0; i < n; i++) this.openPort()
    }

    portTop(pod: RedisPort): THREE.Vector3 {
        return pod.group.position.clone().add(new THREE.Vector3(0, 0.12, 0))
    }

    queueCellTop(n: number): THREE.Vector3 {
        const cell = this.queueCells[Math.max(0, Math.min(this.queueCells.length - 1, n))]
        return cell.position.clone().add(new THREE.Vector3(0, 0.2, 0))
    }

    queueTop(): THREE.Vector3 {
        return new THREE.Vector3(0, QUEUE.y + 0.3, QUEUE.z)
    }

    loopPoint(): THREE.Vector3 {
        return LOOP.clone()
    }

    pulseLoop() {
        this.loopCore.emissiveIntensity = 3.4
    }

    queuePush(): number {
        this.queueDepth = Math.min(this.queueCells.length, this.queueDepth + 1)
        const n = this.queueDepth - 1
        this.paintQueue(2.4, n)
        return n
    }

    queuePop(): void {
        if (this.queueDepth <= 0) return
        this.queueDepth -= 1
        this.paintQueue(2.0, 0)
    }

    get queueLength() {
        return this.queueDepth
    }

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
                    if (spikeIndex >= this.queueDepth) return
                    mat.emissiveIntensity = base + (spike - base) * (1 - k)
                })
                .then(() => this.paintQueue())
        }
    }

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

    randomLiveSmallKey(): RedisKey | null {
        const live = this.keys.filter((k) => k.live && !k.big)
        if (live.length === 0) return null
        return live[randInt(0, live.length - 1)]
    }

    freeKey(): RedisKey | null {
        return this.keys.find((k) => !k.live) ?? null
    }

    focusPageAt(at: THREE.Vector3 | null) {
        const page = at ? this.pageAtPoint(at) : null
        if (page === this.ghostPage) return
        if (this.ghostPage !== null) this.closeGhost()
        this.ghostPage = page
        this.applyGhost()
    }

    private pageAtPoint(at: THREE.Vector3): number | null {
        if (Math.abs(at.y - HEAP.y) > HEAP_PAGE * 2) return null
        const c = Math.round(at.x / CELL + (HEAP.cols - 1) / 2)
        const r = Math.round((at.z - HEAP.cz) / CELL + (HEAP.rows - 1) / 2)
        if (c < 0 || c >= HEAP.cols || r < 0 || r >= HEAP.rows) return null
        const page = r * HEAP.cols + c
        return this.heapMask?.[page] === 1 ? page : null
    }

    private closeGhost() {
        const page = this.ghostPage
        this.ghostPage = null
        if (page === null) return
        this.paintPage(page)
        if (this.pageGhost) this.pageGhost.visible = false
    }

    private applyGhost() {
        const page = this.ghostPage
        if (page === null || !this.pageGhost) return
        const col = page % HEAP.cols
        const row = Math.floor(page / HEAP.cols)
        const at = new THREE.Vector3(heapX(col), HEAP.y, heapZ(row))
        this.pageGhost.position.copy(at)
        this.pageGhost.visible = true
        this.tmpObj.position.copy(at)
        this.tmpObj.scale.setScalar(0.0001)
        this.tmpObj.rotation.set(0, 0, 0)
        this.tmpObj.updateMatrix()
        this.heapMesh.setMatrixAt(page, this.tmpObj.matrix)
        this.heapMesh.instanceMatrix.needsUpdate = true
    }

    private paintPage(page: number) {
        if (!this.heapMesh) return
        const col = page % HEAP.cols
        const row = Math.floor(page / HEAP.cols)
        const used = this.heapMask?.[page] === 1
        this.tmpObj.position.set(heapX(col), HEAP.y, heapZ(row))
        this.tmpObj.scale.setScalar(used ? 1 : 0.001)
        this.tmpObj.rotation.set(0, 0, 0)
        this.tmpObj.updateMatrix()
        this.heapMesh.setMatrixAt(page, this.tmpObj.matrix)
        this.heapMesh.instanceMatrix.needsUpdate = true
    }

    keyTop(key: RedisKey): THREE.Vector3 {
        if (key.big) {
            const at = BIG_SPOT[key.big]
            return new THREE.Vector3(at.x, at.y + 0.5, at.z)
        }
        return this.keyPageTop(key).add(new THREE.Vector3(0, 0.001, 0))
    }

    keyPageTop(key: RedisKey): THREE.Vector3 {
        const row = Math.floor(key.page / HEAP.cols)
        const col = key.page % HEAP.cols
        return new THREE.Vector3(heapX(col), HEAP.y + HEAP_PAGE / 2 + 0.02, heapZ(row))
    }

    inlinePoint(): THREE.Vector3 {
        const row = Math.floor(this.showcasePage / HEAP.cols)
        const col = this.showcasePage % HEAP.cols
        return new THREE.Vector3(heapX(col), HEAP.y, heapZ(row))
    }

    objectPoint(): THREE.Vector3 {
        return this.objectStop.clone()
    }

    rideObject(packet: THREE.Object3D | null, layout: 'inline' | 'pointer' = 'inline') {
        const g = this.objectCage
        if (!g) return
        if (this.objectRow) {
            this.objectRow.inline.visible = layout === 'inline'
            this.objectRow.pointer.visible = layout === 'pointer'
        }
        if (this.objectOutline) {
            const o = this.objectOutline
            if (o.inline) o.inline.visible = layout === 'inline'
            if (o.pointer) o.pointer.visible = layout === 'pointer'
        }
        if (!packet) {
            this.group.add(g)
            g.position.copy(this.objectHome)
            g.scale.setScalar(1)
            g.visible = false
            return
        }
        g.visible = true
        const area = this.objectArea?.[layout]
        const size = area?.getSize(new THREE.Vector3()) ?? null
        const centre = area?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3()
        const longest = size ? Math.max(size.x, size.y, size.z) : 1
        this.values.carryInto(g, size, centre, packet, OBJECT_ACROSS / (longest || 1))
    }

    lightObject(part: 'none' | 'header' | 'payload') {
        if (this.objectHeaderMat)
            this.objectHeaderMat.emissiveIntensity = part === 'header' ? 2.6 : 0.16
        if (this.objectPayloadMat)
            this.objectPayloadMat.emissiveIntensity = part === 'payload' ? 2.6 : 0.36
    }

    showcasePoint(): THREE.Vector3 {
        return this.inlinePoint()
    }

    compactKeyLeft(): RedisKey | null {
        if (this.inlineKey?.live) return this.inlineKey
        const live = this.keys.filter(
            (k) => k.live && !k.aux && !k.big && !k.raw && k.kind === 'string',
        )
        if (live.length === 0) return null
        const host = live.find((k) => k.page === this.showcasePage)
        if (host) return host
        return live.reduce((a, b) => (b.page % HEAP.cols > a.page % HEAP.cols ? a : b))
    }

    rawKeyLeft(): RedisKey | null {
        if (this.rawKey?.live) return this.rawKey
        return this.keys.find((k) => k.live && k.raw && !k.big) ?? null
    }

    valuePoint(key: RedisKey): THREE.Vector3 {
        if (key.big) {
            return this.keyPageTop(key).add(new THREE.Vector3(0, 0.14, 0))
        }
        if (key.aux) {
            return this.keyPageTop(key).add(new THREE.Vector3(0, 0.045, 0))
        }
        return this.keyTop(key)
    }

    nodePoint(key: RedisKey, n: number): THREE.Vector3 {
        if (!key.big) {
            return this.valuePoint(key).add(new THREE.Vector3(0, 0.05 * (n + 1), 0))
        }
        return this.keyPageTop(key).add(new THREE.Vector3(0, 0.18 + 0.04 * n, -0.06))
    }

    innerDictPoint(key: RedisKey): THREE.Vector3 | null {
        if (key.kind !== 'hash' && key.kind !== 'zset') return null
        if (!key.aux && !key.big) return null
        if (!key.big) return this.valuePoint(key)
        return this.keyPageTop(key).add(new THREE.Vector3(0.1, 0.24, 0.06))
    }

    hopPoint(key: RedisKey, n: number): THREE.Vector3 {
        const used = this.heapPages.length > 0 ? this.heapPages : [0]
        const page = used[(((key.page + 97 * (n + 1)) % used.length) + used.length) % used.length]
        const row = Math.floor(page / HEAP.cols)
        const col = page % HEAP.cols
        return new THREE.Vector3(heapX(col), HEAP.y + HEAP_PAGE / 2 + 0.02, heapZ(row))
    }

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

    private bigBox(kind: BigKind): THREE.Box3 {
        return this.values.box(kind)
    }

    private keyBase(key: RedisKey): number {
        return mixHex(0x06222c, KIND_COLOR[key.kind], 0.55 * key.shade)
    }

    private paintAuxKey(key: RedisKey) {
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

    liveOfKind(kind: KeyKind): RedisKey | null {
        const live = this.keys.filter((k) => k.live && k.kind === kind)
        if (live.length === 0) return null
        const compact = live.filter((k) => !k.aux)
        if (compact.length === 0) return live[randInt(0, live.length - 1)]
        if (Math.random() < 0.5) {
            return compact.reduce((a, b) => (b.entries > a.entries ? b : a))
        }
        return compact[randInt(0, compact.length - 1)]
    }

    setKeyKind(key: RedisKey, kind: KeyKind) {
        const range = VALUE_BYTES[kind]
        key.kind = kind
        key.entries = kind === 'string' ? 0 : 1
        key.aux = false
        key.bytes = randInt(range[0], range[1])
        this.keysMesh.setColorAt(key.i, this.tmpColor.setHex(this.keyBase(key)))
        if (this.keysMesh.instanceColor) this.keysMesh.instanceColor.needsUpdate = true
        this.paintAuxKey(key)
        this.paintHeap()
    }

    growKey(key: RedisKey): boolean {
        if (key.kind === 'string' || !key.live) return false
        key.entries++
        if (key.aux) return false
        if (key.entries <= encodingLimit(key.kind)) return false
        key.aux = true
        key.bytes += 400 + key.entries * (key.kind === 'zset' ? 48 : 24)
        this.auxAnim.set(key.i, 0)
        this.flashKey(key, KIND_COLOR[key.kind], 0.9)
        this.paintAuxKey(key)
        this.paintHeap()
        return true
    }

    encoding(key: RedisKey): string {
        return encodingOf(key)
    }

    hotKey(): RedisKey | null {
        const live = this.hotKeys.filter((k) => k.live)
        if (live.length === 0) return null
        return live[randInt(0, live.length - 1)]
    }

    bigKey(kind?: BigKind): RedisKey | null {
        const all = Object.values(this.bigKeys) as RedisKey[]
        const live = all.filter((k) => k && k.live && (!kind || k.big === kind))
        if (live.length === 0) return null
        return live[randInt(0, live.length - 1)]
    }

    get bigCount() {
        return (Object.values(this.bigKeys) as RedisKey[]).filter((k) => k && k.live).length
    }

    get hotCount() {
        return this.hotKeys.filter((k) => k.live).length
    }

    evictionVictim(): RedisKey | null {
        const live = this.keys.filter((k) => k.live && !k.big && !k.hot)
        if (live.length === 0) return null
        return live[randInt(0, live.length - 1)]
    }

    setKeyLive(key: RedisKey, live: boolean) {
        key.live = live
        key.heat = live ? 1 : 0
        if (live) this.occupyHeapPage()
        else this.releaseHeapPage()
        if (key.big) {
            this.flashKey(key, KIND_COLOR[key.kind], 0.5)
            return
        }
        const s = live ? 1 : 0.001
        this.tmpObj.position.copy(key.home)
        this.tmpObj.scale.set(s, s, s)
        this.tmpObj.updateMatrix()
        this.keysMesh.setMatrixAt(key.i, this.tmpObj.matrix)
        this.keysMesh.instanceMatrix.needsUpdate = true
        this.paintAuxKey(key)
        this.flashKey(key, live ? KIND_COLOR[key.kind] : PALETTE.magenta, 0.5)
        this.rebuildPointerWeb()
    }

    private tileBucket(half: 0 | 1, id: number): number {
        return this.dict.bucketAtTile(half, id)
    }

    private usedBuckets(size: number): Set<number> {
        return this.dict.used(this.keys, size)
    }

    get hashSize() {
        return this.dict.size
    }

    private dictStats() {
        return this.dict.stats(this.keys)
    }

    bucketTop(key: RedisKey): THREE.Vector3 {
        const place = this.dict.placeOf(key.i)
        const tile = this.dict.tile(place.half, place.bucket)
        return new THREE.Vector3(
            dictX(tile % DICT.cols),
            DICT.y + 0.05,
            dictZ(Math.floor(tile / DICT.cols)),
        )
    }

    get rehashing() {
        return this.dict.rehashing
    }

    private paintDict() {
        const d = this.dict
        const N = DICT.cols * DICT.rows
        const usedOld = this.usedBuckets(d.size)
        const usedNew = d.size1 > 0 ? this.usedBuckets(d.size1) : null
        const liveHalf = d.half
        const otherHalf = (liveHalf === 0 ? 1 : 0) as 0 | 1
        const empty = mixHex(0x0d3a48, PALETTE.cyan, 0.14)

        for (let id = 0; id < N; id++) {
            const bOld = this.tileBucket(liveHalf, id)
            const bNew = this.tileBucket(otherHalf, id)
            let live = false
            let used = false
            if (d.size1 > 0) {
                if (bOld >= 0 && bOld < d.size && bOld >= d.idx) {
                    live = true
                    used = usedOld.has(bOld)
                } else if (bNew >= 0 && bNew < d.idx) {
                    live = true
                    used = usedNew?.has(bNew) ?? false
                }
            } else if (bOld >= 0 && bOld < d.size) {
                live = true
                used = usedOld.has(bOld)
            }

            this.tmpObj.position.set(
                dictX(id % DICT.cols),
                DICT.y,
                dictZ(Math.floor(id / DICT.cols)),
            )
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

        const text =
            d.size1 > 0
                ? `ht[0] ${d.size} → ht[1] ${d.size1} · ${d.idx}/${d.size}`
                : `ht[0] ${d.size} buckets`
        const el = this.dictTableLab?.element as HTMLElement | undefined
        if (el && el.textContent !== text) el.textContent = text

        this.rebuildPointerWeb()
    }

    private rebuildPointerWeb() {
        const web = this.pointerWeb
        if (!web) return
        const pos: number[] = []
        const col: number[] = []
        const c = new THREE.Color()
        for (const key of this.keys) {
            if (!key.live) continue
            const from = this.bucketTop(key)
            from.y += 0.06
            const to = this.keyTop(key)
            pos.push(from.x, from.y, from.z, to.x, to.y, to.z)
            c.setHex(KIND_COLOR[key.kind])
            col.push(c.r, c.g, c.b, c.r, c.g, c.b)
        }
        if (pos.length === 0) {
            web.visible = false
            return
        }
        web.visible = true
        web.geometry.setPositions(pos)
        web.geometry.setColors(col)
        web.geometry.computeBoundingSphere()
    }

    private paintHeap() {
        if (!this.heapMesh) return
        const free = mixHex(0x04141c, PALETTE.cyan, 0.07)
        const pageCount = HEAP.cols * HEAP.rows
        const mask = this.heapMask
        for (let id = 0; id < pageCount; id++) {
            const row = Math.floor(id / HEAP.cols)
            const col = id % HEAP.cols
            const on = mask?.[id] === 1
            this.tmpObj.position.set(heapX(col), HEAP.y, heapZ(row))
            this.tmpObj.scale.setScalar(on ? 1 : 0.001)
            this.tmpObj.updateMatrix()
            this.heapMesh.setMatrixAt(id, this.tmpObj.matrix)
            const hex = on ? mixHex(0x06222c, PALETTE.cyan, 0.82) : free
            this.heapMesh.setColorAt(id, this.tmpColor.setHex(hex))
        }
        this.heapMesh.instanceMatrix.needsUpdate = true
        if (this.heapMesh.instanceColor) this.heapMesh.instanceColor.needsUpdate = true
        this.applyGhost()
    }

    private maybeGrow() {
        const before = this.dict.size
        const next = this.dict.grow(this.liveKeys)
        if (next === null) return
        this.paintDict()
        this.trace(`dict grow · ${before} → ${next} buckets`)
    }

    rehashStep(buckets = 1) {
        const step = this.dict.advance(buckets)
        if (step === null) return
        if (step.done) this.trace(`dict rehashed · ht[0] ${this.dict.size} buckets`)
        this.paintDict()
    }

    pulseBucket(key: RedisKey) {
        const place = this.dict.placeOf(key.i)
        const tile = this.dict.tile(place.half, place.bucket)
        this.dictMesh.setColorAt(tile, this.tmpColor.setHex(pulseHex(PALETTE.ice, 0.4)))
        if (this.dictMesh.instanceColor) this.dictMesh.instanceColor.needsUpdate = true
        void this.ticker.add(PULSE_TIME, (k) => {
            this.dictMesh.setColorAt(
                tile,
                this.tmpColor
                    .setHex(pulseHex(PALETTE.ice, 0.4))
                    .multiplyScalar(1 + (PULSE_GAIN - 1) * (1 - k)),
            )
            if (this.dictMesh.instanceColor) this.dictMesh.instanceColor.needsUpdate = true
        })
        void this.ticker.wait(PULSE_TIME).then(() => this.paintDict())
    }

    pulsePage(key: RedisKey) {
        const page = key.page
        this.heapMesh.setColorAt(page, this.tmpColor.setHex(pulseHex(PALETTE.ice, 0.5)))
        if (this.heapMesh.instanceColor) this.heapMesh.instanceColor.needsUpdate = true
        void this.ticker.add(PULSE_TIME, (k) => {
            this.heapMesh.setColorAt(
                page,
                this.tmpColor
                    .setHex(pulseHex(PALETTE.ice, 0.5))
                    .multiplyScalar(1 + (PULSE_GAIN - 1) * (1 - k)),
            )
            if (this.heapMesh.instanceColor) this.heapMesh.instanceColor.needsUpdate = true
        })
        void this.ticker.wait(PULSE_TIME).then(() => this.paintHeap())
    }

    flashKey(key: RedisKey, hex: number, dur = PULSE_TIME) {
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

    pulseBig(kind: BigKind) {
        this.values.touched(kind)
    }

    rideBig(kind: BigKind, packet: THREE.Object3D | null) {
        this.values.ride(kind, packet)
    }

    setBigStep(kind: BigKind, n: number, of?: number) {
        this.values.setStep(kind, n, of)
    }

    bigStepOf(kind: BigKind): { step: number; steps: number } {
        return this.values.stepOf(kind)
    }

    get aofUsed() {
        return this.aofHead + 1
    }

    get aofCanGrow() {
        return this.aofBytes < this.aofOrder.length * BLOCK_BYTES
    }

    private aofBlockPos(k: number): THREE.Vector3 {
        const id = this.aofOrder[Math.max(0, Math.min(this.aofOrder.length - 1, k))]
        return new THREE.Vector3(xAt(id % COLS), PAGE_Y, zAt(Math.floor(id / COLS)))
    }

    private aofHeadX(): number {
        return this.aofBlockPos(this.aofHead).x
    }

    private layoutAof() {
        const hex = mixHex(AOF_FILL_DARK, AOF_FILL_BRIGHT, 1)
        const drawTo = this.aofHead
        const eraseTo = Math.max(this.aofDrawn, drawTo)
        for (let k = 0; k <= eraseTo; k++) {
            const i = this.aofOrder[k]
            if (i === undefined) break
            const on = k <= drawTo
            this.tmpObj.position.set(xAt(i % COLS), on ? PAGE_Y : PAGE_Y, zAt(Math.floor(i / COLS)))
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

    bufferAof(bytes: number) {
        this.aofPending++
        this.aofPendingBytes += bytes
        this.aofBuffered = Math.min(1, this.aofPendingBytes / (AOF_BUF_CELLS * BLOCK_BYTES))
        const mat = this.aofBufMats[this.bufferCubeIndex()]
        if (mat) {
            void this.ticker.add(PULSE_TIME, (k) => {
                mat.emissiveIntensity = 1.3 - 0.8 * k
            })
        }
    }

    get aofPendingRecords() {
        return this.aofPending
    }

    private writeAofBytes(bytes: number): THREE.Vector3 | null {
        const before = this.aofUsed
        const maxBlocks = this.aofOrder.length
        const length = this.aofBytes + bytes
        const wantBlocks = Math.max(1, Math.ceil(length / BLOCK_BYTES))
        const blocks = Math.min(wantBlocks, maxBlocks)
        this.aofBytes = Math.min(length, maxBlocks * BLOCK_BYTES)
        if (wantBlocks > maxBlocks) this.aofFull = true
        if (blocks > before) {
            for (let k = before; k < blocks; k++) {
                this.pulseDiskBlock(this.aofOrder[k], PALETTE.amber)
            }
            this.aofHead = blocks - 1
            this.layoutAof()
        }
        return this.aofHeadTop()
    }

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
        const x0 = xAt(minC) - CELL / 2
        const x1 = xAt(maxC) + CELL / 2
        const z0 = zAt(minR) - CELL / 2
        const z1 = zAt(maxR) + CELL / 2
        this.aofEdge.visible = true
        this.aofEdge.resize(x1 - x0, CELL, z1 - z0).centre((x0 + x1) / 2, PAGE_Y, (z0 + z1) / 2)
        this.aofPick.visible = true
        this.aofPick.scale.set(x1 - x0, 1, z1 - z0)
        this.aofPick.position.set((x0 + x1) / 2, PAGE_Y + 0.5, (z0 + z1) / 2)
        REDIS_ANCHOR.aof.set((x0 + x1) / 2, BLOCK_TOP, (z0 + z1) / 2).add(REDIS_ORIGIN)
    }

    private pulseDiskBlock(id: number, hex: number) {
        this.diskBoost.set(id, { v: 1, hex: pulseHex(hex) })
    }

    aofHeadTop(): THREE.Vector3 {
        const p = this.aofBlockPos(this.aofHead)
        return p.add(new THREE.Vector3(0, BLOCK.h / 2, 0))
    }

    aofBufferTop(): THREE.Vector3 {
        const m = this.aofBufCells[this.bufferCubeIndex()]
        if (!m || !this.aofBufGroup) return this.aofHeadTop()
        const v = this.aofBufGroup.position.clone().add(m.position)
        return v.setY(v.y + BLOCK.h * 0.7)
    }

    private bufferCubeIndex() {
        return Math.min(
            this.aofBufCells.length - 1,
            Math.floor(this.aofBuffered * this.aofBufCells.length),
        )
    }

    flushAofBuffer(): { head: THREE.Vector3; records: number } | null {
        const records = this.aofPending
        const bytes = this.aofPendingBytes
        if (records === 0) return null

        this.aofPending = 0
        this.aofPendingBytes = 0
        this.aofBuffered = 0

        const head = this.writeAofBytes(bytes)
        this.pulseBuffered()
        return head ? { head, records } : null
    }

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

    private writeRdbNow() {
        const live = this.keys.map((k) => k.live)
        const { blocks, tail } = this.packRdb(live)
        this.rdbBlocks = blocks.slice(0, this.rdbOrder.length)
        this.rdbLen = this.rdbBlocks.length
        this.rdbTail = tail
        this.rdbBytes = this.keys.reduce((n, k) => n + (k.live ? k.bytes : 0), 0)
        this.layoutRdb()
    }

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

    private rdbHexAt(id: number, seq: number): number {
        const tint = this.rdbBase[id] ?? RDB_FILL_BRIGHT
        return seq === this.rdbLen - 1
            ? mixHex(RDB_FILL_DARK, tint, Math.max(0.12, this.rdbTail))
            : tint
    }

    private restingHex(id: number): number {
        const aofSeq = this.aofIndex.get(id)
        if (aofSeq !== undefined && aofSeq <= this.aofHead) {
            return mixHex(AOF_FILL_DARK, AOF_FILL_BRIGHT, 1)
        }
        const rdbSeq = this.rdbIndex.get(id)
        if (rdbSeq !== undefined && rdbSeq < this.rdbLen) return this.rdbHexAt(id, rdbSeq)
        return 0x000000
    }

    private fitRdbEdge() {
        if (this.rdbLen === 0) {
            this.rdbEdge.visible = false
            this.rdbPick.visible = false
            return
        }
        this.rdbEdge.visible = true
        this.rdbPick.visible = true
        let minC = COLS
        let maxC = -1
        let minR = ROWS
        let maxR = -1
        for (let k = 0; k < this.rdbLen; k++) {
            const id = this.rdbOrder[k]
            const c = id % COLS
            const r = Math.floor(id / COLS)
            minC = Math.min(minC, c)
            maxC = Math.max(maxC, c)
            minR = Math.min(minR, r)
            maxR = Math.max(maxR, r)
        }
        const bx0 = xAt(minC) - CELL / 2
        const bx1 = xAt(maxC) + CELL / 2
        const bz0 = zAt(minR) - CELL / 2
        const bz1 = zAt(maxR) + CELL / 2
        this.rdbEdge
            .resize(bx1 - bx0, CELL, bz1 - bz0)
            .centre((bx0 + bx1) / 2, PAGE_Y, (bz0 + bz1) / 2)
    }

    get rdbBlocksUsed() {
        return this.rdbLen
    }

    private rdbBlockPos(seq: number): THREE.Vector3 {
        const id = this.rdbOrder[Math.max(0, Math.min(this.rdbOrder.length - 1, seq))]
        const row = Math.floor(id / COLS)
        const col = id % COLS
        return new THREE.Vector3(xAt(col), PAGE_Y, zAt(row))
    }

    async runRdbSave(): Promise<void> {
        if (this.savingRdb) return
        this.savingRdb = true
        const base = this.keys.map((k) => k.live)
        const { blocks, tail } = this.packRdb(base)
        this.pulseAgent(this.bgsaveDrone)

        this.rdbAim.set(heapX(0), HEAP.y + 0.8, HEAP.cz)
        await this.ticker.wait(0.28)
        await this.ticker.add(1.0, (k) => {
            const col = Math.min(KEYS.cols - 1, Math.floor(k * KEYS.cols))
            for (const key of this.keys) {
                if (base[key.i] && Math.abs(key.col - col) <= 1) {
                    key.heat = Math.max(key.heat, 0.85)
                }
            }
            this.rdbAim.set(heapX(col), HEAP.y + 0.8, HEAP.cz)
        })

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

    async runLoad(target: boolean[]): Promise<void> {
        if (this.loading) return
        this.loading = true
        this.wipeMemory()
        this.pulseAgent(this.bgsaveDrone)

        const n = this.rdbLen
        let shown = 0
        if (n > 0) {
            await this.ticker.add(Math.max(0.4, n * RDB_BLOCK_TIME), (k) => {
                const upto = Math.max(1, Math.min(n, Math.ceil(k * n)))
                for (let b = shown; b < upto; b++) {
                    this.pulseDiskBlock(this.rdbOrder[b], PALETTE.teal)
                    for (const i of this.rdbBlocks[b] ?? []) if (target[i]) this.reviveKey(i)
                }
                shown = Math.max(shown, upto)
            })
        }

        const m = this.aofUsed
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
        this.rebuildPointerWeb()
        this.paintHeap()
    }

    private reviveKey(i: number) {
        const key = this.keys[i]
        if (!key || key.live) return
        key.live = true
        key.heat = 0.9
        this.paintHeap()
        if (key.big) {
            this.rebuildPointerWeb()
            return
        }
        this.tmpObj.position.copy(key.home)
        this.tmpObj.scale.setScalar(1)
        this.tmpObj.updateMatrix()
        this.keysMesh.setMatrixAt(i, this.tmpObj.matrix)
        this.keysMesh.instanceMatrix.needsUpdate = true
        this.rebuildPointerWeb()
    }

    async runRewrite(): Promise<void> {
        if (this.rewriting) return
        this.rewriting = true
        this.pulseAgent(this.rewriteDrone)

        const oldHead = this.aofHead
        const target = Math.max(2, Math.round(oldHead * 0.25))

        this.rewriteAim.set(heapX(0), HEAP.y + 0.8, HEAP.cz)
        await this.ticker.wait(0.35)
        await this.ticker.add(1.15, (k) => {
            const col = Math.min(KEYS.cols - 1, Math.floor(k * KEYS.cols))
            for (const key of this.keys) {
                if (key.live && Math.abs(key.col - col) <= 1) key.heat = Math.max(key.heat, 0.9)
            }
            this.rewriteAim.set(heapX(col), HEAP.y + 0.8, HEAP.cz)
        })

        setLabelEnabled(this.stagingLab, true)
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

        const smooth = (t: number) => t * t * (3 - 2 * t)
        await this.ticker.add(0.5, (k) => {
            for (let j = 0; j < staged; j++) {
                const t = smooth(Math.max(0, Math.min(1, k * 1.5 - j * 0.05)))
                const pos = this.stagingSlot(j).lerp(this.aofBlockPos(j), t)
                this.placeDiskBlock(this.stagingId(j), pos, true)
            }
            this.rewriteAim.copy(this.aofBlockPos(Math.min(staged - 1, target - 1))).setY(1.4)
        })

        const newHead = Math.max(target, this.aofHead - (oldHead - target))

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
        setLabelEnabled(this.stagingLab, false)
        this.rewrites++
        this.aofHead = newHead
        this.aofBytes = Math.round(this.aofBytes * 0.25)
        this.aofFull = false
        this.layoutAof()
        this.trace(
            `rewrite swap · head ${oldHead} → ${this.aofHead}, ${staged} blocks became the file`,
        )
        this.pulseDiskBlock(this.aofOrder[this.aofHead], PALETTE.amber)
        this.pulseAgent(this.rewriteDrone)
        this.rewriting = false
        this.assertInvariants('bgrewriteaof')
    }

    private stagingSlot(k: number): THREE.Vector3 {
        return new THREE.Vector3(xAt(AOF_C0 + k), PAGE_Y, zAt(STAGING_ROW))
    }

    private setStaged(k: number, on: boolean) {
        this.placeDiskBlock(this.stagingId(k), this.stagingSlot(k), on)
    }

    private stagingId(k: number) {
        return STAGING_ROW * COLS + AOF_C0 + k
    }

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

    verify(): string[] {
        return verifyDisk({
            disk: this.disk,
            aofHead: this.aofHead,
            aofOrder: this.aofOrder,
            aofBlockPos: (k) => this.aofBlockPos(k),
            aofEdge: this.aofEdge,
            rdbLen: this.rdbLen,
            rdbOrder: this.rdbOrder,
            rewriting: this.rewriting,
            stagingId: (k) => this.stagingId(k),
            cols: COLS,
            rows: ROWS,
            cell: CELL,
        })
    }

    private assertInvariants(where: string) {
        if (!checkInvariants) return
        const bad = this.verify()
        if (bad.length === 0) return
        const msg = `[redis] invariants broken after ${where}:\n  ${bad.join('\n  ')}`
        console.error(msg)
        throw new Error(msg)
    }

    private trace(msg: string) {
        if (checkInvariants) console.log(`[redis] ${msg}`)
    }

    pulseAgent(g: THREE.Group) {
        const s = g.scale.x
        void this.ticker.add(0.6, (k) => {
            const f = 1 + 0.35 * Math.sin(k * Math.PI)
            g.scale.setScalar(s * f)
        })
    }

    update(dt: number, time: number) {
        for (const pod of this.ports) {
            const target = pod.active ? (pod.busy ? 2.6 : 0.9) : 0
            pod.ring.emissiveIntensity +=
                (target - pod.ring.emissiveIntensity) * Math.min(1, dt * 8)
            pod.glow.opacity = 0.16 + 0.34 * (pod.ring.emissiveIntensity / 2.6)
            if (pod.pulse > 0) {
                pod.pulse = Math.max(0, pod.pulse - dt * 1.6)
                if (pod.pulse === 0) pod.busy = false
            }
        }

        this.fdMats.forEach((mat, i) => {
            this.fdPulse[i] = Math.max(0, this.fdPulse[i] - dt * 2.2)
            const pod = this.ports[i]
            const base = pod && pod.active ? 0.55 + 0.18 * breathe(time, 1.3, i) : 0.03
            mat.emissiveIntensity = base + this.fdPulse[i] * 2.4
        })

        this.loopCore.emissiveIntensity +=
            (1.35 + 0.35 * breathe(time, 2.2) - this.loopCore.emissiveIntensity) *
            Math.min(1, dt * 6)
        this.loopRing.rotation.z += dt * 0.5

        this.channelPulse = Math.max(0, this.channelPulse - dt * 1.5)
        const ringMat = this.channelRing.material as THREE.MeshBasicMaterial
        ringMat.opacity = 0.3 + 0.12 * breathe(time, 1.1) + this.channelPulse * 0.5
        this.channelRing.scale.setScalar(1 + this.channelPulse * 0.16)

        driftDust(this.motes, dt, time)

        this.values.update(dt, time, this.hotKeys)

        this.rehashTimer -= dt
        if (this.rehashTimer <= 0) {
            this.rehashTimer = 0.25
            this.rehashStep(2)
            this.maybeGrow()
        }

        if (this.auxAnim.size > 0) {
            for (const [i, v] of this.auxAnim) {
                const next = Math.min(1, v + dt * 3.4)
                if (next >= 1) this.auxAnim.delete(i)
                else this.auxAnim.set(i, next)
                this.paintAuxKey(this.keys[i])
            }
        }

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
                            .multiplyScalar(1 + (PULSE_GAIN - 1) * next),
                    )
                }
                dirty = true
            }
            if (dirty && this.disk.instanceColor) this.disk.instanceColor.needsUpdate = true
        }

        if (this.aofBufGroup) {
            const g = this.aofBufGroup
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
            this.aofBufMats.forEach((mat, i) => {
                const live = i <= this.bufferCubeIndex() ? this.aofBuffered : 0
                mat.emissiveIntensity +=
                    (0.5 + live * 0.6 - mat.emissiveIntensity) * Math.min(1, dt * 5)
            })
            REDIS_ANCHOR.aofBuf.copy(g.position).add(REDIS_ORIGIN)
        }

        if (this.savingRdb) {
            this.rewriteStep.copy(this.rdbAim).sub(this.bgsaveDrone.position)
            const dist = this.rewriteStep.length()
            if (dist > 1e-4) {
                const step = Math.min(dist, AGENT_SPEED * dt)
                this.bgsaveDrone.position.addScaledVector(
                    this.rewriteStep.multiplyScalar(1 / dist),
                    step,
                )
            }
        } else {
            const a = time * 0.34
            this.rdbIdle.set(
                this.rdbHome.x + Math.cos(a) * 3.2,
                this.rdbHome.y + Math.sin(time * 0.75) * 0.2,
                this.rdbHome.z + Math.sin(a) * 1.9,
            )
            this.bgsaveDrone.position.lerp(this.rdbIdle, Math.min(1, dt * 1.2))
            this.bgsaveDrone.rotation.y += dt * 0.6
        }

        if (this.rewriting) {
            this.rewriteStep.copy(this.rewriteAim).sub(this.rewriteDrone.position)
            const dist = this.rewriteStep.length()
            if (dist > 1e-4) {
                const step = Math.min(dist, AGENT_SPEED * dt)
                this.rewriteDrone.position.addScaledVector(
                    this.rewriteStep.multiplyScalar(1 / dist),
                    step,
                )
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

    bounds(): THREE.Box3 {
        this.tmpBox.setFromObject(this.group)
        return this.tmpBox.clone()
    }

    setOrigin(pos: THREE.Vector3) {
        REDIS_ORIGIN.copy(pos)
        this.group.position.copy(pos)
        rebaseAnchors()
    }
}
