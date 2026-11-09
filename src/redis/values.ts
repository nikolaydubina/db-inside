import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { PALETTE } from '../postgresql/instance'
import type { Info } from '../postgresql/instance'
import { OutlineBox, breathe, label, radialTexture, setLabelEnabled } from '../core/util'
import { KEY, KIND_COLOR, HEAP_PAGE } from './layout'

/**
 * The three large values, and the mechanism that carries them.
 *
 * A big value is not an exhibit: it is what a read is HOLDING while it walks. So
 * nothing here is drawn until a read picks it up, and the carry is the same for all
 * three — parent to the packet's marker, size off the dashed cage, lift clear of the
 * marker — because "this read is holding a structure" has to look the same whatever
 * the structure is.
 *
 * The cursor is the second idea in this file: the cells the read has touched stay lit
 * and the one it is on pulses, so the animation is the algorithm's history rather than
 * decoration. It is per hop of a walk, and it is reported as numbers (`bigStepOf`) so a
 * story can assert on it.
 *
 * The instance owns the scene, the keys and the picking. This owns the structures, and
 * reaches back through `Host` for the four things it cannot do alone.
 */

export type BigKind = 'hash' | 'zset' | 'list'

/** Where a big value is BUILT. It is hidden at home; these are its coordinates. */
export const BIG_SPOT: Record<BigKind, THREE.Vector3> = {
    hash: new THREE.Vector3(-8.6, 3.4, -6.2),
    zset: new THREE.Vector3(0, 3.4, -6.2),
    list: new THREE.Vector3(8.6, 3.4, -6.2),
}

export interface Host {
    readonly group: THREE.Group
    frame(
        centre: THREE.Vector3,
        size: THREE.Vector3,
        colour: number,
        opts?: { dashed?: boolean; opacity?: number },
    ): { cage: OutlineBox; pick: THREE.Mesh; box: THREE.Box3 }
    addPick(pick: THREE.Mesh): void
    keyInfo(i: number): { info: Info } | null
    readonly bigKeys: Partial<Record<BigKind, { i: number }>>
}

export class BigValues {
    private readonly host: Host
    private groups: Partial<Record<BigKind, THREE.Group>> = {}
    private labels: Partial<Record<BigKind, THREE.Object3D>> = {}
    private areas: Partial<Record<BigKind, THREE.Box3>> = {}
    /** one material per big value, so a touch can light the whole structure */
    private mats: Partial<Record<BigKind, THREE.MeshStandardMaterial>> = {}
    /** the trail behind the read's cursor, and the cursor itself */
    private warm: Partial<Record<BigKind, THREE.MeshStandardMaterial>> = {}
    private hot: Partial<Record<BigKind, THREE.MeshStandardMaterial>> = {}
    /**
     * The cells of each structure, grouped into the STEPS a read takes through it.
     *
     * One step is one thing the algorithm touches: a bucket and its chain, one
     * quicklist node and the elements inside it, one skiplist node and the tower it
     * was promoted to. The read moves one step per hop, so the animation is not
     * decoration — it is the walk, drawn inside the thing being walked.
     */
    private steps: Partial<Record<BigKind, THREE.Mesh[][]>> = {}
    /** which step the carried read is on; -1 when nothing is being read */
    private step: Record<BigKind, number> = { hash: -1, zset: -1, list: -1 }
    private pulse: Record<BigKind, number> = { hash: 0, zset: 0, list: 0 }
    private halos: THREE.Sprite[] = []

    constructor(host: Host) {
        this.host = host
    }

    /** Build the three structures and the halos that mark the hot keys. */
    build(keys: Iterable<{ big?: BigKind; i: number }>, hotKeys: Array<{ home: THREE.Vector3 }>) {
        // which key IS each structure: its card, the bucket the cursor starts on, and
        // the anchor any view would frame all come from this mapping
        for (const key of keys) {
            if (key.big) this.host.bigKeys[key.big] = key
        }
        // built where it lives, then re-parented into a group of its own: the
        // builders place their pieces in cage coordinates, and `attach` keeps the
        // world transform while making the group their parent, so nothing has to be
        // re-derived by hand for the three of them
        this.wrapBig('hash', () => this.buildBigHash())
        this.wrapBig('zset', () => this.buildBigZset())
        this.wrapBig('list', () => this.buildBigList())
        // the cells are drawn; the two extra brightnesses they can be lit with come
        // after, from the base material each builder just made
        this.buildTiers()
        // built, then put away: a carried structure is not an exhibit
        for (const kind of ['hash', 'zset', 'list'] as const) this.ride(kind, null)
        this.buildHotHalos(hotKeys)
    }

