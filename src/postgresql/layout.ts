import * as THREE from 'three'
import { BLOCK_LIFT, FLOOR_Y } from '../core/util'
import { CELL_PITCH, PAGE_8K, PAGE_PITCH } from '../disk/page'
import type { Info } from './instance'

/** The four accents the whole scene is painted with. One place, both cages. */
export const PALETTE = {
  cyan: 0x35e0ff,
  teal: 0x2bffc3,
  amber: 0xffb03a,
  magenta: 0xff3ea5,
  violet: 0x8a7bff,
  ice: 0xbfe9ff,
}

/**
 * Where everything on the postgres side sits, and in what colour.
 *
 * Pure numbers: the cage, the page field, the WAL run, the buffer strip, the
 * backend row and the anchors other packages rebase against. Nothing here draws
 * anything, so a change to the layout cannot quietly change the drawing.
 */
export const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

/** How far "in-memory right now" structures float above the disk plate. */
export const RAM_LIFT = 1.15

/**
 * The disk is tiled edge to edge with 8 kB page blocks. The shared address
 * lattice underneath is square 4 kB cells: an 8 kB page is TWO cells wide and
 * one cell deep, so the page is the composite and the cell is the unit.
 * X cell pitch and z cell pitch are both CELL_PITCH; the page is two of them.
 */
export const PAGE_GRID = {
  cols: 48,
  rows: 34,
  gx: PAGE_PITCH,
  gz: CELL_PITCH,
  bw: PAGE_8K.w,
  bh: PAGE_8K.h,
  bd: PAGE_8K.d,
}

/** Side of one square 4 kB address cell, in world units. */
export const PAGE_CELL = CELL_PITCH

/** Grey tint used for everything postgres owns rather than the user. */
export const SYSTEM_GREY = 0x93a1ae

export type SystemArea = 'catalog' | 'fork' | 'clog'

/**
 * PGDATA is not only user tables. Every database carries its own copy of the
 * catalogs, each relation has FSM/VM forks beside it, and pg_xact holds two
 * bits of commit status per transaction. They are small next to the data, and
 * that is exactly what the grey runs show: real, but not where the rows live.
 */
export const SYSTEM_RUNS: {
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
      rows: [24, 27],
      files: ['pg_class', 'pg_attribute', 'pg_index', 'pg_type', 'pg_proc', 'pg_depend'],
      what: 'The catalog relations every database carries a copy of: what each table is, which columns it has, which indexes exist, and what depends on what. Same 8 kB page as a heap — they are small because there are few of them, not because the pages are smaller: a fresh cluster keeps the whole set in a few megabytes. Queries read them too — the planner asks pg_class and pg_statistic what it is planning over.',
    },
    {
      area: 'fork',
      label: 'FSM · VM',
      c0: 30,
      c1: 31,
      rows: [24, 27],
      files: ['_fsm', '_vm'],
      what: 'Two thin side files per relation, in 8 kB pages like everything else. One byte of free space map per heap page covers 64 MB of relation; two bits of visibility map per page cover 256 MB. The free space map says which pages have room for a new tuple, so an insert need not read every page; the visibility map says which pages are all-visible, which is what lets VACUUM and index-only scans skip work.',
    },
    {
      area: 'clog',
      label: 'CLOG',
      c0: 32,
      c1: 33,
      rows: [24, 27],
      files: ['pg_xact', 'pg_multixact'],
      what: 'Two bits per transaction, and nothing else: committed, aborted, in progress, or not yet assigned. One 8 kB page therefore covers 32,768 transactions, which is why the commit log stays tiny even on a busy server. Every visibility check starts here.',
    },
  ]

/**
 * The WAL is not a column floating in the air: it is a contiguous run of slots
 * in the page lattice, at the front edge of the disk next to the free space it
 * grows into. Segments are appended left to right and recycled in place.
 */
export const WAL_ROW = 33
export const WAL_BUF_LEN = 4

