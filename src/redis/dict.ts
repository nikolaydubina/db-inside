import { fmtBytes } from '../core/util'
import { DICT, HASH_MAX, HASH_SIZES } from './layout'
import type { RedisKey } from './types'

export type DictHalf = 0 | 1

export type DictRow = { label: string; value: string }

export class DictTable {
    size = 32
    size1 = 0
    idx = -1
    half: DictHalf = 0

    get rehashing() {
        return this.idx >= 0
    }

    get bucketCount() {
        return this.size + (this.rehashing ? this.size1 : 0)
    }

    bucketOf(i: number, size: number): number {
        return ((i * 2654435761) >>> 0) % size
    }

    tile(half: DictHalf, bucket: number): number {
        const row = Math.floor(bucket / DICT.tableCols)
        const col = half * DICT.tableCols + (bucket % DICT.tableCols)
        return row * DICT.cols + col
    }

    bucketAtTile(half: DictHalf, id: number): number {
        const row = Math.floor(id / DICT.cols)
        const col = id % DICT.cols
        const which: DictHalf = col < DICT.tableCols ? 0 : 1
        if (which !== half) return -1
        return row * DICT.tableCols + (col % DICT.tableCols)
    }

    used(keys: RedisKey[], size: number): Set<number> {
        const out = new Set<number>()
        for (const k of keys) if (k.live) out.add(this.bucketOf(k.i, size))
        return out
    }

    placeOf(i: number): { half: DictHalf; bucket: number } {
        if (this.idx < 0) return { half: this.half, bucket: this.bucketOf(i, this.size) }
        const moved = this.bucketOf(i, this.size1)
        if (moved < this.idx) return { half: this.half === 0 ? 1 : 0, bucket: moved }
        return { half: this.half, bucket: this.bucketOf(i, this.size) }
    }

    grow(liveKeys: number): number | null {
        if (this.idx >= 0 || this.size >= HASH_MAX) return null
        if (liveKeys <= this.size) return null
        const next = HASH_SIZES.find((s) => s > this.size)
        if (!next) return null
        this.size1 = next
        this.idx = 0
        return next
    }

    advance(buckets = 1): { done: boolean } | null {
        if (this.idx < 0) return null
        this.idx = Math.min(this.size, this.idx + buckets)
        if (this.idx < this.size) return { done: false }
        this.size = this.size1
        this.size1 = 0
        this.idx = -1
        this.half = this.half === 0 ? 1 : 0
        return { done: true }
    }

    stats(keys: RedisKey[]): DictRow[] {
        const oldSize = this.size
        const newSize = this.size1
        const rehashing = newSize > 0 && this.idx >= 0
        const oldBuckets = new Set<number>()
        const newBuckets = new Set<number>()
        let oldKeys = 0
        let newKeys = 0
        for (const k of keys) {
            if (!k.live) continue
            const bOld = this.bucketOf(k.i, oldSize)
            if (!rehashing || bOld >= this.idx) {
                oldBuckets.add(bOld)
                oldKeys++
            }
            if (rehashing) {
                const bNew = this.bucketOf(k.i, newSize)
                if (bNew < this.idx) {
                    newBuckets.add(bNew)
                    newKeys++
                }
            }
        }
        const used = oldBuckets.size + newBuckets.size
        const buckets = oldSize + (rehashing ? newSize : 0)
        const entries = oldKeys + newKeys
        const fill = buckets > 0 ? used / buckets : 0
        const load = buckets > 0 ? entries / buckets : 0
        const slot = 8
        return [
            { label: 'bucket', value: '8 B · one pointer' },
            { label: 'buckets', value: rehashing ? `${oldSize} + ${newSize}` : String(oldSize) },
            { label: 'array', value: fmtBytes(buckets * slot) },
            { label: 'peak array', value: fmtBytes((HASH_MAX + HASH_MAX / 2) * slot) },
            { label: 'per entry', value: '24 B + key + value' },
            {
                label: 'scale',
                value: `1 MiB = ${Math.round((1024 * 1024) / (buckets * slot)).toLocaleString('en-US')} × array`,
            },
            { label: 'used', value: `${used} / ${buckets} · ${Math.round(fill * 100)}%` },
            { label: 'load factor', value: load.toFixed(2) },
            { label: 'keys', value: String(entries) },
            { label: 'chains', value: String(Math.max(0, entries - used)) },
        ]
    }
}
