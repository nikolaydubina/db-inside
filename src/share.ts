import * as THREE from 'three'

/**
 * Shareable links.
 *
 *   /postgresql        the postgres cage, from the shot that view defines
 *   /redis             the same for redis
 *   /redis?cam=…       a camera captured from a real orbit, reproducible
 *
 * The pose is stored RELATIVE TO THE CAGE'S MIN CORNER, not in world space. That
 * is the whole point: a cage can be dragged somewhere else on the floor, and a
 * link made before the move still frames the same part of the same machine when
 * it opens after. World coordinates would break the moment anything moves, and
 * the default layout is only a default.
 *
 * The min corner is the cage's origin — both instances place their group at the
 * floor with the shell starting there, so `group.position` IS min(x, y, z).
 *
 * Encoding is deliberately readable: `cam=px,py,pz~tx,ty,tz~fov`, two decimals.
 * No base64, because a link someone pastes into a chat should be inspectable and
 * hand-editable.
 */
export type ShareDb = 'postgres' | 'redis'

export interface ShareTarget {
    db: ShareDb
    /** camera position, relative to the cage's min corner */
    pos: THREE.Vector3
    /** aim point, relative to the same corner */
    target: THREE.Vector3
    fov: number
}

const DBS: ShareDb[] = ['postgres', 'redis']

/** `/postgresql` and `/redis` (plus the short forms) name a cage; anything else does not. */
export function dbFromPath(pathname: string): ShareDb | null {
    const seg = pathname.replace(/\/+$/, '').split('/').pop()?.toLowerCase() ?? ''
    if (seg === 'postgresql' || seg === 'postgres' || seg === 'psql') return 'postgres'
    if (seg === 'redis') return 'redis'
    return null
}

/** What the address bar should say for a database, with or without a pose. */
export function pathFor(db: ShareDb): string {
    return db === 'postgres' ? '/postgresql' : '/redis'
}

const round = (n: number) => Math.round(n * 100) / 100
const triple = (v: THREE.Vector3) => `${round(v.x)},${round(v.y)},${round(v.z)}`

export function encodePose(cam: THREE.Vector3, target: THREE.Vector3, fov: number): string {
    return `${triple(cam)}~${triple(target)}~${round(fov)}`
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

/**
 * Capture the camera as a link. The cage's min corner is the anchor, so the
 * numbers say "12 left of the corner, 9 up, 21 in front of it" — which is also
 * the number that survives the cage being moved.
 */
export function shareUrl(
    db: ShareDb,
    cageMin: THREE.Vector3,
    cam: THREE.Vector3,
    target: THREE.Vector3,
    fov: number,
): string {
    const rel = cam.clone().sub(cageMin)
    const aim = target.clone().sub(cageMin)
    const url = new URL(location.href)
    url.pathname = pathFor(db)
    url.hash = ''
    url.searchParams.set('cam', encodePose(rel, aim, fov))
    // the cache-busting parameters this page is opened with (?v=) stay: they are
    // how a deploy is pinned, and dropping them would silently change the shot
    return url.toString()
}

/** The database a URL path names, if it names one. */
export function isSharePath(pathname: string): boolean {
    return dbFromPath(pathname) !== null
}

export const SHARE_DBS = DBS
