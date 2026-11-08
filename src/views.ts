import * as THREE from 'three'
import { WORLD_ANCHOR as ANCHOR, BACKEND_ORIGIN, BACKEND_SLOTS, PAGE_GRID, POSTGRES_ORIGIN, PROCESS, pageX, pageZ } from './postgresql/instance'
import { REDIS_ANCHOR, REDIS_ORIGIN } from './redis/redis'
import type { Ticker } from './core/util'
import { easeInOutCubic } from './core/util'

/**
 * Named camera poses, anchored to scene entities instead of hardcoded numbers.
 * Every pose is derived from ANCHOR at call time, so moving a structure moves
 * its views with it.
 *
 *   __psqlViews.list()                    → ids + labels
 *   __psqlViews.go('wal')                 → fly there (0.85s)
 *   __psqlViews.snap('wal')               → cut straight there (for tests)
 *   __psqlViews.anchor('wal')             → the live anchor vector
 */

export interface CameraPose {
    pos: THREE.Vector3
    target: THREE.Vector3
    fov: number
}

export interface ViewDef {
    id: string
    label: string
    /**
     * Path segment: this shot lives at /postgresql/<slug>, /redis/<slug>. Left
     * out, it is derived from the id — see slugOf().
     */
    slug?: string
    /** Scene entity this shot is about. */
    entity: string
    hint: string
    /**
     * Which database's panel this shot belongs in. Left out means postgres, and
     * 'both' is listed under each — the floor is shared, the panels are not.
     */
    db?: 'postgres' | 'redis' | 'both'
    /**
     * A shot of a whole cage, or of the floor. These are reachable by path and by
     * button, but they are never the answer to "what did I just tap" — a tap is
     * about one thing, and zooming out is the opposite of that.
     */
    whole?: boolean
    /**
     * No button, and no `<cage>/<slug>` address: `rig.go()` still reaches it, so a
     * gesture can use it, but it is not something you ask for by name or link to.
     * The floor's shot is like this — it is about both cages, so neither cage's
     * name belongs in front of it, and there is no third path to put it under.
     */
    unlisted?: boolean
    pose(): CameraPose
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

/** Cage-local point → world. ANCHOR is already world; the literals below are not. */
const L = (x: number, y: number, z: number) => V(x, y, z).add(POSTGRES_ORIGIN)

/** Look at `at` from `offset` relative to it. */
const shot = (
    anchor: THREE.Vector3,
    offset: [number, number, number],
    fov = 36,
    lookAt?: [number, number, number],
): CameraPose => ({
    pos: anchor.clone().add(V(...offset)),
    target: anchor.clone().add(V(...(lookAt ?? [0, 0, 0]))),
    fov,
})

const TABLE_ANCHOR = { users: ANCHOR.heap, products: ANCHOR.events, metrics: ANCHOR.metrics }

/**
 * The house shot — where a cage-level view stands, relative to the cage's own
 * origin. One set of numbers for every machine on the floor, and it is the same
 * numbers a `?cam=` override prints, so a shot can be copied straight out of the
 * address bar into here.
 *
 * It is shared on purpose: a reader stepping from one cage to the next should be
 * in the same place looking at the same thing, and a new cage then only has to
 * say where its origin is.
 *
 * It aims at the MIDDLE OF THE CAGE. The drift turns the camera about the point a
 * shot aims at, so a shot that aims past its cage would swing the machine across
 * the frame instead of turning it where it stands — and a camera circling the
 * middle while looking somewhere else is not an orbit of the middle at all.
 * 4.9 is half the 9.8-tall shell, which stands on the floor.
 */
const HOUSE: { offset: [number, number, number]; look: [number, number, number]; fov: number } = {
    offset: [29.29, 14.65, 15.15],
    look: [0, 4.9, 0],
    fov: 40,
}
const houseShot = (origin: THREE.Vector3) => shot(origin, HOUSE.offset, HOUSE.fov, HOUSE.look)

export const VIEWS: ViewDef[] = [
    {
        id: 'overview',
        label: 'overview',
        db: 'both',
        whole: true,
        // Unlisted on purpose: no button in either card, and no `/postgresql/overview`
        // address. Double-tapping empty space still zooms out to it, and the stories
        // still ask for it by id; it is a view, not a place.
        unlisted: true,
        entity: 'the floor',
        hint: 'both databases on the same floor, each in its own cage',
        // midway between the two cages, so rearranging them keeps both in frame
        pose: () =>
            shot(
                POSTGRES_ORIGIN.clone().add(REDIS_ORIGIN).multiplyScalar(0.5),
                [-38, 24, 54],
                46,
                [0, 6.5, 0],
            ),
    },
    {
        id: 'postgres',
        label: 'postgres',
        whole: true,
        entity: 'instance',
        hint: 'the whole postgres instance: disk plate, RAM deck, pipeline',
        pose: () => houseShot(POSTGRES_ORIGIN.clone()),
    },
    {
        id: 'redis',
        label: 'redis',
        db: 'redis',
        whole: true,
        entity: 'redis cage',
        hint: 'the redis instance: almost nothing on the disk, everything in the air',
        pose: () => houseShot(REDIS_ORIGIN.clone()),
    },
    {
        id: 'redis-keys',
        label: 'redis keys',
        db: 'redis',
        entity: 'keyspace',
        hint: 'the keyspace: bucket array below, entries floating above it',
        pose: () => shot(REDIS_ANCHOR.keys, [-3.4, 5.4, 8.6], 34, [0, -0.5, 0]),
    },
    {
        id: 'redis-skew',
        label: 'redis skew',
        db: 'redis',
        entity: 'the distribution',
        hint: 'many small keys, a few very large values, and the handful of keys taking the traffic',
        pose: () =>
            shot(REDIS_ORIGIN.clone().add(V(0, 3.4, -2.6)), [-7.5, 6.5, 15.5], 40, [0, 0.8, 0]),
    },
    {
        id: 'big-zset',
        label: 'sorted set · big',
        slug: 'zset',
        db: 'redis',
        entity: 'a big sorted set',
        hint: 'a skiplist with the dict beside it — one key, 1.4 M members',
        // above the keys plane and looking down: from any lower the plane hangs
        // between the camera and the tower
        pose: () => shot(REDIS_ANCHOR.bigZset, [0.6, 8.0, 5.2], 34, [0, 0.3, 0]),
    },
    {
        id: 'big-hash',
        label: 'hash · big',
        slug: 'hash',
        db: 'redis',
        entity: 'a big hash',
        hint: 'a bucket array with chains — one key, 5.3 M fields',
        pose: () => shot(REDIS_ANCHOR.bigHash, [0.6, 7.4, 5.2], 34, [0, 0.2, 0]),
    },
    {
        id: 'big-list',
        label: 'list · big',
        slug: 'list',
        db: 'redis',
        entity: 'a big list',
        hint: 'a chain of quicklist nodes — one key, 2.1 M elements',
        pose: () => shot(REDIS_ANCHOR.bigList, [0.6, 7.6, 7.2], 34, [0, 0.2, 0]),
    },
    {
        id: 'redis-disk',
        label: 'redis disk',
        db: 'redis',
        entity: 'persistence',
        hint: 'only two files are here: the incremental AOF and the base RDB',
        pose: () => shot(REDIS_ORIGIN.clone().add(V(0, 0, 3.25)), [-5.6, 10.6, 15.6], 38),
    },
    {
        id: 'redis-aof',
        label: 'redis aof',
        db: 'redis',
        entity: 'aof tail',
        hint: 'the end of the log: the block being appended, and the bytes still in aof_buf above it',
        // Aimed between the two things that matter here: the floating buffer and
        // the block under it. The target sits below the strip on purpose, so the
        // cubes and the disk blocks they are destined for are both in frame —
        // framing the buffer alone would cut off what it points at. Stood back from
        // it too: five 4 kB cubes are small, and filling the frame with them hides
        // the log they are about to become.
        pose: () => shot(REDIS_ANCHOR.aofBuf, [-5.4, 5.4, 7.7], 36, [0, -1.2, 0]),
    },
    {
        id: 'redis-loop',
        label: 'command loop',
        slug: 'loop',
        db: 'redis',
        entity: 'the command loop',
        hint: 'one thread: the queue draining into it, epoll feeding it, every command passing through it',
        // The aim point IS the orb centre, on purpose: controls.target is the
        // centre of rotation, so the drift and any orbit the user drags turn
        // about the thing the shot is about. The offset is the angle picked by
        // hand in the browser — from the −x side and above, so the queue over
        // the loop, the epoll plate under it and the paths leaving for the
        // keyspace are all in the same frame at this distance (~9.3 units).
        pose: () => shot(REDIS_ANCHOR.loop, [-4.93, 5.96, 5.11], 34),
    },
    {
        id: 'redis-paths',
        label: 'pointer chases',
        slug: 'paths',
        db: 'redis',
        entity: 'the address chain',
        hint: 'bucket → entry → value → the heap pages a walk lands on, all in one frame',
        // Wide on purpose: a traversal is a route BETWEEN three layers — the dict
        // at 5.85, the value structures at ~3.4, the heap at 1.95 — and a shot of
        // any one of them shows a structure, not the movement between them. Stood
        // to the left of the cage, so the loop (which is near and bright) does not
        // sit on top of the sorted set at the centre of the frame.
        pose: () => shot(REDIS_ORIGIN.clone().add(V(0, 3.2, -3.0)), [-9, 4.5, 16], 42),
    },
    {
        id: 'redis-hash-walk',
        label: 'hash lookups',
        slug: 'hash-paths',
        db: 'redis',
        entity: 'the big hash and its pages',
        hint: 'HGET is one bucket; HGETALL walks every bucket and every chain into the heap',
        // Aimed between the big hash (which sits on the left) and the arena under
        // it, because the difference between the two reads is a route, not a shape:
        // one hop for a field, a sweep of the whole bucket array for HGETALL.
        pose: () => shot(REDIS_ORIGIN.clone().add(V(-4.3, 3.0, -3.5)), [-4.5, 4.2, 15.5], 44),
    },
    {
        id: 'redis-journey',
        label: 'one lookup',
        slug: 'journey',
        db: 'redis',
        entity: 'one request, end to end',
        hint: 'socket → queue → loop → bucket → page → object → back out',
        // The whole path, so the shot has to hold the port strip, the queue, the
        // loop, the dict, the heap and the object section at once — the only way
        // to follow a request is to see where it starts and where it goes.
        pose: () =>
            shot(REDIS_ORIGIN.clone().add(V(-4, 6.2, 1.2)), [5, 4.5, 18], 44),
    },
    {
        id: 'redis-inline',
        label: 'inline value',
        slug: 'inline',
        db: 'redis',
        entity: 'one value object',
        hint: 'sixteen bytes: a header, and a payload that is sometimes inside it',
        // The cage now sits at heap level, so the shot is low: the page the read
        // lands on, the object section above it, and the dict at the top edge —
        // bucket → page → object, with both ends in frame.
        pose: () =>
            shot(REDIS_ORIGIN.clone().add(V(-8.0, 3.6, -1.6)), [3.8, 3.0, 9.4], 40),
    },
    {
        id: 'redis-pubsub',
        label: 'redis pub/sub',
        db: 'redis',
        entity: 'the fan-out',
        hint: 'the command loop and the sockets listening to it: a publish touches no key and no file',
        // Framed from the loop UPWARDS, because that is where this route goes: the
        // thread sits a little below the rim, and the sockets it writes to are at
        // the top. Aiming at the loop alone would cut the listeners out of the
        // frame, which is the entire point of the shot.
        pose: () => shot(REDIS_ANCHOR.loop.clone().add(V(0.6, 1.35, 2.4)), [1.2, 2.6, 12.4], 37),
    },
    {
        id: 'disk',
        label: 'disk',
        entity: 'disk plate',
        hint: 'the page field from above: solid near the WAL, holes into free space',
        pose: () => shot(V(0, 0, 3.2), [0.5, 15, 21], 38),
    },
    {
        id: 'tables',
        label: 'tables',
        entity: 'table runs',
        hint: 'the three table runs: fills, dead pages, allocation',
        pose: () => shot(V(2.0, 0.4, 4.4), [1.5, 7.5, 15], 34),
    },
    {
        id: 'wal',
        label: 'wal',
        entity: 'wal run',
        hint: 'log run, write head, and the wal_buffers hovering above it',
        pose: () => shot(ANCHOR.wal, [4.5, 4.0, 7.5], 32, [0, 0.2, 0]),
    },
    {
        id: 'wal-buffers',
        label: 'wal buffers',
        entity: 'wal_buffers',
        hint: 'the tail of the log in memory: the cubes, and the segments they are destined for below',
        // Same shot as redis-aof, on purpose: the two buffers are the same idea in
        // two machines, so they are framed the same way — same direction, aimed
        // under the cubes so the memory and the blocks it will be written to are
        // both in frame. Pulled back a little because this strip is wider (four
        // 8 kB cubes end to end, not five 4 kB ones).
        pose: () => shot(ANCHOR.walBuf, [-4.3, 4.3, 6.1], 34, [0, -0.85, 0]),
    },
    {
        id: 'buffers',
        label: 'buffers',
        entity: 'shared buffers',
        hint: 'the RAM deck: page tiles, dirty pages, buffer hits',
        // steeper than before: at a shallow angle the buffers merge into ridges
        pose: () => shot(ANCHOR.bufferCenter, [0.8, 9.2, 5.8], 36),
    },
    {
        id: 'pipeline',
        label: 'pipeline',
        entity: 'process pipelines',
        hint: 'one dashed lane per live backend: parser → planner → executor, running in parallel',
        pose: () =>
            shot(V(0, PROCESS.y, (PROCESS.zParse + PROCESS.zExec) / 2), [4.5, 4.2, 13], 38),
    },
    {
        id: 'indexes',
        label: 'indexes',
        entity: 'index structures',
        hint: 'b-tree, BRIN, GIN and hash floating as they sit in RAM',
        pose: () => shot(L(5.0, 2.4, -2.6), [7.5, 5.0, 12.5], 36),
    },
    {
        id: 'autovacuum',
        label: 'autovacuum',
        entity: 'the vacuum drone',
        hint: 'the drone that walks the heap: it reclaims space inside pages, never shrinks the file',
        // The one subject that FLIES: the pose reads a live anchor, so the camera
        // aims at where the drone is this frame, and the rig's follow then keeps it
        // framed with inertia as it patrols — it trails a little and settles
        // instead of snapping to it. It is a small thing on a wide disk plate, so
        // the shot stands well back: close up the frame is one drone and no plate,
        // and there is nothing to see it against.
        pose: () => shot(ANCHOR.vacuum, [5.1, 4.4, 10.5], 34, [0, -1.4, 0]),
    },
    {
        id: 'free',
        label: 'free space',
        slug: 'free-space',
        entity: 'unallocated tail',
        hint: 'the empty tail of the disk: slot lattice, no pages',
        pose: () => shot(L(pageX(4), 0, pageZ(16)), [-6.0, 5.5, 11.0], 34),
    },
    {
        id: 'clients',
        label: 'clients',
        entity: 'backend ports',
        hint: 'connection ports on the top rim — one process per connection',
        // far enough back that all six ports fit, and centred on the strip: an
        // x offset swings the view and silently cropped the outer two
        pose: () =>
            shot(
                L(0, BACKEND_ORIGIN.y - 0.9, BACKEND_ORIGIN.z),
                [0, 6.4, 20.5],
                36,
                [0, -1.3, 0],
            ),
    },
    {
        id: 'pages',
        label: 'pages',
        entity: 'page blocks',
        hint: 'down at block level: individual 8 kB pages of a table run',
        pose: () =>
            shot(L(pageX(24), 0.25, pageZ(14)), [1.6, 1.1, 2.4], 30, [0, 0.1, 0]),
    },
]

export const tableView = (name: keyof typeof TABLE_ANCHOR): ViewDef => ({
    id: `table-${name}`,
    slug: `table-${name}`,
    label: `table: ${name}`,
    entity: `table:${name}`,
    hint: `close-up of the ${name} page run`,
    pose: () => shot(TABLE_ANCHOR[name], [3.0, 4.2, 7.0], 32, [0, 0.2, 0]),
})

/**
 * One connection on its own: the port, the input-buffer stack under it, and
 * nothing else of the pool in frame. This is what the story's buffer steps look
 * at, because "the buffer" is a per-backend thing and a wide shot of six ports
 * does not show any one of them.
 */
export const backendView = (i: number): ViewDef => {
    const x = BACKEND_SLOTS[i] ?? 0
    // aim a little below the middle of port + stack so the subject sits above
    // centre, clear of the caption panel along the bottom
    const mid = L(x, BACKEND_ORIGIN.y - 1.15, BACKEND_ORIGIN.z)
    return {
        id: `backend-${i}`,
        // 1-based, because the label says "backend 1" and a path that disagrees
        // with the thing on screen is worse than no path
        slug: `backend-${i + 1}`,
        label: `backend ${i + 1}`,
        entity: `backend ${i + 1}`,
        hint: 'one connection close up: port, input buffer, what it is running',
        // Symmetric and narrow: the target port sits dead centre, the whole
        // subject (port down to the last buffer cell) fits between the top of
        // the frame and the caption panel, and the neighbouring ports stay at
        // the edges as context rather than competing for attention. Closer than
        // ~15 units the port's halo plus bloom white the frame out.
        pose: () => shot(mid, [0, 4.0, 16.3], 20, [0, -0.97, 0]),
    }
}

export const ALL_VIEWS = [
    ...VIEWS,
    ...(['users', 'products', 'metrics'] as const).map(tableView),
    ...BACKEND_SLOTS.map((_, i) => backendView(i)),
]

/**
 * The shots that belong in one database's panel. A view with no `db` is
 * postgres's (the first cage, and the default for anything unnamed), and a
 * `both` view is listed in each panel, because either tab may want it. Unlisted
 * shots are in neither list — they have no address and no button.
 */
export const viewsFor = (db: 'postgres' | 'redis') =>
    ALL_VIEWS.filter((v) => !v.unlisted && (v.db === 'both' || (v.db ?? 'postgres') === db))

/**
 * The path segment of a shot — `/postgresql/wal`, `/redis/keys`.
 *
 * Two shots ARE their cage, so they are the path with nothing after it. The rest
 * is the id, minus a `redis-` prefix that would only repeat what the path already
 * says: `/redis/keys`, not `/redis/redis-keys`.
 */
export function slugOf(v: ViewDef): string {
    if (v.slug !== undefined) return v.slug
    if (v.id === 'postgres' || v.id === 'redis') return ''
    return v.db === 'redis' ? v.id.replace(/^redis-/, '') : v.id
}

/** The shot a cage opens on when its path names nothing else. */
export function defaultView(db: 'postgres' | 'redis'): ViewDef {
    const v = ALL_VIEWS.find((x) => x.id === db)
    if (!v) throw new Error(`[views] no default shot for ${db}`)
    return v
}

/** The shot a path names. An empty slug is the cage's own shot. */
export function viewBySlug(db: 'postgres' | 'redis', slug: string): ViewDef | null {
    if (!slug) return defaultView(db)
    return viewsFor(db).find((v) => slugOf(v) === slug) ?? null
}

/**
 * Which named shot is ABOUT this box — what a double-tap should turn into.
 *
 * A view's pose target is the point its shot aims at, so it sits inside the thing
 * the shot is about. That is the first test, and it is why this needs no table of
 * names: tap the WAL run and the shot aimed into the WAL run is the one that
 * matches. A small pad covers the shots aimed deliberately just under their
 * subject — both buffer strips look past their cubes at the blocks below.
 *
 * Not everything has an aim point inside it, though. A shot can be about a
 * CLUSTER — the floating index structures are one view of four separate trees —
 * and then tapping any one tree should still find it. So a shot also matches when
 * what you tapped is within its own reach: the frame at the subject is about
 * `2·tan(fov/2)·dist` wide, and a third of the camera-to-subject distance is a
 * fair bracket for "the sort of thing this shot is showing".
 *
 * Where several shots match, the nearest aim point wins: that is the tightest
 * reading of the tap, so a page inside a table run picks the page's shot over the
 * table's. Whole-cage and floor shots are excluded — tapping one thing is never a
 * request to zoom out.
 */
export function viewForBox(db: 'postgres' | 'redis', box: THREE.Box3, pad = 1.5): ViewDef | null {
    if (box.isEmpty()) return null
    const centre = box.getCenter(new THREE.Vector3())
    let best: ViewDef | null = null
    let bestDist = Infinity
    for (const v of viewsFor(db)) {
        if (v.whole) continue
        const pose = v.pose()
        const aim = pose.target
        const inside =
            aim.x >= box.min.x - pad &&
            aim.x <= box.max.x + pad &&
            aim.y >= box.min.y - pad &&
            aim.y <= box.max.y + pad &&
            aim.z >= box.min.z - pad &&
            aim.z <= box.max.z + pad
        const d = aim.distanceTo(centre)
        if (!inside && d > 0.35 * pose.pos.distanceTo(aim)) continue
        if (d < bestDist) {
            best = v
            bestDist = d
        }
    }
    return best
}

export interface RigOptions {
    camera: THREE.PerspectiveCamera
    controls: { target: THREE.Vector3; update(): void }
    ticker: Ticker
    /** Called before any navigation — use it to stop auto-orbit, exit fly, etc. */
    beforeNavigate?: () => void
}

export function createCameraRig({ camera, controls, ticker, beforeNavigate }: RigOptions) {
    let current: string | null = null
    /**
     * Bumped by every navigation. A tween that wakes up with a stale token
     * stops writing, so two moves started inside one tween duration cannot
     * fight over the camera and leave it on the pose that happened to be added
     * last. Without this, stepping quickly through a story landed on the
     * previous step's view while the rig still reported the new one.
     */
    let nav = 0

    /**
     * What the camera keeps its TARGET on, as a live point. A named view
     * resolves this through its own pose function, and poses are built from live
     * anchors — so the point moves when the thing the view is about moves: a cage
     * being dragged, the aof_buf strip drifting along the log.
     */
    let followPoint: (() => THREE.Vector3) | null = null
    /** Name of what is being followed, for the console and for tests. */
    let followName: string | null = null
    /** Tweens in flight: following must not write while one is aiming the camera. */
    let tweening = 0
    /** How hard the camera is pulled after a target that moved, in 1/s. */
    const FOLLOW_RATE = 3.2
    const followDelta = new THREE.Vector3()
    /**
     * A ride: a subject the camera sits a fixed distance from and looks straight
     * at, for as long as it lasts.
     *
     * This is not the pan-follow above. That one keeps the aim point relative to
     * the camera and only ever translates, which is right for a structure that
     * drifts a little. A packet crosses the cage in seconds and changes direction
     * on the way, so the ride eases the camera toward `subject + dir × dist` and
     * the aim point onto the subject itself — one rule per frame, no tween to
     * fight, and it settles instead of lagging a fixed fraction behind.
     */
    let ride: { target: THREE.Object3D; dir: THREE.Vector3; dist: number } | null = null
    const rideAt = new THREE.Vector3()
    const rideWant = new THREE.Vector3()
    const RIDE_RATE = 6

    const apply = (pose: CameraPose) => {
        ride = null
        camera.position.copy(pose.pos)
        controls.target.copy(pose.target)
        if (Math.abs(camera.fov - pose.fov) > 0.01) {
            camera.fov = pose.fov
            camera.updateProjectionMatrix()
        }
        controls.update()
    }

    const find = (id: string) => ALL_VIEWS.find((v) => v.id === id)

    /**
     * Smallest distance along `dir` at which every corner of `box` is inside the
     * frustum. Bisection instead of a bounding sphere, because a sphere over a
     * wide flat box (the cage, the disk plate) is much larger than the box looks
     * on screen and would push the camera far too far away.
     */
    const fitDistance = (box: THREE.Box3, dir: THREE.Vector3) => {
        const centre = box.getCenter(new THREE.Vector3())
        const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
        const tanH = tanV * camera.aspect
        const fwd = dir.clone().negate()
        const right = new THREE.Vector3().crossVectors(fwd, camera.up)
        if (right.lengthSq() < 1e-8) right.set(1, 0, 0)
        right.normalize()
        const up = new THREE.Vector3().crossVectors(right, fwd).normalize()

        const corners: THREE.Vector3[] = []
        for (let i = 0; i < 8; i++) {
            corners.push(
                new THREE.Vector3(
                    i & 1 ? box.max.x : box.min.x,
                    i & 2 ? box.max.y : box.min.y,
                    i & 4 ? box.max.z : box.min.z,
                ),
            )
        }
        const inView = (d: number) => {
            const cam = centre.clone().addScaledVector(dir, d)
            return corners.every((c) => {
                const v = c.clone().sub(cam)
                const z = v.dot(fwd)
                return (
                    z > 0.01 &&
                    Math.abs(v.dot(right)) <= tanH * z &&
                    Math.abs(v.dot(up)) <= tanV * z
                )
            })
        }

        let lo = 0.4
        let hi = 160
        for (let i = 0; i < 28; i++) {
            const mid = (lo + hi) / 2
            if (inView(mid)) hi = mid
            else lo = mid
        }
        return hi * 1.06 // a little air around it
    }

    /**
     * Frame something and leave the camera pointed at it — the double-click
     * behaviour. Keeps the current viewing direction, so it reads as a dolly
     * rather than a jump cut.
     */
    function focus(
        target: THREE.Object3D | THREE.Box3,
        opts: { duration?: number; padding?: number } = {},
    ): Promise<boolean> {
        const box = target instanceof THREE.Box3 ? target.clone() : new THREE.Box3().setFromObject(target)
        if (box.isEmpty()) return Promise.resolve(false)
        const centre = box.getCenter(new THREE.Vector3())

        // keep the direction we are already looking from
        const dir = camera.position.clone().sub(controls.target)
        if (dir.lengthSq() < 1e-6) dir.set(0, 0.35, 1)
        dir.normalize()

        const dist = THREE.MathUtils.clamp(
            fitDistance(box, dir) * (opts.padding ?? 1),
            1.6,
            55, // never further out than the overview shot
        )
        const toPos = centre.clone().addScaledVector(dir, dist)
        const fromPos = camera.position.clone()
        const fromTarget = controls.target.clone()

        current = null
        // A box was measured at this instant, so there is nothing live to hold on
        // to — but a picked OBJECT has a position of its own, so a double-tapped
        // cage can still be dragged afterwards and the camera stays on it.
        ride = null
        if (target instanceof THREE.Box3) {
            followPoint = null
            followName = null
        } else {
            const live = new THREE.Vector3()
            const shift = centre.clone().sub(target.getWorldPosition(live))
            followPoint = () => target.getWorldPosition(live).add(shift)
            followName = 'focus'
        }
        beforeNavigate?.()

        const dur = opts.duration ?? 0.95
        const mine = ++nav
        tweening++
        return ticker
            .add(dur, (k) => {
                if (mine !== nav) return
                const e = easeInOutCubic(k)
                camera.position.lerpVectors(fromPos, toPos, e)
                controls.target.lerpVectors(fromTarget, centre, e)
                controls.update()
            })
            .then(() => {
                tweening--
                return true
            })
    }

    /** Fly to a named view. `instant` cuts instead of tweening (tests, links). */
    function go(id: string, opts: { instant?: boolean; duration?: number } = {}): boolean {
        const view = find(id)
        if (!view) {
            console.warn(`[views] unknown view "${id}"`, ALL_VIEWS.map((v) => v.id))
            return false
        }
        const pose = view.pose()
        current = id
        // a drifting auto-orbit would immediately drag the camera off the pose
        beforeNavigate?.()
        // a named view is not a ride: it aims at a place, not at a moving object
        ride = null

        // from now on the camera holds on to whatever this view is about
        followPoint = () => view.pose().target
        followName = id

        if (opts.instant) {
            // an instant cut must still cancel any tween already in flight,
            // otherwise that tween keeps writing and drags the camera back to
            // wherever it was heading — which is exactly how a story step ended
            // up showing the previous step's view
            nav++
            apply(pose)
            return true
        }

        const fromPos = camera.position.clone()
        const fromTarget = controls.target.clone()
        const fromFov = camera.fov
        const dur = opts.duration ?? 0.85
        const mine = ++nav
        tweening++
        void ticker
            .add(dur, (k) => {
                if (mine !== nav) return
                const e = easeInOutCubic(k)
                camera.position.lerpVectors(fromPos, pose.pos, e)
                controls.target.lerpVectors(fromTarget, pose.target, e)
                camera.fov = fromFov + (pose.fov - fromFov) * e
                camera.updateProjectionMatrix()
                controls.update()
            })
            .then(() => tweening--)
        return true
    }

    return {
        go,
        snap: (id: string) => go(id, { instant: true }),
        focus,
        /**
         * Translate the view without rotating or re-framing it. Some subjects
         * drift on their own — wal_buffers slides along the WAL run as the head
         * advances — and a lock that only frames once leaves them behind. This
         * lets the story follow them the way a camera operator would pan.
         */
        pan(delta: THREE.Vector3) {
            camera.position.add(delta)
            controls.target.add(delta)
            controls.update()
        },
        /**
         * Hold the camera on what the current view is about, whatever happens to
         * it. Subjects move for their own reasons — a cage is dragged across the
         * floor, the aof_buf strip drifts along the log as it grows, a write head
         * walks along its run — and a camera parked at absolute coordinates
         * silently stops describing them.
         *
         * This only ever PANS. Orbit angle, distance and field of view are kept
         * exactly as the user set them, so looking around a subject still works
         * while it moves. The pull is exponential rather than instant: the camera
         * trails a little and settles, instead of teleporting after every step.
         */
        follow(dt: number) {
            // A ride moves the camera even while a tween is "in flight" — the ride
            // cancelled that tween when it was installed, and time may be stopped,
            // in which case the tween would never finish and the camera would sit
            // waiting forever.
            if (ride) {
                // An object that has left the scene is not a subject any more. Its
                // world position is then just its cage-local numbers with no cage
                // around them, which is a point in the middle of the floor — the
                // camera used to be dragged over to it the instant a packet was
                // despawned.
                if (!ride.target.parent) {
                    ride = null
                    followName = null
                    return
                }
                ride.target.getWorldPosition(rideAt)
                rideWant.copy(rideAt).addScaledVector(ride.dir, ride.dist)
                const k = 1 - Math.exp(-dt * RIDE_RATE)
                camera.position.lerp(rideWant, k)
                controls.target.lerp(rideAt, k)
                controls.update()
                return
            }
            if (!followPoint || tweening > 0) return
            followDelta.copy(followPoint()).sub(controls.target)
            if (followDelta.lengthSq() < 1e-8) return
            followDelta.multiplyScalar(1 - Math.exp(-dt * FOLLOW_RATE))
            controls.target.add(followDelta)
            camera.position.add(followDelta)
        },
        /** Is a ride framing its subject yet? The story's arrival test. */
        settled() {
            if (!ride) return false
            ride.target.getWorldPosition(rideAt)
            rideWant.copy(rideAt).addScaledVector(ride.dir, ride.dist)
            // A ride on something that is moving never sits dead still: it trails
            // by roughly speed/rate. So "arrived" means framing — inside a margin
            // that scales with the standoff, with the aim on the subject — not
            // "motionless at an absolute point", which it would never satisfy and
            // the panel would sit on "camera → …" for the whole step.
            const tol = Math.max(0.4, ride.dist * 0.12)
            return (
                camera.position.distanceTo(rideWant) < tol &&
                controls.target.distanceTo(rideAt) < tol
            )
        },
        /** What the camera is currently holding on to, if anything. */
        following: () => followName,
        /**
         * The slow drift: turn the camera about the aim point.
         *
         * The aim point is the centre of what the shot is about — a cage-level shot
         * aims at the middle of its cage precisely so this is an orbit of the cage —
         * so the subject turns where it stands and the framing does not change. This
         * is OrbitControls' autoRotate, done here because the rate belongs with the
         * rest of the camera and not in a control's magic constant.
         */
        turn(angle: number) {
            const dx = camera.position.x - controls.target.x
            const dz = camera.position.z - controls.target.z
            const c = Math.cos(angle)
            const s = Math.sin(angle)
            camera.position.x = controls.target.x + dx * c - dz * s
            camera.position.z = controls.target.z + dx * s + dz * c
        },
        /**
         * Let go of the subject.
         *
         * The follow exists so a view keeps describing a thing that moves while
         * you watch it — a cage being dragged, a buffer strip drifting along the
         * log. It is NOT a lock: the moment the camera is driven by hand —
         * orbiting, zooming, flying — the user owns the camera and this gets
         * released, so `?view=` only decides where you START. Navigating to a
         * view again re-arms it.
         */
        release() {
            ride = null
            if (!followPoint && !followName) return
            followPoint = null
            followName = null
        },
        /**
         * Keep the camera on this object as it moves, without moving it now.
         *
         * `frame()` measures a box once and then lets go, which is right for a
         * structure that stands still. A packet does not: it crosses the cage in a
         * couple of seconds, so a story frames it once and then hands the camera
         * the OBJECT — the same live follow a dragged cage gets, so the orbit, the
         * distance and the lens the frame chose are kept and only the position
         * tracks. Panning the camera by hand from a 200 ms poll instead leaves it
         * lagging a fixed fraction behind its subject, which reads as jitter.
         */
        hold(target: THREE.Object3D | null, shot?: { dir: [number, number, number]; dist: number; fov?: number }) {
            if (!target || !shot) {
                ride = null
                followPoint = null
                followName = null
                return
            }
            // any tween still aiming the camera is cancelled: from here on the ride
            // is the only thing writing, so there is nothing to fight
            nav++
            tweening = 0
            followPoint = null
            ride = {
                target,
                dir: new THREE.Vector3(...shot.dir).normalize(),
                dist: Math.max(1.2, shot.dist),
            }
            followName = 'riding'
            if (shot.fov !== undefined && Math.abs(camera.fov - shot.fov) > 0.01) {
                camera.fov = shot.fov
                camera.updateProjectionMatrix()
            }
        },
        /**
         * Frame a world-space box from a direction. This is how the story aims
         * the camera: it knows *what* it wants to look at and hands over a box,
         * so a step never hardcodes a camera position or a pod index. Returns
         * the pose it flew to, so a test can check the camera actually got there.
         */
        frame(
            box: THREE.Box3,
            dir: [number, number, number],
            opts: {
                fov?: number
                padding?: number
                lookShift?: [number, number, number]
                duration?: number
            } = {},
        ): CameraPose | null {
            if (box.isEmpty()) return null
            const centre = box.getCenter(new THREE.Vector3())
            const fov = opts.fov ?? 36
            // fitDistance reads camera.fov/aspect, so measure at the target fov
            const keepFov = camera.fov
            camera.fov = fov
            camera.updateProjectionMatrix()
            const d = new THREE.Vector3(...dir).normalize()
            const dist = THREE.MathUtils.clamp(fitDistance(box, d) * (opts.padding ?? 1.06), 1.6, 140)
            camera.fov = keepFov
            camera.updateProjectionMatrix()

            const target = centre.clone().add(new THREE.Vector3(...(opts.lookShift ?? [0, 0, 0])))
            const pose: CameraPose = { pos: centre.clone().addScaledVector(d, dist), target, fov }

            current = null
            // the box was measured once, so there is nothing live to follow
            ride = null
            followPoint = null
            followName = null
            beforeNavigate?.()
            const fromPos = camera.position.clone()
            const fromTarget = controls.target.clone()
            const fromFov = camera.fov
            const dur = opts.duration ?? 0.85
            const mine = ++nav
            tweening++
            void ticker
                .add(dur, (k) => {
                    if (mine !== nav) return
                    const e = easeInOutCubic(k)
                    camera.position.lerpVectors(fromPos, pose.pos, e)
                    controls.target.lerpVectors(fromTarget, pose.target, e)
                    camera.fov = fromFov + (pose.fov - fromFov) * e
                    camera.updateProjectionMatrix()
                    controls.update()
                })
                .then(() => tweening--)
            return pose
        },
        /** Is the camera sitting at an arbitrary pose (used for framed subjects)? */
        atPose(pose: CameraPose | null, tol = 0.45) {
            if (!pose) return false
            return (
                camera.position.distanceTo(pose.pos) < tol &&
                controls.target.distanceTo(pose.target) < tol
            )
        },
        /**
         * Where a box lands on screen, in normalised device coordinates plus a
         * coverage figure. This is what lets a test assert "the camera is on the
         * subject" from state alone: every corner inside the frustum and a
         * decent share of the frame, instead of eyeballing a screenshot.
         */
        projectBox(box: THREE.Box3) {
            if (box.isEmpty()) return null
            camera.updateMatrixWorld()
            let minX = 1
            let maxX = -1
            let minY = 1
            let maxY = -1
            let behind = false
            for (let i = 0; i < 8; i++) {
                const v = new THREE.Vector3(
                    i & 1 ? box.max.x : box.min.x,
                    i & 2 ? box.max.y : box.min.y,
                    i & 4 ? box.max.z : box.min.z,
                )
                const view = v.clone().applyMatrix4(camera.matrixWorldInverse)
                if (view.z > -0.05) behind = true
                const p = v.project(camera)
                minX = Math.min(minX, p.x)
                maxX = Math.max(maxX, p.x)
                minY = Math.min(minY, p.y)
                maxY = Math.max(maxY, p.y)
            }
            return {
                inside: !behind && minX > -1 && maxX < 1 && minY > -1 && maxY < 1,
                centre: [(minX + maxX) / 2, (minY + maxY) / 2] as [number, number],
                /** fraction of the frame's height the subject occupies */
                coverage: (maxY - minY) / 2,
            }
        },
        list: () => ALL_VIEWS.map(({ id, label, entity, hint }) => ({ id, label, entity, hint })),
        current: () => current,
        /** Live anchor vector for an entity, handy when writing new views. */
        anchor: (name: keyof typeof ANCHOR) => ANCHOR[name].clone(),
        /** Pose for a view without moving the camera. */
        pose: (id: string) => find(id)?.pose() ?? null,
        /** Frame an arbitrary world point. */
        lookAt: (p: THREE.Vector3, offset: [number, number, number] = [0, 3, 8], fov = 36) => {
            apply({ pos: p.clone().add(V(...offset)), target: p.clone(), fov })
        },
        /** Useful sanity check for tests: does the camera match the view? */
        isAt(id: string, tol = 0.4) {
            const view = find(id)
            if (!view) return false
            const pose = view.pose()
            return (
                camera.position.distanceTo(pose.pos) < tol &&
                controls.target.distanceTo(pose.target) < tol
            )
        },
        /** Grid helpers so new views can refer to the page lattice. */
        page: (col: number, row: number, y = 0.25) => L(pageX(col), y, pageZ(row)),
        grid: PAGE_GRID,
    }
}

export type CameraRig = ReturnType<typeof createCameraRig>
