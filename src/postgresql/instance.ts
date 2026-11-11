import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { BlockField } from '../core/field'
import { makePacket } from '../core/packet'
import {
    Ticker,
    OutlineBox,
    PULSE_GAIN,
    PULSE_TIME,
    breathe,
    driftDust,
    dustField,
    easeInOutCubic,
    floorLabel,
    fmtBytes,
    halo,
    label,
    neonEdges,
    pulseHex,
    radialTexture,
    rand,
    randInt,
    slotLattice,
    travel,
} from '../core/util'
import { PostgresqlPathEnd, QueryChain, pathCurve } from './flow'
import { LockRack, LOCK_COLOUR, type LockMode, type LockWait } from './locks'
import { freeAt as fragmentedFree } from '../disk/fragmentation'
import { createPostgresqlIndexCompanion } from './indexes'
import type { PostgresqlIndexCompanionHandle } from './indexes'
import {
    PALETTE,
    ANCHOR,
    BLOCK_FREE,
    BUFFER_COLS,
    BUFFER_ROWS,
    BUFFER_TOP_Y,
    BUFFER_Y,
    BUF_DARK,
    BUF_FILL_BRIGHT,
    BUF_FILL_DARK,
    CACHE_GHOST,
    DISK_FIELD,
    DISK_LABEL_PAD,
    DSM_CAGE,
    DSM_SEGMENTS,
    EFFECTIVE_CACHE_SIZE,
    FILL_BRIGHT,
    FILL_DARK,
    FLOOR_LABEL_Y,
    LOCK_RACK,
    LOCK_SLOTS,
    MAINT_CAGE,
    MAINT_DEFAULT,
    MAINT_LIFT,
    MAINT_STACK,
    PAGE_CELL,
    PAGE_GRID,
    PAGE_TOP_Y,
    PAGE_Y,
    POSTGRES_ORIGIN,
    PROCESS,
    SYSTEM_GREY,
    SYSTEM_RUNS,
    TABLE_REGIONS,
    TMP_CAGE,
    TMP_COLS,
    TMP_ROWS,
    WAL_BUF_LEN,
    WAL_C0,
    WAL_LEN,
    WAL_ROW,
    WORLD_ANCHOR,
    bufferSlotX,
    bufferSlotZ,
    pageX,
    pageZ,
    rebaseAnchors,
} from './layout'
import type { PostgresqlSystemArea } from './layout'
export * from './layout'

export interface StatLine {
    label: string
    value: string
}

export interface Info {
    title: string
    body: string
    meta?: string

    stats?: () => StatLine[]
}

export interface BlockPick {
    key: string
    info: Info
    box: THREE.Box3
}

export const BLOCK_PICK_RANGE = 7

export const PAGE_BYTES = 8192

export const WAL_SEGMENT_BYTES = 16 * 1024 * 1024

export interface Page {
    mesh: THREE.Mesh
    mat: THREE.MeshStandardMaterial
    base: THREE.Color
    heat: number
    row: number
    col: number
    dirty: boolean

    fill: number

    block: Page8K | null
}

export interface Tuple {
    mesh: THREE.Mesh
    mat: THREE.MeshStandardMaterial
    dead: boolean
    home: THREE.Vector3
}

export interface Page8K {
    i: number
    home: THREE.Vector3
    row: number
    col: number
    color: number
    table: string | null

    fill: number

    shade: number

    hint: number
    hintAmt: number

    free: boolean

    system: PostgresqlSystemArea | null

    dead: boolean
    busy: boolean
}

export const enum PostgresqlNodeName {
    Parse = 1,
    Plan = 2,
    Exec = 3,
}

export const POSTGRESQL_NODE_NAME: Record<PostgresqlNodeName, string> = {
    [PostgresqlNodeName.Parse]: 'parse',
    [PostgresqlNodeName.Plan]: 'plan',
    [PostgresqlNodeName.Exec]: 'exec',
}

export const INBUF_CELLS = 3

export const BACKEND_SLOTS = [-9.6, -5.75, -1.9, 1.9, 5.75, 9.6]

export const BACKEND_ORIGIN = { y: 9.88, z: 5.8 }

const INBUF_PITCH = 0.52

const INBUF_BOTTOM = -1.86

const INBUF_CELL = { w: 0.22, h: 0.16, d: 0.22 }

export interface BackendPod {
    id: number
    group: THREE.Group
    ring: THREE.MeshStandardMaterial
    glow: THREE.SpriteMaterial
    pick: THREE.Mesh
    active: boolean
    busy: boolean
    index: number
    pulse: number

    inbuf: number

    pending: number

    cells: THREE.Mesh[]

    pipeline: ProcessPipeline
}

export interface PipelineNode {
    group: THREE.Group
    core: THREE.MeshStandardMaterial
    cage: THREE.MeshStandardMaterial
    ring: THREE.Mesh
    baseScale: number
    home: THREE.Vector3
    pulse: number
}

export interface ProcessPipeline {
    group: THREE.Group
    cage: OutlineBox
    nodes: Record<PostgresqlNodeName, PipelineNode>
}

const glowMat = (
    color: number,
    emissive: number,
    intensity: number,
    opts: Partial<THREE.MeshStandardMaterialParameters> = {},
) =>
    new THREE.MeshStandardMaterial({
        color,
        emissive,
        emissiveIntensity: intensity,
        roughness: 0.42,
        metalness: 0.35,
        ...opts,
    })

export class PostgresInstance {
    readonly group = new THREE.Group()
    readonly pages: Page[] = []

    readonly pages8k: Page8K[] = []

    readonly tableBlocks: Page8K[] = []
    readonly pickables: THREE.Object3D[] = []
    readonly walBufferMats: THREE.MeshStandardMaterial[] = []

    readonly walBlocks: Page8K[] = []

    private walBoost = new Map<number, number>()

    readonly walBufBlocks: THREE.Mesh[] = []
    private walBufGroup!: THREE.Group
    locks!: LockRack
    private readonly lockTethers = new Map<string, THREE.Line>()

    get lockHeld() {
        return this.locks.held
    }

    get lockWaiting() {
        return this.locks.waiting
    }

    get lockHolders() {
        return this.locks.holders
    }

    readonly dsmMats: THREE.MeshStandardMaterial[] = []
    private readonly dsmBlocks: THREE.Mesh[] = []
    private dsmCage!: OutlineBox
    private dsmLive: number[] = []
    private dsmTarget: number[] = []
    private dsmNext = 0
    private dsmPulse = 0
    private lockPulse = 0

    private cacheEdge!: OutlineBox
    private cacheSheet!: THREE.MeshBasicMaterial
    private cachePulse = 0

    private maintCage!: OutlineBox
    private maintHost!: THREE.Group
    private chunks!: BlockField
    private maintChains: QueryChain[] = []
    private tmpPages!: BlockField
    maintPass = 1

    get maintFill() {
        return this.chunks ? this.chunks.used / Math.max(1, this.chunks.capacity) : 0
    }

    get maintUsed() {
        return this.chunks ? this.chunks.used : 0
    }

    readonly indexCompanion: PostgresqlIndexCompanionHandle

    pageField!: THREE.InstancedMesh

    private liftMesh!: THREE.Mesh

    bufferCorners!: {
        nearLeft: THREE.Vector3
        nearRight: THREE.Vector3
        farLeft: THREE.Vector3
        farRight: THREE.Vector3
    }

    readonly pageBlockGeo = new RoundedBoxGeometry(
        PAGE_GRID.bw,
        PAGE_GRID.bh,
        PAGE_GRID.bd,
        1,
        0.02,
    )

    readonly backends: BackendPod[] = []
    readonly scanner: THREE.Mesh
    readonly vacuumDrone: THREE.Group
    motes!: THREE.Points

    private deadCount = 0

    constructor(private ticker: Ticker) {
        this.buildShell()
        this.buildBufferPool()
        this.buildMemoryFixtures()
        this.buildWal()
        this.buildPageField()
        this.buildTableRegions()
        this.indexCompanion = createPostgresqlIndexCompanion(this.group)
        this.buildLocks()
        this.buildBackends()
        this.scanner = this.makeScanner()
        this.vacuumDrone = this.makeVacuumDrone()
        this.vacuumDrone.add(this.maintHost)
        this.maintHost.position.set(0, MAINT_LIFT, 0)

        this.openBackend()
        this.openBackend()
        this.openBackend()

        rebaseAnchors()
    }

    private register(obj: THREE.Object3D, info: Info, outline?: OutlineBox) {
        obj.userData.info = info

        if (outline) obj.userData.outline = outline
        this.pickables.push(obj)
        return obj
    }

    private buildMemoryFixtures() {
        this.buildDynamicSharedMemory()
        this.buildEffectiveCache()
        this.buildMaintenanceWork()
        this.buildTempWork()
    }

