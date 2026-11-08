import * as THREE from 'three'

import { BLOCK_LIFT, FLOOR_Y } from '../core/util'
import { CELL_PITCH, PAGE_4K, PAGE_PITCH } from '../disk/page'
import { BACKEND_ORIGIN, PALETTE } from '../postgresql/instance'

/* ------------------------------- layout -------------------------------- */
/**
 * The second database. Same species as the postgres cage next door — same
 * outline cage, same 4 kB address lattice (an 8 kB page spans two cells) on
 * the same plate, same ports on the top rim, same painted floor labels — but a
 * different machine underneath: one thread, no planner, and the data itself
 * living in RAM.
 *
 * Where postgres has pages on the floor and a small cache floating above them,
 * redis has almost nothing on the floor and the dataset itself in the air.
 */
export const REDIS_ORIGIN = new THREE.Vector3(-13, 0, -34)

/* ------------------------------- geometry ---------------------------------- */

/** Identical shell to the postgres cage: the two read as the same species. */
export const SHELL = { w: 26.0, h: 9.8, d: 16.0 }

/**
 * The footprint of the block field. There is no platform under it: the blocks
 * stand on the global floor grid, so this only says where the field begins and
 * ends. Same rectangle as the postgres disk.
 */
export const FIELD = { w: 24, d: 8.5, cz: 3.25 }

/**
 * Spacing of the in-memory planes (dict, keyspace, buffers). The disk grid is
 * finer; see CELL below. Keeping them separate is what lets the 4 kB address
 * cell be square without shrinking the keyspace.
 */
export const PITCH = PAGE_PITCH
/** Side of one square address cell on the disk grid. */
export const CELL = CELL_PITCH
/**
 * One filesystem block: 4 kB, exactly one square cell. The only unit a file
 * has. An 8 kB page next door is two of these along x.
 */
export const BLOCK = PAGE_4K
/**
 * One key: a dictEntry, its sds key and its value object. A few hundred bytes at
 * most — twenty times smaller than the 4 kB block it is stored in, which is why a
 * key is drawn as a small cube and not as a block. Sizes here are a fourth of a
 * block's, not 1/20th: below that the keys stop being readable as objects, and
 * the point is the ratio, not the exact scale.
 */
export const KEY = { w: 0.16, h: 0.1, d: 0.16 }
/** What a filesystem stores a byte stream in — the only unit a file has. */
export const BLOCK_BYTES = PAGE_4K.bytes
/** Blocks rest ON the floor, lifted by the shared hair so the grid never cuts them. */
export const PAGE_Y = PAGE_4K.centreY(FLOOR_Y, BLOCK_LIFT)
export const BLOCK_TOP = PAGE_4K.topY(FLOOR_Y, BLOCK_LIFT)
/** Labels are painted on the floor: the same plane as the grid, +3 mm for the glyphs. */
export const FLOOR_LABEL_Y = FLOOR_Y + 0.003
/** Gap between the block field's edge and the first glyph of the DISK label. */
export const DISK_LABEL_PAD = 0.21

/** 4 kB cells across the 24-unit field. */
export const COLS = 96
/** 4 kB cells deep in the 8.5-unit field. */
export const ROWS = 34
export const xAt = (c: number) => -11.875 + c * CELL
export const zAt = (r: number) => -0.875 + r * CELL

/**
 * Persistence, and only persistence, is on the disk: the incremental AOF run
 * at the front edge and the base RDB blob off to one side. Everything else is
 * free space, because the dataset is not here.
 */
export const AOF_ROW = ROWS - 1
/** First cell of the log, chosen so it still begins where the page-level run did. */
export const AOF_C0 = 44
/** Blocks the log occupies at boot — it has been running and has not been rewritten yet. */
export const AOF_SEED = 13
/**
 * Where a rewrite builds its new file: four cells (one unit) in front of the
 * log, opposite the blocks those writes will end up in. Close enough that the
 * swap is a short move you can follow, and far enough that the log's own growth
 * never lands on it for a long time.
 */
