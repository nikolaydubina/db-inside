import * as THREE from 'three'
import { BACKEND_ORIGIN } from '../postgresql/instance'
import { RedisBigKind, REDIS_BIG_SPOT } from './values'
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

import { RedisKeyKind, REDIS_KEY_KIND_NAME } from './kind'

export { RedisKeyKind, REDIS_KEY_KIND_NAME }

export const REDIS_BIG_REAL: Record<RedisBigKind, { entries: number; mib: number; unit: string }> =
    {
        [RedisBigKind.Hash]: { entries: 5_300_000, mib: 393, unit: 'fields' },
        [RedisBigKind.ZSet]: { entries: 1_400_000, mib: 160, unit: 'members' },
        [RedisBigKind.List]: { entries: 2_100_000, mib: 92, unit: 'elements' },
    }

export interface RedisKey {
    i: number
    row: number
    col: number
    home: THREE.Vector3

    page: number
    kind: RedisKeyKind
    live: boolean

    ttl: number
    heat: number
    shade: number

    bytes: number

    entries: number

    aux: boolean

    big?: RedisBigKind

    raw?: boolean

    hot?: boolean
}

export function encodingOf(key: RedisKey): string {
    switch (key.kind) {
        case RedisKeyKind.String:
            return key.bytes <= 44 ? 'embstr' : 'raw'
        case RedisKeyKind.Hash:
            return key.aux ? 'hashtable' : 'listpack'
        case RedisKeyKind.Set:
            return key.aux ? 'hashtable' : 'intset'
        case RedisKeyKind.ZSet:
            return key.aux ? 'skiplist + dict' : 'listpack'
        case RedisKeyKind.List:
            return key.big
                ? 'quicklist · listpacks'
                : key.aux
                  ? 'quicklist · 2 nodes'
                  : 'quicklist · 1 node'
    }
}

export function auxBlocks(key: RedisKey): number {
    if (!key.aux || key.kind === RedisKeyKind.String) return 0
    return key.kind === RedisKeyKind.ZSet ? 2 : 1
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
    REDIS_ANCHOR.bigHash.copy(REDIS_BIG_SPOT[RedisBigKind.Hash]).add(o)
    REDIS_ANCHOR.bigZset.copy(REDIS_BIG_SPOT[RedisBigKind.ZSet]).add(o)
    REDIS_ANCHOR.bigList.copy(REDIS_BIG_SPOT[RedisBigKind.List]).add(o)
}

rebaseAnchors()

export const mixHex = (a: number, b: number, t: number) =>
    new THREE.Color(a).lerp(new THREE.Color(b), t).getHex()
