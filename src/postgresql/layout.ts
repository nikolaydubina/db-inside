import * as THREE from 'three'
import { BLOCK_LIFT, FLOOR_Y } from '../core/util'
import { CELL_PITCH, PAGE_8K, PAGE_PITCH } from '../disk/page'
import type { Info } from './instance'

export const PALETTE = {
    cyan: 0x35e0ff,
    teal: 0x2bffc3,
    amber: 0xffb03a,
    magenta: 0xff3ea5,
    violet: 0x8a7bff,
    ice: 0xbfe9ff,
}

export const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

export const RAM_LIFT = 1.15

export const PAGE_GRID = {
    cols: 48,
    rows: 34,
    gx: PAGE_PITCH,
    gz: CELL_PITCH,
    bw: PAGE_8K.w,
    bh: PAGE_8K.h,
    bd: PAGE_8K.d,
}

export const PAGE_CELL = CELL_PITCH

export const SYSTEM_GREY = 0x93a1ae

export type SystemArea = 'catalog' | 'fork' | 'clog'

export const SYSTEM_RUNS: {
    area: SystemArea
    label: string

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
        what: 'The catalog relations every database carries a copy of: what each table is, which columns it has, which indexes exist, and what depends on what. Same 8 KiB page as a heap — they are small because there are few of them, not because the pages are smaller: a fresh cluster keeps the whole set in a few megabytes. Queries read them too — the planner asks pg_class and pg_statistic what it is planning over.',
    },
    {
        area: 'fork',
        label: 'FSM · VM',
        c0: 30,
        c1: 31,
        rows: [24, 27],
        files: ['_fsm', '_vm'],
        what: 'Two thin side files per relation, in 8 KiB pages like everything else. One byte of free space map per heap page covers 64 MiB of relation; two bits of visibility map per page cover 256 MiB. The free space map says which pages have room for a new tuple, so an insert need not read every page; the visibility map says which pages are all-visible, which is what lets VACUUM and index-only scans skip work.',
    },
    {
        area: 'clog',
        label: 'CLOG',
        c0: 32,
        c1: 33,
        rows: [24, 27],
        files: ['pg_xact', 'pg_multixact'],
        what: 'Two bits per transaction, and nothing else: committed, aborted, in progress, or not yet assigned. One 8 KiB page therefore covers 32,768 transactions, which is why the commit log stays tiny even on a busy server. Every visibility check starts here.',
    },
]

export const WAL_ROW = 33
export const WAL_BUF_LEN = 4

export const BUFFER_COLS = 12
export const BUFFER_ROWS = 6
export const BUFFER_Y = 5.35
export const bufferSlotX = (c: number) => -3.75 + c * PAGE_GRID.gx
export const bufferSlotZ = (r: number) => -2.75 + r * PAGE_GRID.gz

export const WAL_C0 = 10
export const WAL_LEN = 12

export const PAGE_Y = PAGE_8K.centreY(FLOOR_Y, BLOCK_LIFT)
export const pageX = (col: number) => -11.75 + col * PAGE_GRID.gx
export const pageZ = (row: number) => -0.875 + row * PAGE_GRID.gz
export const PAGE_W = PAGE_GRID.cols * PAGE_GRID.gx
export const PAGE_D = PAGE_GRID.rows * PAGE_GRID.gz

export const PAGE_Z0 = pageZ(0) - PAGE_GRID.gz / 2

export const DISK_FIELD = { w: PAGE_W, d: PAGE_D, cz: PAGE_Z0 + PAGE_D / 2 }

export const PAGE_TOP_Y = PAGE_8K.topY(FLOOR_Y, BLOCK_LIFT)
export const BUFFER_TOP_Y = BUFFER_Y + PAGE_GRID.bh / 2

export const FLOOR_LABEL_Y = FLOOR_Y + 0.003

export const DISK_LABEL_PAD = 0.21

export const BLOCK_FREE = 0x6b4a1c

export const FILL_DARK = 0x0e0a04
export const FILL_BRIGHT = 0xd28f2c

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
            title: 'TABLE: users — contiguous 8 KiB pages',
            body: "A table is not a separate kind of object: it is a named, contiguous run of 8 KiB pages, and this outline is all that 'table' means at the storage layer. Rows live inside those pages. Page height is how full the page is: INSERTs fill a page up and allocate a new one from the run when it is full, DELETEs drain it. Dead row versions collect inside the page until VACUUM reclaims that space — the page itself stays in the file either way.",
            meta: 'demo table · 160 pages · heap file on disk',
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
            title: 'TABLE: products — 160 contiguous pages',
            body: 'Another example table, same shape: a contiguous run of pages, nothing more. These rows are wide and carry a jsonb document, which is why the interesting query is containment inside the document. A B-tree cannot answer that, because the whole document is one value in one column — which is what GIN is for.',
            meta: 'demo table · 160 pages · jsonb payload · heap file',
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
            title: 'TABLE: metrics — 72 contiguous pages',
            body: 'A third example table, again just pages: append-only measurements written in timestamp order. Nothing in Postgres guaranteed that order — we simply inserted them that way, so ranges of these pages hold narrow timestamp ranges. That is exactly the assumption BRIN exploits, and why it can be a few kilobytes for a huge table.',
            meta: 'demo table · 72 pages · naturally ordered · heap file',
        },
    },
]

export const PROCESS = {
    y: 8.45,
    zParse: 4.85,
    zPlan: 3.35,
    zExec: 1.85,

    w: 1.8,
    h: 1.5,
    d: 5.0,

    coreR: 0.3,
    cageR: 0.58,
    ringR: 0.72,
    haloR: 1.9,
}

export const ANCHOR = {
    sky: V(-11.0, 27, 0.8),
    parse: V(1.9, PROCESS.y, PROCESS.zParse),
    plan: V(1.9, PROCESS.y, PROCESS.zPlan),
    exec: V(1.9, PROCESS.y, PROCESS.zExec),
    bufferCenter: V(-1.0, 5.35, -2.125),
    wal: V(-4.0, 0.55, pageZ(WAL_ROW)),

    walBuf: V(pageX(WAL_C0 + WAL_LEN - 1), 1.95, pageZ(WAL_ROW)),

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

export const POSTGRES_ORIGIN = new THREE.Vector3(0, 0, 0)

export const WORLD_ANCHOR = Object.fromEntries(
    Object.entries(ANCHOR).map(([k, v]) => [k, v.clone()]),
) as typeof ANCHOR

export function rebaseAnchors() {
    for (const k of Object.keys(ANCHOR) as (keyof typeof ANCHOR)[]) {
        WORLD_ANCHOR[k].copy(ANCHOR[k]).add(POSTGRES_ORIGIN)
    }
}
rebaseAnchors()