    private buildDynamicSharedMemory() {
        const b = DSM_CAGE
        const cage = new OutlineBox(b.w, b.h, b.d, PALETTE.ice, 0.24, { dashed: true })
        cage.centre(b.x, b.y, b.z)
        this.group.add(cage)
        this.dsmCage = cage

        const geo = new THREE.BoxGeometry(0.3, 0.26, 0.3)
        for (let i = 0; i < DSM_SEGMENTS; i++) {
            const mat = glowMat(0x08161d, PALETTE.ice, 0.1)
            const m = new THREE.Mesh(geo, mat)
            m.position.set(b.x - 0.34 + (i % 2) * 0.68, b.y - 0.26 + Math.floor(i / 2) * 0.52, b.z)
            this.group.add(m)
            this.dsmMats.push(mat)
            this.dsmBlocks.push(m)
        }
        this.dsmLive = new Array(DSM_SEGMENTS).fill(0)
        this.dsmTarget = new Array(DSM_SEGMENTS).fill(0)
        this.dsmNext = 0

        const lab = label('/dev/shm · DSM')
        lab.position.set(b.x - b.w / 2 - 0.05, b.y - b.h / 2 - 0.1, b.z)
        this.group.add(lab)

        const pick = new THREE.Mesh(
            new THREE.BoxGeometry(b.w, b.h, b.d),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        pick.position.set(b.x, b.y, b.z)
        this.group.add(pick)
        this.register(
            pick,
            {
                title: '/dev/shm — dynamic shared memory, one segment per query',
                body: 'This is the second kind of shared memory in postgres, and it is not the buffer pool: segments cut on demand and mapped from /dev/shm, by default dynamic_shared_memory_type = posix on Linux. A parallel query allocates one, the leader and its workers attach to it, they hand block ranges to each other through it, and it is unlinked when the query ends — so the cage empties again. Each cube here is one live segment. Because /dev/shm is a tmpfs it has a size of its own, and that size is a hard limit: a container left at the default 64 MB makes a parallel query fail outright with “could not resize shared memory segment … No space left on device”. Nothing degrades and nothing falls back — every other memory limit on this page costs speed when you press it, this one errors.',
                meta: 'dynamic_shared_memory_type = posix · one per parallel query · tmpfs size is a hard limit',
                stats: () => [
                    {
                        label: 'segments live',
                        value: `${this.dsmLive.filter((v) => v > 0.5).length} of ${DSM_SEGMENTS}`,
                    },
                    { label: 'holds', value: 'parallel state + tuple queues' },
                    { label: 'freed', value: 'when the query ends' },
                ],
            },
            cage,
        )
    }

    private buildEffectiveCache() {
        const b = CACHE_GHOST
        const ghost = new THREE.Group()
        ghost.position.set(b.x, b.y, b.z)

        const edge = new OutlineBox(b.w, 0.02, b.d, PALETTE.cyan, 0.14, { dashed: true })
        ghost.add(edge)
        this.cacheEdge = edge

        const sheet = new THREE.Mesh(
            new THREE.PlaneGeometry(b.w, b.d),
            new THREE.MeshBasicMaterial({
                color: PALETTE.cyan,
                transparent: true,
                opacity: 0.04,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
                side: THREE.DoubleSide,
            }),
        )
        sheet.rotation.x = -Math.PI / 2
        ghost.add(sheet)
        this.cacheSheet = sheet.material as THREE.MeshBasicMaterial

        const lab = label(`OS PAGE CACHE · assumed ${EFFECTIVE_CACHE_SIZE}`)
        lab.position.set(b.w / 2 + 0.05, 0.06, 0)
        ghost.add(lab)
        this.group.add(ghost)

        const pick = new THREE.Mesh(
            new THREE.BoxGeometry(1.2, 0.5, 1.2),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        pick.position.set(b.x, b.y + 0.2, b.z)
        this.group.add(pick)
        this.register(pick, {
            title: 'effective_cache_size — the planner’s belief, not memory',
            body: `Nothing is allocated here and nothing is reserved: this is a number handed to the cost model, the only knob on this page that changes no memory at all. It tells the planner how much of the disk it may assume the operating system caches on its behalf — shared_buffers plus the kernel page cache — and it is used for one decision: whether a page the planner expects to read again is likely to be a disk access or a memory copy. Say the cache is large and random index lookups look cheap, so index scans win; say it is small and the planner starts preferring sequential scans that touch every page once. Convention is about three quarters of the machine’s RAM; here it is ${EFFECTIVE_CACHE_SIZE}. Both directions have a trap: too low and good index plans get thrown away, too high and the planner picks index scans the cache cannot actually hold, which turn into random I/O. It is also the honest account of a buffer miss — a miss in shared_buffers is usually a copy from this second level, not a read from the plate below.`,
            meta: 'planner cost input · allocates nothing · ≈ ¾ of RAM by convention',
            stats: () => [
                { label: 'assumed', value: EFFECTIVE_CACHE_SIZE },
                { label: 'is', value: 'shared_buffers + OS page cache' },
                { label: 'allocates', value: 'nothing' },
            ],
        })
    }

    private buildMaintenanceWork() {
        // The store belongs to the job, not to a coordinate in space: it is a companion on
        // the drone, so it goes where the worker goes and is gone when the worker is. A
        // dashed cage is the notation for a structure with no footprint of its own.
        const host = new THREE.Group()
        const cage = new OutlineBox(MAINT_CAGE.w, MAINT_CAGE.h, MAINT_CAGE.d, 0xc7ff5a, 0.22, {
            dashed: true,
        })
        cage.centre(0, MAINT_CAGE.h / 2, 0)
        host.add(cage)
        this.maintCage = cage

        // Not pages: one plate is the address list of one heap page — a block number and a
        // bit per slot — so the stack counts pages to revisit, not bytes copied. Pages are
        // cubes everywhere else in the scene; an address is a slab.
        this.chunks = new BlockField({
            cols: 1,
            rows: MAINT_STACK,
            layers: 1,
            size: 0.42,
            sizeY: 0.028,
            pitchX: 0,
            pitchY: 0.054,
            pitchZ: 0,
            home: new THREE.Vector3(0, 0.12 + (MAINT_STACK * 0.054) / 2, 0),
            colour: 0xb6ef63,
            dark: 0x2c3d12,
        })
        host.add(this.chunks.group)

        const lab = label(`addresses · ${MAINT_DEFAULT} budget`)
        lab.position.set(-MAINT_CAGE.w / 2 - 0.05, MAINT_CAGE.h + 0.14, 0)
        host.add(lab)

        const pick = new THREE.Mesh(
            new THREE.BoxGeometry(MAINT_CAGE.w, MAINT_CAGE.h, MAINT_CAGE.d),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        pick.position.set(0, MAINT_CAGE.h / 2, 0)
        host.add(pick)
        // Nothing to show while no job is running: the budget is per operation, so it
        // appears with the vacuum and goes with it.
        host.visible = false
        this.register(
            pick,
            {
                title: 'maintenance_work_mem — addresses of dead tuples, one plate per page',
                body: `The budget is ${MAINT_DEFAULT} and nothing in it is data: what a vacuum keeps is the address of each dead tuple it finds — six bytes, a block number and a slot — grouped by page, so one plate here is one heap page with dead tuples and the offsets inside it that have to go. No page is copied in and no tuple is copied in; the page itself is read into a shared buffer when the scan inspects it, and read again when the vacuum comes back to prune it. That second visit is the whole reason the list exists: without it a vacuum would have to hold every page it means to rewrite in memory at once. The list grows only as far as the heap has dead tuples to record, which is why this stack is short — a 64 MB budget is eleven million addresses and a table this size produces thousands — but fill it before the scan is done and vacuum processes what it holds and starts another pass over the heap, so a small value costs passes and never a spill. Compare the neighbours: the sort beside this one holds real tuples and does spill, to 8 KiB pages in pgsql_tmp. When the job ends the stack is released to the allocator, not to the operating system, so RSS stays where it was and the next vacuum fills the same memory again.`,
                meta: `per operation, per worker · ${MAINT_DEFAULT} ≈ 11 M addresses · one plate = one page’s addresses`,
                stats: () => [
                    {
                        label: 'store',
                        value: `${this.maintUsed} of ${MAINT_STACK} plates`,
                    },
                    { label: 'plate', value: 'one page · its dead slots' },
                    { label: 'plate bytes', value: '6 B per dead tuple' },
                    { label: 'budget', value: MAINT_DEFAULT },
                    { label: 'scope', value: 'one operation, one worker' },
                    { label: 'pass', value: String(this.maintPass) },
                ],
            },
            cage,
        )

        this.maintHost = host
    }

    private buildTempWork() {
        const b = TMP_CAGE
        // A sort that outgrows its memory does not lose the work: it writes sorted runs to
        // files and merges them back. Those are pages, so they are blocks.
        const cage = new OutlineBox(b.w, b.h, b.d, PALETTE.amber, 0.2, { dashed: true })
        cage.centre(b.x, b.y, b.z)
        this.group.add(cage)

        this.tmpPages = new BlockField({
            cols: TMP_COLS,
            rows: TMP_ROWS,
            layers: 1,
            size: PAGE_GRID.bw,
            pitchX: 0.52,
            pitchY: 0.3,
            pitchZ: 0.3,
            home: new THREE.Vector3(b.x, b.y, b.z),
            colour: PALETTE.amber,
            dark: 0x2a1a05,
        })
        this.group.add(this.tmpPages.group)
        this.tmpPages.group.visible = false

        const lab = label('pgsql_tmp · sorted runs')
        lab.position.set(b.x - b.w / 2 - 0.05, b.y + b.h / 2 + 0.14, b.z)
        this.group.add(lab)

        const pick = new THREE.Mesh(
            new THREE.BoxGeometry(b.w, b.h, b.d),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        pick.position.set(b.x, b.y, b.z)
        this.group.add(pick)
        this.register(
            pick,
            {
                title: 'pgsql_tmp — where a sort puts what it cannot hold',
                body: `The one thing on this page that is disk and not memory: a directory inside the data directory (base/pgsql_tmp, or the tablespace’s own), where a sort that runs out of maintenance_work_mem writes what it has sorted so far and starts again on the rest. Those runs are ordinary files of ordinary BLCKSZ pages, so they are blocks here and always will be. CREATE INDEX is the job that lives here: it reads the table, builds index tuples in a tuplesort, and once the budget is gone it writes a sorted run and carries on — at the end it merges the runs into one ordered stream and writes the index in a single pass. The file is unlinked when the operation finishes, which is why this cage is empty: nothing in this scene sorts enough to spill, and a 64 MB budget sorts a very large table before it does. What makes it worth watching for is that it is invisible until it happens — the statement simply gets slower, and the disk fills while it runs; log_temp_files logs each one with its size once it is gone, and temp_file_limit can kill a query that crosses it.`,
                meta: 'temp files on disk · BLCKSZ pages · unlinked at the end · zero here',
                stats: () => [
                    { label: 'files', value: '0' },
                    { label: 'block', value: 'BLCKSZ · 8 KiB' },
                    { label: 'when', value: 'sort outgrows the budget' },
                    { label: 'seen by', value: 'log_temp_files' },
                ],
            },
            cage,
        )
    }

    private maintChain() {
        const chain = new QueryChain(this.group)
        this.maintChains.push(chain)
        return chain
    }

    /** The stack rides the drone, so its slots have to be read in the parent's space. */
    private storeTop(slot: number) {
        return this.chunks.top(slot).add(this.maintHost.position).add(this.vacuumDrone.position)
    }

    private async flyTidIntoStore(page: Page8K, chunk: number) {
        const from = this.blockTop(page).add(new THREE.Vector3(0, 0.14, 0))
        const to = this.storeTop(chunk)
        const tid = makePacket(PALETTE.amber, 0.13, this.group, {
            emissive: 1.9,
            haloScale: 3.0,
            haloOpacity: 0.55,
        })
        tid.position.copy(from)
        const curve = pathCurve([
            from,
            from
                .clone()
                .lerp(to, 0.45)
                .add(new THREE.Vector3(0.7, 1.35, 0.3)),
            to,
        ])
        const chain = this.maintChain()
        const flow = chain.addCurve(curve, PALETTE.amber, { speed: 0.55, opacity: 0.42 })
        await travel(this.ticker, tid, curve, 0.3, easeInOutCubic)
        flow.flash(0.8)
        this.group.remove(tid)
        chain.fadeOut(this.ticker, 0.45)
        await this.chunks.grow(chunk, 1, 0.18, this.ticker)
    }

    private async flyTidOutOfStore(rec: { chunk: number; page: Page8K }) {
        const from = this.storeTop(rec.chunk)
        const to = this.blockTop(rec.page).add(new THREE.Vector3(0, 0.05, 0))
        const tid = makePacket(PALETTE.amber, 0.13, this.group, {
            emissive: 1.9,
            haloScale: 3.0,
            haloOpacity: 0.55,
        })
        tid.position.copy(from)
        await this.chunks.grow(rec.chunk, 0, 0.16, this.ticker)
        const curve = pathCurve([
            from,
            from
                .clone()
                .lerp(to, 0.55)
                .add(new THREE.Vector3(-0.5, 1.1, -0.2)),
            to,
        ])
        const chain = this.maintChain()
        const flow = chain.addCurve(curve, PALETTE.amber, { speed: 0.55, opacity: 0.42 })
        await travel(this.ticker, tid, curve, 0.26, easeInOutCubic)
        flow.flash(0.8)
        this.group.remove(tid)
        chain.fadeOut(this.ticker, 0.45)
        // the revisit: this page is pruned, and the address that led here is dropped
        rec.page.dead = false
        void this.ticker.add(0.45, (k) => {
            const base = this.fillHex(rec.page)
            this.tmpColorC.setHex(0xc7ff5a).lerp(this.tmpColorA.setHex(base), k)
            if (k >= 0.999) this.tmpColorC.setHex(base)
            this.paintBlock(rec.page, this.tmpColorC.getHex())
        })
        this.chunks.release(rec.chunk)
    }

    private buildShell() {
        const shellH = 9.8

        const shellW = 26.0
        const shellD = 16.0

        const cage = new OutlineBox(shellW, shellH, shellD, 0x3fa8cc, 0.34)
        cage.fromFloor(0, 0, 0)
        this.group.add(cage)
        this.register(cage, {
            title: 'PostgreSQL',
            body: 'One running postgres instance — not a single process but a small family of them: a postmaster that listens and forks, one backend process per connection, plus the checkpointer, the WAL writer and autovacuum. Everything inside this cage — parser, planner, executor, buffers, WAL — is shared by them. Clients sit outside, in the sky.',
            meta: 'postmaster + backends + auxiliaries · shared memory',
        })

        const diskFloorPick = new THREE.Mesh(
            new THREE.BoxGeometry(DISK_FIELD.w, 0.3, DISK_FIELD.d),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        diskFloorPick.position.set(0, 0.15, DISK_FIELD.cz)
        this.group.add(diskFloorPick)
        this.register(diskFloorPick, {
            title: 'Disk — a field of 8 KiB pages',
            body: 'Every block is one 8 KiB page; brighter and taller means fuller. The grid under the blocks is the 4 KiB filesystem cell — two cells make one page — so a page covers two squares and the address lattice stays the unit the OS allocates in. Most of these pages belong to tables and indexes we do not draw — system catalogues, other tables — and each keeps its own slightly different shade. The three outlined runs are the tables we do label. The gaps are free space: no page there at all, just room the files can grow into. RAM only ever holds copies, so only copies float.',
            meta: 'disk · one block = 8 KiB page · lived-in, not a grid of blanks',
            stats: () => this.pageStats(this.pages8k),
        })

        const floorLab = floorLabel('DISK', { height: 0.475, color: 'rgba(170, 220, 242, 0.9)' })
        floorLab.rotation.z = Math.PI / 2
        const ink = floorLab.userData.ink as { x0: number; x1: number; y0: number; y1: number }

        floorLab.position.set(
            DISK_FIELD.w / 2 + DISK_LABEL_PAD + ink.y1,
            FLOOR_LABEL_Y,
            DISK_FIELD.cz + DISK_FIELD.d / 2 + ink.x0,
        )
        this.group.add(floorLab)

        const STICKER_INSET = 0.45
        const sticker = floorLabel('POSTGRESQL', {
            height: 0.475,
            color: 'rgba(170, 220, 242, 0.9)',
        })
        const inkSticker = sticker.userData.ink as {
            x0: number
            x1: number
            y0: number
            y1: number
        }

        sticker.rotation.set(0, Math.PI / 2, 0)
        sticker.position.set(
            shellW / 2 + 0.012,
            shellH - STICKER_INSET - inkSticker.y1,
            shellD / 2 - STICKER_INSET + inkSticker.x0,
        )

            ; (sticker.material as THREE.MeshBasicMaterial).side = THREE.FrontSide
        this.group.add(sticker)

        this.motes = dustField(shellW, shellH, shellD)
        this.group.add(this.motes)
    }

    private buildBufferPool() {
        const cols = BUFFER_COLS
        const rows = BUFFER_ROWS

        const corner = (col: number, row: number) =>
            new THREE.Vector3(
                bufferSlotX(col) + Math.sign(col === 0 ? -1 : 1) * PAGE_GRID.bw * 0.5,
                BUFFER_Y + PAGE_GRID.bh * 0.5,
                bufferSlotZ(row) + (row === 0 ? -1 : 1) * PAGE_GRID.bd * 0.5,
            )
        this.bufferCorners = {
            nearLeft: corner(0, rows - 1),
            nearRight: corner(cols - 1, rows - 1),
            farLeft: corner(0, 0),
            farRight: corner(cols - 1, 0),
        }

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const mat = glowMat(BUF_DARK, PALETTE.cyan, 0.22, {
                    metalness: 0.5,
                    roughness: 0.35,
                })
                const mesh = new THREE.Mesh(this.pageBlockGeo, mat)
                mesh.castShadow = false
                mesh.receiveShadow = false
                this.group.add(mesh)
                const fill = rand(0.18, 1)
                const page: Page = {
                    mesh,
                    mat,
                    base: new THREE.Color(PALETTE.cyan),
                    heat: rand(0, 0.25),
                    row: r,
                    col: c,
                    dirty: false,
                    fill,
                    block: null,
                }
                this.pages.push(page)
                this.setBufferFill(page, fill)
            }
        }

        const w = cols * PAGE_GRID.gx
        const d = rows * PAGE_GRID.gz
        const pick = new THREE.Mesh(
            new THREE.BoxGeometry(w, 0.8, d),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        pick.position.set(ANCHOR.bufferCenter.x, BUFFER_Y, ANCHOR.bufferCenter.z)
        this.group.add(pick)
        this.register(pick, {
            title: 'Shared buffers',
            body: 'The page cache every backend shares. Each block is one buffer slot holding a full 8 KiB page — identical to a page on disk. The slot is always 8 KiB; what varies is how packed the page inside is, and that is what brightness and height show. Lifecycle: a miss picks a victim with the clock sweep (usage_count 0), writes it back if it is dirty, then reads the new page in. The slot itself never moves — only which page lives in it changes. Hue is state: cyan = cached and clean, amber = dirty (waiting to be written), green = just served a hit.',
            meta: 'shared_buffers · RAM · 8 KiB pages · clock sweep',
            stats: () => {
                const slots = this.pages.length
                const total = slots * PAGE_BYTES
                let occupied = 0
                let used = 0
                let dirty = 0
                for (const p of this.pages) {
                    if (p.fill > 0.001) {
                        occupied++
                        used += p.fill * PAGE_BYTES
                    }
                    if (p.dirty) dirty++
                }
                return [
                    { label: 'slots', value: `${slots} × 8 KiB` },
                    { label: 'total', value: fmtBytes(total) },
                    { label: 'occupied', value: `${occupied} slots · ${fmtBytes(used)}` },
                    { label: 'dirty', value: `${dirty} slots` },
                ]
            },
        })
    }

    private setBufferFill(page: Page, fill: number) {
        page.fill = Math.max(0, Math.min(1, fill))
        page.mat.color.copy(BUF_FILL_DARK).lerp(BUF_FILL_BRIGHT, page.fill)
        const h = 0.5 + 0.5 * page.fill
        page.mesh.scale.y = h
        page.mesh.position.set(
            bufferSlotX(page.col),
            BUFFER_Y - PAGE_GRID.bh * (1 - h) * 0.5,
            bufferSlotZ(page.row),
        )
    }

    setPageFill(idx: number, fill: number) {
        const p = this.pages[idx]
        if (p) this.setBufferFill(p, fill)
    }

    async swapBufferPage(idx: number, fill: number, block?: Page8K | null) {
        const p = this.pages[idx]
        if (!p) return
        const from = p.fill
        await this.ticker.add(0.16, (k) => this.setBufferFill(p, from * (1 - k)))
        const to = fill
        await this.ticker.add(0.2, (k) => this.setBufferFill(p, to * k))
        p.block = block ?? null
    }

    private writeSlot(): { idx: number; page: Page } | null {
        if (this.pages.length === 0) return null
        const cached = this.pages
            .map((p, i) => ({ idx: i, page: p }))
            .filter(({ page }) => page.block?.table)
        if (cached.length > 0 && Math.random() < 0.75) return cached[randInt(0, cached.length - 1)]
        const blocks = this.tableBlocks.filter((b) => !b.busy)
        if (blocks.length === 0) return null
        const idx = randInt(0, this.pages.length - 1)
        const page = this.pages[idx]
        page.block = blocks[randInt(0, blocks.length - 1)]
        this.setBufferFill(page, page.block.fill)
        return { idx, page }
    }

    writeIntoBuffer(kind: 'insert' | 'delete'): { idx: number; page: Page; fill: number } | null {
        const slot = this.writeSlot()
        if (!slot) return null
        const { page } = slot
        const next =
            kind === 'insert'
                ? Math.min(1, page.fill + rand(0.15, 0.45))
                : page.fill < 0.4 && Math.random() < 0.55
                    ? 0
                    : Math.max(0, page.fill - rand(0.25, 0.6))
        this.setBufferFill(page, next)
        page.dirty = true
        page.base.set(PALETTE.amber)
        page.heat = 1
        return { idx: slot.idx, page, fill: next }
    }

    private buildWal() {
        const x0 = pageX(WAL_C0) - PAGE_GRID.gx / 2
        const x1 = pageX(WAL_C0 + WAL_LEN - 1) + PAGE_GRID.gx / 2
        const z0 = pageZ(WAL_ROW) - PAGE_GRID.gz / 2
        const z1 = pageZ(WAL_ROW) + PAGE_GRID.gz / 2
        const runEdge = new OutlineBox(x1 - x0, PAGE_CELL, z1 - z0, 0xffb03a, 0.75).centre(
            (x0 + x1) / 2,
            PAGE_Y,
            (z0 + z1) / 2,
        )
        this.group.add(runEdge)

        const pick = new THREE.Mesh(
            new THREE.BoxGeometry(x1 - x0, 1.4, z1 - z0),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        pick.position.set((x0 + x1) / 2, PAGE_Y + 0.5, (z0 + z1) / 2)
        this.group.add(pick)
        this.register(
            pick,
            {
                title: 'Write-ahead log (on disk)',
                body: 'A run of segment blocks in pg_wal, appended left to right on every change before the heap page is touched. The block currently being written is the WAL head: it stands up and pulses. Nothing floats above it. The newest bytes sit in wal_buffers — the floating cyan cubes above — and only reach disk when the WAL writer issues write + fsync; COMMIT does not return until that fsync finishes. The run is a ring, not a growing file: when the head reaches the end it wraps and writes over the oldest segment, which by then is behind the last checkpoint and no longer needed. That is why pg_wal has a bounded footprint instead of filling the disk.',
                meta: 'pg_wal · sequential blocks on disk · tail in wal_buffers · fsync',
                stats: () => this.pageStats(this.walBlocks),
            },
            runEdge,
        )

        const wb = new THREE.Group()
        const wbGeo = new RoundedBoxGeometry(PAGE_GRID.bw, PAGE_GRID.bh, PAGE_GRID.bd, 2, 0.025)
        for (let i = 0; i < WAL_BUF_LEN; i++) {
            const mat = new THREE.MeshStandardMaterial({
                color: 0x0b2a36,
                emissive: PALETTE.cyan,
                emissiveIntensity: 0.5,
                roughness: 0.35,
                metalness: 0.45,
                transparent: true,
                opacity: 0.94,
            })
            const m = new THREE.Mesh(wbGeo, mat)
            m.position.set((i - (WAL_BUF_LEN - 1) / 2) * PAGE_GRID.gx, 0, 0)
            m.add(neonEdges(wbGeo, 0x8fe6ff, 0.55))
            wb.add(m)
            this.walBufferMats.push(mat)
            this.walBufBlocks.push(m)
        }
        wb.position.set(pageX(WAL_C0 + WAL_LEN - 1), 1.95, pageZ(WAL_ROW))
        this.group.add(wb)
        this.walBufGroup = wb

        const wbPick = new THREE.Mesh(
            new THREE.BoxGeometry(WAL_BUF_LEN * PAGE_GRID.gx, 0.8, PAGE_GRID.bd * 1.3),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        wbPick.position.set(0, 0.1, 0)
        wb.add(wbPick)
        this.register(wbPick, {
            title: 'wal_buffers — the not-yet-written tail of the log',
            body: 'wal_buffers is a circular strip of 8 KiB shared-memory pages that holds the newest WAL records. It is NOT a copy of heap pages: the records describe changes to pages, but the buffer holds the log stream itself. Anything here is not durable yet — it becomes durable when the WAL writer writes it to the segment blocks below and fsyncs. After that the memory is simply overwritten, so these cubes are a staging area, and the segment below is the lasting artefact.',
            meta: 'wal_buffers · RAM · 8 KiB pages · circular · flushed by WAL writer',
            stats: () => {
                const cubes = this.walBufBlocks.length
                const total = cubes * PAGE_BYTES
                const fill = Math.max(0, Math.min(1, this.walBuffered))
                return [
                    { label: 'cubes', value: `${cubes} × 8 KiB` },
                    { label: 'total', value: fmtBytes(total) },
                    {
                        label: 'occupied',
                        value: `${fmtBytes(fill * total)} · ${Math.round(fill * 100)}%`,
                    },
                ]
            },
        })

        const wbLab = label('WAL BUFFERS')
        wbLab.position.set(0, 0.75, 0)
        wb.add(wbLab)

        const lab = label('WAL')
        lab.position.set(x0 + 0.4, PAGE_Y + 0.85, z1 + 0.15)
        this.group.add(lab)
    }

    private styleWal(time: number, dt: number) {
        const len = this.walBlocks.length
        const head = this.walHeadIndex
        const live = Math.min(len, Math.max(1, this.walWritten))
        for (let i = 0; i < len; i++) {
            const p = this.walBlocks[i]
            if (p.busy) continue
            const behind = (head - i + len) % len
            const on = behind < live
            const isHead = i === head
            const boost = this.walBoost.get(i) ?? 0
            if (boost > 0) {
                const next = boost * (1 - Math.min(1, dt * 2.6))
                if (next < 0.03) this.walBoost.delete(i)
                else this.walBoost.set(i, next)
            }

            const fill = isHead ? Math.max(0.08, this.walProgress) : on ? 1 : 0
            const base = isHead ? 0xffc76b : on ? 0xc9822a : 0x140f07
            const k = (isHead ? 0.82 + 0.18 * breathe(time, 2.2, 0) : 1) + boost * 0.6
            this.tmpColorC.setHex(base).multiplyScalar(k)
            this.paintBlock(p, this.tmpColorC.getHex())
            p.fill = fill
            this.applyTransform(
                p,
                1,
                on || isHead ? this.blockScale(fill) : this.blockScale(0) * 0.35,
            )
        }
    }

    flashWalSegment(i: number) {
        this.walBoost.set(i, 1)
    }

    walSlot(i: number) {
        return new THREE.Vector3(pageX(WAL_C0 + (WAL_LEN - 1 - i)), PAGE_Y, pageZ(WAL_ROW))
    }

    private buildPageField() {
        const { cols, rows, bw, bh, bd } = PAGE_GRID
        const geo = new RoundedBoxGeometry(bw, bh, bd, 1, 0.02)
        const mat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            emissive: PALETTE.amber,
            emissiveIntensity: 0.14,
            roughness: 0.5,
            metalness: 0.3,
        })
        const field = new THREE.InstancedMesh(geo, mat, cols * rows)
        field.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        field.castShadow = true
        field.receiveShadow = true
        this.group.add(field)
        this.pageField = field
        field.userData.infoFor = (hit: THREE.Intersection) => this.blockPick(hit)
        this.pickables.push(field)

        const inTable = (r: number, c: number) =>
            TABLE_REGIONS.some((t) => r >= t.r0 && r <= t.r1 && c >= t.c0 && c <= t.c1)

        const freeAt = (c: number) =>
            fragmentedFree(c, cols, { packed: 0.6, allFree: 0.8, maxFree: 0.9 })

        const dummy = new THREE.Object3D()
        const hints = [PALETTE.teal, PALETTE.violet, 0x5a7bff, PALETTE.amber]
        let i = 0
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const home = new THREE.Vector3(pageX(c), PAGE_Y, pageZ(r))
                const table = inTable(r, c)
                const onWal = r === WAL_ROW && c >= WAL_C0 && c < WAL_C0 + WAL_LEN
                const free = !table && !onWal && freeAt(c)

                dummy.position.copy(home)
                if (free) {
                    dummy.scale.setScalar(0.001)
                } else {
                    dummy.scale.set(1, 1, 1)
                }
                dummy.updateMatrix()
                field.setMatrixAt(i, dummy.matrix)

                const block: Page8K = {
                    i,
                    home,
                    row: r,
                    col: c,
                    color: BLOCK_FREE,
                    table: null,
                    fill: free || table || onWal ? 0 : rand(0.1, 1),
                    shade: rand(0.8, 1.14),
                    hint: hints[randInt(0, hints.length - 1)],
                    hintAmt: free ? 0 : Math.random() < 0.4 ? rand(0.05, 0.16) : 0,
                    free,
                    system: null,
                    dead: false,
                    busy: false,
                }
                this.pages8k.push(block)
                if (onWal) this.walBlocks.unshift(block)
                i++
            }
        }
        this.pages8k.forEach((p) => {
            if (!p.free) this.setFill(p, p.fill)
        })
        this.markSystemAreas()

        this.group.add(
            slotLattice(
                pageX(0) - PAGE_GRID.gx / 2,
                pageX(cols - 1) + PAGE_GRID.gx / 2,
                pageZ(0) - PAGE_GRID.gz / 2,
                pageZ(rows - 1) + PAGE_GRID.gz / 2,
                PAGE_CELL,
                PAGE_CELL,
            ),
        )

        this.liftMesh = new THREE.Mesh(
            geo.clone(),
            new THREE.MeshStandardMaterial({
                color: 0xffffff,
                emissive: PALETTE.amber,
                emissiveIntensity: 2.4,
                roughness: 0.35,
                metalness: 0.3,
            }),
        )
        this.liftMesh.visible = false
        this.group.add(this.liftMesh)
    }

    paintBlock(p: Page8K, hex: number) {
        const field = this.pageField
        if (!field) return
        field.setColorAt(p.i, this.tmpColor.setHex(hex))
        if (field.instanceColor) field.instanceColor.needsUpdate = true
    }

    private paintPageLit(p: Page8K, base: number, v: number) {
        const field = this.pageField
        if (!field) return
        const c = this.tmpColorA
            .setHex(base)
            .lerp(this.tmpColorB.setHex(pulseHex(base)), Math.min(1, v))
            .multiplyScalar(1 + (PULSE_GAIN - 1) * Math.min(1, v))
        field.setColorAt(p.i, c)
        if (field.instanceColor) field.instanceColor.needsUpdate = true
    }

    private fillHex(p: Page8K) {
        if (p.fill <= 0.001) {
            return this.tmpColorA.setHex(BLOCK_FREE).multiplyScalar(p.shade).getHex()
        }
        const ramp = this.tmpColorA
            .setHex(FILL_DARK)
            .lerp(this.tmpColorB.setHex(FILL_BRIGHT), p.fill)
        if (p.table) ramp.lerp(this.tmpColorB.setHex(p.color), 0.28)
        if (p.hintAmt > 0) ramp.lerp(this.tmpColorB.setHex(p.hint), p.hintAmt)
        ramp.multiplyScalar(p.shade)
        return ramp.getHex()
    }

    private blockScale(fill: number) {
        return 0.45 + 0.55 * fill
    }

    blockTop(p: Page8K): THREE.Vector3 {
        const h = PAGE_GRID.bh * this.blockScale(p.fill)
        return p.home.clone().setY(p.home.y - PAGE_GRID.bh / 2 + h)
    }

    pageTop(p: Page): THREE.Vector3 {
        return p.mesh.position.clone().setY(p.mesh.position.y + (PAGE_GRID.bh / 2) * p.mesh.scale.y)
    }

    blockPick(hit: THREE.Intersection): BlockPick | null {
        const id = hit.instanceId
        if (id === undefined) return null
        const p = this.pages8k[id]
        if (!p || p.free) return null
        if (hit.distance > BLOCK_PICK_RANGE) return null
        const walIdx = this.walBlocks.indexOf(p)
        if (walIdx >= 0) {
            return {
                key: `wal-${walIdx}`,
                info: this.walSegmentInfo(walIdx),
                box: this.blockBox(p),
            }
        }
        if (p.system) {
            return { key: `sys-${p.i}`, info: this.systemInfo(p), box: this.blockBox(p) }
        }
        return { key: `page-${p.i}`, info: this.blockInfo(p), box: this.blockBox(p) }
    }

    private systemInfo(p: Page8K): Info {
        const run = SYSTEM_RUNS.find((r) => r.area === p.system)
        if (!run) return this.blockInfo(p)
        const file = run.files[(p.col - run.c0) % run.files.length]
        const pageInFile = p.row - run.rows[0] + Math.floor((p.col - run.c0) / run.files.length)
        return {
            title: `${file} · system page`,
            body:
                `${run.what} This particular block is one 8 KiB page of ${file}. It is drawn grey because it is ` +
                `not user data: you cannot query it as a table, and VACUUM writes into it rather than reclaiming ` +
                `it. In a real PGDATA these live in base/<dboid>/ next to the heap files, plus pg_xact for the ` +
                `commit status — small, but every query touches them.`,
            meta: `${run.label.toLowerCase()} · page ${pageInFile} of ${file} · postgres-owned, not your data`,
        }
    }

    private blockBox(p: Page8K): THREE.Box3 {
        const half = PAGE_GRID.bh / 2
        const h = PAGE_GRID.bh * this.blockScale(p.fill)
        const y0 = p.home.y - half
        return new THREE.Box3(
            new THREE.Vector3(p.home.x - PAGE_GRID.bw / 2, y0, p.home.z - PAGE_GRID.bd / 2),
            new THREE.Vector3(p.home.x + PAGE_GRID.bw / 2, y0 + h, p.home.z + PAGE_GRID.bd / 2),
        ).translate(POSTGRES_ORIGIN)
    }

    blockInfo(p: Page8K): Info {
        const start = p.i * PAGE_BYTES
        const end = start + PAGE_BYTES - 1
        const packed = Math.round(p.fill * 100)
        const owner = p.table
            ? `the heap file of TABLE: ${p.table}`
            : 'a relation the scene does not label'
        const KiB = (n: number) => (n / 1024).toFixed(1).replace(/\.0$/, '')
        const dead = p.dead
            ? ' It currently holds dead row versions — VACUUM will reclaim the space inside this page.'
            : ''
        return {
            title: `Page ${p.i} · 8 KiB contiguous`,
            body:
                `A block is one contiguous 8 KiB stretch of a file — the smallest unit Postgres ever reads or ` +
                `writes, and the unit shared_buffers caches. It is not a row and not a table: rows are packed ` +
                `into the front of it, left to right, and the free space left over sits in the middle. Reading ` +
                `"one page" therefore means one 8192-byte request, never a partial read. This one belongs to ` +
                `${owner} and is ${packed}% full: taller and brighter means more of its bytes are in use.` +
                dead,
            meta:
                `bytes ${start}–${end} · page ${p.i} of the file · ${packed}% packed` +
                ` · ${KiB(PAGE_BYTES)} KiB block${p.dead ? ' · dead tuples' : ''}`,
        }
    }

    walSegmentInfo(i: number): Info {
        const len = this.walBlocks.length
        const head = this.walHeadIndex
        const behind = (head - i + len) % len
        const live = Math.min(len, Math.max(1, this.walWritten))
        const isHead = i === head
        const start = i * WAL_SEGMENT_BYTES
        const end = start + WAL_SEGMENT_BYTES - 1
        const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MiB`
        const written = isHead ? this.walProgress : behind < live ? 1 : 0
        const state = isHead
            ? `the head, ${Math.round(written * 100)}% written`
            : written > 0
                ? 'written and waiting to be recycled'
                : 'recyclable — its bytes stay until the head comes round again'
        return {
            title: `WAL segment ${i} · ${mb(WAL_SEGMENT_BYTES)} contiguous`,
            body:
                `A segment is one contiguous file of ${mb(WAL_SEGMENT_BYTES)} in pg_wal, and the log is little ` +
                `more than a numbered list of them. Records are appended to the current one until it is full, ` +
                `then the head moves to the next number. The run has a fixed footprint: once it reaches the end ` +
                `the head wraps and writes over the oldest segment, which by then sits behind the last ` +
                `checkpoint and is no longer needed. Height and brightness here are how much of the segment is ` +
                `written, so an empty head means nothing has landed in it yet.`,
            meta: `bytes ${start}–${end} · segment ${i + 1} of ${len} · ${state}`,
        }
    }

    private applyTransform(p: Page8K, scale: number, sy?: number) {
        const d = this.dummy
        d.position.copy(p.home)
        d.rotation.set(0, 0, 0)
        d.scale.set(scale, scale, scale)
        if (sy !== undefined) {
            d.scale.y = sy
            d.position.y = p.home.y + (PAGE_GRID.bh / 2) * (sy - 1)
        }
        d.updateMatrix()
        this.pageField.setMatrixAt(p.i, d.matrix)
        this.pageField.instanceMatrix.needsUpdate = true
    }

    setFill(p: Page8K, fill: number) {
        p.fill = Math.max(0, Math.min(1, fill))
        this.paintBlock(p, this.fillHex(p))
        this.applyTransform(p, 1, this.blockScale(p.fill))
    }

    private hideBlock(p: Page8K) {
        this.applyTransform(p, 0.001)
    }

    private showBlock(p: Page8K) {
        this.applyTransform(p, 1, this.blockScale(p.fill))
    }

    touchBlocks(blocks: Page8K[], hex: number, dur = PULSE_TIME, lift = 1.35) {
        for (const p of blocks) this.paintPageLit(p, hex, 1)
        for (const p of blocks) {
            const liftBy = this.blockScale(p.fill) * lift
            this.applyTransform(p, 1, liftBy)
            void this.ticker
                .add(dur, (k) => {
                    this.paintPageLit(p, hex, 1 - k)
                })
                .then(() => {
                    if (p.busy) return
                    this.paintBlock(p, this.fillHex(p))
                    this.showBlock(p)
                })
        }
    }

    private markSystemAreas() {
        let c0 = Infinity
        let c1 = -Infinity
        let r0 = Infinity
        let r1 = -Infinity
        const pages: Page8K[] = []
        for (const run of SYSTEM_RUNS) {
            for (let r = run.rows[0]; r <= run.rows[1]; r++) {
                for (let c = run.c0; c <= run.c1; c++) {
                    const p = this.pages8k.find((b) => b.row === r && b.col === c)
                    if (!p || p.free) continue
                    p.system = run.area
                    pages.push(p)
                    p.hint = SYSTEM_GREY
                    p.hintAmt = 0.92
                    p.shade = rand(0.86, 1.04)
                    this.setFill(p, rand(0.16, 0.42))
                    c0 = Math.min(c0, c)
                    c1 = Math.max(c1, c)
                    r0 = Math.min(r0, r)
                    r1 = Math.max(r1, r)
                }
            }
        }
        if (c1 < c0) return

        const x0 = pageX(c0) - PAGE_GRID.gx / 2
        const x1 = pageX(c1) + PAGE_GRID.gx / 2
        const z0 = pageZ(r0) - PAGE_GRID.gz / 2
        const z1 = pageZ(r1) + PAGE_GRID.gz / 2
        const cx = (x0 + x1) / 2
        const cz = (z0 + z1) / 2

        const cage = new OutlineBox(x1 - x0, PAGE_CELL, z1 - z0, SYSTEM_GREY, 0.5).centre(
            cx,
            PAGE_Y,
            cz,
        )
        this.group.add(cage)

        const pick = new THREE.Mesh(
            new THREE.BoxGeometry(x1 - x0, 1.2, z1 - z0),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        pick.position.set(cx, PAGE_Y + 0.2, cz)
        this.group.add(pick)
        this.register(
            pick,
            {
                title: 'PG SYSTEM — what postgres keeps for itself',
                body:
                    'Not all of pgdata is your data. Inside this cage: the catalog relations every database carries ' +
                    'a copy of (what each table is, what columns it has, what depends on what), the free space and ' +
                    'visibility maps that sit beside each relation, and the commit log. They are ordinary 8 KiB pages ' +
                    'like everything else here — the same block size, the same buffer pool — they are just small, ' +
                    'because there are few of them: a fresh cluster holds the whole set in a few megabytes. Hover a ' +
                    'grey block to see which file it belongs to.',
                meta: 'catalogs · free space map · visibility map · commit log · 8 KiB pages',
                stats: () => this.pageStats(pages),
            },
            cage,
        )

        const lab = label('PG SYSTEM')
        lab.position.set(x0 + 0.45, PAGE_Y + 0.95, z1 + 0.1)
        this.group.add(lab)
    }

    pickBlockForRead(): Page8K | null {
        const filled = this.tableBlocks.filter((b) => b.fill > 0.001 && !b.busy)
        if (filled.length === 0) return null
        return filled[randInt(0, filled.length - 1)]
    }

    async compact(): Promise<{ table: string; pages: number }> {
        const region = TABLE_REGIONS[randInt(0, TABLE_REGIONS.length - 1)]
        const blocks = this.tableBlocks
            .filter((b) => b.table === region.label)
            .sort((a, b) => a.row - b.row || a.col - b.col)
        if (blocks.length === 0) return { table: region.label, pages: 0 }

        const before = blocks.map((b) => b.fill)
        const packed = before.filter((f) => f > 0.001).sort((a, b) => b - a)
        const after = blocks.map((_, i) => (i < packed.length ? packed[i] : 0))

        await this.ticker.add(0.9, (k) => {
            blocks.forEach((b, i) => {
                const stagger = Math.min(1, Math.max(0, k * 1.7 - i / blocks.length))
                this.setFill(b, before[i] + (after[i] - before[i]) * easeInOutCubic(stagger))
            })
        })
        this.touchBlocks(blocks, 0x9be8ff, PULSE_TIME, 1.15)
        await this.ticker.wait(0.3)
        return { table: region.label, pages: packed.length }
    }

    settlePage(p: Page8K) {
        this.setFill(p, p.fill)
    }

    private pageStats(blocks: Page8K[]): StatLine[] {
        const pages = blocks.length
        const total = pages * PAGE_BYTES
        let occupiedPages = 0
        let occupiedBytes = 0
        let deadPages = 0
        for (const b of blocks) {
            if (b.fill > 0.001) {
                occupiedPages++
                occupiedBytes += b.fill * PAGE_BYTES
            }
            if (b.dead) deadPages++
        }
        const avgFill = occupiedPages > 0 ? occupiedBytes / (occupiedPages * PAGE_BYTES) : 0
        return [
            { label: 'blocks', value: `${pages} × 8 KiB` },
            { label: 'total', value: fmtBytes(total) },
            { label: 'occupied', value: `${occupiedPages} pages · ${fmtBytes(occupiedBytes)}` },
            { label: 'free slots', value: `${pages - occupiedPages} pages` },
            { label: 'avg fill', value: occupiedPages > 0 ? `${Math.round(avgFill * 100)}%` : '—' },
            ...(deadPages > 0 ? [{ label: 'dead pages', value: String(deadPages) }] : []),
        ]
    }

    private buildTableRegions() {
        for (const region of TABLE_REGIONS) {
            const blocks: Page8K[] = []
            for (let r = region.r0; r <= region.r1; r++) {
                for (let c = region.c0; c <= region.c1; c++) {
                    const p = this.pages8k.find((b) => b.row === r && b.col === c)
                    if (!p) continue
                    p.table = region.label
                    p.color = region.color
                    const initial = Math.random() < 0.84 ? rand(0.18, 1) : 0
                    p.shade = rand(0.82, 1.12)
                    this.setFill(p, initial)
                    blocks.push(p)
                }
            }
            this.tableBlocks.push(...blocks)

            const x0 = pageX(region.c0) - PAGE_GRID.bw / 2 - 0.09
            const x1 = pageX(region.c1) + PAGE_GRID.bw / 2 + 0.09
            const z0 = pageZ(region.r0) - PAGE_GRID.bd / 2 - 0.09
            const z1 = pageZ(region.r1) + PAGE_GRID.bd / 2 + 0.09
            const w = x1 - x0
            const d = z1 - z0
            const cx = (x0 + x1) / 2
            const cz = (z0 + z1) / 2
            const h = PAGE_CELL

            const edges = new OutlineBox(w, h, d, region.color, 0.85).centre(cx, PAGE_Y, cz)
            this.group.add(edges)

            const pick = new THREE.Mesh(
                new THREE.BoxGeometry(w, h + 0.7, d),
                new THREE.MeshBasicMaterial({ visible: false }),
            )
            pick.position.set(cx, PAGE_Y + h / 2, cz)
            this.group.add(pick)
            this.register(pick, { ...region.info, stats: () => this.pageStats(blocks) }, edges)

            const stagger = TABLE_REGIONS.findIndex((r) => r.label === region.label) * 0.45
            const lab = label(`TABLE: ${region.label}`)
            lab.position.set(cx, PAGE_Y + h + 0.55 + stagger, cz)
            this.group.add(lab)

            ANCHOR[region.anchor].set(cx, PAGE_Y, cz)
        }

        const freeLab = floorLabel('FREE SPACE', {
            height: 0.58,
            color: 'rgba(128, 158, 178, 0.85)',
            opacity: 0.55,
            weight: 400,
        })
        freeLab.rotation.z = Math.PI / 2
        freeLab.position.set(pageX(5), FLOOR_LABEL_Y, pageZ(14))
        this.group.add(freeLab)

        const freePick = new THREE.Mesh(
            new THREE.BoxGeometry(3.2, 0.7, 4.6),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        freePick.position.set(pageX(5), PAGE_Y, pageZ(14))
        this.group.add(freePick)
        freePick.userData.noOutline = true
        this.register(freePick, {
            title: 'Free space — room the files can grow into',
            body: 'These slots hold no page at all. A table or index is a contiguous run of 8 KiB pages, so when a relation runs out of pages it simply takes the next slots in its own file — this is where that growth comes from. Free space is not a fixed size and nothing owns it in advance: the files claim it as they fill. A table that was rewritten by VACUUM FULL gives slots back here.',
            meta: 'unallocated · no page on disk · allocated on demand',
        })
    }

    private buildLocks() {
        this.locks = new LockRack(this.ticker)
        this.group.add(this.locks.group)

        const b = LOCK_RACK
        const pick = new THREE.Mesh(
            new THREE.BoxGeometry(b.w + 0.5, b.h + 0.5, b.d + 1.9),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        pick.position.set(b.x, b.y, b.z + 0.35)
        this.group.add(pick)
        this.register(
            pick,
            {
                title: 'Lock manager',
                body: `One block per locked object, a pip per holder. This is the table that has no pages. Every lock a transaction takes on a table, an index or a transaction id is an entry in a hash inside the main shared memory segment, allocated once at startup from max_connections × max_locks_per_transaction and never grown afterwards. The entry is keyed by what is being locked, so it is one block per object and not one per session: three readers of the same table share one block, and each backend holding it is a pip on its front, which is what the row in pg_locks with granted = true is. The colour is the mode. The mode is what decides who may sit beside whom: AccessShare conflicts with nothing except the exclusive modes, RowExclusive still shares with readers, and AccessExclusive — ALTER TABLE, DROP, TRUNCATE — shares with nobody, which is why a statement that runs in milliseconds can hold up every SELECT on the table for as long as it has to queue for it. A backend whose mode conflicts gets no pip and does not spin: it records granted = false, joins a queue on that entry and sleeps on a semaphore, which is what surfaces as wait_event = Lock. Nothing in this queue is about rows. A row lock is a bit in the tuple header, so an UPDATE of a million rows adds no entries at all; what a second session waits on is the holder’s transaction id, one entry keyed by the transaction that covers every row it has locked. Hooks go when the transaction ends, not when the statement does, which is why one idle-in-transaction session stalls everything behind it — and after deadlock_timeout a waiter builds a wait-for graph and aborts one transaction to break a cycle. Run out of entries and the statement fails outright: out of shared memory, increase max_locks_per_transaction.`,
                meta: 'lock table · shared memory · always sized up front · row locks live in the tuple header',
                stats: () => [
                    { label: 'entries', value: `${this.lockHeld} of ${LOCK_SLOTS} blocks` },
                    { label: 'holders', value: `${this.lockHolders} pips` },
                    {
                        label: 'waiting',
                        value: `${this.lockWaiting} backend${this.lockWaiting === 1 ? '' : 's'}`,
                    },
                    { label: 'sized by', value: 'max_connections × max_locks_per_transaction' },
                    { label: 'released', value: 'at COMMIT, not at statement end' },
                ],
            },
            this.locks.cage,
        )
    }

    /**
     * One entry per locked object, one pip per backend holding it. The entry is tethered to
     * the relation on the plate, so the block on the rack is visibly *about* something.
     */
    holdLock(relation: string, mode: LockMode, aim?: THREE.Vector3) {
        const { slot, created } = this.locks.acquire(relation, mode)
        if (slot < 0 || !aim || !created) return slot
        this.tether(relation, slot, mode, aim)
        return slot
    }

    private tether(relation: string, slot: number, mode: LockMode, aim: THREE.Vector3) {
        const line = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([this.locks.slotPoint(slot), aim.clone()]),
            new THREE.LineBasicMaterial({
                color: LOCK_COLOUR[mode],
                transparent: true,
                opacity: 0.45,
            }),
        )
        this.group.add(line)
        this.lockTethers.set(relation, line)
    }

    private dropTether(relation: string) {
        const line = this.lockTethers.get(relation)
        if (!line) return
        this.group.remove(line)
        line.geometry.dispose()
            ; (line.material as THREE.Material).dispose()
        this.lockTethers.delete(relation)
    }

    releaseLock(relation: string) {
        this.dropTether(relation)
        this.locks.release(relation)
    }

    releaseLocks() {
        for (const relation of [...this.lockTethers.keys()]) this.dropTether(relation)
        this.locks.releaseAll()
    }

    /** A statement asking for a lock: granted now, or refused and left to queue. */
    lockAsk(relation: string, mode: LockMode, aim?: THREE.Vector3) {
        const before = this.locks.fits(relation, mode)
        const { slot, created, granted } = this.locks.acquire(relation, mode)
        if (granted && created && aim) this.tether(relation, slot, mode, aim)
        return { granted, slot, wasFree: before }
    }

    /** One backend's hook goes; when the last one does, the entry drains and its tether with it. */
    lockDrop(relation: string) {
        this.locks.unlock(relation)
        if (this.locks.held === 0 || !this.locks.locked(relation)) this.dropTether(relation)
    }

    lockFits(relation: string, mode: LockMode) {
        return this.locks.fits(relation, mode)
    }

    lockQueuePoint(index = 0) {
        return this.locks.queuePoint(index)
    }

    lockSlotOf(relation: string) {
        return this.locks.slotOf(relation)
    }

    /** A refusal flashes the cage, so the queue is noticed even with the camera wide. */
    pulseLockCage() {
        this.lockPulse = 1
    }

    parkLock(mode: LockMode, target: number) {
        return this.locks.park(mode, target)
    }

    admitLock(wait: LockWait, relation = 'relation') {
        return this.locks.admit(wait, relation)
    }

    clearLocks() {
        for (const relation of [...this.lockTethers.keys()]) this.dropTether(relation)
        this.locks.clear()
    }

    lockRackBox() {
        // Layout coords are the instance's own; the cage is placed by setOrigin, so the
        // subject the camera frames has to be moved into world space like every other box.
        return this.locks.bounds.translate(POSTGRES_ORIGIN)
    }

    private buildBackends() {
        const slots = BACKEND_SLOTS
        const ringGeo = new THREE.TorusGeometry(0.34, 0.05, 8, 28)
        const pickGeo = new THREE.BoxGeometry(0.9, 0.5, 0.9)
        const cellGeo = new THREE.BoxGeometry(INBUF_CELL.w, INBUF_CELL.h, INBUF_CELL.d)

        slots.forEach((x, i) => {
            const g = new THREE.Group()
            g.position.set(x, BACKEND_ORIGIN.y, BACKEND_ORIGIN.z)
            g.visible = false

            const ring = new THREE.MeshStandardMaterial({
                color: 0x0b1a24,
                emissive: PALETTE.cyan,
                emissiveIntensity: 0.9,
                roughness: 0.3,
                metalness: 0.5,
            })
            const ringMesh = new THREE.Mesh(ringGeo, ring)
            ringMesh.rotation.x = Math.PI / 2
            g.add(ringMesh)

            const glow = new THREE.SpriteMaterial({
                map: radialTexture(),
                color: PALETTE.cyan,
                transparent: true,
                opacity: 0,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
            })
            const sprite = new THREE.Sprite(glow)
            sprite.scale.setScalar(2.0)
            g.add(sprite)

            const pick = new THREE.Mesh(pickGeo, new THREE.MeshBasicMaterial({ visible: false }))
            pick.userData.info = {
                title: `Backend · connection ${i + 1}`,
                body: 'One live client connection, handled by its own backend process, forked by the postmaster when the client connected. It parses, plans and executes its own queries in its own address space, then returns the result through this same slot. That is why the boxes above it are that backend\u2019s private memory and die with it, and why the bill is per connection: a few megabytes each, capped by max_connections. The redis cage next door serves the same kind of socket from one thread and a kernel fd set, which is the whole reason it can hold two orders of magnitude more of them.',
                meta: 'process · ~5 MiB private heap · MaxConnections 100',
            }

            this.group.add(g)
            g.add(pick)

            const cells: THREE.Mesh[] = []
            for (let c = 0; c < INBUF_CELLS; c++) {
                const cell = new THREE.Mesh(
                    cellGeo,
                    new THREE.MeshStandardMaterial({
                        color: 0x0a1118,
                        emissive: PALETTE.cyan,
                        emissiveIntensity: 1,
                        roughness: 0.4,
                    }),
                )
                cell.position.set(0, INBUF_BOTTOM + c * INBUF_PITCH, 0)
                cell.visible = false
                g.add(cell)
                cells.push(cell)
            }

            const bufPick = new THREE.Mesh(
                new THREE.BoxGeometry(0.7, 2.0, 0.7),
                new THREE.MeshBasicMaterial({ visible: false }),
            )
            bufPick.position.set(0, INBUF_BOTTOM + (INBUF_CELLS - 1) * INBUF_PITCH * 0.5, 0)
            g.add(bufPick)
            this.register(bufPick, {
                title: 'Backend input buffer',
                body: 'Each backend reads its connection into a private buffer in its own process memory — 8 KiB to start, grown as needed. This is per-process heap, not shared_buffers: no other backend can see it. The wire from the client comes down into the port, requests stack up above it, and the one at the bottom is what the backend is executing right now. Cyan is executing, violet is already received and waiting. A connection runs one statement at a time, in order — this is where pipelining waits.',
                meta: 'per-connection RAM · private heap · pipelining waits here',
            })

            this.backends.push({
                id: i,
                group: g,
                ring,
                glow,
                pick,
                active: false,
                busy: false,
                index: i,
                pulse: 0,
                inbuf: 0,
                pending: 0,
                cells,
                pipeline: this.buildProcessPipeline(i, x),
            })
        })
    }

    private findBackend(id: number) {
        return this.backends.find((b) => b.id === id)
    }

    openBackend(): BackendPod | null {
        const free = this.backends.find((b) => !b.active)
        if (!free) return null
        free.active = true
        free.busy = false
        free.inbuf = 0
        free.pending = 0
        free.pipeline.group.visible = true
        return free
    }

    closeBackend(): boolean {
        const idle = this.backends.filter(
            (b) => b.active && !b.busy && b.inbuf === 0 && b.pending === 0,
        )
        if (idle.length === 0) return false
        const victim = idle[randInt(0, idle.length - 1)]
        victim.active = false
        victim.busy = false
        victim.inbuf = 0
        victim.pending = 0
        victim.pipeline.group.visible = false
        return true
    }

    closeIdleBackendsTo(keep: number) {
        while (this.activeBackendCount > keep && this.closeBackend()) { }
    }

    acquireBackend(): BackendPod | null {
        const active = this.backends.filter((b) => b.active)
        const idle = active.filter((b) => !b.busy)
        if (idle.length > 0) {
            const pod = idle[randInt(0, idle.length - 1)]
            pod.busy = true
            return pod
        }
        if (active.length === 0) {
            const first = this.openBackend()
            if (!first) return null
            first.busy = true
            return first
        }
        const opened = this.openBackend()
        if (!opened) return null
        opened.busy = true
        return opened
    }

    releaseBackend(pod: BackendPod) {
        const b = this.findBackend(pod.id)
        if (b) b.busy = false
    }

    pulseBackend(pod: BackendPod) {
        const b = this.findBackend(pod.id)
        if (b) b.pulse = 1
    }

    backendBufferExit(pod: BackendPod) {
        const head = pod.cells[0]
        const out = pod.group.position.clone().add(head.position)
        out.y -= INBUF_CELL.h / 2
        return out
    }

    backendBufferEntry(pod: BackendPod, queued: number) {
        const cell = pod.cells[Math.min(INBUF_CELLS - 1, Math.max(0, queued))]
        const out = pod.group.position.clone().add(cell.position)
        out.y += INBUF_CELL.h / 2
        return out
    }

    get activeBackendCount() {
        return this.backends.filter((b) => b.active).length
    }

    get busyBackendCount() {
        return this.backends.filter((b) => b.active && b.busy).length
    }

    get backendStates() {
        return this.backends.filter((b) => b.active).map((b) => b.busy)
    }

    get maxBackendCount() {
        return this.backends.length
    }

    private buildProcessPipeline(index: number, x: number): ProcessPipeline {
        const group = new THREE.Group()
        this.group.add(group)

        const defs: {
            name: PostgresqlNodeName
            z: number
            color: number
            text: string
            info: Info
        }[] = [
                {
                    name: PostgresqlNodeName.Parse,
                    z: PROCESS.zParse,
                    color: PALETTE.cyan,
                    text: 'PARSER',
                    info: {
                        title: 'Parser + rewriter',
                        body: 'The SQL text becomes a parse tree, syntax is checked, and the rewriter expands views and rules before planning.',
                        meta: 'raw_parser · rewrite',
                    },
                },
                {
                    name: PostgresqlNodeName.Plan,
                    z: PROCESS.zPlan,
                    color: PALETTE.violet,
                    text: 'PLANNER',
                    info: {
                        title: 'Planner / optimizer',
                        body: 'A cost-based optimizer enumerates access paths — seq scan, index scan, nested loop, hash join — estimates rows from statistics, and keeps the cheapest plan.',
                        meta: 'pg_planner · cost model',
                    },
                },
                {
                    name: PostgresqlNodeName.Exec,
                    z: PROCESS.zExec,
                    color: PALETTE.teal,
                    text: 'EXECUTOR',
                    info: {
                        title: 'Executor',
                        body: 'Walks the plan tree tuple by tuple, evaluating quals, joins and aggregates. Every page request goes through the buffer manager. Rows do not go to a separate stage: the executor hands them to the connection protocol as it produces them, so the answer streams out of the same port the query came in on.',
                        meta: 'executor · volcano model · rows stream to the client',
                    },
                },
            ]

        const nodes = {} as Record<PostgresqlNodeName, PipelineNode>
        for (const def of defs) {
            const pos = new THREE.Vector3(x, PROCESS.y, def.z)
            const node = new THREE.Group()
            node.position.copy(pos)

            const coreMat = new THREE.MeshStandardMaterial({
                color: 0x08131c,
                emissive: def.color,
                emissiveIntensity: 0.45,
                roughness: 0.25,
                metalness: 0.5,
            })
            const core = new THREE.Mesh(new THREE.IcosahedronGeometry(PROCESS.coreR, 1), coreMat)
            node.add(core)

            const cageMat = new THREE.MeshStandardMaterial({
                color: 0x0d2431,
                emissive: def.color,
                emissiveIntensity: 0.3,
                wireframe: true,
                transparent: true,
                opacity: 0.55,
            })
            const cage = new THREE.Mesh(new THREE.IcosahedronGeometry(PROCESS.cageR, 1), cageMat)
            node.add(cage)

            const ring = new THREE.Mesh(
                new THREE.TorusGeometry(PROCESS.ringR, 0.014, 6, 48),
                new THREE.MeshBasicMaterial({
                    color: def.color,
                    transparent: true,
                    opacity: 0.65,
                    blending: THREE.AdditiveBlending,
                }),
            )
            ring.rotation.x = Math.PI / 2
            node.add(ring)

            node.add(halo(def.color, PROCESS.haloR, 0.18))

            const lab = label(def.text)
            lab.position.set(PROCESS.ringR + 0.16, 0.05, 0)
            node.add(lab)

            this.register(node, {
                ...def.info,
                title: `${def.info.title} · process ${index + 1}`,
            })
            group.add(node)
            nodes[def.name] = {
                group: node,
                core: coreMat,
                cage: cageMat,
                ring,
                baseScale: 1,
                home: pos.clone(),
                pulse: 0,
            }
        }

        const cage = new OutlineBox(PROCESS.w, PROCESS.h, PROCESS.d, PALETTE.cyan, 0.45, {
            dashed: true,
        }).centre(x, PROCESS.y, (PROCESS.zParse + PROCESS.zExec) / 2)
        group.add(cage)
        this.register(cage, {
            title: `Process ${index + 1} — parser → planner → executor`,
            body: 'Each live backend owns its own parser, planner and executor, running in its own process. A statement arrives on this connection, becomes a parse tree, is costed into a plan and is executed here — and while this process is executing, another backend can be parsing or planning its own statement. That is the parallelism this lane makes visible. What the processes share is below the dashed box: one buffer pool, one WAL, one disk.',
            meta: 'backend process · private pipeline · one statement at a time',
        })

        const lab = label(`PROCESS ${index + 1}`)
        lab.position.set(x, PROCESS.y + PROCESS.h / 2 + 0.35, PROCESS.zParse + 0.35)
        group.add(lab)

        group.visible = false
        return { group, cage, nodes }
    }

    private makeScanner() {
        const beam = new THREE.Mesh(
            new THREE.BoxGeometry(0.05, 0.05, PAGE_GRID.rows * PAGE_GRID.gz + 0.6),
            new THREE.MeshBasicMaterial({
                color: PALETTE.teal,
                transparent: true,
                opacity: 0.5,
                blending: THREE.AdditiveBlending,
            }),
        )
        beam.position.set(pageX(0), 1.15, DISK_FIELD.cz)
        beam.visible = false
        this.group.add(beam)
        return beam
    }

    private makeVacuumDrone() {
        const drone = new THREE.Group()
        const body = new THREE.Mesh(
            new THREE.IcosahedronGeometry(0.3, 1),
            glowMat(0x101a12, 0xc7ff5a, 1.1),
        )
        drone.add(body)
        const ring = new THREE.Mesh(
            new THREE.TorusGeometry(0.52, 0.02, 6, 40),
            new THREE.MeshBasicMaterial({ color: 0xc7ff5a, transparent: true, opacity: 0.6 }),
        )
        ring.rotation.x = Math.PI / 2
        drone.add(ring)
        drone.add(halo(0xc7ff5a, 2.4, 0.4))
        drone.position.set(-8.5, 2.9, DISK_FIELD.cz)
        const lab = label('AUTOVACUUM')
        lab.position.set(0.6, 0.95, 0)
        drone.add(lab)

        this.group.add(drone)
        drone.userData.info = {
            title: 'AUTOVACUUM — reclaims space inside pages',
            body: 'It walks the heap, finds pages holding dead row versions, and marks that space reusable for future rows. That is all: it never deletes a page, never moves rows between pages and never shrinks the file. A page that ends up completely empty stays in the file as a flat, unusable-for-tuples block. Compaction and defragmentation are a different job — VACUUM FULL, CLUSTER or pg_repack rewrite the table into a fresh file, which is why they take an exclusive lock.',
            meta: 'vacuum · space inside pages · not defragmentation',
        }
        this.pickables.push(drone)
        return drone
    }

    setPageActive(idx: number, color: THREE.ColorRepresentation, heat = 1) {
        const p = this.pages[idx]
        if (!p) return
        p.base.set(color)
        p.heat = Math.max(p.heat, heat)
    }

    pickBufferPage(): number {
        const sorted = this.pages.map((p, i) => ({ i, h: p.heat })).sort((a, b) => a.h - b.h)
        return sorted[randInt(0, Math.min(5, sorted.length - 1))].i
    }

    async scanHeap(): Promise<number> {
        const beam = this.scanner
        beam.visible = true
        const slot = this.dsmNext % DSM_SEGMENTS
        this.dsmNext++
        if (this.dsmTarget.length === DSM_SEGMENTS) this.dsmTarget[slot] = 1
        this.dsmPulse = 1
        const from = pageX(0) - 0.6
        const to = pageX(PAGE_GRID.cols - 1) + 0.6
        await this.ticker.add(1.1, (k) => {
            beam.position.x = from + (to - from) * k
                ; (beam.material as THREE.MeshBasicMaterial).opacity = 0.1 + 0.55 * Math.sin(k * Math.PI)
        })
        beam.visible = false
        if (this.dsmTarget.length === DSM_SEGMENTS) this.dsmTarget[slot] = 0
        return 0
    }

    async flushWal(): Promise<void> {
        const lit = this.walFilledSegments
        for (let i = 0; i < lit; i++) {
            this.flashWalSegment(i)
            await this.ticker.wait(0.05)
        }
        await this.ticker.wait(0.35)
    }

    walBuffered = 0

    private bufferCubeIndex() {
        return Math.min(
            this.walBufBlocks.length - 1,
            Math.floor(this.walBuffered * this.walBufBlocks.length),
        )
    }

    walBufferTop(): THREE.Vector3 {
        const m = this.walBufBlocks[this.bufferCubeIndex()]
        if (!m || !this.walBufGroup) return this.walHeadTop()
        return new THREE.Vector3(
            this.walBufGroup.position.x + m.position.x,
            this.walBufGroup.position.y + m.position.y + PAGE_GRID.bh * 0.7,
            this.walBufGroup.position.z,
        )
    }

    private busiestPipeline(name: PostgresqlNodeName): PipelineNode {
        const open = this.backends.filter((b) => b.active)
        const pod = open.find((b) => b.busy) ?? open[0] ?? this.backends[0]
        return pod.pipeline.nodes[name]
    }

    pathEnd(name: PostgresqlPathEnd): THREE.Vector3 {
        switch (name) {
            case PostgresqlPathEnd.Parse:
                return this.busiestPipeline(PostgresqlNodeName.Parse).group.position.clone()
            case PostgresqlPathEnd.Plan:
                return this.busiestPipeline(PostgresqlNodeName.Plan).group.position.clone()
            case PostgresqlPathEnd.Exec:
                return this.busiestPipeline(PostgresqlNodeName.Exec).group.position.clone()
            case PostgresqlPathEnd.WalBuf:
                return this.walBufferTop()
            case PostgresqlPathEnd.WalHead:
                return this.walHeadTop()
            case PostgresqlPathEnd.Buffer:
                return new THREE.Vector3(bufferSlotX(6), BUFFER_TOP_Y, bufferSlotZ(3))
            case PostgresqlPathEnd.Heap:
                return new THREE.Vector3(ANCHOR.heap.x, PAGE_TOP_Y + 0.3, ANCHOR.heap.z)
            case PostgresqlPathEnd.Disk:
                return new THREE.Vector3(ANCHOR.disk.x, PAGE_TOP_Y, ANCHOR.disk.z)
        }
    }

    appendWal(fraction: number) {
        this.walBuffered = Math.min(1, this.walBuffered + fraction)
        const mat = this.walBufferMats[this.bufferCubeIndex()]
        if (mat) {
            void this.ticker.add(PULSE_TIME, (k) => {
                mat.emissiveIntensity = 1.25 - 0.75 * k
            })
        }
    }

    flushWalBuffers(): number {
        const moved = this.walBuffered
        this.walBuffered = 0
        if (moved <= 0.01) return 0
        this.flashWalSegment(this.walHeadIndex)
        const before = this.walWritten
        this.walProgress += moved * 0.9
        while (this.walProgress >= 1) {
            this.walProgress -= 1
            this.walWritten++
        }
        if (this.walWritten > before) {
            this.sealedSegments += this.walWritten - before
            this.flashWalSegment((this.walWritten - 1) % this.walBlocks.length)
        }
        for (const mat of this.walBufferMats) {
            void this.ticker.add(0.45, (k) => {
                mat.emissiveIntensity = 0.2 + 0.3 * k
            })
        }
        return moved
    }

    async vacuum(): Promise<number> {
        const dead = this.tableBlocks.filter((p) => p.dead)
        if (dead.length === 0) return 0
        this.droneBusy = true
        const drone = this.vacuumDrone

        this.chunks.reset()
        this.maintPass = 1

        const pending = dead.slice()
        while (pending.length > 0) {
            // Pass one — walk the heap and record where the dead tuples are.
            const records: { chunk: number; page: Page8K }[] = []
            while (pending.length > 0) {
                const p = pending[0]
                const over = p.home.clone().add(new THREE.Vector3(0, 2.2, 0))
                const from = drone.position.clone()
                await this.ticker.add(0.16, (k) => {
                    drone.position.lerpVectors(from, over, easeInOutCubic(k))
                })
                const chunk = this.chunks.claim()
                // Store full: this pass ends here, and another scan follows after the
                // addresses it does hold have been used.
                if (chunk === null) break
                pending.shift()
                records.push({ chunk, page: p })
                await this.flyTidIntoStore(p, chunk)
            }

            // Pass two — read the store back, page by page, and prune what it points at.
            for (const rec of records) await this.flyTidOutOfStore(rec)
            if (pending.length > 0) this.maintPass++
        }

        this.deadCount = 0
        // The store's own memory is released here, with the job: back to the allocator,
        // not to the operating system, so the next job claims the same bytes again.
        await this.ticker.wait(0.25)
        this.droneBusy = false
        return dead.length
    }

    markDeadTuples(n: number): number {
        let made = 0
        for (let i = 0; i < n; i++) {
            const live = this.tableBlocks.filter((p) => !p.dead)
            if (live.length === 0) break
            const p = live[randInt(0, live.length - 1)]
            p.dead = true
            this.paintBlock(p, 0xff3ea5)
            made++
        }
        this.deadCount += made
        return made
    }

    async dirtyPages(n: number): Promise<void> {
        const dirty = this.pages.map((p, i) => ({ p, i })).filter(({ p }) => p.dirty)
        const chosen = (dirty.length > 0 ? dirty : this.pages.map((p, i) => ({ p, i }))).slice(0, n)
        for (const { p } of chosen) {
            if (p.dirty && p.block) {
                this.setFill(p.block, p.fill)
                this.touchBlocks([p.block], PALETTE.amber)
            }
            p.dirty = false
            p.base.set(PALETTE.cyan)
            await this.ticker.wait(0.03)
        }
    }

    cleanAllPages(): void {
        for (const p of this.pages) {
            p.dirty = false
            p.base.set(PALETTE.cyan)
        }
    }

    pulseNode(pod: BackendPod, name: PostgresqlNodeName, strength = 1) {
        const n = pod.pipeline.nodes[name]
        if (n) n.pulse = Math.max(n.pulse, strength)
        // The planner is the only consumer of effective_cache_size, so its pulse is
        // the one moment the ghost cache gets brighter.
        if (name === PostgresqlNodeName.Plan) this.cachePulse = Math.max(this.cachePulse, strength)
    }

    flashDisk(_idx = -1) {
        void this.ticker
            .add(0.9, (k) => {
                this.diskFlash = 0.6 * Math.sin(k * Math.PI)
            })
            .then(() => {
                this.diskFlash = 0
            })
    }

    liftFromDisk(pageIdx: number) {
        const free = this.pages8k.filter((b) => !b.busy && !this.walBlocks.includes(b))
        if (free.length === 0) return
        const block = free[randInt(0, free.length - 1)]
        const page = this.pages[pageIdx]
        block.busy = true
        this.hideBlock(block)

        const mesh = this.liftMesh
        mesh.visible = true
        mesh.position.copy(block.home)
        mesh.rotation.set(0, 0, 0)
        mesh.scale.setScalar(1)

        const home = block.home.clone()
        const target = page
            ? page.mesh.position.clone().add(new THREE.Vector3(0, -0.55, 0))
            : home.clone().add(new THREE.Vector3(0, 3, 0))

        void this.ticker
            .add(0.85, (k) => {
                const e = easeInOutCubic(k)
                mesh.position.lerpVectors(home, target, e)
                mesh.position.y += Math.sin(e * Math.PI) * 1.1
                mesh.rotation.y = e * 0.7
                mesh.scale.setScalar(1 - 0.45 * Math.max(0, (e - 0.55) / 0.45))
            })
            .then(() => {
                mesh.visible = false
                this.showBlock(block)
                block.busy = false
            })
    }

    get deadTuples() {
        return this.deadCount
    }

    walBlockPosition(i: number) {
        return this.walSlot(i)
    }

    private walWritten = 4
    walProgress = 0
    sealedSegments = 0

    get walHeadIndex() {
        return this.walWritten % this.walBlocks.length
    }

    get walHeadBlock(): Page8K | undefined {
        return this.walBlocks[this.walHeadIndex]
    }

    walHeadTop(): THREE.Vector3 {
        const head = this.walHeadBlock
        return head ? this.blockTop(head) : this.walSlot(0).setY(PAGE_Y + PAGE_GRID.bh / 2)
    }

    walRunBox() {
        const box = new THREE.Box3()
        for (let i = 0; i < this.walBlocks.length; i++) box.expandByPoint(this.walSlot(i))
        return box.isEmpty() ? box : box.expandByScalar(PAGE_GRID.bh).translate(POSTGRES_ORIGIN)
    }

    walBuffersBox() {
        const box = new THREE.Box3()
        const v = new THREE.Vector3()
        for (const m of this.walBufBlocks) {
            m.getWorldPosition(v)
            box.expandByPoint(v)
        }
        return box.isEmpty() ? box : box.expandByScalar(PAGE_GRID.bh * 0.9)
    }

    walHeadBox() {
        const c = this.walSlot(this.walHeadIndex)
        const r = new THREE.Vector3(PAGE_GRID.bw / 2, PAGE_GRID.bh / 2, PAGE_GRID.bd / 2)
        return new THREE.Box3(c.clone().sub(r), c.clone().add(r)).translate(POSTGRES_ORIGIN)
    }

    get walFilledSegments() {
        return Math.min(this.walBlocks.length, Math.max(1, this.walWritten))
    }

    get walFill() {
        return Math.min(1, (this.walWritten + this.walProgress) / this.walBlocks.length)
    }

    recycleWal() {
        this.walWritten = 1
        this.walProgress = 0
    }

    setOrigin(pos: THREE.Vector3): THREE.Vector3 {
        const delta = pos.clone().sub(this.group.position)
        if (delta.lengthSq() === 0) return delta
        this.group.position.copy(pos)
        POSTGRES_ORIGIN.copy(pos)
        rebaseAnchors()
        return delta
    }

    update(dt: number, time: number) {
        for (const p of this.pages) {
            p.heat = Math.max(0, p.heat - dt * 0.75)
            const idle = breathe(time, 0.8, p.row * 0.7 + p.col * 0.4) * 0.08
            const dirty = p.dirty ? 0.65 : 0
            p.mat.emissive.copy(p.base)
            p.mat.emissiveIntensity = 0.22 + idle + p.heat * 1.15 + dirty * 0.5
        }

        this.styleWal(time, dt)

        if (this.walBufGroup) {
            const headCol = WAL_C0 + (WAL_LEN - 1 - this.walHeadIndex)
            const targetX = pageX(headCol)
            const g = this.walBufGroup
            g.position.x += (targetX - g.position.x) * Math.min(1, dt * 2.4)
            g.position.z = pageZ(WAL_ROW)
            g.position.y = 1.95 + Math.sin(time * 1.3) * 0.08
            WORLD_ANCHOR.walBuf.copy(g.position).add(POSTGRES_ORIGIN)
            this.walBufBlocks.forEach((m, i) => {
                const ph = i * 1.15
                m.position.y = 0.16 + Math.sin(time * 1.9 + ph) * 0.09
                m.rotation.z = Math.sin(time * 1.15 + ph) * 0.16
                m.rotation.y = Math.sin(time * 0.75 + ph * 0.7) * 0.4
                m.scale.setScalar(1 + Math.sin(time * 2.4 + ph) * 0.035)
            })
        }

        this.locks.update(dt, time)

        this.dsmPulse = Math.max(0, this.dsmPulse - dt * 0.9)
        this.maintChains = this.maintChains.filter((c) => {
            c.update(dt)
            return !c.disposed
        })
        let dsmLit = 0
        for (const v of this.dsmLive) dsmLit = Math.max(dsmLit, v)
        this.dsmCage?.brighten(0.4 * dsmLit)
        this.dsmMats.forEach((m, i) => {
            const target = this.dsmTarget[i] ?? 0
            this.dsmLive[i] =
                (this.dsmLive[i] ?? 0) + (target - (this.dsmLive[i] ?? 0)) * Math.min(1, dt * 5)
            const live = this.dsmLive[i]
            m.emissiveIntensity =
                0.08 + live * (1.0 + this.dsmPulse * 0.9 + 0.2 * breathe(time, 3, i))
            if (live > 0.3) this.dsmBlocks[i].rotation.y += dt * (1.2 + this.dsmPulse)
        })

        this.cachePulse = Math.max(0, this.cachePulse - dt * 1.5)
        if (this.cacheSheet) {
            this.cacheSheet.opacity = 0.035 + 0.015 * breathe(time, 0.7, 0) + 0.14 * this.cachePulse
            this.cacheEdge.brighten(0.4 * this.cachePulse)
        }

        this.maintCage?.brighten(0.5 * this.maintFill)
        this.lockPulse = Math.max(0, this.lockPulse - dt * 0.7)
        this.locks.cage.brighten(0.6 * this.lockPulse)

        for (const b of this.backends) {
            b.pulse = Math.max(0, b.pulse - dt * 2.2)
            b.group.visible = b.active
            b.pipeline.group.visible = b.active

            if (b.active) {
                for (const key of [
                    PostgresqlNodeName.Parse,
                    PostgresqlNodeName.Plan,
                    PostgresqlNodeName.Exec,
                ]) {
                    const n = b.pipeline.nodes[key]
                    const phase = n.home.x * 0.7 + n.home.z
                    n.pulse = Math.max(0, n.pulse - dt * 1.9)
                    n.ring.rotation.z += dt * (key === PostgresqlNodeName.Exec ? 1.5 : 0.7)
                    n.group.position.set(
                        n.home.x + Math.sin(time * 0.42 + phase) * 0.05,
                        n.home.y +
                        Math.sin(time * 0.75 + phase * 1.3) * 0.09 +
                        Math.sin(time * 1.9 + phase) * 0.03 +
                        n.pulse * 0.12,
                        n.home.z + Math.cos(time * 0.5 + phase) * 0.05,
                    )
                    n.group.rotation.y += dt * 0.12
                    n.core.emissiveIntensity = (b.busy ? 1.0 : 0.35) + n.pulse * 1.6
                    n.cage.emissiveIntensity = 0.3 + n.pulse * 0.5
                    n.group.scale.setScalar(
                        1 + Math.sin(time * 1.2 + phase) * 0.035 + n.pulse * 0.12,
                    )
                }
            }

            if (b.busy) {
                b.ring.emissiveIntensity = 2.6 + b.pulse * 2
            } else {
                b.ring.emissiveIntensity =
                    (b.active ? 0.9 + 0.2 * breathe(time, 1.1, b.id) : 0.1) + b.pulse * 2
            }
            b.glow.opacity = b.active ? 0.16 + 0.34 * (b.ring.emissiveIntensity / 2.6) : 0

            const held = b.busy ? 1 + b.inbuf : 0
            b.cells.forEach((cell, i) => {
                cell.visible = i < held
                if (!cell.visible) return
                const mat = cell.material as THREE.MeshStandardMaterial
                if (i === 0) {
                    mat.emissive.setHex(PALETTE.cyan)
                    mat.emissiveIntensity = 1.6 + 0.5 * Math.sin(time * 9 + b.id)
                } else {
                    mat.emissive.setHex(0xb46bff)
                    mat.emissiveIntensity = 0.85
                }
            })
        }

        driftDust(this.motes, dt, time)

        if (this.deadCount > 0) {
            for (const p of this.pages8k) {
                if (!p.dead) continue
                const k = 0.35 + 0.45 * breathe(time, 2.6, p.col * 0.3 + p.row * 0.7)
                this.tmpColorC.setHex(this.fillHex(p)).lerp(this.tmpColor.setHex(0xff3ea5), k)
                this.paintBlock(p, this.tmpColorC.getHex())
            }
        }

        const fieldMat = this.pageField.material as THREE.MeshStandardMaterial
        fieldMat.emissiveIntensity = 0.14 + 0.05 * breathe(time, 0.6, 0) + this.diskFlash

        if (!this.droneBusy) {
            const a = time * 0.35
            const target = new THREE.Vector3(
                Math.cos(a) * 8.6,
                2.9 + Math.sin(time * 0.9) * 0.35,
                DISK_FIELD.cz + Math.sin(a) * 3.1,
            )
            this.vacuumDrone.position.lerp(target, Math.min(1, dt * 1.2))
            this.vacuumDrone.rotation.y += dt * 0.8
        } else {
            this.vacuumDrone.rotation.y += dt * 2.4
        }
        // The store exists only while the worker is running an operation.
        this.maintHost.visible = this.droneBusy
        WORLD_ANCHOR.vacuum.copy(this.vacuumDrone.position).add(POSTGRES_ORIGIN)
    }

    droneBusy = false
    private diskFlash = 0
    private tmpColor = new THREE.Color()
    private tmpColorA = new THREE.Color()
    private tmpColorB = new THREE.Color()
    private tmpColorC = new THREE.Color()
    private dummy = new THREE.Object3D()
}