/* shared_buffers floats on the same address lattice as the disk */
export const BUFFER_COLS = 12
export const BUFFER_ROWS = 6
export const BUFFER_Y = 5.35
export const bufferSlotX = (c: number) => -3.75 + c * PAGE_GRID.gx
export const bufferSlotZ = (r: number) => -2.75 + r * PAGE_GRID.gz
/** Leftmost slot of the run — the free space it grows into sits just below. */
export const WAL_C0 = 10
export const WAL_LEN = 12
/** Blocks rest ON the floor, lifted by the shared hair so the grid never cuts them. */
export const PAGE_Y = PAGE_8K.centreY(FLOOR_Y, BLOCK_LIFT)
export const pageX = (col: number) => -11.75 + col * PAGE_GRID.gx
export const pageZ = (row: number) => -0.875 + row * PAGE_GRID.gz
export const PAGE_W = PAGE_GRID.cols * PAGE_GRID.gx
export const PAGE_D = PAGE_GRID.rows * PAGE_GRID.gz
/** Outer edge of the block field — the blocks are the only thing in the plate. */
export const PAGE_Z0 = pageZ(0) - PAGE_GRID.gz / 2

/**
 * Where the block field begins and ends. There is no plate under it: the blocks
 * stand on the global floor grid, so this only describes the footprint —
 * derived from the lattice, zero padding. Same rectangle as the redis disk.
 */
export const DISK_FIELD = { w: PAGE_W, d: PAGE_D, cz: PAGE_Z0 + PAGE_D / 2 }

/**
 * World Y of the top face of a resting block, on disk and in RAM. Every arrow
 * that lands on a page aims at one of these planes, never at thin air.
 */
export const PAGE_TOP_Y = PAGE_8K.topY(FLOOR_Y, BLOCK_LIFT)
export const BUFFER_TOP_Y = BUFFER_Y + PAGE_GRID.bh / 2

/**
 * Floor text sits ON the ground: the same plane as the floor grid, a few
 * millimetres above it so the grid lines do not cut through the glyphs.
 */
export const FLOOR_LABEL_Y = FLOOR_Y + 0.003

/** Gap between the block field's edge and the first glyph of the DISK label. */
export const DISK_LABEL_PAD = 0.21

/** Albedo of a free (unassigned) page block. */
export const BLOCK_FREE = 0x6b4a1c
/** Page fill ramp: empty slot → packed page. */
export const FILL_DARK = 0x0e0a04
export const FILL_BRIGHT = 0xd28f2c
/** Same idea for the page copies in RAM: dim = sparse, bright = packed. */
export const BUF_DARK = 0x081a24
export const BUF_FILL_DARK = new THREE.Color(0x081a24)
export const BUF_FILL_BRIGHT = new THREE.Color(0x9fe8ff)

export interface TableRegion {
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
export const TABLE_REGIONS: TableRegion[] = [
  {
    anchor: 'heap',
    label: 'users',
    c0: 19,
    c1: 28,
    r0: 6,
    r1: 21,
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
    r0: 6,
    r1: 21,
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
    r0: 22,
    r1: 33,
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
  bufferCenter: V(-1.0, 5.35, -2.125),
  wal: V(-4.0, 0.55, pageZ(WAL_ROW)),
  /**
   * The wal_buffers strip. It drifts along the run with the write head, so
   * PostgresInstance.update() rewrites this one live, every frame — a view that
   * frames it has to read the value at call time, not at boot.
   */
  walBuf: V(pageX(WAL_C0 + WAL_LEN - 1), 1.95, pageZ(WAL_ROW)),
  /**
   * The autovacuum drone, which patrols the disk plate. Like walBuf this is
   * rewritten live every frame — a shot of it has to read the anchor at call time,
   * or it would keep framing where the drone used to be.
   */
  vacuum: V(-8.5, 2.9, DISK_FIELD.cz),
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

/**
 * Where the postgres cage's own origin sits in the world. Everything inside the
 * class is built in cage-local units; ANCHOR and this vector are what the rest
 * of the app reads, so moving the cage means moving both together. Set through
 * PostgresInstance.setOrigin().
 */
export const POSTGRES_ORIGIN = new THREE.Vector3(0, 0, 0)

/**
 * World copies of ANCHOR, recomputed whenever the cage moves. ANCHOR stays
 * cage-local because that is what the geometry is built from; anything that
 * frames the instance from outside — camera views, the axes marks — reads these.
 */
export const WORLD_ANCHOR = Object.fromEntries(
  Object.entries(ANCHOR).map(([k, v]) => [k, v.clone()]),
) as typeof ANCHOR

export function rebaseAnchors() {
  for (const k of Object.keys(ANCHOR) as (keyof typeof ANCHOR)[]) {
    WORLD_ANCHOR[k].copy(ANCHOR[k]).add(POSTGRES_ORIGIN)
  }
}
rebaseAnchors()


