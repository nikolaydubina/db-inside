import * as THREE from 'three'
import {
    WORLD_ANCHOR as ANCHOR,
    BACKEND_ORIGIN,
    BACKEND_SLOTS,
    PAGE_GRID,
    POSTGRES_ORIGIN,
    PROCESS,
    pageX,
    pageZ,
} from './postgresql/instance'
import { REDIS_ANCHOR, REDIS_ORIGIN } from './redis/redis'
import type { Ticker } from './core/util'
import { easeInOutCubic } from './core/util'

export interface CameraPose {
    pos: THREE.Vector3
    target: THREE.Vector3
    fov: number
}

export interface ViewDef {
    id: string
    label: string

    slug?: string

    entity: string
    hint: string

    db?: 'postgres' | 'redis' | 'both'

    whole?: boolean

    unlisted?: boolean
    pose(): CameraPose
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

const L = (x: number, y: number, z: number) => V(x, y, z).add(POSTGRES_ORIGIN)

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

        unlisted: true,
        entity: 'the floor',
        hint: 'both databases on the same floor, each in its own cage',

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
        id: 'redis-dict',
        label: 'dict',
        db: 'redis',
        entity: 'the keyspace dict',
        hint: 'the bucket array: a key hashes into one slot, and a slot is a pointer to a page',

        pose: () => shot(REDIS_ANCHOR.dict, [-2.8, 6.4, 21.4], 34, [0, -0.6, 0]),
    },

    {
        id: 'redis-disk',
        label: 'disk',
        db: 'redis',
        entity: 'persistence',
        hint: 'only two files are here: the incremental AOF and the base RDB',
        pose: () => shot(REDIS_ORIGIN.clone().add(V(0, 0, 3.25)), [-5.6, 10.6, 15.6], 38),
    },
    {
        id: 'redis-aof',
        label: 'aof',
        db: 'redis',
        entity: 'aof tail',
        hint: 'the end of the log: the block being appended, and the bytes still in aof_buf above it',

        pose: () => shot(REDIS_ANCHOR.aofBuf, [-5.4, 5.4, 7.7], 36, [0, -1.2, 0]),
    },
    {
        id: 'redis-loop',
        label: 'command loop',
        slug: 'loop',
        db: 'redis',
        entity: 'the command loop',
        hint: 'one thread: the queue draining into it, epoll feeding it, every command passing through it',

        pose: () => shot(REDIS_ANCHOR.loop, [-4.93, 5.96, 5.11], 34),
    },
    {
        id: 'redis-pubsub',
        label: 'channel',
        slug: 'channel',
        db: 'redis',
        entity: 'the channel',
        hint: 'the command loop and the sockets listening to it: a publish touches no key and no file',

        pose: () => shot(REDIS_ANCHOR.loop, [11.78, 4.62, -2.72], 37, [0.6, 1.35, 2.4]),
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

        pose: () => shot(ANCHOR.walBuf, [-4.3, 4.3, 6.1], 34, [0, -0.85, 0]),
    },
    {
        id: 'buffers',
        label: 'buffers',
        entity: 'shared buffers',
        hint: 'the RAM deck: page tiles, dirty pages, buffer hits',

        pose: () => shot(ANCHOR.bufferCenter, [0.8, 9.2, 5.8], 36),
    },
    {
        id: 'pipeline',
        label: 'pipeline',
        entity: 'process pipelines',
        hint: 'one dashed lane per live backend: parser → planner → executor, running in parallel',
        pose: () => shot(V(0, PROCESS.y, (PROCESS.zParse + PROCESS.zExec) / 2), [4.5, 4.2, 13], 38),
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

        pose: () =>
            shot(L(0, BACKEND_ORIGIN.y - 0.9, BACKEND_ORIGIN.z), [0, 6.4, 20.5], 36, [0, -1.3, 0]),
    },
    {
        id: 'pages',
        label: 'pages',
        entity: 'page blocks',
        hint: 'down at block level: individual 8 KiB pages of a table run',
        pose: () => shot(L(pageX(24), 0.25, pageZ(14)), [1.6, 1.1, 2.4], 30, [0, 0.1, 0]),
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

export const backendView = (i: number): ViewDef => {
    const x = BACKEND_SLOTS[i] ?? 0
    const mid = L(x, BACKEND_ORIGIN.y - 1.15, BACKEND_ORIGIN.z)
    return {
        id: `backend-${i}`,

        slug: `backend-${i + 1}`,
        label: `backend ${i + 1}`,
        entity: `backend ${i + 1}`,
        hint: 'one connection close up: port, input buffer, what it is running',

        pose: () => shot(mid, [0, 4.0, 16.3], 20, [0, -0.97, 0]),
    }
}

export const ALL_VIEWS = [
    ...VIEWS,
    ...(['users', 'products', 'metrics'] as const).map(tableView),
    ...BACKEND_SLOTS.map((_, i) => backendView(i)),
]

export const viewsFor = (db: 'postgres' | 'redis') =>
    ALL_VIEWS.filter((v) => !v.unlisted && (v.db === 'both' || (v.db ?? 'postgres') === db))

export function slugOf(v: ViewDef): string {
    if (v.slug !== undefined) return v.slug
    if (v.id === 'postgres' || v.id === 'redis') return ''
    return v.db === 'redis' ? v.id.replace(/^redis-/, '') : v.id
}

export function defaultView(db: 'postgres' | 'redis'): ViewDef {
    const v = ALL_VIEWS.find((x) => x.id === db)
    if (!v) throw new Error(`[views] no default shot for ${db}`)
    return v
}

export function viewBySlug(db: 'postgres' | 'redis', slug: string): ViewDef | null {
    if (!slug) return defaultView(db)
    return viewsFor(db).find((v) => slugOf(v) === slug) ?? null
}

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
    beforeNavigate?: () => void
}

