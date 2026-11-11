import * as THREE from 'three'

import { BLOCK_LIFT, FLOOR_Y } from '../core/util'
import { CELL_PITCH, PAGE_4K, PAGE_PITCH } from '../disk/page'
import { BACKEND_ORIGIN, PALETTE } from '../postgresql/instance'
import { RedisKeyKind } from './kind'

export { RedisKeyKind } from './kind'

export const REDIS_ORIGIN = new THREE.Vector3(-13, 0, -34)

export const SHELL = { w: 26.0, h: 9.8, d: 16.0 }

export const FIELD = { w: 24, d: 8.5, cz: 3.25 }

export const PITCH = PAGE_PITCH

export const CELL = CELL_PITCH

export const BLOCK = PAGE_4K

export const KEY = { w: 0.16, h: 0.1, d: 0.16 }

export const BLOCK_BYTES = PAGE_4K.bytes

export const PAGE_Y = PAGE_4K.centreY(FLOOR_Y, BLOCK_LIFT)
export const BLOCK_TOP = PAGE_4K.topY(FLOOR_Y, BLOCK_LIFT)

export const FLOOR_LABEL_Y = FLOOR_Y + 0.003

export const DISK_LABEL_PAD = 0.21

export const COLS = 96

export const ROWS = 34
export const xAt = (c: number) => -11.875 + c * CELL
export const zAt = (r: number) => -0.875 + r * CELL

export const AOF_ROW = ROWS - 1

export const AOF_C0 = 44

export const AOF_SEED = 13

export const STAGING_ROW = AOF_ROW - 4

export const RDB = { c0: 8, c1: 27, r0: 4, r1: 17 }

export const RDB_BLOCK_TIME = 0.035
export const AOF_RECORD_TIME = 0.055

export let checkInvariants =
    typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug')

export function setInvariantChecks(on: boolean) {
    checkInvariants = on
}

export const DICT = { cols: 32, rows: 8, tableCols: 16, y: 5.85, cz: -2.2 }

export const HASH_SIZES = [32, 64, 128] as const
export const HASH_MAX = HASH_SIZES[HASH_SIZES.length - 1]
export const KEYS = { cols: 26, rows: 7, y: 7.0, cz: -2.2 }

export const INLINE = { x: -9.9, y: 3.25, z: -0.3, w: 2.9, h: 1.15, d: 1.25 }

export const HEAP = { cols: 48, rows: 16, y: 1.95, cz: KEYS.cz }

export const HEAP_PAGE = 0.23

export const HEAP_OCCUPANCY = 0.8
export const heapX = (c: number) => (c - (HEAP.cols - 1) / 2) * CELL
export const heapZ = (r: number) => HEAP.cz + (r - (HEAP.rows - 1) / 2) * CELL

export const heapPageOf = (i: number, pageCount: number) => (i * 209) % pageCount

export function heapOccupancyMask(pageCount: number, occupancy: number): Uint8Array {
    let s = 0x9e3779b9
    const rnd = () => {
        s = (s + 0x6d2b79f5) | 0
        let t = Math.imul(s ^ (s >>> 15), 1 | s)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const used = new Uint8Array(pageCount)
    const target = Math.round(pageCount * occupancy)
    const fillTo = Math.min(pageCount, Math.round(pageCount * Math.min(1, occupancy + 0.08)))
    let count = 0

    while (count < fillTo) {
        const len = 1 + Math.floor(rnd() * 12)
        const start = Math.floor(rnd() * pageCount)
        for (let k = 0; k < len && count < fillTo; k++) {
            const id = start + k
            if (id >= pageCount) break
            if (!used[id]) {
                used[id] = 1
                count++
            }
        }
    }

    while (count > target) {
        const len = 1 + Math.floor(rnd() * 10)
        const start = Math.floor(rnd() * pageCount)
        for (let k = 0; k < len && count > target; k++) {
            const id = start + k
            if (id >= pageCount) break
            if (used[id]) {
                used[id] = 0
                count--
            }
        }
    }
    return used
}

export const dictX = (c: number) => (c - (DICT.cols - 1) / 2) * PITCH
export const dictZ = (r: number) => DICT.cz + (r - (DICT.rows - 1) / 2) * PITCH
export const keyX = (c: number) => (c - (KEYS.cols - 1) / 2) * PITCH
export const keyZ = (r: number) => KEYS.cz + (r - (KEYS.rows - 1) / 2) * PITCH

export const LOOP = new THREE.Vector3(0, 7.6, 1.4)
export const QUEUE = { cells: 10, y: 8.95, z: BACKEND_ORIGIN.z }

export const CHANNEL = { name: 'news', at: new THREE.Vector3(0, 8.3, 3.5) }

export const EPOLL = {
    y: LOOP.y - 1.15,
    z: LOOP.z,
    pitch: 0.34,
    w: 0.24,
    h: 0.06,
    d: 0.2,
}

export const AOF_BUF_CELLS = 5

export const AOF_BUF_Y = 1.7

export const AGENT_SPEED = 16

export const QUEUE_EMPTY = 0.05
export const QUEUE_HEAD = 1.5

export const RDB_CENTRE = new THREE.Vector3(
    (xAt(RDB.c0) + xAt(RDB.c1)) / 2,
    BLOCK_TOP,
    (zAt(RDB.r0) + zAt(RDB.r1)) / 2,
)

export const AOF_FILL_DARK = 0x2a1a04
export const AOF_FILL_BRIGHT = 0xe09a2e
export const RDB_FILL_DARK = 0x06222c
export const RDB_FILL_BRIGHT = 0x23c9a6

export const KIND_COLOR: Record<RedisKeyKind, number> = {
    [RedisKeyKind.String]: PALETTE.cyan,
    [RedisKeyKind.List]: PALETTE.teal,
    [RedisKeyKind.Hash]: PALETTE.violet,
    [RedisKeyKind.Set]: PALETTE.magenta,
    [RedisKeyKind.ZSet]: PALETTE.ice,
}

export const LISTPACK_MAX_ENTRIES = 128
export const INTSET_MAX_ENTRIES = 512
export const encodingLimit = (kind: RedisKeyKind) =>
    kind === RedisKeyKind.Set ? INTSET_MAX_ENTRIES : LISTPACK_MAX_ENTRIES

export const VALUE_BYTES: Record<RedisKeyKind, [number, number]> = {
    [RedisKeyKind.String]: [48, 700],
    [RedisKeyKind.List]: [200, 2600],
    [RedisKeyKind.Hash]: [180, 3200],
    [RedisKeyKind.Set]: [140, 2000],
    [RedisKeyKind.ZSet]: [220, 2800],
}
