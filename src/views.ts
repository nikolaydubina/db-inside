import * as THREE from 'three'
import { ANCHOR, BACKEND_ORIGIN, BACKEND_SLOTS, PAGE_GRID, pageX, pageZ } from './instance'
import type { Ticker } from './util'
import { easeInOutCubic } from './util'

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
    /** Scene entity this shot is about. */
    entity: string
    hint: string
    pose(): CameraPose
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

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

export const VIEWS: ViewDef[] = [
    {
        id: 'overview',
        label: 'overview',
        entity: 'instance',
        hint: 'the whole instance: disk plate, RAM deck, pipeline',
        pose: () => shot(V(0, 0, 0), [29.2, 19, 34.5], 40, [3.4, 6.6, 1.0]),
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
        entity: 'parser → executor',
        hint: 'parse → plan → execute orbs and the query path between them',
        pose: () => shot(V(0.2, 6.8, -2.2), [0.5, 4.5, 12], 36),
    },
    {
        id: 'indexes',
        label: 'indexes',
        entity: 'index structures',
        hint: 'b-tree, BRIN, GIN and hash floating as they sit in RAM',
        pose: () => shot(V(5.0, 2.4, -2.6), [7.5, 5.0, 12.5], 36),
    },
    {
        id: 'free',
        label: 'free space',
        entity: 'unallocated tail',
        hint: 'the empty tail of the disk: slot lattice, no pages',
        pose: () => shot(V(pageX(4), 0, pageZ(8)), [-6.0, 5.5, 11.0], 34),
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
                V(0, BACKEND_ORIGIN.y - 0.9, BACKEND_ORIGIN.z),
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
            shot(V(pageX(24), 0.25, pageZ(7)), [1.6, 1.1, 2.4], 30, [0, 0.1, 0]),
    },
]

export const tableView = (name: keyof typeof TABLE_ANCHOR): ViewDef => ({
    id: `table-${name}`,
    label: `table: ${name}`,
    entity: `table:${name}`,
    hint: `close-up of the ${name} page run`,
    pose: () => shot(TABLE_ANCHOR[name], [3.0, 4.2, 7.0], 32, [0, 0.2, 0]),
})

/**
 * One connection on its own: the port, the input-buffer shaft under it, and
 * nothing else of the pool in frame. This is what the story's buffer steps look
 * at, because "the buffer" is a per-backend thing and a wide shot of six ports
 * does not show any one of them.
 */
export const backendView = (i: number): ViewDef => {
    const x = BACKEND_SLOTS[i] ?? 0
    // aim a little below the middle of port + shaft so the subject sits above
    // centre, clear of the caption panel along the bottom
    const mid = V(x, BACKEND_ORIGIN.y - 1.15, BACKEND_ORIGIN.z)
    return {
        id: `backend-${i}`,
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

    const apply = (pose: CameraPose) => {
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
        beforeNavigate?.()

        const dur = opts.duration ?? 0.95
        const mine = ++nav
        return ticker
            .add(dur, (k) => {
                if (mine !== nav) return
                const e = easeInOutCubic(k)
                camera.position.lerpVectors(fromPos, toPos, e)
                controls.target.lerpVectors(fromTarget, centre, e)
                controls.update()
            })
            .then(() => true)
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
        void ticker.add(dur, (k) => {
            if (mine !== nav) return
            const e = easeInOutCubic(k)
            camera.position.lerpVectors(fromPos, pose.pos, e)
            controls.target.lerpVectors(fromTarget, pose.target, e)
            camera.fov = fromFov + (pose.fov - fromFov) * e
            camera.updateProjectionMatrix()
            controls.update()
        })
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
            beforeNavigate?.()
            const fromPos = camera.position.clone()
            const fromTarget = controls.target.clone()
            const fromFov = camera.fov
            const dur = opts.duration ?? 0.85
            const mine = ++nav
            void ticker.add(dur, (k) => {
                if (mine !== nav) return
                const e = easeInOutCubic(k)
                camera.position.lerpVectors(fromPos, pose.pos, e)
                controls.target.lerpVectors(fromTarget, pose.target, e)
                camera.fov = fromFov + (pose.fov - fromFov) * e
                camera.updateProjectionMatrix()
                controls.update()
            })
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
        page: (col: number, row: number, y = 0.25) => V(pageX(col), y, pageZ(row)),
        grid: PAGE_GRID,
    }
}

export type CameraRig = ReturnType<typeof createCameraRig>