    /** The sprites that mark the hot keys, so the instance can keep them in step. */
    get hotHalos(): THREE.Sprite[] {
        return this.halos
    }

    /** Per-frame upkeep: the structures breathe, the cursor moves, halos glow. */
    update(dt: number, time: number, hot: Array<{ live: boolean }>) {
        // a big value that was touched burns for a beat and settles back
        for (const kind of ['hash', 'zset', 'list'] as BigKind[]) {
            this.pulse[kind] = Math.max(0, this.pulse[kind] - dt * 2.2)
            const mat = this.mats[kind]
            if (!mat) continue
            mat.emissiveIntensity = 0.42 + 0.1 * breathe(time, 1.4, kind.length) + this.pulse[kind] * 2.2
        }

        // The read's cursor, moving through the structure in its hands.
        //
        // The cells it has left stay lit, so the trail is the algorithm's history —
        // which buckets a field lookup hashed past, how many nodes of a quicklist this
        // GET has already read. The cell it is ON pulses faster than the rest of the
        // structure, at a rate the eye reads as "working" rather than "settled". Driven
        // by real time, because a story stops the SIM clock for a caption and a cursor
        // frozen mid-pulse looks like the read has died.
        for (const kind of ['hash', 'zset', 'list'] as BigKind[]) {
            const hotMat = this.hot[kind]
            if (hotMat) hotMat.emissiveIntensity = 2.0 + 0.9 * breathe(time, 5.5, kind.length)
            const warm = this.warm[kind]
            if (warm) warm.emissiveIntensity = 0.95 + 0.12 * this.pulse[kind]
        }

        // hot keys glow softly, and stop glowing when they are gone
        this.halos.forEach((s, i) => {
            const key = hot[i]
            const on = !!key && key.live
            s.visible = on
            if (on) s.material.opacity = 0.16 + 0.12 * breathe(time, 1.6, i)
        })
    }

    /** Run one builder, then move what it made into a group of its own. */
    private wrapBig(kind: BigKind, build: () => void) {
        const group = this.host.group
        const before = new Set(group.children)
        build()
        const g = new THREE.Group()
        g.position.copy(BIG_SPOT[kind])
        group.add(g)
        for (const child of [...group.children]) {
            if (child === g || before.has(child)) continue
            g.attach(child)
        }
        this.groups[kind] = g
    }

    /**
     * Carry a structure with the read, or put it back.
     *
     * It becomes a child of the packet's MARKER, which is the whole mechanism: the
     * packet is the object the camera rides and the scene moves, so parenting is what
     * makes the cage follow through every leg and hand-off with no per-frame work.
     *
     * Home is HIDDEN, not a display. The three dashed cages used to stand at the back
     * as exhibits you could walk up to, which meant the same structure was drawn twice:
     * once on display and once in the read's hands. A big value is not an object that
     * sits somewhere — it is what a read is holding while it walks.
     */
    ride(kind: BigKind, packet: THREE.Object3D | null) {
        const g = this.groups[kind]
        if (!g) return
        if (!packet) {
            this.host.group.add(g)
            g.position.copy(BIG_SPOT[kind])
            g.scale.setScalar(1)
            g.visible = false
            // and the cursor is put back to rest with it: a lit trail on a structure
            // nobody is reading describes a walk that has already finished
            this.setStep(kind, -1)
            const lab = this.labels[kind]
            if (lab) setLabelEnabled(lab as CSS2DObject, false)
            return
        }
        g.visible = true
        // Through the LABEL system, not `visible`: updateLabelLOD recomputes every
        // tag's visibility each frame from `labelEnabled` and its distance, so a plain
        // `.visible = false` here is undone by the next frame and the label stays.
        const lab = this.labels[kind]
        if (lab) setLabelEnabled(lab as CSS2DObject, false)
        const area = this.areas[kind]
        const size = area?.getSize(new THREE.Vector3()) ?? null
        // the box is in cage coordinates; the group stands at BIG_SPOT, so what matters
        // for placement is the box centre relative to that
        const centre = area?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3()
        centre.sub(BIG_SPOT[kind])
        const longest = size ? Math.max(size.x, size.y, size.z) : 2
        this.carry(g, size, centre, packet, 2 / (longest || 1))
    }