export function createCameraRig({ camera, controls, ticker, beforeNavigate }: RigOptions) {
    let current: string | null = null
    let nav = 0

    let followPoint: (() => THREE.Vector3) | null = null
    let followName: string | null = null
    let tweening = 0
    const FOLLOW_RATE = 3.2
    const followDelta = new THREE.Vector3()
    let ride: {
        target: THREE.Object3D
        dir: THREE.Vector3
        dist: number
        base: number
        near: number
    } | null = null
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
        return hi * 1.06
    }

    function focus(
        target: THREE.Object3D | THREE.Box3,
        opts: { duration?: number; padding?: number } = {},
    ): Promise<boolean> {
        const box =
            target instanceof THREE.Box3 ? target.clone() : new THREE.Box3().setFromObject(target)
        if (box.isEmpty()) return Promise.resolve(false)
        const centre = box.getCenter(new THREE.Vector3())

        const dir = camera.position.clone().sub(controls.target)
        if (dir.lengthSq() < 1e-6) dir.set(0, 0.35, 1)
        dir.normalize()

        const dist = THREE.MathUtils.clamp(fitDistance(box, dir) * (opts.padding ?? 1), 1.6, 55)
        const toPos = centre.clone().addScaledVector(dir, dist)
        const fromPos = camera.position.clone()
        const fromTarget = controls.target.clone()

        current = null
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

    function go(id: string, opts: { instant?: boolean; duration?: number } = {}): boolean {
        const view = find(id)
        if (!view) {
            console.warn(
                `[views] unknown view "${id}"`,
                ALL_VIEWS.map((v) => v.id),
            )
            return false
        }
        const pose = view.pose()
        current = id
        beforeNavigate?.()
        ride = null

        followPoint = () => view.pose().target
        followName = id

        if (opts.instant) {
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
        pan(delta: THREE.Vector3) {
            camera.position.add(delta)
            controls.target.add(delta)
            controls.update()
        },
        follow(dt: number) {
            if (ride) {
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
        settled() {
            if (!ride) return false
            ride.target.getWorldPosition(rideAt)
            rideWant.copy(rideAt).addScaledVector(ride.dir, ride.dist)
            const tol = Math.max(0.4, ride.dist * 0.12)
            return (
                camera.position.distanceTo(rideWant) < tol &&
                controls.target.distanceTo(rideAt) < tol
            )
        },
        following: () => followName,
        holdDepth(depth: number) {
            if (!ride) return
            const want = ride.base + (ride.near - ride.base) * THREE.MathUtils.clamp(depth, 0, 1)
            ride.dist = Math.max(0.06, want)
        },
        turn(angle: number) {
            const dx = camera.position.x - controls.target.x
            const dz = camera.position.z - controls.target.z
            const c = Math.cos(angle)
            const s = Math.sin(angle)
            camera.position.x = controls.target.x + dx * c - dz * s
            camera.position.z = controls.target.z + dx * s + dz * c
        },
        release() {
            ride = null
            if (!followPoint && !followName) return
            followPoint = null
            followName = null
        },
        hold(
            target: THREE.Object3D | null,
            shot?: { dir: [number, number, number]; dist: number; near?: number; fov?: number },
        ) {
            if (!target || !shot) {
                ride = null
                followPoint = null
                followName = null
                return
            }
            nav++
            tweening = 0
            followPoint = null
            ride = {
                target,
                dir: new THREE.Vector3(...shot.dir).normalize(),
                dist: Math.max(0.06, shot.dist),
                base: Math.max(0.06, shot.dist),
                near: Math.max(0.06, shot.near ?? shot.dist),
            }
            followName = 'riding'
            if (shot.fov !== undefined && Math.abs(camera.fov - shot.fov) > 0.01) {
                camera.fov = shot.fov
                camera.updateProjectionMatrix()
            }
        },
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
            const keepFov = camera.fov
            camera.fov = fov
            camera.updateProjectionMatrix()
            const d = new THREE.Vector3(...dir).normalize()
            const dist = THREE.MathUtils.clamp(
                fitDistance(box, d) * (opts.padding ?? 1.06),
                1.6,
                140,
            )
            camera.fov = keepFov
            camera.updateProjectionMatrix()

            const target = centre.clone().add(new THREE.Vector3(...(opts.lookShift ?? [0, 0, 0])))
            const pose: CameraPose = { pos: centre.clone().addScaledVector(d, dist), target, fov }

            current = null
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
        atPose(pose: CameraPose | null, tol = 0.45) {
            if (!pose) return false
            return (
                camera.position.distanceTo(pose.pos) < tol &&
                controls.target.distanceTo(pose.target) < tol
            )
        },
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
                coverage: (maxY - minY) / 2,
            }
        },
        list: () => ALL_VIEWS.map(({ id, label, entity, hint }) => ({ id, label, entity, hint })),
        current: () => current,
        anchor: (name: keyof typeof ANCHOR) => ANCHOR[name].clone(),
        pose: (id: string) => find(id)?.pose() ?? null,
        lookAt: (p: THREE.Vector3, offset: [number, number, number] = [0, 3, 8], fov = 36) => {
            apply({ pos: p.clone().add(V(...offset)), target: p.clone(), fov })
        },
        isAt(id: string, tol = 0.4) {
            const view = find(id)
            if (!view) return false
            const pose = view.pose()
            return (
                camera.position.distanceTo(pose.pos) < tol &&
                controls.target.distanceTo(pose.target) < tol
            )
        },
        page: (col: number, row: number, y = 0.25) => L(pageX(col), y, pageZ(row)),
        grid: PAGE_GRID,
    }
}

export type CameraRig = ReturnType<typeof createCameraRig>
