import * as THREE from 'three'

/**
 * Addressing. The URL is the thing you share, so it says WHAT you are looking at
 * and never from where.
 *
 *   /postgresql         the postgres cage, from the shot that cage keeps for itself
 *   /postgresql/wal     the same cage, framed on the WAL run
 *   /redis/keys         redis, framed on the keyspace
 *
 * Every target that has a named shot has a path (see views.ts), and a shot is a
 * function of the scene — anchored to the structures themselves — so the same
 * address frames the same thing at any window size, and still frames it after a
 * cage has been dragged somewhere else on the floor. An angle in the URL would be
 * true only for the machine that made it.
 *
 * `?cam=` survives as a precise override, and is the one part of this file that is
 * not meant to be read by a person: `pos~target~fov`, comma triples, relative to
 * the CAGE ORIGIN — the point each instance stands its group at, which is the
 * middle of the cage's footprint on the floor. It is for pinning a camera while
 * authoring; nothing links to one by hand.
 */
export type ShareDb = 'postgres' | 'redis'

/** Where a path points: a cage, and a shot in it. `''` is the cage's own shot. */
export interface Address {
    db: ShareDb
    /** view slug, e.g. 'wal'; '' for the cage's default */
    slug: string
}

const dbOf = (seg: string): ShareDb | null => {
    if (seg === 'postgresql' || seg === 'postgres' || seg === 'psql') return 'postgres'
    if (seg === 'redis') return 'redis'
    return null
}

/**
 * Read a path. `/` is the landing page and nothing else is addressable, so a
 * segment that is not a cage — or a path deeper than cage/shot — is not an
 * address, and the caller boots normally.
 */
export function addressFromPath(pathname: string): Address | null {
    const segs = pathname.split('/').filter(Boolean).map((s) => s.toLowerCase())
    if (segs.length === 0 || segs.length > 2) return null
    const db = dbOf(segs[0])
    if (!db) return null
    return { db, slug: segs[1] ?? '' }
}

/** The address for a cage and a shot in it. */
export function pathFor(db: ShareDb, slug = ''): string {
    const base = db === 'postgres' ? '/postgresql' : '/redis'
    return slug ? `${base}/${slug}` : base
}

const round = (n: number) => Math.round(n * 100) / 100
const triple = (v: THREE.Vector3) => `${round(v.x)},${round(v.y)},${round(v.z)}`

/** A pose as `?cam=` writes it — both points relative to the cage's origin. */
export function encodePose(pos: THREE.Vector3, target: THREE.Vector3, fov: number): string {
    return `${triple(pos)}~${triple(target)}~${round(fov)}`
}

/**
 * Read `cam=` back. Anything malformed is not an error worth throwing over: a
 * hand-edited link should land you on the cage's default shot, not on a blank
 * page, so this returns null and the caller uses the named view instead.
 */
export function decodePose(raw: string | null): { pos: THREE.Vector3; target: THREE.Vector3; fov: number } | null {
    if (!raw) return null
    const parts = raw.split('~')
    if (parts.length !== 3) return null
    // named apart from the Vector3 formatter above so the two never get confused
    const readTriple = (s: string) => {
        const n = s.split(',').map(Number)
        return n.length === 3 && n.every((v) => Number.isFinite(v)) ? n : null
    }
    const pos = readTriple(parts[0])
    const target = readTriple(parts[1])
    const fov = Number(parts[2])
    if (!pos || !target || !Number.isFinite(fov) || fov <= 5 || fov >= 120) return null
    return {
        pos: new THREE.Vector3(pos[0], pos[1], pos[2]),
        target: new THREE.Vector3(target[0], target[1], target[2]),
        fov,
    }
}