export const STAGING_ROW = AOF_ROW - 4
/**
 * The base file's area in 4 kB cells: 10 pages wide and 7 pages deep, the same
 * rectangle as before. Each 8 kB page is two cells along x, so the page count
 * is unchanged while every cell is square.
 */
export const RDB = { c0: 8, c1: 27, r0: 4, r1: 17 }

/**
 * How long one block takes to read or write during a load or a save, in
 * simulated seconds. A real 4 kB block is microseconds; this is the scale at
 * which a human can watch a file being written without it lying about the order.
 */
export const RDB_BLOCK_TIME = 0.035
export const AOF_RECORD_TIME = 0.055

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
export const DICT = { cols: 32, rows: 7, y: 3.9, cz: -2.2 }
/**
 * Bucket counts the floor can draw. Real dicts double forever; this lattice holds
 * 224 tiles, so the demonstration stops at 128 and says so in the card rather
 * than silently refusing to grow.
 */
export const HASH_SIZES = [32, 64, 128] as const
export const HASH_MAX = HASH_SIZES[HASH_SIZES.length - 1]
export const KEYS = { cols: 26, rows: 7, y: 7.0, cz: -2.2 }

export const dictX = (c: number) => (c - (DICT.cols - 1) / 2) * PITCH
export const dictZ = (r: number) => DICT.cz + (r - (DICT.rows - 1) / 2) * PITCH
export const keyX = (c: number) => (c - (KEYS.cols - 1) / 2) * PITCH
export const keyZ = (r: number) => KEYS.cz + (r - (KEYS.rows - 1) / 2) * PITCH

/** The single command loop, and the queue it drains. */
export const LOOP = new THREE.Vector3(0, 7.6, 1.4)
export const QUEUE = { cells: 10, y: 8.95, z: BACKEND_ORIGIN.z }
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
export const CHANNEL = { name: 'news', at: new THREE.Vector3(0, 8.3, 3.5) }
/**
 * The kernel's readiness set — epoll's registered fds, drawn as one tile per
 * connection on a plate hanging under the loop that consults it. This is the
 * structure that makes "ten thousand connections, one thread" true, and it
 * belongs to the kernel, not to the redis heap, which is why its cage is dashed.
 */
export const EPOLL = {
    y: LOOP.y - 1.15,
    z: LOOP.z,
    pitch: 0.34,
    w: 0.24,
    h: 0.06,
    d: 0.2,
}

/** AOF buffer: the bytes not yet written to the file, in memory. */
export const AOF_BUF_CELLS = 5
/** Height the aof_buf strip floats at: above the run, below the keyspace. */
export const AOF_BUF_Y = 1.7
/** Top speed of a working agent, in units/s — fast, but a flight you can follow. */
export const AGENT_SPEED = 16
/** Emissive of an empty queue slot, and of the head of the queue. */
export const QUEUE_EMPTY = 0.05
export const QUEUE_HEAD = 1.5

export const RDB_CENTRE = new THREE.Vector3(
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
export const AOF_FILL_DARK = 0x2a1a04
export const AOF_FILL_BRIGHT = 0xe09a2e
export const RDB_FILL_DARK = 0x06222c
export const RDB_FILL_BRIGHT = 0x23c9a6

/** Kind tints stay in the legend's family: RAM is cyan, disk is amber. */
export const KIND_COLOR: Record<KeyKind, number> = {
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
export const LISTPACK_MAX_ENTRIES = 128
export const INTSET_MAX_ENTRIES = 512
export const encodingLimit = (kind: KeyKind) =>
    kind === 'set' ? INTSET_MAX_ENTRIES : LISTPACK_MAX_ENTRIES
/**
 * Bytes a key and its value take in the dump. Strings are small, collections are
 * not: this is why an RDB block holds a different number of keys every time, and
 * why the file's length tracks the dataset rather than the key count.
 */
export const VALUE_BYTES: Record<KeyKind, [number, number]> = {
    string: [48, 700],
    list: [200, 2600],
    hash: [180, 3200],
    set: [140, 2000],
    zset: [220, 2800],
}

/** The kind of a value: what a key's payload actually is. */
export type KeyKind = 'string' | 'list' | 'hash' | 'set' | 'zset'