    /**
     * Put a structure in the read's hands: sized, and lifted clear of the packet.
     *
     * Two units across at full size — about five marker-widths — so the read visibly
     * holds a structure and the page it lands in still fits inside the frame. All of
     * these numbers are in the marker's space, which is then scaled by the marker.
     */
    private carry(
        g: THREE.Object3D,
        size: THREE.Vector3 | null,
        centre: THREE.Vector3,
        packet: THREE.Object3D,
        scale: number,
    ) {
        const host = (packet.userData.marker as THREE.Object3D | undefined) ?? packet
        host.add(g)
        g.scale.setScalar(scale)
        // Padded clear of the marker, not centred on it.
        //
        // At the packet's own centre the structure's meshes and the marker occupy the
        // same space, and the read looks like it is reading through its cargo. The
        // structure is lifted so its bottom face sits a small gap above the marker, and
        // shifted so its own centre is over the marker horizontally: the packet reads
        // as being carried ON the structure rather than inside it.
        const MARKER_HALF = HEAP_PAGE / 2
        const GAP = 0.1
        const lift = MARKER_HALF + GAP + (size ? (size.y / 2) * scale : 0)
        g.position.set(-centre.x * scale, lift - centre.y * scale, -centre.z * scale)
    }

    private material(kind: BigKind): THREE.MeshStandardMaterial {
        const mat = new THREE.MeshStandardMaterial({
            color: 0x0d0a16,
            emissive: KIND_COLOR[kind],
            emissiveIntensity: 0.42,
            roughness: 0.4,
            metalness: 0.35,
        })
        this.mats[kind] = mat
        return mat
    }

    /**
     * Put a structure in the read's hands — the same carry, called by the value object.
     *
     * The object cage is not a big value, but it IS something a read holds, and one
     * mechanism for that is the point of this module: two implementations would drift.
     */
    carryInto(
        g: THREE.Object3D,
        size: THREE.Vector3 | null,
        centre: THREE.Vector3,
        packet: THREE.Object3D,
        scale: number,
    ) {
        this.carry(g, size, centre, packet, scale)
    }

    /** The volume one big value occupies, cage-local — its dashed cage, in a box. */
    box(kind: BigKind): THREE.Box3 {
        return (this.areas[kind] ?? new THREE.Box3()).clone()
    }

    /**
     * The three brightnesses a cell of a carried structure can be in.
     *
     * rest — not touched by this read: the structure's own slow breathing.
     * warm — the read has been here and moved on: it stays lit, so the cells behind the
     *        cursor are the algorithm's history, not a hint.
     * hot  — the cell the read is ON right now.
     *
     * Three materials per kind rather than one per cell. A cell's brightness is one of
     * three values and swapping materials is free, while ~110 private materials with
     * their own uniforms updated every frame is real cost on the one thread this whole
     * drawing is trying to say something about.
     */
    private buildTiers() {
        for (const kind of ['hash', 'zset', 'list'] as BigKind[]) {
            const base = this.mats[kind]
            if (!base) continue
            const warm = base.clone()
            warm.emissiveIntensity = 0.95
            const hot = base.clone()
            hot.emissiveIntensity = 2.4
            this.warm[kind] = warm
            this.hot[kind] = hot
        }
    }

    /**
     * Move the read's cursor through the structure it is holding.
     *
     * `n` is the hop the walk just landed on and `of` the last hop of that walk, so the
     * cursor is SPREAD over the drawn cells: a range scan of a nine-bucket array drawn
     * as nine columns reaches the last column on its last hop instead of crawling
     * through the first three. Called with no `of`, the read landed on a single bucket —
     * a field lookup — and the cursor goes to one column of its own, derived from the
     * key so it lands on the same bucket twice in a row and does not flicker between
     * reads that are meant to be identical.
     *
     * A negative `n` puts the structure back to rest: the cage is being put away, or the
     * ride is over, and a lit trail left behind would describe a read that has already
     * finished.
     */
    setStep(kind: BigKind, n: number, of?: number) {
        const steps = this.steps[kind]
        if (!steps || steps.length === 0) return
        const rest = this.mats[kind]
        if (n < 0) {
            this.step[kind] = -1
            for (const cells of steps) for (const cell of cells) if (rest) cell.material = rest
            return
        }
        const at =
            of === undefined
                ? this.bucketFor(kind, steps.length)
                : Math.min(steps.length - 1, Math.floor((n * steps.length) / (of + 1)))
        this.step[kind] = at
        const warm = this.warm[kind]
        const hot = this.hot[kind]
        steps.forEach((cells, i) => {
            const mat = i < at ? warm : i === at ? hot : rest
            if (!mat) return
            for (const cell of cells) cell.material = mat
        })
    }

