import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import {
  Ticker,
  OutlineBox,
  breathe,
  easeInOutCubic,
  floorLabel,
  halo,
  label,
  neonEdges,
  radialTexture,
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

/**
 * What the pointer found inside the instanced page field: the info for that one
 * block, a stable key for hover bookkeeping, and bounds tight enough to draw an
 * outline around a single block rather than around the whole field.
 */
export interface BlockPick {
  key: string
  info: Info
  box: THREE.Box3
}

/** Camera distance inside which individual blocks can be picked. */
export const BLOCK_PICK_RANGE = 7

/** Postgres page size. One block is exactly this many bytes, always. */
export const PAGE_BYTES = 8192

/** Default WAL segment size: the run is a set of these, numbered in order. */
export const WAL_SEGMENT_BYTES = 16 * 1024 * 1024

export interface Page {
  mesh: THREE.Mesh
  mat: THREE.MeshStandardMaterial
  base: THREE.Color
  heat: number
  row: number
  col: number
  dirty: boolean
  /** How packed the page is with live tuples, 0..1 — same meaning as on disk. */
  fill: number
  /** The block on disk this slot currently holds a copy of, if any. */
  block: Page8K | null
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
  /**
   * A page that belongs to postgres itself rather than to user data: a system
   * catalog, an FSM/VM fork, or the commit log. Drawn grey — the scene's way of
   * saying "this is not yours".
   */
  system: SystemArea | null
  /** Holds dead row versions: VACUUM will reclaim the space inside it. */
  dead: boolean
  busy: boolean
}

export type NodeName = 'parse' | 'plan' | 'exec'

/**
 * Cells in a backend's input buffer. Slot 0 is whatever it is executing right
 * now, the rest are pipelined requests whose bytes are already sitting in that
 * process's own heap. This is private memory per backend — NOT shared_buffers.
 */
export const INBUF_CELLS = 3
/** x of each connection port along the top rim, in order */
export const BACKEND_SLOTS = [-9.6, -5.75, -1.9, 1.9, 5.75, 9.6]
/** where the ports sit in the scene */
export const BACKEND_ORIGIN = { y: 9.88, z: 5.8 }
/** vertical pitch between buffered requests */
const INBUF_PITCH = 0.52
/** local y of the oldest cell — the head of the buffer, about to be executed */
const INBUF_BOTTOM = -1.86

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
  /** requests pipelined behind the running one, waiting in the input buffer */
  inbuf: number
  /**
   * Requests sent on this connection whose bytes are still on their way. A pool
   * checks a connection out the moment it hands it to a client, so a burst of
   * taps spreads across ports instead of piling onto the first one.
   */
  pending: number
  /** the drawn cells of the input buffer */
  cells: THREE.Mesh[]
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

/** How far "in-memory right now" structures float above the disk plate. */
const RAM_LIFT = 1.15

/**
 * The disk is tiled edge to edge with page blocks. Spacing is 0.5 and the floor
 * grid is drawn every 2 units, so four blocks fit exactly in one grid cell and
 * every fourth block edge lands on a grid line.
 */
export const PAGE_GRID = { cols: 48, rows: 17, gx: 0.5, gz: 0.5, bw: 0.46, bh: 0.28, bd: 0.46 }

/** Grey tint used for everything postgres owns rather than the user. */
const SYSTEM_GREY = 0x93a1ae

export type SystemArea = 'catalog' | 'fork' | 'clog'

/**
 * PGDATA is not only user tables. Every database carries its own copy of the
 * catalogs, each relation has FSM/VM forks beside it, and pg_xact holds two
 * bits of commit status per transaction. They are small next to the data, and
 * that is exactly what the grey runs show: real, but not where the rows live.
 */
const SYSTEM_RUNS: {
  area: SystemArea
  label: string
  /** inclusive column span */
  c0: number
  c1: number
  rows: [number, number]
  files: string[]
  what: string
}[] = [
    {
      area: 'catalog',
      label: 'CATALOGS',
      c0: 24,
      c1: 29,
      rows: [12, 13],
      files: ['pg_class', 'pg_attribute', 'pg_index', 'pg_type', 'pg_proc', 'pg_depend'],
      what: 'The catalog relations every database carries a copy of: what each table is, which columns it has, which indexes exist, and what depends on what. Same 8 kB page as a heap — they are small because there are few of them, not because the pages are smaller: a fresh cluster keeps the whole set in a few megabytes. Queries read them too — the planner asks pg_class and pg_statistic what it is planning over.',
    },
    {
      area: 'fork',
      label: 'FSM · VM',
      c0: 30,
      c1: 31,
      rows: [12, 13],
      files: ['_fsm', '_vm'],
      what: 'Two thin side files per relation, in 8 kB pages like everything else. One byte of free space map per heap page covers 64 MB of relation; two bits of visibility map per page cover 256 MB. The free space map says which pages have room for a new tuple, so an insert need not read every page; the visibility map says which pages are all-visible, which is what lets VACUUM and index-only scans skip work.',
    },
    {
      area: 'clog',
      label: 'CLOG',
      c0: 32,
      c1: 33,
      rows: [12, 13],
      files: ['pg_xact', 'pg_multixact'],
      what: 'Two bits per transaction, and nothing else: committed, aborted, in progress, or not yet assigned. One 8 kB page therefore covers 32,768 transactions, which is why the commit log stays tiny even on a busy server. Every visibility check starts here.',
    },
  ]

/**
 * The WAL is not a column floating in the air: it is a contiguous run of slots
 * in the page lattice, at the front edge of the disk next to the free space it
 * grows into. Segments are appended left to right and recycled in place.
 */
const WAL_ROW = 16
const WAL_BUF_LEN = 4

/* shared_buffers sits on the same 0.5 lattice as the disk, floating above it */
const BUFFER_COLS = 12
const BUFFER_ROWS = 6
const BUFFER_Y = 5.35
const bufferSlotX = (c: number) => -3.75 + c * PAGE_GRID.gx
const bufferSlotZ = (r: number) => -2.75 + r * PAGE_GRID.gz
export { bufferSlotX, bufferSlotZ }
/** Leftmost slot of the run — the free space it grows into sits just below. */
const WAL_C0 = 10
const WAL_LEN = 12
const PAGE_Y = 0.25
export const pageX = (col: number) => -11.75 + col * PAGE_GRID.gx
export const pageZ = (row: number) => -0.75 + row * PAGE_GRID.gz
const PAGE_W = PAGE_GRID.cols * PAGE_GRID.gx
const PAGE_D = PAGE_GRID.rows * PAGE_GRID.gz
/** Outer edge of the block field — the blocks are the only thing in the plate. */
const PAGE_Z0 = pageZ(0) - PAGE_GRID.gz / 2

/**
 * The plate under the page blocks: same footprint as the field, zero padding.
 * The plates used to be a hand-picked size slightly larger than the blocks, so
 * its edge sat a random distance off the outermost row and nothing that lined
 * up against "the disk" was actually lining up with the blocks. Derived from
 * the lattice now, so the only gap at the edge is the block spacing.
 */
export const DISK_PLATE = { w: PAGE_W, d: PAGE_D, cz: PAGE_Z0 + PAGE_D / 2, top: 0.09 }

/**
 * World Y of the top face of a resting block, on disk and in RAM. Every arrow
 * that lands on a page aims at one of these planes, never at thin air.
 */
export const PAGE_TOP_Y = PAGE_Y + PAGE_GRID.bh / 2
export const BUFFER_TOP_Y = BUFFER_Y + PAGE_GRID.bh / 2

/**
 * Floor text sits *on* the ground: the floor grid is drawn at 0.09 and the
 * plate's top face at 0.08, so this is a hair above both — enough to avoid
 * z-fighting, not enough to read as a floating sign.
 */
const FLOOR_LABEL_Y = 0.1

/** Albedo of a free (unassigned) page block. */
const BLOCK_FREE = 0x6b4a1c
/** Page fill ramp: empty slot → packed page. */
const FILL_DARK = 0x0e0a04
const FILL_BRIGHT = 0xd28f2c
/** Same idea for the page copies in RAM: dim = sparse, bright = packed. */
const BUF_DARK = 0x081a24
const BUF_FILL_DARK = new THREE.Color(0x081a24)
const BUF_FILL_BRIGHT = new THREE.Color(0x9fe8ff)

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
  bufferCenter: V(-1.0, 5.35, -1.5),
  wal: V(-4.0, 0.55, 7.25),
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
  readonly walBufferMats: THREE.MeshStandardMaterial[] = []
  /** The page blocks that belong to the WAL run, in write order. */
  readonly walBlocks: Page8K[] = []
  /** Per-segment flash boost, decays in update(). */
  private walBoost = new Map<number, number>()
  /** the floating wal_buffers cubes, and the group that carries them */
  readonly walBufBlocks: THREE.Mesh[] = []
  private walBufGroup!: THREE.Group
  readonly btreeMats: THREE.MeshStandardMaterial[] = []
  readonly ginMats: THREE.MeshStandardMaterial[] = []
  readonly brinMats: THREE.MeshStandardMaterial[] = []
  readonly hashMats: THREE.MeshStandardMaterial[] = []
  readonly lockMats: THREE.MeshStandardMaterial[] = []
  /** Instanced field of 8 kB page blocks that fills the whole disk plate. */
  pageField!: THREE.InstancedMesh
  /** Reusable block mesh used while a page is being read up into RAM. */
  private liftMesh!: THREE.Mesh
  /** Pool corners for attaching labels to the actual block grid. */
  bufferCorners!: {
    nearLeft: THREE.Vector3
    nearRight: THREE.Vector3
    farLeft: THREE.Vector3
    farRight: THREE.Vector3
  }
  /** The one geometry every 8 kB block in the scene uses. */
  readonly pageBlockGeo = new RoundedBoxGeometry(
    PAGE_GRID.bw,
    PAGE_GRID.bh,
    PAGE_GRID.bd,
    1,
    0.02,
  )
  private markGeo!: THREE.TorusGeometry
  private markMat!: THREE.MeshBasicMaterial
  /** One port per client connection, sitting on the top boundary of the box. */
  readonly backends: BackendPod[] = []
  readonly scanner: THREE.Mesh
  readonly vacuumDrone: THREE.Group
  motes!: THREE.Points
  haloRing!: THREE.Mesh

  indexScan = false
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
    this.scanner = this.makeScanner()
    this.vacuumDrone = this.makeVacuumDrone()

    // a few clients are already connected when the instance starts
    this.openBackend()
    this.openBackend()
    this.openBackend()
  }

  /* --------------------------------- building ------------------------------- */

  private register(obj: THREE.Object3D, info: Info, outline?: OutlineBox) {
    obj.userData.info = info
    // a pickable that already owns an outline highlights that outline rather
    // than having a second box drawn around it
    if (outline) obj.userData.outline = outline
    this.pickables.push(obj)
    return obj
  }

  private buildShell() {
    const shellH = 9.8
    const shellW = 25.2
    const shellD = 16.0

    // The process boundary is one outline box — the same primitive the table
    // selection marquees use. No posts, no rim, nothing with thickness. It is
    // picked by its edges, so it never occludes anything inside it.
    const cage = new OutlineBox(shellW, shellH, shellD, 0x3fa8cc, 0.34)
    cage.fromFloor(0, 0, 0)
    this.group.add(cage)
    this.register(cage, {
      title: 'PostgreSQL',
      body: 'One running postgres instance — not a single process but a small family of them: a postmaster that listens and forks, one backend process per connection, plus the checkpointer, the WAL writer and autovacuum. Everything inside this cage — parser, planner, executor, buffers, WAL — is shared by them. Clients sit outside, in the sky.',
      meta: 'postmaster + backends + auxiliaries · shared memory',
    })

    // There is deliberately no pedestal here: the instance stands on the same
    // global floor grid as everything else, so the disk field is not sitting on
    // a slab of its own. The plate under the blocks is the only local surface.

    /* -------------------------------------------------------------------- disk */
    // The disk is only the field of page blocks. This plate is deliberately
    // colourless — it just gives the blocks a bed and marks their footprint.
    const plate = new THREE.Mesh(
      new RoundedBoxGeometry(DISK_PLATE.w, 0.04, DISK_PLATE.d, 2, 0.02),
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

    const plateEdge = new OutlineBox(
      DISK_PLATE.w,
      0.04,
      DISK_PLATE.d,
      0x2f9fbf,
      0.55,
    ).centre(0, 0.06, DISK_PLATE.cz)
    this.group.add(plateEdge)

    const diskFloorPick = new THREE.Mesh(
      new THREE.BoxGeometry(DISK_PLATE.w, 0.3, DISK_PLATE.d),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    diskFloorPick.position.set(0, 0.12, DISK_PLATE.cz)
    this.group.add(diskFloorPick)
    this.register(
      diskFloorPick,
      {
        title: 'Disk — a field of 8 kB pages',
        body: 'Every block is one 8 kB page; brighter and taller means fuller. Most of these pages belong to tables and indexes we do not draw — system catalogues, other tables — and each keeps its own slightly different shade. The three outlined runs are the tables we do label. The gaps are free space: no page there at all, just room the files can grow into. RAM only ever holds copies, so only copies float.',
        meta: 'disk · one block = 8 kB page · lived-in, not a grid of blanks',
      },
      plateEdge,
    )

    // On the floor and off the plate, along the short axis, starting at the
    // front corner past the metrics run. Same treatment as FREE SPACE: it is
    // painted on the ground, so it foreshortens and goes away with the surface.
    // Placement is on the ink, not the quad (the quad carries padding), so the
    // first glyph begins on the corner and the text sits just off the edge.
    const floorLab = floorLabel('DISK', { height: 0.475, color: 'rgba(170, 220, 242, 0.9)' })
    floorLab.rotation.z = Math.PI / 2
    const ink = floorLab.userData.ink as { x0: number; x1: number; y0: number; y1: number }
    // Line the first glyph up with the corner of the block field itself.
    // rotation.z of +90° maps plane +x onto world -z and plane +y onto world
    // -x, so the ink's left edge sets the start along the field edge and its
    // top edge sits on that edge
    floorLab.position.set(
      DISK_PLATE.w / 2 + ink.y1,
      FLOOR_LABEL_Y,
      DISK_PLATE.cz + DISK_PLATE.d / 2 + ink.x0,
    )
    this.group.add(floorLab)

    const processLabel = label('POSTGRESQL')
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
        // a point with no map renders as a hard white square, which reads as a
        // node sitting in the scene — the soft radial sprite reads as dust
        map: radialTexture(),
        alphaTest: 0.01,
        size: 0.13,
        transparent: true,
        opacity: 0.32,
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
  }

  /**
   * shared_buffers: the same 8 kB page blocks as the disk, but floating in RAM.
   * Same size, same shape, same lattice alignment — nothing is bolted down.
   */
  private buildBufferPool() {
    const cols = BUFFER_COLS
    const rows = BUFFER_ROWS

    // corners of the floating grid, handy for labels and camera framing
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
        const mat = glowMat(BUF_DARK, PALETTE.cyan, 0.22, { metalness: 0.5, roughness: 0.35 })
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

    // invisible pick volume over the whole pool
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
      body: 'The page cache every backend shares. Each block is one buffer slot holding a full 8 kB page — identical to a page on disk. The slot is always 8 kB; what varies is how packed the page inside is, and that is what brightness and height show. Lifecycle: a miss picks a victim with the clock sweep (usage_count 0), writes it back if it is dirty, then reads the new page in. The slot itself never moves — only which page lives in it changes. Hue is state: cyan = cached and clean, amber = dirty (waiting to be written), green = just served a hit.',
      meta: 'shared_buffers · RAM · 8 kB pages · clock sweep',
    })
  }

  /** Colour + height of one buffer page, driven by how packed it is. */
  private setBufferFill(page: Page, fill: number) {
    page.fill = Math.max(0, Math.min(1, fill))
    page.mat.color.copy(BUF_FILL_DARK).lerp(BUF_FILL_BRIGHT, page.fill)
    const h = 0.5 + 0.5 * page.fill
    page.mesh.scale.y = h
    // keep the slot pinned to the lattice; only its height changes
    page.mesh.position.set(
      bufferSlotX(page.col),
      BUFFER_Y - PAGE_GRID.bh * (1 - h) * 0.5,
      bufferSlotZ(page.row),
    )
  }

  /** Public hook: a page landed in this slot (its fill comes from the disk copy). */
  setPageFill(idx: number, fill: number) {
    const p = this.pages[idx]
    if (p) this.setBufferFill(p, fill)
  }

  /**
   * A miss evicts the current occupant of the slot (clock sweep) and reads a new
   * page into it. Layout never moves — only which page lives in the slot.
   */
  async swapBufferPage(idx: number, fill: number, block?: Page8K | null) {
    const p = this.pages[idx]
    if (!p) return
    const from = p.fill
    await this.ticker.add(0.16, (k) => this.setBufferFill(p, from * (1 - k)))
    const to = fill
    await this.ticker.add(0.2, (k) => this.setBufferFill(p, to * k))
    p.block = block ?? null
  }

  /**
   * The slot a write will modify. Postgres never writes a block in place: it
   * loads the page into a shared buffer slot if it is not there already, and the
   * change happens to that copy. Prefers a slot that already caches a table page
   * — that is what a live write usually finds.
   */
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

  /**
   * Apply a change to a buffer page. The slot holds the new contents and is
   * dirty; the block on disk still holds the old contents, and stays that way
   * until the checkpointer writes the page back. Returns the slot so the arrow
   * can end on the page that actually changed.
   */
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

  /**
   * The WAL is not separate geometry: it is a marked run of blocks inside the
   * page field. buildPageField styles those blocks, so nothing can overlap.
   */
  private buildWal() {
    // the run is a real extent on disk, so it gets a real extent outline
    const x0 = pageX(WAL_C0) - PAGE_GRID.gx / 2
    const x1 = pageX(WAL_C0 + WAL_LEN - 1) + PAGE_GRID.gx / 2
    const z0 = pageZ(WAL_ROW) - PAGE_GRID.gz / 2
    const z1 = pageZ(WAL_ROW) + PAGE_GRID.gz / 2
    const runEdge = new OutlineBox(
      x1 - x0,
      0.5,
      z1 - z0,
      0xffb03a,
      0.75,
    ).centre((x0 + x1) / 2, PAGE_Y + 0.1, (z0 + z1) / 2)
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
      },
      runEdge,
    )

    // wal_buffers: page-sized cubes of shared memory holding the tail of the
    // log. They hover in the same lattice columns as the segments below and
    // drift with the write head.
    const wb = new THREE.Group()
    const wbGeo = new RoundedBoxGeometry(PAGE_GRID.bw, PAGE_GRID.bh, PAGE_GRID.bd, 2, 0.025)
    for (let i = 0; i < WAL_BUF_LEN; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x0b2a36,
        emissive: PALETTE.cyan,
        // deliberately dim at rest: four adjacent emissive cubes at full
        // strength bloom into one white slab, and then they stop reading as
        // four pages of staging memory
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
      body: 'wal_buffers is a circular strip of 8 kB shared-memory pages that holds the newest WAL records. It is NOT a copy of heap pages: the records describe changes to pages, but the buffer holds the log stream itself. Anything here is not durable yet — it becomes durable when the WAL writer writes it to the segment blocks below and fsyncs. After that the memory is simply overwritten, so these cubes are a staging area, and the segment below is the lasting artefact.',
      meta: 'wal_buffers · RAM · 8 kB pages · circular · flushed by WAL writer',
    })

    const wbLab = label('WAL BUFFERS · RAM')
    wbLab.position.set(0, 0.75, 0)
    wb.add(wbLab)

    const lab = label('WAL · DISK')
    lab.position.set(x0 + 0.4, PAGE_Y + 0.85, z1 + 0.15)
    this.group.add(lab)
  }

  /**
   * WAL blocks are ordinary blocks in the field — we only restyle them, so they
   * can never overlap or z-fight with the surrounding pages.
   *
   * The run is a ring, not a growing line: pg_wal has a fixed footprint, so the
   * write head wraps and overwrites segments that are no longer needed. That is
   * the whole reason a busy server's WAL does not fill the disk.
   */
  private styleWal(time: number, dt: number) {
    const len = this.walBlocks.length
    const head = this.walHeadIndex
    const live = Math.min(len, Math.max(1, this.walWritten))
    for (let i = 0; i < len; i++) {
      const p = this.walBlocks[i]
      if (p.busy) continue
      // how far behind the head this segment was written; 0 is the head itself
      const behind = (head - i + len) % len
      const on = behind < live
      const isHead = i === head
      const boost = this.walBoost.get(i) ?? 0
      if (boost > 0) {
        const next = boost * (1 - Math.min(1, dt * 2.6))
        if (next < 0.03) this.walBoost.delete(i)
        else this.walBoost.set(i, next)
      }

      // Height is real, not decorative: a finished segment is full, the head is
      // as full as the bytes actually appended to it, and a recycled one starts
      // again from near-empty. Every other part of the scene reads p.fill, so
      // arrows land on the true top face.
      const fill = isHead ? Math.max(0.08, this.walProgress) : on ? 1 : 0
      const base = isHead ? 0xffc76b : on ? 0xc9822a : 0x140f07
      const k = (isHead ? 0.82 + 0.18 * breathe(time, 2.2, 0) : 1) + boost * 0.6
      this.tmpColorC.setHex(base).multiplyScalar(k)
      this.paintBlock(p, this.tmpColorC.getHex())
      p.fill = fill
      this.applyTransform(p, 1, on || isHead ? this.blockScale(fill) : this.blockScale(0) * 0.35)
    }
  }

  /** One-shot flare on a WAL block, used when a checkpoint recycles the run. */
  flashWalSegment(i: number) {
    this.walBoost.set(i, 1)
  }

  /** Centre of WAL segment `i` in the page lattice. */
  walSlot(i: number) {
    // index 0 is the oldest segment: it sits at the far end, and appends walk
    // leftwards towards the unallocated space
    return new THREE.Vector3(pageX(WAL_C0 + (WAL_LEN - 1 - i)), PAGE_Y, pageZ(WAL_ROW))
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
    // registered by hand: the field answers with a different object per
    // instance, so it has no single info of its own
    field.userData.infoFor = (hit: THREE.Intersection) => this.blockPick(hit)
    this.pickables.push(field)

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
        const onWal = r === WAL_ROW && c >= WAL_C0 && c < WAL_C0 + WAL_LEN
        const free = !table && !onWal && freeAt(c)

        dummy.position.copy(home)
        if (free) {
          // no page here: collapse the block so the plate shows through
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
          // pages we do not label still hold data from other tables
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
        // unshift keeps walBlocks in *write* order: index 0 is the oldest
        // segment at the far end, so appends walk towards the free space
        if (onWal) this.walBlocks.unshift(block)
        i++
      }
    }
    this.pages8k.forEach((p) => {
      if (!p.free) this.setFill(p, p.fill)
    })
    this.markSystemAreas()

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

    this.markGeo = new THREE.TorusGeometry(0.34, 0.025, 4, 28)
    this.markMat = new THREE.MeshBasicMaterial({
      color: PALETTE.amber,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })

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
    // a page with nothing in it is not a dark page — it is not there at all
    if (p.fill <= 0.001) {
      return this.tmpColorA.setHex(BLOCK_FREE).multiplyScalar(p.shade).getHex()
    }
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

  /**
   * Centre of the top face of a page block — the exact point an arrow should
   * land on. Blocks stand on the plate and grow upwards, so the top is the
   * bottom plus the scaled height, not half a block above the centre.
   */
  blockTop(p: Page8K): THREE.Vector3 {
    const h = PAGE_GRID.bh * this.blockScale(p.fill)
    return p.home.clone().setY(p.home.y - PAGE_GRID.bh / 2 + h)
  }

  /** The same point for a page living in shared buffers. */
  pageTop(p: Page): THREE.Vector3 {
    return p.mesh.position.clone().setY(p.mesh.position.y + (PAGE_GRID.bh / 2) * p.mesh.scale.y)
  }

  /**
   * The field is one InstancedMesh, so what the pointer lands on is an
   * instance, not an object. From a distance a single 0.5-unit block is a few
   * pixels across and the whole field would swallow every click meant for the
   * plate, so blocks only become pickable once the camera is close to them.
   */
  blockPick(hit: THREE.Intersection): BlockPick | null {
    const id = hit.instanceId
    if (id === undefined) return null
    const p = this.pages8k[id]
    if (!p || p.free) return null
    if (hit.distance > BLOCK_PICK_RANGE) return null
    // the WAL run is part of the same InstancedMesh, but a segment is not a page
    const walIdx = this.walBlocks.indexOf(p)
    if (walIdx >= 0) {
      return { key: `wal-${walIdx}`, info: this.walSegmentInfo(walIdx), box: this.blockBox(p) }
    }
    if (p.system) {
      return { key: `sys-${p.i}`, info: this.systemInfo(p), box: this.blockBox(p) }
    }
    return { key: `page-${p.i}`, info: this.blockInfo(p), box: this.blockBox(p) }
  }

  /** A grey block: one page of something postgres keeps for itself. */
  private systemInfo(p: Page8K): Info {
    const run = SYSTEM_RUNS.find((r) => r.area === p.system)
    if (!run) return this.blockInfo(p)
    const file = run.files[(p.col - run.c0) % run.files.length]
    const pageInFile = p.row - run.rows[0] + Math.floor((p.col - run.c0) / run.files.length)
    return {
      title: `${file} · system page`,
      body:
        `${run.what} This particular block is one 8 kB page of ${file}. It is drawn grey because it is ` +
        `not user data: you cannot query it as a table, and VACUUM writes into it rather than reclaiming ` +
        `it. In a real PGDATA these live in base/<dboid>/ next to the heap files, plus pg_xact for the ` +
        `commit status — small, but every query touches them.`,
      meta: `${run.label.toLowerCase()} · page ${pageInFile} of ${file} · postgres-owned, not your data`,
    }
  }

  /** Tight bounds of one block, for the hover outline. */
  private blockBox(p: Page8K): THREE.Box3 {
    const half = PAGE_GRID.bh / 2
    const h = PAGE_GRID.bh * this.blockScale(p.fill)
    const y0 = p.home.y - half
    return new THREE.Box3(
      new THREE.Vector3(p.home.x - PAGE_GRID.bw / 2, y0, p.home.z - PAGE_GRID.bd / 2),
      new THREE.Vector3(p.home.x + PAGE_GRID.bw / 2, y0 + h, p.home.z + PAGE_GRID.bd / 2),
    )
  }

  blockInfo(p: Page8K): Info {
    // pages are numbered from 0 in the relation's file, and each one is exactly
    // 8 kB, so the byte range is arithmetic rather than a lookup
    const start = p.i * PAGE_BYTES
    const end = start + PAGE_BYTES - 1
    const packed = Math.round(p.fill * 100)
    const owner = p.table ? `the heap file of TABLE: ${p.table}` : 'a relation the scene does not label'
    const kB = (n: number) => (n / 1024).toFixed(1).replace(/\.0$/, '')
    const dead = p.dead
      ? ' It currently holds dead row versions — VACUUM will reclaim the space inside this page.'
      : ''
    return {
      title: `Page ${p.i} · 8 kB contiguous`,
      body:
        `A block is one contiguous 8 kB stretch of a file — the smallest unit Postgres ever reads or ` +
        `writes, and the unit shared_buffers caches. It is not a row and not a table: rows are packed ` +
        `into the front of it, left to right, and the free space left over sits in the middle. Reading ` +
        `"one page" therefore means one 8192-byte request, never a partial read. This one belongs to ` +
        `${owner} and is ${packed}% full: taller and brighter means more of its bytes are in use.` +
        dead,
      meta: `bytes ${start}–${end} · page ${p.i} of the file · ${packed}% packed` +
        ` · ${kB(PAGE_BYTES)} kB block${p.dead ? ' · dead tuples' : ''}`,
    }
  }

  /**
   * One segment of pg_wal. The height of the block is how much of it has been
   * written, so this reads the same number the geometry is drawn from.
   */
  walSegmentInfo(i: number): Info {
    const len = this.walBlocks.length
    const head = this.walHeadIndex
    const behind = (head - i + len) % len
    const live = Math.min(len, Math.max(1, this.walWritten))
    const isHead = i === head
    const start = i * WAL_SEGMENT_BYTES
    const end = start + WAL_SEGMENT_BYTES - 1
    const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`
    const written = isHead
      ? this.walProgress
      : behind < live
        ? 1
        : 0
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
      // scaled around its centre a block would sink into the plate as it fills
      // and float as it empties; keep the bottom face planted instead
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

  /**
   * Flash the pages a statement touched, then settle back to their fill colour.
   * This is how you see which blocks the query actually rewrote.
   */
  touchBlocks(blocks: Page8K[], hex: number, dur = 0.55, lift = 1.35) {
    for (const p of blocks) this.paintBlock(p, hex)
    for (const p of blocks) {
      const liftBy = this.blockScale(p.fill) * lift
      this.applyTransform(p, 1, liftBy)
      void this.ticker.add(dur, () => { }).then(() => {
        if (p.busy) return
        this.paintBlock(p, this.fillHex(p))
        this.showBlock(p)
      })
    }
  }

  /**
   * Paint the grey runs that belong to postgres rather than to user data, cage
   * them together and tag the cage. They stay low: these files are small next
   * to the heaps, and the cage says "same disk, different owner".
   */
  private markSystemAreas() {
    let c0 = Infinity
    let c1 = -Infinity
    let r0 = Infinity
    let r1 = -Infinity
    for (const run of SYSTEM_RUNS) {
      for (let r = run.rows[0]; r <= run.rows[1]; r++) {
        for (let c = run.c0; c <= run.c1; c++) {
          const p = this.pages8k.find((b) => b.row === r && b.col === c)
          if (!p || p.free) continue
          p.system = run.area
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

    const cage = new OutlineBox(x1 - x0, 0.55, z1 - z0, SYSTEM_GREY, 0.5).centre(
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
          'visibility maps that sit beside each relation, and the commit log. They are ordinary 8 kB pages ' +
          'like everything else here — the same block size, the same buffer pool — they are just small, ' +
          'because there are few of them: a fresh cluster holds the whole set in a few megabytes. Hover a ' +
          'grey block to see which file it belongs to.',
        meta: 'catalogs · free space map · visibility map · commit log · 8 kB pages',
      },
      cage,
    )

    const lab = label('PG SYSTEM')
    lab.position.set(x0 + 0.45, PAGE_Y + 0.95, z1 + 0.1)
    this.group.add(lab)
  }

  /** Expanding ring on top of one page: "the arrow landed exactly here". */
  markBlock(p: Page8K, hex: number) {
    const ring = new THREE.Mesh(this.markGeo, this.markMat.clone())
    const mat = ring.material as THREE.MeshBasicMaterial
    mat.color.setHex(hex)
    ring.rotation.x = -Math.PI / 2
    ring.position.copy(this.blockTop(p))
    ring.scale.setScalar(0.35)
    this.group.add(ring)
    void this.ticker
      .add(0.6, (k) => {
        ring.scale.setScalar(0.35 + k * 0.9)
        mat.opacity = 0.85 * (1 - k)
      })
      .then(() => {
        this.group.remove(ring)
        mat.dispose()
      })
  }

  /** A page in some table that a read is about to touch. */
  pickBlockForRead(): Page8K | null {
    const filled = this.tableBlocks.filter((b) => b.fill > 0.001 && !b.busy)
    if (filled.length === 0) return null
    return filled[randInt(0, filled.length - 1)]
  }

  /**
   * VACUUM FULL / CLUSTER style rewrite: the relation is packed into a
   * brand-new file, tuples pulled to the front, and the empty pages at the end
   * disappear. That is the only thing that actually defragments a heap.
   */
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
        // a rewrite sweeps the relation from front to back
        const stagger = Math.min(1, Math.max(0, k * 1.7 - i / blocks.length))
        this.setFill(b, before[i] + (after[i] - before[i]) * easeInOutCubic(stagger))
      })
    })
    this.touchBlocks(blocks, 0x9be8ff, 0.5, 1.15)
    await this.ticker.wait(0.3)
    return { table: region.label, pages: packed.length }
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

      const edges = new OutlineBox(w, h, d, region.color, 0.85).centre(
        cx,
        PAGE_Y - 0.12 + h / 2,
        cz,
      )
      this.group.add(edges)

      const pick = new THREE.Mesh(
        new THREE.BoxGeometry(w, h + 0.7, d),
        new THREE.MeshBasicMaterial({ visible: false }),
      )
      pick.position.set(cx, PAGE_Y + h / 2, cz)
      this.group.add(pick)
      this.register(pick, region.info, edges)

      // centred above the run, at staggered heights so labels never collide
      const stagger = TABLE_REGIONS.findIndex((r) => r.label === region.label) * 0.45
      const lab = label(`TABLE: ${region.label}`)
      lab.position.set(cx, PAGE_Y + h + 0.55 + stagger, cz)
      this.group.add(lab)

      ANCHOR[region.anchor].set(cx, PAGE_Y, cz)
    }

    // point at a genuine hole in the field: space the files can grow into.
    // Secondary by design — mid-grey and small, lying in the middle of the
    // emptiness rather than sitting above it. Turned to run along the disk's
    // shorter axis so it fits the gap instead of sprawling across the field.
    const freeLab = floorLabel('FREE SPACE', {
      height: 0.58,
      color: 'rgba(128, 158, 178, 0.85)',
      opacity: 0.55,
      weight: 400,
    })
    freeLab.rotation.z = Math.PI / 2
    freeLab.position.set(pageX(5), FLOOR_LABEL_Y, pageZ(7))
    this.group.add(freeLab)

    // tappable: the hole needs somewhere to send its explanation, now that the
    // label only says two words
    const freePick = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 0.7, 4.6),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    freePick.position.set(pageX(5), PAGE_Y, pageZ(7))
    this.group.add(freePick)
    // nothing to outline: the pick volume is a box of empty air, so hovering it
    // would draw a cage around nothing. The floor label is the marker.
    freePick.userData.noOutline = true
    this.register(freePick, {
      title: 'Free space — room the files can grow into',
      body: 'These slots hold no page at all. A table or index is a contiguous run of 8 kB pages, so when a relation runs out of pages it simply takes the next slots in its own file — this is where that growth comes from. Free space is not a fixed size and nothing owns it in advance: the files claim it as they fill. A table that was rewritten by VACUUM FULL gives slots back here.',
      meta: 'unallocated · no page on disk · allocated on demand',
    })
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
    const slots = BACKEND_SLOTS
    const baseGeo = new THREE.CylinderGeometry(0.46, 0.54, 0.3, 20)
    const ringGeo = new THREE.TorusGeometry(0.56, 0.042, 6, 32)
    const LEDGeo = new THREE.SphereGeometry(0.16, 12, 10)
    const baseMat = glowMat(0x07131c, 0x1a4d63, 0.45, { metalness: 0.6, roughness: 0.3 })
    const pickGeo = new THREE.BoxGeometry(1.36, 0.62, 1.36)
    const cellGeo = new THREE.BoxGeometry(0.36, 0.36, 0.36)

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

      // The input buffer as a shaft, not a row of boxes: the client's wire comes
      // down into the port, the bytes stack up in a vertical queue in this
      // backend's own memory, and the work leaves from the bottom of it. The
      // internal line into the pipeline picks up exactly where it ends.
      const shaftTop = -0.3
      const shaftBottom = INBUF_BOTTOM - 0.42
      const rail = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.035, shaftTop - shaftBottom, 8),
        new THREE.MeshStandardMaterial({
          color: 0x0a1118,
          emissive: PALETTE.cyan,
          emissiveIntensity: 0.7,
          roughness: 0.5,
        }),
      )
      rail.position.y = (shaftTop + shaftBottom) / 2
      g.add(rail)

      const cells: THREE.Mesh[] = []
      for (let c = 0; c < INBUF_CELLS; c++) {
        const cell = new THREE.Mesh(
          cellGeo,
          new THREE.MeshStandardMaterial({
            color: 0x0a1118,
            emissive: 0xb46bff,
            emissiveIntensity: 0.04,
            roughness: 0.4,
          }),
        )
        // 0 is the oldest and sits at the bottom, closest to execution; later
        // arrivals stack upward toward the incoming wire
        cell.position.set(0, INBUF_BOTTOM + c * INBUF_PITCH, 0)
        g.add(cell)
        cells.push(cell)
      }

      // tappable: this is the one place in the drawing that is a backend's own
      // memory rather than the shared pool, and it is worth being able to ask
      const bufPick = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 2.5, 0.9),
        new THREE.MeshBasicMaterial({ visible: false }),
      )
      bufPick.position.set(0, INBUF_BOTTOM + (INBUF_CELLS - 1) * INBUF_PITCH * 0.5, 0)
      g.add(bufPick)
      this.register(bufPick, {
        title: 'Backend input buffer',
        body: 'Each backend reads its connection into a private buffer in its own process memory — 8 kB to start, grown as needed. This is per-process heap, not shared_buffers: no other backend can see it. The wire from the client comes down into the port, requests stack up in the shaft, and the one at the bottom is what the backend is executing right now. Cyan is executing, violet is already received and waiting. A connection runs one statement at a time, in order.',
        meta: 'per-connection RAM · private heap · pipelining waits here',
      })

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
        inbuf: 0,
        pending: 0,
        cells,
      })
    })

    const lab = label('BACKENDS')
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
    // a recycled slot must not inherit counters from its previous life
    free.inbuf = 0
    free.pending = 0
    if (!this.pickables.includes(free.pick)) this.pickables.push(free.pick)
    return free
  }

  closeBackend(): boolean {
    // only a connection with nothing running and nothing buffered can go away;
    // closing one mid-buffer orphans requests that were already accepted
    const idle = this.backends.filter((b) => b.active && !b.busy && b.inbuf === 0 && b.pending === 0)
    if (idle.length === 0) return false
    const victim = idle[randInt(0, idle.length - 1)]
    victim.active = false
    victim.busy = false
    victim.inbuf = 0
    victim.pending = 0
    const idx = this.pickables.indexOf(victim.pick)
    if (idx >= 0) this.pickables.splice(idx, 1)
    return true
  }

  /**
   * Close idle connections until `keep` remain. A story uses this to start from
   * an empty pool so its first caption describes what is actually on screen.
   */
  closeIdleBackendsTo(keep: number) {
    while (this.activeBackendCount > keep && this.closeBackend()) {
      /* keep going until only `keep` are left */
    }
  }

  acquireBackend(): BackendPod | null {
    const active = this.backends.filter((b) => b.active)
    // A pooled connection is reused first: that is what a client pool does, and
    // it is why the port count stays put under light load.
    const idle = active.filter((b) => !b.busy)
    if (idle.length > 0) {
      const pod = idle[randInt(0, idle.length - 1)]
      pod.busy = true
      return pod
    }
    // Every open connection is busy, so the postmaster forks another backend —
    // but only up to max_connections. Past that, clients genuinely wait, and
    // the caller keeps the query queued instead of double-booking a port.
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

  /**
   * Where a backend's work leaves its input buffer: the bottom of the shaft.
   * The internal pipeline line starts here, so the flow is continuous — client
   * wire, port, buffer, then into the machine.
   */
  backendBufferExit(pod: BackendPod) {
    return pod.group.position.clone().add(new THREE.Vector3(0, INBUF_BOTTOM - 0.55, 0))
  }

  /** The top cell of a backend's input buffer — where new bytes drop in. */
  backendBufferEntry(pod: BackendPod) {
    return pod.group.position.clone().add(new THREE.Vector3(0, INBUF_BOTTOM + (INBUF_CELLS - 1) * INBUF_PITCH, 0))
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

  /** Slots in the scene are the server's max_connections. */
  get maxBackendCount() {
    return this.backends.length
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
          body: 'Walks the plan tree tuple by tuple, evaluating quals, joins and aggregates. Every page request goes through the buffer manager. Rows do not go to a separate stage: the executor hands them to the connection protocol as it produces them, so the answer streams out of the same port the query came in on.',
          meta: 'executor · volcano model · rows stream to the client',
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
    // only shown while a scan is actually sweeping the heap
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
    drone.position.set(-8.5, 2.9, DISK_PLATE.cz)
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
      this.flashWalSegment(i)
      await this.ticker.wait(0.05)
    }
    await this.ticker.wait(0.35)
  }

  /**
   * WAL records currently held in wal_buffers, as a fraction of the strip.
   * Everything here is *not* durable: it exists in shared memory only.
   */
  walBuffered = 0

  /** The cube the next record lands in. */
  private bufferCubeIndex() {
    return Math.min(
      this.walBufBlocks.length - 1,
      Math.floor(this.walBuffered * this.walBufBlocks.length),
    )
  }

  /** Top face of the wal_buffers cube being written — where an append lands. */
  walBufferTop(): THREE.Vector3 {
    const m = this.walBufBlocks[this.bufferCubeIndex()]
    if (!m) return this.walHeadTop()
    const v = new THREE.Vector3()
    m.getWorldPosition(v)
    return v.setY(v.y + PAGE_GRID.bh * 0.7)
  }

  /**
   * A backend appended a record. This is the point of the WAL: the bytes go to
   * wal_buffers in shared memory first, and nothing is durable yet.
   */
  appendWal(fraction: number) {
    this.walBuffered = Math.min(1, this.walBuffered + fraction)
    const mat = this.walBufferMats[this.bufferCubeIndex()]
    if (mat) {
      void this.ticker.add(0.5, (k) => {
        // a gentle lift only: these cubes are already emissive, and anything
        // brighter blooms into a white slab that hides the thing it marks
        mat.emissiveIntensity = 1.25 - 0.75 * k
      })
    }
  }

  /**
   * The WAL writer: write + fsync. Everything buffered joins the segment on
   * disk, and only after this can a COMMIT be answered. Returns what moved so
   * the caller can account for bytes that became durable.
   */
  flushWalBuffers(): number {
    const moved = this.walBuffered
    this.walBuffered = 0
    if (moved <= 0.01) return 0
    this.flashWalSegment(this.walHeadIndex)
    // advance the ring: a batch of records is worth part of a segment, and the
    // head wraps round rather than running out of run
    const before = this.walWritten
    this.walProgress += moved * 0.9
    while (this.walProgress >= 1) {
      this.walProgress -= 1
      this.walWritten++
    }
    // a segment just filled: mark it, because the head leaving it is the only
    // moment a WAL block becomes complete. Nothing moves — it stays exactly
    // where it is until the head comes round to overwrite it.
    if (this.walWritten > before) {
      this.sealedSegments += this.walWritten - before
      this.flashWalSegment((this.walWritten - 1) % this.walBlocks.length)
    }
    // the staging memory is simply reused once its contents are on disk
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

  /**
   * Write dirty pages back to the blocks they cache, then clean them. This is
   * the only moment a buffer page's contents reach the disk field — a write in
   * the executor only ever dirties a slot.
   */
  async dirtyPages(n: number): Promise<void> {
    const dirty = this.pages.map((p, i) => ({ p, i })).filter(({ p }) => p.dirty)
    const chosen = (dirty.length > 0 ? dirty : this.pages.map((p, i) => ({ p, i }))).slice(0, n)
    for (const { p } of chosen) {
      if (p.dirty && p.block) {
        this.setFill(p.block, p.fill)
        this.markBlock(p.block, PALETTE.amber)
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
    // never lift a WAL block: its styling is owned by styleWal()
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

  /**
   * Segments written since the run started. The head is this modulo the run, so
   * it wraps; `walWritten` itself keeps counting.
   */
  private walWritten = 4
  /** How much of the head segment is actually written, 0..1. */
  walProgress = 0
  /** Segments that have been filled to the brim and left behind. */
  sealedSegments = 0

  /** Index of the block currently being written — the WAL head. */
  get walHeadIndex() {
    return this.walWritten % this.walBlocks.length
  }

  /** The WAL block being appended to right now. */
  get walHeadBlock(): Page8K | undefined {
    return this.walBlocks[this.walHeadIndex]
  }

  /** Top face of the WAL head block — where a WAL append arrow should land. */
  walHeadTop(): THREE.Vector3 {
    const head = this.walHeadBlock
    return head ? this.blockTop(head) : this.walSlot(0).setY(PAGE_Y + PAGE_GRID.bh / 2)
  }

  /** Box around the whole on-disk WAL run. */
  walRunBox() {
    const box = new THREE.Box3()
    for (let i = 0; i < this.walBlocks.length; i++) box.expandByPoint(this.walSlot(i))
    return box.isEmpty() ? box : box.expandByScalar(PAGE_GRID.bh)
  }

  /** Box around the floating wal_buffers cubes. */
  walBuffersBox() {
    const box = new THREE.Box3()
    const v = new THREE.Vector3()
    for (const m of this.walBufBlocks) {
      m.getWorldPosition(v)
      box.expandByPoint(v)
    }
    return box.isEmpty() ? box : box.expandByScalar(PAGE_GRID.bh * 0.9)
  }

  /** Box around the segment being appended to right now. */
  walHeadBox() {
    const c = this.walSlot(this.walHeadIndex)
    const r = new THREE.Vector3(PAGE_GRID.bw / 2, PAGE_GRID.bh / 2, PAGE_GRID.bd / 2)
    return new THREE.Box3(c.clone().sub(r), c.clone().add(r))
  }

  /** Segments currently holding data: the run fills up, then stays full forever. */
  get walFilledSegments() {
    return Math.min(this.walBlocks.length, Math.max(1, this.walWritten))
  }

  /** How far round the ring the head has got, 0..1 — handy for diagnostics. */
  get walFill() {
    return Math.min(1, (this.walWritten + this.walProgress) / this.walBlocks.length)
  }

  /**
   * Start the ring again from its first segment, as a checkpoint does when the
   * segments behind the redo point become recyclable.
   */
  recycleWal() {
    this.walWritten = 1
    this.walProgress = 0
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

    this.styleWal(time, dt)

    // wal_buffers hover above the write head, bobbing and swaying like they are
    // only half in this world — because they are not on disk yet
    if (this.walBufGroup) {
      const headCol = WAL_C0 + (WAL_LEN - 1 - this.walHeadIndex)
      const targetX = pageX(headCol)
      const g = this.walBufGroup
      g.position.x += (targetX - g.position.x) * Math.min(1, dt * 2.4)
      g.position.z = pageZ(WAL_ROW)
      g.position.y = 1.95 + Math.sin(time * 1.3) * 0.08
      this.walBufBlocks.forEach((m, i) => {
        const ph = i * 1.15
        m.position.y = 0.16 + Math.sin(time * 1.9 + ph) * 0.09
        m.rotation.z = Math.sin(time * 1.15 + ph) * 0.16
        m.rotation.y = Math.sin(time * 0.75 + ph * 0.7) * 0.4
        m.scale.setScalar(1 + Math.sin(time * 2.4 + ph) * 0.035)
      })
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

      // input buffer: cell 0 is the statement being executed, the others are
      // pipelined requests parked in this backend's own memory. A dim cell is
      // an empty slot — 8 kB of buffer with nothing in it.
      const held = b.busy ? 1 + b.inbuf : 0
      b.cells.forEach((cell, i) => {
        const mat = cell.material as THREE.MeshStandardMaterial
        if (i >= held) {
          mat.emissiveIntensity = 0.04
          return
        }
        if (i === 0) {
          mat.emissive.setHex(PALETTE.cyan)
          mat.emissiveIntensity = 1.6 + 0.5 * Math.sin(time * 9 + b.id)
        } else {
          mat.emissive.setHex(0xb46bff)
          mat.emissiveIntensity = 0.85
        }
      })
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

    // motes drift upward and wrap, with a little lateral wander
    const attr = this.motes.geometry.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < attr.count; i++) {
      let y = attr.getY(i) + dt * 1.15
      if (y > 9.6) y = 0.25
      attr.setY(i, y)
      attr.setX(i, attr.getX(i) + Math.sin(time * 1.7 + i * 0.9) * dt * 0.22)
      attr.setZ(i, attr.getZ(i) + Math.cos(time * 1.3 + i * 1.3) * dt * 0.18)
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
