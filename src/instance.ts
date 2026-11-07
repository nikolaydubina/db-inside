import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import {
  Ticker,
  breathe,
  easeInOutCubic,
  halo,
  label,
  neonEdges,
  rand,
  randInt,
} from './util'

export const PALETTE = {
  cyan: 0x35e0ff,
  teal: 0x2bffc3,
  amber: 0xffb03a,
  magenta: 0xff3ea5,
  violet: 0x8a7bff,
  ice: 0xbfe9ff,
}

export interface Info {
  title: string
  body: string
  meta?: string
}

export interface Page {
  mesh: THREE.Mesh
  mat: THREE.MeshStandardMaterial
  base: THREE.Color
  heat: number
  row: number
  col: number
  dirty: boolean
}

export interface Tuple {
  mesh: THREE.Mesh
  mat: THREE.MeshStandardMaterial
  dead: boolean
  home: THREE.Vector3
}

/** One block of the disk field: a single 8 kB page. */
export interface Page8K {
  /** Instance index inside the page-field InstancedMesh. */
  i: number
  home: THREE.Vector3
  row: number
  col: number
  color: number
  table: string | null
  /** 0 = nothing on this page, 1 = packed full. Drives colour and height. */
  fill: number
  /** Per-page brightness jitter, so no two pages look identical. */
  shade: number
  /** Optional colour cast hinting at a different data set. */
  hint: number
  hintAmt: number
  /** No page here at all: free space the files could grow into. */
  free: boolean
  /** Holds dead row versions: VACUUM will reclaim the space inside it. */
  dead: boolean
  busy: boolean
}

export type NodeName = 'parse' | 'plan' | 'exec' | 'result'

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

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

/** y of the first WAL segment: the log sits on the disk floor, not in the air. */
const WAL_BASE = 0.23

/** How far "in-memory right now" structures float above the disk plate. */
const RAM_LIFT = 1.15

/** The amber plate: width, depth and centre-z of the disk area on the floor. */
export const DISK_PLATE = { w: 24.2, d: 9.0, cz: 3.2, top: 0.09 }

/**
 * The disk is tiled edge to edge with page blocks. Spacing is 0.5 and the floor
 * grid is drawn every 2 units, so four blocks fit exactly in one grid cell and
 * every fourth block edge lands on a grid line.
 */
export const PAGE_GRID = { cols: 48, rows: 17, gx: 0.5, gz: 0.5, bw: 0.46, bh: 0.28, bd: 0.46 }
const PAGE_Y = 0.25
const pageX = (col: number) => -11.75 + col * PAGE_GRID.gx
const pageZ = (row: number) => -0.75 + row * PAGE_GRID.gz
const PAGE_W = PAGE_GRID.cols * PAGE_GRID.gx
const PAGE_D = PAGE_GRID.rows * PAGE_GRID.gz

/** Albedo of a free (unassigned) page block. */
const BLOCK_FREE = 0x6b4a1c
/** Page fill ramp: empty slot → packed page. */
const FILL_DARK = 0x0e0a04
const FILL_BRIGHT = 0xd28f2c

interface TableRegion {
  anchor: 'heap' | 'events' | 'metrics'
  label: string
  c0: number
  c1: number
  r0: number
  r1: number
  color: number
  info: Info
}

/**
 * A table is nothing but a named, contiguous run of pages on the disk. These
 * outlines are the only thing that distinguishes a table from free space.
 */
const TABLE_REGIONS: TableRegion[] = [
  {
    anchor: 'heap',
    label: 'users',
    c0: 19,
    c1: 28,
    r0: 3,
    r1: 10,
    color: PALETTE.teal,
    info: {
      title: 'TABLE: users — contiguous 8 kB pages',
      body: 'A table is not a separate kind of object: it is a named, contiguous run of 8 kB pages, and this outline is all that \'table\' means at the storage layer. Rows live inside those pages. Page height is how full the page is: INSERTs fill a page up and allocate a new one from the run when it is full, DELETEs drain it. Dead row versions collect inside the page until VACUUM reclaims that space — the page itself stays in the file either way.',
      meta: 'demo table · 28 pages · heap file on disk',
    },
  },
  {
    anchor: 'events',
    label: 'products',
    c0: 30,
    c1: 39,
    r0: 3,
    r1: 10,
    color: PALETTE.amber,
    info: {
      title: 'TABLE: products — 32 contiguous pages',
      body: 'Another example table, same shape: a contiguous run of pages, nothing more. These rows are wide and carry a jsonb document, which is why the interesting query is containment inside the document. A B-tree cannot answer that, because the whole document is one value in one column — which is what GIN is for.',
      meta: 'demo table · 32 pages · jsonb payload · heap file',
    },
  },
  {
    anchor: 'metrics',
    label: 'metrics',
    c0: 41,
    c1: 46,
    r0: 11,
    r1: 16,
    color: 0x5a7bff,
    info: {
      title: 'TABLE: metrics — 21 contiguous pages',
      body: 'A third example table, again just pages: append-only measurements written in timestamp order. Nothing in Postgres guaranteed that order — we simply inserted them that way, so ranges of these pages hold narrow timestamp ranges. That is exactly the assumption BRIN exploits, and why it can be a few kilobytes for a huge table.',
      meta: 'demo table · 21 pages · naturally ordered · heap file',
    },
  },
]