    /** Which bucket a fixed key hashes to, stable across reads of it. */
    private bucketFor(kind: BigKind, buckets: number): number {
        const i = this.host.bigKeys[kind]?.i ?? 0
        return Math.abs((i * 2654435761) % buckets)
    }

    /**
     * Where the read's cursor is inside a carried structure, as numbers.
     *
     * The animation is a claim about the algorithm — this many buckets scanned, this
     * many nodes read — so it is readable the same way the phase and the gap are: from
     * outside, without looking at the picture.
     */
    stepOf(kind: BigKind): { step: number; steps: number } {
        return { step: this.step[kind], steps: this.steps[kind]?.length ?? 0 }
    }

    /**
     * One big value was touched. The whole structure lights at once, because that is
     * the honest picture: a command against a value like this walks all of it, on the
     * one thread, and every other client waits.
     */
    touched(kind: BigKind) {
        this.pulse[kind] = 1
    }

    /** The dashed cage, the pick box and the label for one big value. */
    private frameOf(kind: BigKind, w: number, h: number, d: number, cy: number) {
        const at = BIG_SPOT[kind]
        const centre = new THREE.Vector3(at.x, at.y + cy, at.z)
        const size = new THREE.Vector3(w, h, d)
        const { pick, box } = this.host.frame(centre, size, KIND_COLOR[kind], {
            dashed: true,
            opacity: 0.2,
        })
        // the camera frames exactly this volume, and the card reports it
        this.areas[kind] = box
        const key = this.host.bigKeys[kind]
        if (key) {
            pick.userData.infoFor = () => this.host.keyInfo(key.i)
            this.host.addPick(pick)
        }
        const lab = label(`${kind.toUpperCase()} · 1 KEY`)
        lab.position.set(at.x - w / 2 - 0.45, at.y + cy + h / 2 + 0.3, at.z - d / 2 - 0.1)
        this.host.group.add(lab)
        this.labels[kind] = lab
    }

