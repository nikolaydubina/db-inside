import * as THREE from 'three'
import { BACKEND_ORIGIN } from '../postgresql/instance'
import { BIG_SPOT } from './values'
import type { BigKind } from './values'
import {
    AOF_BUF_Y,
    AOF_C0,
    AOF_ROW,
    BLOCK_TOP,
    DICT,
    HEAP,
    LOOP,
    RDB_CENTRE,
    REDIS_ORIGIN,
    xAt,
    zAt,
} from './layout'

export type KeyKind = 'string' | 'list' | 'hash' | 'set' | 'zset'

export const BIG_REAL: Record<BigKind, { entries: number; mb: number; unit: string }> = {
    hash: { entries: 5_300_000, mb: 412, unit: 'fields' },
    zset: { entries: 1_400_000, mb: 168, unit: 'members' },
    list: { entries: 2_100_000, mb: 96, unit: 'elements' },
}

export interface RedisKey {
    i: number
    row: number
    col: number
    home: THREE.Vector3

    page: number
    kind: KeyKind
    live: boolean

    ttl: number
    heat: number
    shade: number

    bytes: number

    entries: number

    aux: boolean

    big?: BigKind

    raw?: boolean

    hot?: boolean
}

export function encodingOf(key: RedisKey): string {
    switch (key.kind) {
        case 'string':
            return key.bytes <= 44 ? 'embstr' : 'raw'
        case 'hash':
            return key.aux ? 'hashtable' : 'listpack'
        case 'set':
            return key.aux ? 'hashtable' : 'intset'
        case 'zset':
            return key.aux ? 'skiplist + dict' : 'listpack'
        case 'list':
            return key.big
                ? 'quicklist · listpacks'
                : key.aux
                    ? 'quicklist · 2 nodes'
                    : 'quicklist · 1 node'
    }
}

export function auxBlocks(key: RedisKey): number {
    if (!key.aux || key.kind === 'string') return 0
    return key.kind === 'zset' ? 2 : 1
}

export interface RedisPort {
    id: number
    group: THREE.Group
    ring: THREE.MeshStandardMaterial
    glow: THREE.SpriteMaterial
    busy: boolean
    active: boolean
    pulse: number

    subs: boolean
}

export const REDIS_ANCHOR = {
    sky: new THREE.Vector3(),
    keys: new THREE.Vector3(),
    dict: new THREE.Vector3(),
    loop: new THREE.Vector3(),
    ports: new THREE.Vector3(),
    aof: new THREE.Vector3(),

    aofBuf: new THREE.Vector3(),
    rdb: new THREE.Vector3(),

    bigHash: new THREE.Vector3(),
    bigZset: new THREE.Vector3(),
    bigList: new THREE.Vector3(),
}

export function rebaseAnchors() {
    const o = REDIS_ORIGIN
    REDIS_ANCHOR.sky.set(6, 26, 2).add(o)
    REDIS_ANCHOR.keys.set(0, HEAP.y + 0.5, HEAP.cz + 0.4).add(o)
    REDIS_ANCHOR.dict.set(0, DICT.y, DICT.cz).add(o)
    REDIS_ANCHOR.loop.copy(LOOP).add(o)
    REDIS_ANCHOR.ports.set(0, BACKEND_ORIGIN.y, BACKEND_ORIGIN.z).add(o)
    REDIS_ANCHOR.aof.set(xAt(AOF_C0), BLOCK_TOP, zAt(AOF_ROW)).add(o)
    REDIS_ANCHOR.aofBuf.set(xAt(AOF_C0), AOF_BUF_Y, zAt(AOF_ROW)).add(o)
    REDIS_ANCHOR.rdb.copy(RDB_CENTRE).add(o)
    REDIS_ANCHOR.bigHash.copy(BIG_SPOT.hash).add(o)
    REDIS_ANCHOR.bigZset.copy(BIG_SPOT.zset).add(o)
    REDIS_ANCHOR.bigList.copy(BIG_SPOT.list).add(o)
}

rebaseAnchors()

export const mixHex = (a: number, b: number, t: number) =>
    new THREE.Color(a).lerp(new THREE.Color(b), t).getHex()