export const ANCHOR = {
  sky: V(-11.0, 27, 0.8),
  parse: V(-9.4, 6.55, -2.0),
  plan: V(-4.4, 6.85, -2.4),
  exec: V(1.6, 6.85, -2.4),
  result: V(8.2, 6.6, -1.8),
  bufferCenter: V(-1.0, 5.5, -1.4),
  wal: V(10.9, 4.6, 2.4),
  heap: V(-7.4, 0.5, 4.0),
  index: V(4.2, 2.6, -5.6),
  disk: V(7.0, 0.5, 5.6),
  events: V(0.2, 0.5, 4.6),
  metrics: V(-5.2, 0.5, 0.6),
  gin: V(10.3, 1.4, -3.4),
  brin: V(-1.9, 1.6, -5.3),
  hash: V(5.9, 1.2, 1.0),
  hub: V(0, 7.2, 0),
  resultSky: V(10.6, 24, 1.2),
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
  /** Every 8 kB block on the disk plate. */
  readonly pages8k: Page8K[] = []
  /** The blocks that belong to a table, i.e. the ones VACUUM can touch. */
  readonly tableBlocks: Page8K[] = []
  readonly pickables: THREE.Object3D[] = []
  readonly nodes: Record<NodeName, PipelineNode>
  readonly walMats: THREE.MeshStandardMaterial[] = []
  readonly walBufferMats: THREE.MeshStandardMaterial[] = []
  readonly walSegments: THREE.Mesh[] = []
  readonly btreeMats: THREE.MeshStandardMaterial[] = []
  readonly ginMats: THREE.MeshStandardMaterial[] = []
  readonly brinMats: THREE.MeshStandardMaterial[] = []
  readonly hashMats: THREE.MeshStandardMaterial[] = []
  readonly lockMats: THREE.MeshStandardMaterial[] = []
  /** Instanced field of 8 kB page blocks that fills the whole disk plate. */
  pageField!: THREE.InstancedMesh
  /** Reusable block mesh used while a page is being read up into RAM. */
  private liftMesh!: THREE.Mesh
  /** One port per client connection, sitting on the top boundary of the box. */
  readonly backends: BackendPod[] = []
  readonly walHead: THREE.Mesh
  readonly scanner: THREE.Mesh
  readonly vacuumDrone: THREE.Group
  readonly bufferFrame: THREE.Mesh
  motes!: THREE.Points
  haloRing!: THREE.Mesh

  indexScan = false
  walFill = 0.35
  private deadCount = 0

  constructor(private ticker: Ticker) {
    this.buildShell()
    this.buildBufferPool()
    this.buildWal()
    this.buildPageField()
    this.buildTableRegions()
    this.buildIndex()
    this.buildGin()
    this.buildBrin()
    this.buildHash()
    this.buildLocks()
    this.buildBackends()
    this.nodes = this.buildPipeline()
    this.walHead = this.makeWalHead()
    this.scanner = this.makeScanner()
    this.vacuumDrone = this.makeVacuumDrone()
    this.bufferFrame = this.group.children.find(
      (o) => o.userData.bufferFrame === true,
    ) as THREE.Mesh

    // a few clients are already connected when the instance starts
    this.openBackend()
    this.openBackend()
    this.openBackend()
  }

  /* --------------------------------- building ------------------------------- */

  private register(obj: THREE.Object3D, info: Info) {
    obj.userData.info = info
    this.pickables.push(obj)
    return obj
  }

  private buildShell() {
    const shellH = 9.8
    const shellW = 25.2
    const shellD = 16.0
    const shellGeo = new THREE.BoxGeometry(shellW, shellH, shellD)

    // wireframe cage only — faces would hide the internals
    const edges = neonEdges(shellGeo, 0x3fa8cc, 0.3)
    edges.position.y = shellH / 2
    this.group.add(edges)

    const edges2 = neonEdges(shellGeo, 0x1d5f78, 0.5)
    edges2.position.y = shellH / 2
    edges2.scale.set(0.999, 0.998, 0.999)
    this.group.add(edges2)

    // corner posts
    const postGeo = new RoundedBoxGeometry(0.14, shellH, 0.14, 2, 0.03)
    const postMat = glowMat(0x0a1a26, 0x2fa6c8, 0.55)
    for (const x of [-12.5, 12.5]) {
      for (const z of [-7.9, 7.9]) {
        const p = new THREE.Mesh(postGeo, postMat)
        p.position.set(x, shellH / 2, z)
        p.castShadow = true
        this.group.add(p)
      }
    }

    // roof rim
    const roof = new THREE.Mesh(
      new RoundedBoxGeometry(shellW, 0.1, shellD, 2, 0.04),
      new THREE.MeshStandardMaterial({
        color: 0x061019,
        metalness: 0.6,
        roughness: 0.4,
        transparent: true,
        opacity: 0.55,
      }),
    )
    roof.position.y = shellH + 0.02
    roof.scale.set(1.001, 1, 1.001)
    roof.visible = false
    this.group.add(roof)
    const roofEdge = neonEdges(
      new THREE.BoxGeometry(shellW, 0.08, shellD),
      0x35e0ff,
      0.3,
    )
    roofEdge.position.y = shellH + 0.02
    this.group.add(roofEdge)

    // city-block pad: the blue grid floor everything floats over
    const pad = new THREE.Mesh(
      new RoundedBoxGeometry(27.6, 0.06, 18.4, 2, 0.1),
      new THREE.MeshStandardMaterial({
        color: 0x081420,
        emissive: 0x04141f,
        emissiveIntensity: 0.9,
        roughness: 0.85,
        metalness: 0.2,
      }),
    )
    pad.position.y = 0.05
    pad.receiveShadow = true
    this.group.add(pad)

    const padLineMat = new THREE.LineBasicMaterial({
      color: 0x1a5f78,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    })
    const padPts: number[] = []
    for (let x = -13; x <= 13; x += 2) {
      padPts.push(x, 0.09, -8.6, x, 0.09, 8.6)
    }
    for (let z = -8; z <= 8; z += 2) {
      padPts.push(-13.5, 0.09, z, 13.5, 0.09, z)
    }
    const padGeo = new THREE.BufferGeometry()
    padGeo.setAttribute('position', new THREE.Float32BufferAttribute(padPts, 3))
    this.group.add(new THREE.LineSegments(padGeo, padLineMat))

    const padEdge = neonEdges(new THREE.BoxGeometry(27.6, 0.06, 18.4), 0x35e0ff, 0.45)
    padEdge.position.y = 0.05
    this.group.add(padEdge)

    /* -------------------------------------------------------------------- disk */
    // The disk is only the field of page blocks. This plate is deliberately
    // colourless — it just gives the blocks a bed and marks their footprint.
    const plate = new THREE.Mesh(
      new RoundedBoxGeometry(PAGE_W + 0.4, 0.04, PAGE_D + 0.4, 2, 0.02),
      new THREE.MeshStandardMaterial({
        color: 0x060a0f,
        emissive: 0x081820,
        emissiveIntensity: 0.8,
        roughness: 0.92,
        metalness: 0.2,
      }),
    )
    plate.position.set(0, 0.06, DISK_PLATE.cz)
    plate.receiveShadow = true
    this.group.add(plate)

    const plateEdge = neonEdges(
      new THREE.BoxGeometry(PAGE_W + 0.4, 0.04, PAGE_D + 0.4),
      0x2f9fbf,
      0.55,
    )
    plateEdge.position.copy(plate.position)
    this.group.add(plateEdge)

    const diskFloorPick = new THREE.Mesh(
      new THREE.BoxGeometry(DISK_PLATE.w, 0.3, DISK_PLATE.d),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    diskFloorPick.position.set(0, 0.12, DISK_PLATE.cz)
    this.group.add(diskFloorPick)
    this.register(diskFloorPick, {
      title: 'Disk — a field of 8 kB pages',
      body: 'Every block is one 8 kB page; brighter and taller means fuller. Most of these pages belong to tables and indexes we do not draw — system catalogues, other tables — and each keeps its own slightly different shade. The three outlined runs are the tables we do label. The gaps are free space: no page there at all, just room the files can grow into. RAM only ever holds copies, so only copies float.',
      meta: 'disk · one block = 8 kB page · lived-in, not a grid of blanks',
    })

    const floorLab = label('DISK · ALL PAGE FILES')
    floorLab.position.set(-10.2, 0.5, DISK_PLATE.cz + PAGE_D / 2 + 0.75)
    this.group.add(floorLab)

    const processLabel = label('POSTGRESQL PROCESS')
    processLabel.position.set(-12.3, 10.15, 8.1)
    this.group.add(processLabel)

    // drifting data motes inside the instance
    const count = 220
    const pos = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      pos[i * 3] = rand(-11.8, 11.8)
      pos[i * 3 + 1] = rand(0.3, 9.5)
      pos[i * 3 + 2] = rand(-7.2, 7.2)
    }
    const moteGeo = new THREE.BufferGeometry()
    moteGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const motes = new THREE.Points(
      moteGeo,
      new THREE.PointsMaterial({
        color: 0x8fe6ff,
        size: 0.06,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      }),
    )
    this.group.add(motes)
    this.motes = motes

    const haloRing = new THREE.Mesh(
      new THREE.TorusGeometry(14.6, 0.02, 4, 160),
      new THREE.MeshBasicMaterial({
        color: 0x2f9fbf,
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    haloRing.rotation.x = Math.PI / 2
    haloRing.position.y = 9.15
    this.group.add(haloRing)
    this.haloRing = haloRing

    this.register(roof, {
      title: 'PostgreSQL process',
      body: 'One running postgres instance: a postmaster, backend processes and shared memory. Everything inside this cage — parser, planner, executor, buffers, WAL — is part of it. Clients sit outside, in the sky.',
      meta: 'process · postmaster + backends · shared memory',
    })
  }

  private buildBufferPool() {
    const frameW = 11.4
    const frameD = 4.3
    const frame = new THREE.Mesh(
      new RoundedBoxGeometry(frameW, 0.26, frameD, 2, 0.06),
      glowMat(0x071420, 0x1f6f8c, 0.38, { metalness: 0.3, roughness: 0.55 }),
    )
    frame.position.set(ANCHOR.bufferCenter.x, 5.06, ANCHOR.bufferCenter.z)
    frame.castShadow = true
    frame.receiveShadow = true
    frame.userData.bufferFrame = true
    this.group.add(frame)
    this.register(frame, {
      title: 'Shared buffers',
      body: 'The only RAM in the picture: a page cache every backend shares. Reads and writes hit 8 kB page copies here first; a miss pulls the page up from disk and evicts another one with the clock-sweep algorithm. The table itself never moves — only copies do.',
      meta: 'shared_buffers · RAM · 8 kB pages · clock sweep',
    })

    const frameEdge = neonEdges(new THREE.BoxGeometry(frameW, 0.26, frameD), 0x35e0ff, 0.5)
    frameEdge.position.copy(frame.position)
    this.group.add(frameEdge)

    // the pool floats — RAM is not bolted to the floor. A soft ring underneath
    // makes the levitation legible instead of accidental.
    const levitation = new THREE.Mesh(
      new THREE.TorusGeometry(5.6, 0.05, 6, 128),
      new THREE.MeshBasicMaterial({
        color: 0x35e0ff,
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    levitation.rotation.x = Math.PI / 2
    levitation.position.set(ANCHOR.bufferCenter.x, 4.72, ANCHOR.bufferCenter.z)
    levitation.scale.set(1, 0.48, 1)
    this.group.add(levitation)

    const cols = 8
    const rows = 4
    const gapX = 1.3
    const gapZ = 0.93
    const originX = ANCHOR.bufferCenter.x - ((cols - 1) * gapX) / 2
    const originZ = ANCHOR.bufferCenter.z - ((rows - 1) * gapZ) / 2
    const pageGeo = new RoundedBoxGeometry(1.08, 0.12, 0.64, 2, 0.03)

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const mat = glowMat(0x0b2230, PALETTE.cyan, 0.22, { metalness: 0.5, roughness: 0.35 })
        const mesh = new THREE.Mesh(pageGeo, mat)
        mesh.position.set(originX + c * gapX, 5.28, originZ + r * gapZ)
        mesh.castShadow = true
        mesh.receiveShadow = true
        this.group.add(mesh)
        this.pages.push({
          mesh,
          mat,
          base: new THREE.Color(PALETTE.cyan),
          heat: rand(0, 0.25),
          row: r,
          col: c,
          dirty: false,
        })
      }
    }

    // invisible pick volume over the whole pool
    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(cols * gapX, 0.9, rows * gapZ),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pick.position.set(ANCHOR.bufferCenter.x, 5.35, ANCHOR.bufferCenter.z)
    this.group.add(pick)
    this.register(pick, {
      title: 'Shared buffer pages',
      body: 'Each tile is one 8 kB page of a table or index. Cyan means cached and clean, amber means dirty (changed, waiting to be written), green means a hit just served a query.',
      meta: '40 pages · ~320 kB shown',
    })
  }

  private buildWal() {
    const x = ANCHOR.wal.x
    const z = ANCHOR.wal.z
    const segGeo = new RoundedBoxGeometry(0.85, 0.3, 0.85, 2, 0.04)
    for (let i = 0; i < 7; i++) {
      const mat = glowMat(0x241703, 0xa85a14, 0.62, {
        roughness: 0.45,
        metalness: 0.25,
      })
      const seg = new THREE.Mesh(segGeo, mat)
      seg.position.set(x, WAL_BASE + i * 0.42, z)
      seg.castShadow = true
      seg.receiveShadow = true
      this.group.add(seg)
      this.walSegments.push(seg)
      this.walMats.push(mat)

      const seam = neonEdges(segGeo, 0xffb03a, 0.85)
      seam.position.copy(seg.position)
      this.group.add(seam)
    }

    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 5.4, 1.5),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pick.position.set(x, 3.1, z)
    this.group.add(pick)
    this.register(pick, {
      title: 'Write-ahead log (on disk)',
      body: 'A sequence of segment files in pg_wal, appended on every change before the heap page is touched. The newest bytes sit in wal_buffers — the floating cyan blocks above — and only reach disk when the WAL writer issues write + fsync; COMMIT does not return until that fsync finishes. A checkpoint then flushes dirty pages and recycles old segments.',
      meta: 'pg_wal · disk files · tail buffered in wal_buffers · fsync',
    })

    // wal_buffers: the only part of the WAL that lives in RAM
    const wb = new THREE.Group()
    const wbGeo = new RoundedBoxGeometry(0.34, 0.34, 0.34, 2, 0.04)
    for (let i = 0; i < 3; i++) {
      const mat = glowMat(0x08222e, PALETTE.cyan, 0.7, { metalness: 0.4 })
      const m = new THREE.Mesh(wbGeo, mat)
      m.position.set(i * 0.5, Math.sin(i * 1.7) * 0.12, 0)
      wb.add(m)
      this.walBufferMats.push(mat)
    }
    wb.position.set(x - 0.55, 4.35, z + 0.55)
    this.group.add(wb)

    const wbPick = new THREE.Mesh(
      new THREE.BoxGeometry(1.9, 0.9, 0.9),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    wbPick.position.copy(wb.position)
    this.group.add(wbPick)
    this.register(wbPick, {
      title: 'wal_buffers — the WAL tail in RAM',
      body: 'WAL records are written to these shared-memory buffers first, then flushed to the segment files on disk in order. It is the same split as heap pages: the durable thing is on disk, RAM only holds a short recent stretch. Default is 1/32 of shared_buffers, about 16 MB.',
      meta: 'wal_buffers · RAM · tail of the log · flushed by WAL writer',
    })

    const wbLab = label('WAL BUFFERS · RAM')
    wbLab.position.set(x - 1.1, 5.6, z + 1.05)
    this.group.add(wbLab)

    const lab = label('WAL · DISK')
    lab.position.set(x - 1.5, 4.25, z + 0.4)
    this.group.add(lab)
  }

  private makeWalHead() {
    const head = new THREE.Group()
    const core = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 0.08, 0.95),
      new THREE.MeshBasicMaterial({
        color: 0xffd089,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
      }),
    )
    head.add(core)
    head.add(halo(PALETTE.amber, 1.9, 0.24))
    head.position.set(ANCHOR.wal.x, 2.6, ANCHOR.wal.z)
    this.group.add(head)
    return core
  }

  /** The disk plate is tiled edge to edge with 8 kB pages — this *is* the disk. */
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

    const inTable = (r: number, c: number) =>
      TABLE_REGIONS.some((t) => r >= t.r0 && r <= t.r1 && c >= t.c0 && c <= t.c1)

    // Fragmentation grows as you move away from the WAL: packed solid next to
    // it, thinning out past 60%, and the outer 20% of the disk is untouched
    // space with no pages in it at all.
    const freeAt = (c: number) => {
      const t = 1 - c / (cols - 1)
      if (t > 0.8) return true
      if (t > 0.6) return Math.random() < ((t - 0.6) / 0.2) * 0.9
      return false
    }

    const dummy = new THREE.Object3D()
    const hints = [PALETTE.teal, PALETTE.violet, 0x5a7bff, PALETTE.amber]
    let i = 0
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const home = new THREE.Vector3(pageX(c), PAGE_Y, pageZ(r))
        const table = inTable(r, c)
        const free = !table && freeAt(c)

        dummy.position.copy(home)
        if (free) {
          // no page here: collapse the block so the plate shows through
          dummy.scale.setScalar(0.001)
        } else {
          dummy.scale.set(1, 1, 1)
        }
        dummy.updateMatrix()
        field.setMatrixAt(i, dummy.matrix)

        this.pages8k.push({
          i,
          home,
          row: r,
          col: c,
          color: BLOCK_FREE,
          table: null,
          // pages we do not label still hold data from other tables
          fill: free || table ? 0 : rand(0.1, 1),
          shade: rand(0.8, 1.14),
          hint: hints[randInt(0, hints.length - 1)],
          hintAmt: free ? 0 : Math.random() < 0.4 ? rand(0.05, 0.16) : 0,
          free,
          dead: false,
          busy: false,
        })
        i++
      }
    }
    this.pages8k.forEach((p) => {
      if (!p.free) this.setFill(p, p.fill)
    })

    // in the untouched tail, draw the slot lattice only — no pages, just room
    const freeCols = Math.floor(cols * 0.2)
    const fx0 = pageX(0) - PAGE_GRID.gx / 2
    const fx1 = pageX(freeCols - 1) + PAGE_GRID.gx / 2
    const fz0 = pageZ(0) - PAGE_GRID.gz / 2
    const fz1 = pageZ(rows - 1) + PAGE_GRID.gz / 2
    const slotPts: number[] = []
    for (let x = fx0; x <= fx1 + 0.001; x += PAGE_GRID.gx) {
      slotPts.push(x, PAGE_Y - 0.12, fz0, x, PAGE_Y - 0.12, fz1)
    }
    for (let z = fz0; z <= fz1 + 0.001; z += PAGE_GRID.gz) {
      slotPts.push(fx0, PAGE_Y - 0.12, z, fx1, PAGE_Y - 0.12, z)
    }
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

    // one reusable mesh carries a page while it is being read into RAM
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

  /** Albedo of one page block in the instanced field. */
  paintBlock(p: Page8K, hex: number) {
    const field = this.pageField
    if (!field) return
    field.setColorAt(p.i, this.tmpColor.setHex(hex))
    if (field.instanceColor) field.instanceColor.needsUpdate = true
  }

  /** Colour a page by how full it is; a table tint keeps the tables apart. */
  private fillHex(p: Page8K) {
    const ramp = this.tmpColorA.setHex(FILL_DARK).lerp(this.tmpColorB.setHex(FILL_BRIGHT), p.fill)
    if (p.table) ramp.lerp(this.tmpColorB.setHex(p.color), 0.28)
    if (p.hintAmt > 0) ramp.lerp(this.tmpColorB.setHex(p.hint), p.hintAmt)
    ramp.multiplyScalar(p.shade)
    return ramp.getHex()
  }

  /** Height of a block: an empty page is a flat slot, a full one is a cube. */
  private blockScale(fill: number) {
    return 0.45 + 0.55 * fill
  }

  private applyTransform(p: Page8K, scale: number, sy?: number) {
    const d = this.dummy
    d.position.copy(p.home)
    d.rotation.set(0, 0, 0)
    d.scale.set(scale, scale, scale)
    if (sy !== undefined) d.scale.y = sy
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

  /**
   * Flash the pages a statement touched, then settle back to their fill colour.
   * This is how you see which blocks the query actually rewrote.
   */
  touchBlocks(blocks: Page8K[], hex: number, dur = 0.55, lift = 1.35) {
    for (const p of blocks) this.paintBlock(p, hex)
    for (const p of blocks) {
      const liftBy = this.blockScale(p.fill) * lift
      this.applyTransform(p, 1, liftBy)
      void this.ticker.add(dur, () => {}).then(() => {
        if (p.busy) return
        this.paintBlock(p, this.fillHex(p))
        this.showBlock(p)
      })
    }
  }

  /** INSERT: pages fill up, and a brand-new page is allocated when one is full. */
  insertRows(n = 2): Page8K[] {
    const touched: Page8K[] = []
    for (let k = 0; k < n; k++) {
      const region = TABLE_REGIONS[randInt(0, TABLE_REGIONS.length - 1)]
      const blocks = this.tableBlocks.filter((b) => b.table === region.label && !b.busy)
      if (blocks.length === 0) continue
      const partial = blocks.filter((b) => b.fill > 0 && b.fill < 1)
      const fresh = blocks.filter((b) => b.fill === 0)
      let p: Page8K | undefined
      if (partial.length > 0 && Math.random() < 0.7) {
        p = partial[randInt(0, partial.length - 1)]
        this.setFill(p, p.fill + rand(0.15, 0.45))
      } else if (fresh.length > 0) {
        // a new page is initialised for this heap
        p = fresh[randInt(0, fresh.length - 1)]
        this.setFill(p, rand(0.12, 0.3))
      } else if (partial.length > 0) {
        p = partial[randInt(0, partial.length - 1)]
        this.setFill(p, p.fill + 0.2)
      }
      if (p) touched.push(p)
    }
    // an insert makes pages visibly fatter and brighter
    this.touchBlocks(touched, 0xd9ff7a, 0.6, 1.6)
    return touched
  }

  /** DELETE: pages get emptier, and a drained page becomes a flat free slot. */
  deleteRows(n = 2): Page8K[] {
    const touched: Page8K[] = []
    for (let k = 0; k < n; k++) {
      const filled = this.tableBlocks.filter((b) => b.fill > 0 && !b.busy)
      if (filled.length === 0) break
      const p = filled[randInt(0, filled.length - 1)]
      this.setFill(p, p.fill - rand(0.25, 0.6))
      touched.push(p)
    }
    // a delete makes them sag and dim
    this.touchBlocks(touched, 0xff3ea5, 0.55, 0.7)
    return touched
  }

  settlePage(p: Page8K) {
    this.setFill(p, p.fill)
  }

  /**
   * Tables are just contiguous runs of those pages, so they are drawn as
   * selection marquees over the block field — no extra geometry, no fake shape.
   */
  private buildTableRegions() {
    for (const region of TABLE_REGIONS) {
      const blocks: Page8K[] = []
      for (let r = region.r0; r <= region.r1; r++) {
        for (let c = region.c0; c <= region.c1; c++) {
          const p = this.pages8k.find((b) => b.row === r && b.col === c)
          if (!p) continue
          p.table = region.label
          p.color = region.color
          // pages start out partly used, with a believable spread of fill levels;
          // the rest of the reserved run is still unallocated (flat slots)
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
      const h = 0.46

      const edges = neonEdges(new THREE.BoxGeometry(w, h, d), region.color, 0.85)
      edges.position.set(cx, PAGE_Y - 0.12 + h / 2, cz)
      this.group.add(edges)

      // faint wash so the run reads as "selected pages", not as a solid object
      const wash = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshBasicMaterial({
          color: region.color,
          transparent: true,
          opacity: 0.04,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      )
      wash.position.copy(edges.position)
      this.group.add(wash)

      const pick = new THREE.Mesh(
        new THREE.BoxGeometry(w, h + 0.7, d),
        new THREE.MeshBasicMaterial({ visible: false }),
      )
      pick.position.set(cx, PAGE_Y + h / 2, cz)
      this.group.add(pick)
      this.register(pick, region.info)

      const lab = label(`TABLE: ${region.label}`)
      lab.position.set(cx - w / 2, PAGE_Y + h + 0.55, z0)
      this.group.add(lab)

      ANCHOR[region.anchor].set(cx, PAGE_Y, cz)
    }

    // point at a genuine hole in the field: space the files can grow into
    const freeLab = label('FREE SPACE · ALLOCATABLE')
    freeLab.position.set(pageX(4), PAGE_Y + 0.05, pageZ(PAGE_GRID.rows - 1))
    this.group.add(freeLab)
  }

  private buildIndex() {
    const cx = ANCHOR.index.x
    const cz = ANCHOR.index.z
    const tree = new THREE.Group()
    const nodeGeo = new RoundedBoxGeometry(0.66, 0.26, 0.66, 2, 0.04)

    const levels = [
      { y: 3.1, xs: [cx] },
      { y: 2.2, xs: [cx - 1.45, cx, cx + 1.45] },
      { y: 1.3, xs: [cx - 2.9, cx - 1.9, cx - 0.95, cx, cx + 0.95, cx + 1.9, cx + 2.9] },
    ]
    const pts: THREE.Vector3[][] = []
    for (const level of levels) {
      const rowPts: THREE.Vector3[] = []
      for (const x of level.xs) {
        const mat = glowMat(0x0a1f2c, PALETTE.violet, 0.55, { metalness: 0.5 })
        const m = new THREE.Mesh(nodeGeo, mat)
        m.position.set(x, level.y, cz)
        m.castShadow = true
        tree.add(m)
        this.btreeMats.push(mat)
        rowPts.push(m.position.clone())
      }
      pts.push(rowPts)
    }

    // edges: each parent connects to 2-3 children
    const segs: number[] = []
    for (let l = 0; l < 2; l++) {
      const parents = pts[l]
      const children = pts[l + 1]
      parents.forEach((p, i) => {
        const span = children.length / parents.length
        const start = Math.floor(i * span)
        const end = Math.floor((i + 1) * span)
        for (let c = start; c < end; c++) {
          segs.push(p.x, p.y, p.z, children[c].x, children[c].y, children[c].z)
        }
      })
    }
    const edgeGeo = new THREE.BufferGeometry()
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3))
    const edges = new THREE.LineSegments(
      edgeGeo,
      new THREE.LineBasicMaterial({
        color: 0x8a7bff,
        transparent: true,
        opacity: 0.45,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    tree.add(edges)

    const base = new THREE.Mesh(
      new RoundedBoxGeometry(6.5, 0.24, 2.0, 2, 0.05),
      glowMat(0x080f1a, 0x3b2f8f, 0.4),
    )
    base.position.set(cx, 0.95, cz)
    tree.add(base)

    // an index is built and read in memory: float the whole tree above the plate
    tree.position.y = RAM_LIFT - 0.55
    this.group.add(tree)

    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(6.8, 3.1, 1.4),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pick.position.set(cx, 1.5 + RAM_LIFT, cz)
    this.group.add(pick)
    this.register(pick, {
      title: 'B-tree index — the tree as it sits in RAM',
      body: 'A balanced tree over key → TID. It is shown floating because this is the tree the backends walk right now: its pages were read from its index file into shared buffers, and the hot internal pages stay there. An index scan costs ~3 page reads instead of the whole table.',
      meta: 'b-tree · 3 levels · key → TID · pages cached in RAM',
    })

    const lab = label('B-TREE')
    lab.position.set(cx - 1.6, 2.85 + RAM_LIFT, cz + 1.4)
    this.group.add(lab)
  }

  private buildGin() {
    const cx = ANCHOR.gin.x
    const cz = ANCHOR.gin.z

    const base = new THREE.Mesh(
      new RoundedBoxGeometry(3.4, 0.26, 2.6, 2, 0.06),
      glowMat(0x140a18, 0x6a1f4d, 0.6, { metalness: 0.4, roughness: 0.5 }),
    )
    base.position.set(cx, 0.36 + RAM_LIFT, cz)
    base.castShadow = true
    base.receiveShadow = true
    this.group.add(base)

    const pinGeo = new THREE.BoxGeometry(0.09, 1, 0.09)
    const cols = 6
    const rows = 4
    const gx = 0.5
    const gz = 0.52
    const ox = cx - ((cols - 1) * gx) / 2
    const oz = cz - ((rows - 1) * gz) / 2

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const h = 0.45 + Math.random() * 1.15
        const mat = glowMat(0x2a0a1e, PALETTE.magenta, 0.75)
        const m = new THREE.Mesh(pinGeo, mat)
        m.scale.y = h
        m.position.set(ox + c * gx, 0.5 + RAM_LIFT + h / 2, oz + r * gz)
        m.castShadow = true
        this.group.add(m)
        this.ginMats.push(mat)
      }
    }

    // posting-list rail across the top of the keys
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(3.0, 0.02, 0.03),
      new THREE.MeshBasicMaterial({
        color: 0xff8ac8,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    rail.position.set(cx, 1.95 + RAM_LIFT, cz - 0.78)
    this.group.add(rail)

    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(3.6, 2.2, 2.8),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pick.position.set(cx, 1.3 + RAM_LIFT, cz)
    this.group.add(pick)
    this.register(pick, {
      title: 'GIN — Generalized Inverted Index',
      body: 'Maps each element of a composite value — a jsonb key, an array element, a full-text lexeme — to a posting list of row TIDs. Fast for containment (`@>`, `?`, `@@`) and full-text search, expensive to update because one row can write many postings.',
      meta: 'gin · element → posting list · jsonb / arrays / tsvector',
    })

    const lab = label('GIN')
    lab.position.set(cx - 1.3, 2.75 + RAM_LIFT, cz + 0.3)
    this.group.add(lab)
  }

  private buildBrin() {
    const cx = ANCHOR.brin.x
    const cz = ANCHOR.brin.z + 2.55
    const slabGeo = new RoundedBoxGeometry(0.32, 0.42, 0.78, 2, 0.03)
    const dotGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1)

    for (let i = 0; i < 8; i++) {
      const mat = glowMat(0x0c0a24, PALETTE.violet, 0.7)
      const m = new THREE.Mesh(slabGeo, mat)
      m.position.set(cx - 2.1 + i * 0.6, 0.34 + RAM_LIFT, cz)
      m.castShadow = true
      this.group.add(m)
      this.brinMats.push(mat)

      for (const dz of [-0.2, 0.2]) {
        const dot = new THREE.Mesh(dotGeo, mat)
        dot.position.set(m.position.x, 0.61 + RAM_LIFT, cz + dz)
        this.group.add(dot)
      }
    }

    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(4.8, 0.9, 1.2),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pick.position.set(cx, 0.55 + RAM_LIFT, cz)
    this.group.add(pick)
    this.register(pick, {
      title: 'BRIN — Block Range Index',
      body: 'Stores only min/max per range of pages (default 128), so the whole index is a few kilobytes even for a huge heap. Floating here because the summary tuples are what lives in memory while a scan runs; it is a tiny file of its own on the plate below. Great when data is ordered by the indexed column, useless when values are scattered.',
      meta: 'brin · min/max per 128 pages · tiny · summarised in RAM',
    })

    const lab = label('BRIN')
    lab.position.set(cx + 0.1, 1.35 + RAM_LIFT, cz + 0.85)
    this.group.add(lab)
  }

  private buildHash() {
    const cx = ANCHOR.hash.x
    const cz = ANCHOR.hash.z

    const hubMat = glowMat(0x0a1a14, PALETTE.teal, 0.8, { metalness: 0.5 })
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.5, 16), hubMat)
    hub.position.set(cx, 0.35 + RAM_LIFT, cz)
    hub.castShadow = true
    this.group.add(hub)
    this.hashMats.push(hubMat)

    const bucketGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.42, 12)
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      const mat = glowMat(0x081a16, PALETTE.teal, 0.5, { metalness: 0.55 })
      const b = new THREE.Mesh(bucketGeo, mat)
      b.position.set(cx + Math.cos(a) * 1.12, 0.3 + RAM_LIFT, cz + Math.sin(a) * 1.12)
      b.castShadow = true
      this.group.add(b)
      this.hashMats.push(mat)
    }

    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(2.7, 1.0, 2.7),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pick.position.set(cx, 0.45 + RAM_LIFT, cz)
    this.group.add(pick)
    this.register(pick, {
      title: 'Hash index',
      body: 'Hashes the key into one of N buckets and stores TIDs there. Equality lookups only: no range scans, no ordering. Shown in memory: a lookup touches a single bucket page, and those pages sit in shared buffers while the index is being used.',
      meta: 'hash · 32-bit hash → bucket · equality only',
    })

    const lab = label('HASH')
    lab.position.set(cx + 0.2, 1.35 + RAM_LIFT, cz + 1.7)
    this.group.add(lab)
  }

  private buildLocks() {
    const cluster = new THREE.Group()
    cluster.position.set(0.4, 2.5, -3.9)
    const geo = new THREE.BoxGeometry(0.26, 0.26, 0.26)
    for (let i = 0; i < 7; i++) {
      const mat = glowMat(0x160a18, PALETTE.magenta, 0.35)
      const m = new THREE.Mesh(geo, mat)
      m.position.set(rand(-0.7, 0.7), rand(-0.3, 0.4), rand(-0.4, 0.4))
      m.rotation.set(rand(0, 1), rand(0, 1), rand(0, 1))
      cluster.add(m)
      this.lockMats.push(mat)
    }
    this.group.add(cluster)
    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 1.2, 1.4),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pick.position.copy(cluster.position)
    this.group.add(pick)
    this.register(pick, {
      title: 'Lock manager',
      body: 'Table and row locks plus MVCC snapshots let many transactions run at once. Contention shows up here as wait events.',
      meta: 'locks · MVCC snapshots',
    })
  }

  private buildBackends() {
    const slots = [-9.6, -5.75, -1.9, 1.9, 5.75, 9.6]
    const baseGeo = new THREE.CylinderGeometry(0.46, 0.54, 0.3, 20)
    const ringGeo = new THREE.TorusGeometry(0.56, 0.042, 6, 32)
    const LEDGeo = new THREE.SphereGeometry(0.16, 12, 10)
    const baseMat = glowMat(0x07131c, 0x1a4d63, 0.45, { metalness: 0.6, roughness: 0.3 })
    const pickGeo = new THREE.BoxGeometry(1.36, 0.62, 1.36)

    slots.forEach((x, i) => {
      const g = new THREE.Group()
      g.position.set(x, 9.88, 5.8)
      g.visible = false
      g.scale.setScalar(0.001)

      const base = new THREE.Mesh(baseGeo, baseMat)
      base.castShadow = true
      g.add(base)

      const ring = new THREE.MeshStandardMaterial({
        color: 0x0a1018,
        emissive: PALETTE.cyan,
        emissiveIntensity: 0.7,
        roughness: 0.3,
        metalness: 0.4,
      })
      const ringMesh = new THREE.Mesh(ringGeo, ring)
      ringMesh.rotation.x = Math.PI / 2
      ringMesh.position.y = 0.16
      g.add(ringMesh)

      const ledMat = new THREE.MeshStandardMaterial({
        color: 0x0a1018,
        emissive: PALETTE.cyan,
        emissiveIntensity: 0.9,
        roughness: 0.4,
      })
      const led = new THREE.Mesh(LEDGeo, ledMat)
      led.position.y = 0.24
      g.add(led)

      const gl = halo(PALETTE.cyan, 2.4, 0)
      gl.position.y = 0.3
      g.add(gl)

      // invisible hover/selection box that hugs this connection
      const pick = new THREE.Mesh(
        pickGeo,
        new THREE.MeshBasicMaterial({ visible: false }),
      )
      pick.position.copy(g.position)
      pick.userData.info = {
        title: `Backend · connection ${i + 1}`,
        body: 'One live client connection, handled by its own backend process. It parses, plans and executes its own queries, then returns the result through this same slot. Ports appear and disappear as clients connect and disconnect.',
        meta: 'process · one per connection · not a thread',
      }

      this.group.add(g)
      this.group.add(pick)
      this.backends.push({
        id: i,
        group: g,
        ring,
        glow: gl.material,
        pick,
        active: false,
        busy: false,
        index: i,
        pulse: 0,
      })
    })

    const lab = label('BACKENDS · CONNECTIONS')
    lab.position.set(-10.6, 11.05, 5.8)
    this.group.add(lab)
  }

  /* ---------------------------- backends lifecycle --------------------------- */

  private findBackend(id: number) {
    return this.backends.find((b) => b.id === id)
  }

  openBackend(): BackendPod | null {
    const free = this.backends.find((b) => !b.active)
    if (!free) return null
    free.active = true
    free.busy = false
    if (!this.pickables.includes(free.pick)) this.pickables.push(free.pick)
    return free
  }

  closeBackend(): boolean {
    const idle = this.backends.filter((b) => b.active && !b.busy)
    if (idle.length === 0) return false
    const victim = idle[randInt(0, idle.length - 1)]
    victim.active = false
    victim.busy = false
    const idx = this.pickables.indexOf(victim.pick)
    if (idx >= 0) this.pickables.splice(idx, 1)
    return true
  }

  acquireBackend(): BackendPod | null {
    let active = this.backends.filter((b) => b.active)
    if (active.length === 0) {
      const opened = this.openBackend()
      if (!opened) return null
      active = [opened]
    }
    const free = active.filter((b) => !b.busy)
    const pod =
      free.length > 0 ? free[randInt(0, free.length - 1)] : active[randInt(0, active.length - 1)]
    pod.busy = true
    return pod
  }

  releaseBackend(pod: BackendPod) {
    const b = this.findBackend(pod.id)
    if (b) b.busy = false
  }

  pulseBackend(pod: BackendPod) {
    const b = this.findBackend(pod.id)
    if (b) b.pulse = 1
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

  private buildPipeline(): Record<NodeName, PipelineNode> {
    const defs: { name: NodeName; pos: THREE.Vector3; color: number; text: string; info: Info }[] = [
      {
        name: 'parse',
        pos: ANCHOR.parse,
        color: PALETTE.cyan,
        text: 'PARSER',
        info: {
          title: 'Parser + rewriter',
          body: 'The SQL text becomes a parse tree, syntax is checked, and the rewriter expands views and rules before planning.',
          meta: 'raw_parser · rewrite',
        },
      },
      {
        name: 'plan',
        pos: ANCHOR.plan,
        color: PALETTE.violet,
        text: 'PLANNER',
        info: {
          title: 'Planner / optimizer',
          body: 'A cost-based optimizer enumerates access paths — seq scan, index scan, nested loop, hash join — estimates rows from statistics, and keeps the cheapest plan.',
          meta: 'pg_planner · cost model',
        },
      },
      {
        name: 'exec',
        pos: ANCHOR.exec,
        color: PALETTE.teal,
        text: 'EXECUTOR',
        info: {
          title: 'Executor',
          body: 'Walks the plan tree tuple by tuple, evaluating quals, joins and aggregates. Every page request goes through the buffer manager.',
          meta: 'executor · volcano model',
        },
      },
      {
        name: 'result',
        pos: ANCHOR.result,
        color: PALETTE.ice,
        text: 'RESULT',
        info: {
          title: 'Result → client',
          body: 'Rows stream back over the wire protocol as DataRow messages. A query ends when the portal is closed and the transaction commits.',
          meta: 'DataRow · CommandComplete',
        },
      },
    ]

    const out = {} as Record<NodeName, PipelineNode>
    for (const def of defs) {
      const group = new THREE.Group()
      group.position.copy(def.pos)

      const coreMat = new THREE.MeshStandardMaterial({
        color: 0x08131c,
        emissive: def.color,
        emissiveIntensity: 1.0,
        roughness: 0.25,
        metalness: 0.5,
      })
      const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 1), coreMat)
      group.add(core)

      const cageMat = new THREE.MeshStandardMaterial({
        color: 0x0d2431,
        emissive: def.color,
        emissiveIntensity: 0.4,
        wireframe: true,
        transparent: true,
        opacity: 0.55,
      })
      const cage = new THREE.Mesh(new THREE.IcosahedronGeometry(0.82, 1), cageMat)
      group.add(cage)

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1.02, 0.016, 6, 64),
        new THREE.MeshBasicMaterial({
          color: def.color,
          transparent: true,
          opacity: 0.65,
          blending: THREE.AdditiveBlending,
        }),
      )
      ring.rotation.x = Math.PI / 2
      group.add(ring)

      group.add(halo(def.color, 2.6, 0.2))

      const lab = label(def.text)
      lab.position.set(0.95, 0.05, 0)
      group.add(lab)

      this.register(group, def.info)
      this.group.add(group)
      out[def.name] = {
        group,
        core: coreMat,
        cage: cageMat,
        ring,
        baseScale: 1,
        home: def.pos.clone(),
        pulse: 0,
      }
    }
    return out
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
    beam.position.set(pageX(0), 1.15, DISK_PLATE.cz)
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
    drone.position.set(-8.5, 2.9, DISK_PLATE.cz)
    const lab = label('AUTOVACUUM')
    lab.position.set(0.55, 0.35, 0)
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

  /* ---------------------------------- runtime -------------------------------- */

  setPageActive(idx: number, color: THREE.ColorRepresentation, heat = 1) {
    const p = this.pages[idx]
    if (!p) return
    p.base.set(color)
    p.heat = Math.max(p.heat, heat)
  }

  pickBufferPage(): number {
    // prefer cool pages so the animation reads clearly
    const sorted = this.pages
      .map((p, i) => ({ i, h: p.heat }))
      .sort((a, b) => a.h - b.h)
    return sorted[randInt(0, Math.min(5, sorted.length - 1))].i
  }

  async scanHeap(): Promise<number> {
    const beam = this.scanner
    beam.visible = true
    const from = pageX(0) - 0.6
    const to = pageX(PAGE_GRID.cols - 1) + 0.6
    await this.ticker.add(1.1, (k) => {
      beam.position.x = from + (to - from) * k
        ; (beam.material as THREE.MeshBasicMaterial).opacity =
          0.1 + 0.55 * Math.sin(k * Math.PI)
    })
    beam.visible = false
    return 0
  }

  async scanIndex(): Promise<number[]> {
    const touched: number[] = []
    const order = [0, 1, 2, 1, 2, 2, 3, 2, 3, 3, 3]
    for (let i = 0; i < 6; i++) {
      const idx = order[i]
      const mat = this.btreeMats[idx]
      if (mat) {
        mat.emissiveIntensity = 1.4
        touched.push(idx)
        void this.ticker.add(0.45, (k) => {
          mat.emissiveIntensity = 1.4 - 0.9 * k
        })
      }
      await this.ticker.wait(0.09)
    }
    return touched
  }

  async flushWal(): Promise<void> {
    const lit = this.walFilledSegments
    for (let i = 0; i < lit; i++) {
      const m = this.walMats[i]
      void this.ticker.add(0.55, (k) => {
        m.emissiveIntensity = 0.6 + 2.2 * Math.sin(k * Math.PI)
      })
      await this.ticker.wait(0.05)
    }
    await this.ticker.wait(0.35)
  }

  async vacuum(): Promise<number> {
    const dead = this.tableBlocks.filter((p) => p.dead)
    if (dead.length === 0) return 0
    this.droneBusy = true
    const drone = this.vacuumDrone

    for (const p of dead) {
      // the drone hovers over the page, scrubs it, and moves on
      const over = p.home.clone().add(new THREE.Vector3(0, 2.2, 0))
      const from = drone.position.clone()
      await this.ticker.add(0.28, (k) => {
        drone.position.lerpVectors(from, over, easeInOutCubic(k))
      })
      p.dead = false
      // the page itself flares green as the space inside it becomes reusable
      void this.ticker.add(0.5, (k) => {
        const base = this.fillHex(p)
        this.tmpColorC
          .setHex(0xc7ff5a)
          .lerp(this.tmpColorA.setHex(base), k)
        if (k >= 0.999) this.tmpColorC.setHex(base)
        this.paintBlock(p, this.tmpColorC.getHex())
      })
      await this.ticker.wait(0.1)
    }
    this.deadCount = 0
    await this.ticker.wait(0.3)
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
    const chosen = this.pages
      .map((p, i) => ({ p, i }))
      .sort(() => Math.random() - 0.5)
      .slice(0, n)
    for (const { p } of chosen) {
      p.dirty = true
      p.base.set(PALETTE.amber)
      p.heat = 1
      await this.ticker.wait(0.03)
    }
  }

  cleanAllPages(): void {
    for (const p of this.pages) {
      p.dirty = false
      p.base.set(PALETTE.cyan)
    }
  }

  pulseNode(name: NodeName, strength = 1) {
    const n = this.nodes[name]
    if (n) n.pulse = Math.max(n.pulse, strength)
  }

  flashDisk(_idx = -1) {
    void this.ticker.add(0.9, (k) => {
      this.diskFlash = 0.6 * Math.sin(k * Math.PI)
    }).then(() => {
      this.diskFlash = 0
    })
  }

  /**
   * A buffer miss: one block physically lifts out of the disk array, floats up
   * toward the shared buffers and fades as the page lands in a buffer slot.
   * The floating is the whole point — it is the block that is now in memory.
   */
  liftFromDisk(pageIdx: number) {
    const free = this.pages8k.filter((b) => !b.busy)
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
    return new THREE.Vector3(ANCHOR.wal.x, WAL_BASE + i * 0.42, ANCHOR.wal.z)
  }

  get walFilledSegments() {
    return Math.max(1, Math.round(this.walFill * this.walSegments.length))
  }

  update(dt: number, time: number) {
    // buffer page shimmer + heat decay
    for (const p of this.pages) {
      p.heat = Math.max(0, p.heat - dt * 0.75)
      const idle = breathe(time, 0.8, p.row * 0.7 + p.col * 0.4) * 0.08
      const dirty = p.dirty ? 0.65 : 0
      p.mat.emissive.copy(p.base)
      p.mat.emissiveIntensity = 0.22 + idle + p.heat * 1.15 + dirty * 0.5
    }

    // WAL head rides the fill level
    const walTop = WAL_BASE + this.walFill * 6 * 0.42
    this.walHead.position.y += (walTop - this.walHead.position.y) * Math.min(1, dt * 3)
    this.walHead.rotation.y += dt * 2.2

    for (let i = 0; i < this.walMats.length; i++) {
      const on = i / this.walMats.length < this.walFill
      this.walMats[i].emissiveIntensity =
        (on ? 0.7 : 0.1) + (on ? breathe(time, 1.4, i * 0.6) * 0.12 : 0)
    }

    // pipeline nodes drift like slow satellites and breathe when they work
    for (const key of Object.keys(this.nodes) as NodeName[]) {
      const n = this.nodes[key]
      const phase = n.home.x * 0.7 + n.home.z
      n.pulse = Math.max(0, n.pulse - dt * 1.9)
      n.ring.rotation.z += dt * (key === 'exec' ? 1.5 : 0.7)
      n.group.position.set(
        n.home.x + Math.sin(time * 0.42 + phase) * 0.1,
        n.home.y +
        Math.sin(time * 0.75 + phase * 1.3) * 0.16 +
        Math.sin(time * 1.9 + phase) * 0.04 +
        n.pulse * 0.12,
        n.home.z + Math.cos(time * 0.5 + phase) * 0.1,
      )
      n.group.rotation.y += dt * 0.12
      n.core.emissiveIntensity = 1.0 + n.pulse * 1.6
      n.group.scale.setScalar(1 + Math.sin(time * 1.2 + phase) * 0.035 + n.pulse * 0.12)
    }

    // index highlight when index scan is on
    this.btreeMats.forEach((m, i) => {
      const target = this.indexScan ? 0.55 + 0.35 * Math.sin(time * 2 + i) : 0.4
      m.emissiveIntensity += (target - m.emissiveIntensity) * Math.min(1, dt * 4)
    })

    // locks twinkle
    this.lockMats.forEach((m, i) => {
      m.emissiveIntensity = 0.25 + 0.3 * breathe(time, 1.7, i)
    })

    // backend connection ports: scale in/out, glow while busy
    for (const b of this.backends) {
      b.pulse = Math.max(0, b.pulse - dt * 2.2)
      const target = b.active ? 1 : 0
      const s = b.group.scale.x + (target - b.group.scale.x) * Math.min(1, dt * 7)
      b.group.scale.setScalar(Math.max(0.001, s + b.pulse * 0.07))
      b.group.visible = s > 0.02

      if (b.busy) {
        b.ring.emissiveIntensity = 2.2 + 0.5 * Math.sin(time * 7 + b.id) + b.pulse * 2
        b.glow.opacity = 0.45
      } else {
        b.ring.emissiveIntensity =
          (b.active ? 0.75 + 0.2 * breathe(time, 1.1, b.id) : 0.1) + b.pulse * 2
        b.glow.opacity = b.active ? 0.08 : 0
      }
    }

    // index structures shimmer at different rhythms
    this.ginMats.forEach((m, i) => {
      m.emissiveIntensity = 0.62 + 0.34 * breathe(time, 2.0, i * 0.55)
    })
    this.brinMats.forEach((m, i) => {
      m.emissiveIntensity = 0.6 + 0.3 * breathe(time, 0.8, i * 0.8)
    })
    this.hashMats.forEach((m, i) => {
      m.emissiveIntensity = 0.35 + 0.3 * breathe(time, 1.5, i * 0.9)
    })

    // disks twinkle softly so the array looks powered
    // motes drift upward and wrap
    const attr = this.motes.geometry.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < attr.count; i++) {
      let y = attr.getY(i) + dt * 0.35
      if (y > 9.6) y = 0.25
      attr.setY(i, y)
    }
    attr.needsUpdate = true
    this.haloRing.rotation.z += dt * 0.12

    // dead pages breathe magenta until VACUUM reclaims the space inside them
    if (this.deadCount > 0) {
      for (const p of this.pages8k) {
        if (!p.dead) continue
        const k = 0.35 + 0.45 * breathe(time, 2.6, p.col * 0.3 + p.row * 0.7)
        this.tmpColorC.setHex(this.fillHex(p)).lerp(this.tmpColor.setHex(0xff3ea5), k)
        this.paintBlock(p, this.tmpColorC.getHex())
      }
    }

    // the block field breathes very slowly so it does not look like a texture
    const fieldMat = this.pageField.material as THREE.MeshStandardMaterial
    fieldMat.emissiveIntensity = 0.14 + 0.05 * breathe(time, 0.6, 0) + this.diskFlash

    // vacuum drone patrols the whole disk plate
    if (!this.droneBusy) {
      const a = time * 0.35
      const target = new THREE.Vector3(
        Math.cos(a) * 8.6,
        2.9 + Math.sin(time * 0.9) * 0.35,
        DISK_PLATE.cz + Math.sin(a) * 3.1,
      )
      this.vacuumDrone.position.lerp(target, Math.min(1, dt * 1.2))
      this.vacuumDrone.rotation.y += dt * 0.8
    } else {
      this.vacuumDrone.rotation.y += dt * 2.4
    }
  }

  droneBusy = false
  private diskFlash = 0
  private tmpColor = new THREE.Color()
  private tmpColorA = new THREE.Color()
  private tmpColorB = new THREE.Color()
  private tmpColorC = new THREE.Color()
  private dummy = new THREE.Object3D()
}