    /** A hashtable: the bucket array, and the chains hanging off it. */
    private buildBigHash() {
        const at = BIG_SPOT.hash
        const mat = this.material('hash')
        const cols = 9
        const rows = 3
        const pitch = 0.36
        // One STEP per column: the three rows are the same bucket slot drawn with
        // depth, and the chain hangs off the back of it. A read that hashes a field
        // lands on one column and follows its chain; a range scan walks the columns left
        // to right. Both are the same step — "this bucket and everything in it".
        const steps: THREE.Mesh[][] = Array.from({ length: cols }, () => [])
        const bucketGeo = new RoundedBoxGeometry(0.24, 0.07, 0.24, 1, 0.01)
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const tile = new THREE.Mesh(bucketGeo, mat)
                tile.position.set(
                    at.x + (c - (cols - 1) / 2) * pitch,
                    at.y,
                    at.z + (r - (rows - 1) / 2) * pitch,
                )
                this.host.group.add(tile)
                steps[c].push(tile)
            }
        }
        // one entry per bucket, two in a few, none in others — the chains are the reason
        // the array stays small while the value grows
        const eGeo = new RoundedBoxGeometry(0.15, 0.15, 0.15, 1, 0.01)
        for (let c = 0; c < cols; c++) {
            const links = c % 4 === 1 ? 2 : c % 5 === 2 ? 0 : 1
            for (let k = 0; k < links; k++) {
                const e = new THREE.Mesh(eGeo, mat)
                e.position.set(
                    at.x + (c - (cols - 1) / 2) * pitch,
                    at.y + 0.28 + k * 0.17,
                    at.z + ((rows - 1) / 2) * pitch + 0.26,
                )
                this.host.group.add(e)
                steps[c].push(e)
            }
        }
        this.steps.hash = steps
        this.frameOf('hash', cols * pitch + 0.5, 1.6, rows * pitch + 1.2, 0.34)
    }

    /** A sorted set: a skiplist tower, and the dict beside it. */
    private buildBigZset() {
        const at = BIG_SPOT.zset
        const mat = this.material('zset')
        const pitch = 0.42
        // Heights per column, as a skiplist really builds them: every node is at the
        // bottom level, and each one is promoted a few levels with probability 1/4. The
        // result is what makes the picture mean something — a link two levels up skips
        // over whole runs of the list, which is the entire idea.
        const heights = [5, 1, 2, 1, 4, 1, 3, 1, 2, 1, 5]
        const cols = heights.length
        const levels = 5
        // One STEP per column: the node, its tower, and the links that arrive at it. A
        // skiplist scan is exactly that — step right along a level, and the tower is what
        // the node you stepped onto was promoted to.
        const steps: THREE.Mesh[][] = Array.from({ length: cols }, () => [])
        const nodeGeo = new RoundedBoxGeometry(0.17, 0.17, 0.17, 1, 0.01)
        for (let lv = 0; lv < levels; lv++) {
            const y = at.y + lv * 0.32
            let prev = NaN
            for (let c = 0; c < cols; c++) {
                if (heights[c] <= lv) continue
                const x = at.x + (c - (cols - 1) / 2) * pitch
                const node = new THREE.Mesh(nodeGeo, mat)
                node.position.set(x, y, at.z)
                this.host.group.add(node)
                steps[c].push(node)
                if (!Number.isNaN(prev) && x - prev > 0.1) {
                    const link = new THREE.Mesh(new THREE.BoxGeometry(x - prev - 0.14, 0.02, 0.02), mat)
                    link.position.set((prev + x) / 2, y, at.z)
                    this.host.group.add(link)
                    // the link belongs to the column it ARRIVES at: the trail then shows
                    // the ground already covered, not the ground ahead
                    steps[c].push(link)
                }
                prev = x
            }
        }
        this.steps.zset = steps
        // the other half of the value: a dict for "score of this member"
        const dictGeo = new RoundedBoxGeometry(0.2, 0.06, 0.2, 1, 0.01)
        for (let c = 0; c < 6; c++) {
            const tile = new THREE.Mesh(dictGeo, mat)
            tile.position.set(at.x - 0.75 + c * 0.3, at.y - 0.55, at.z + 0.95)
            this.host.group.add(tile)
        }
        this.frameOf('zset', 5.0, 2.7, 2.5, 0.5)
    }

    /** A long list: a chain of quicklist nodes, each a small listpack. */
    private buildBigList() {
        const at = BIG_SPOT.list
        const mat = this.material('list')
        const nodes = 5
        // One STEP per node: the node, the elements packed inside it, and the link that
        // got us here. Stepping a quicklist is reading one node's listpack and following
        // its "next" pointer, so the cursor is one node wide.
        const steps: THREE.Mesh[][] = Array.from({ length: nodes }, () => [])
        const nodeGeo = new RoundedBoxGeometry(0.72, 0.22, 0.34, 1, 0.02)
        const sliceGeo = new THREE.BoxGeometry(0.19, 0.23, 0.35)
        let x = at.x - 2.3
        for (let n = 0; n < nodes; n++) {
            const node = new THREE.Mesh(nodeGeo, mat)
            node.position.set(x, at.y, at.z)
            this.host.group.add(node)
            steps[n].push(node)
            // the listpack inside the node, drawn as the pack of elements it is
            for (let k = -1; k <= 1; k++) {
                const slice = new THREE.Mesh(sliceGeo, mat)
                slice.position.set(x + k * 0.21, at.y, at.z)
                this.host.group.add(slice)
                steps[n].push(slice)
            }
            if (n < nodes - 1) {
                // the third gap is drawn long: that is where the drawing stops and the
                // real chain runs on for tens of thousands more nodes
                const skip = n === 2 ? 1.5 : 0
                const link = new THREE.Mesh(new THREE.BoxGeometry(0.34 + skip, 0.03, 0.03), mat)
                link.position.set(x + 0.53 + skip / 2, at.y, at.z)
                this.host.group.add(link)
                // arriving at the NEXT node, like the skiplist's links
                steps[n + 1].push(link)
                x += 1.02 + skip
            }
        }
        this.steps.list = steps
        this.frameOf('list', 7.4, 1.4, 1.9, 0.1)
    }

    /**
     * Hot keys. Nothing about them is special in memory — that IS the point: a 200-byte
     * string can carry most of the traffic in a keyspace of millions, and every request
     * for it goes through the same one thread.
     */
    private buildHotHalos(hotKeys: Array<{ home: THREE.Vector3 }>) {
        for (const [i, key] of hotKeys.entries()) {
            const sprite = new THREE.Sprite(
                new THREE.SpriteMaterial({
                    map: radialTexture(),
                    color: PALETTE.ice,
                    transparent: true,
                    opacity: 0.26,
                    depthWrite: false,
                    blending: THREE.AdditiveBlending,
                }),
            )
            sprite.scale.setScalar(0.62)
            sprite.position.copy(key.home).add(new THREE.Vector3(0, KEY.h * 0.7, 0))
            sprite.userData.hot = i
            this.host.group.add(sprite)
            this.halos.push(sprite)
        }
    }
}
