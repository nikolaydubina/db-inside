import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { PALETTE } from '../postgresql/instance'
import type { Info } from '../postgresql/instance'
import { OutlineBox, breathe, label, radialTexture, setLabelEnabled } from '../core/util'
import { KEY, HEAP_PAGE } from './layout'

export const enum RedisReadOp {
    Point = 1,
    Walk = 2,
    Object = 3,
}

export const enum RedisBigKind {
    Hash = 1,
    ZSet = 2,
    List = 3,
}

export const REDIS_BIG_KIND_NAME: Record<RedisBigKind, string> = {
    [RedisBigKind.Hash]: 'hash',
    [RedisBigKind.ZSet]: 'zset',
    [RedisBigKind.List]: 'list',
}

export const REDIS_BIG_COLOR: Record<RedisBigKind, number> = {
    [RedisBigKind.Hash]: PALETTE.violet,
    [RedisBigKind.ZSet]: PALETTE.ice,
    [RedisBigKind.List]: PALETTE.teal,
}

export const REDIS_BIG_SPOT: Record<RedisBigKind, THREE.Vector3> = {
    [RedisBigKind.Hash]: new THREE.Vector3(-8.6, 3.4, -6.2),
    [RedisBigKind.ZSet]: new THREE.Vector3(0, 3.4, -6.2),
    [RedisBigKind.List]: new THREE.Vector3(8.6, 3.4, -6.2),
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
    readonly bigKeys: Partial<Record<RedisBigKind, { i: number }>>
}

export class BigValues {
    private readonly host: Host
    private groups: Partial<Record<RedisBigKind, THREE.Group>> = {}
    private labels: Partial<Record<RedisBigKind, THREE.Object3D>> = {}
    private areas: Partial<Record<RedisBigKind, THREE.Box3>> = {}

    private mats: Partial<Record<RedisBigKind, THREE.MeshStandardMaterial>> = {}

    private warm: Partial<Record<RedisBigKind, THREE.MeshStandardMaterial>> = {}
    private hot: Partial<Record<RedisBigKind, THREE.MeshStandardMaterial>> = {}

    private steps: Partial<Record<RedisBigKind, THREE.Mesh[][]>> = {}

    private step: Record<RedisBigKind, number> = {
        [RedisBigKind.Hash]: -1,
        [RedisBigKind.ZSet]: -1,
        [RedisBigKind.List]: -1,
    }
    private pulse: Record<RedisBigKind, number> = {
        [RedisBigKind.Hash]: 0,
        [RedisBigKind.ZSet]: 0,
        [RedisBigKind.List]: 0,
    }
    private halos: THREE.Sprite[] = []

    constructor(host: Host) {
        this.host = host
    }

    build(
        keys: Iterable<{ big?: RedisBigKind; i: number }>,
        hotKeys: Array<{ home: THREE.Vector3 }>,
    ) {
        for (const key of keys) {
            if (key.big) this.host.bigKeys[key.big] = key
        }

        this.wrapBig(RedisBigKind.Hash, () => this.buildBigHash())
        this.wrapBig(RedisBigKind.ZSet, () => this.buildBigZset())
        this.wrapBig(RedisBigKind.List, () => this.buildBigList())

        this.buildTiers()

        for (const kind of [RedisBigKind.Hash, RedisBigKind.ZSet, RedisBigKind.List])
            this.ride(kind, null)
        this.buildHotHalos(hotKeys)
    }

    get hotHalos(): THREE.Sprite[] {
        return this.halos
    }

    update(dt: number, time: number, hot: Array<{ live: boolean }>) {
        for (const kind of [RedisBigKind.Hash, RedisBigKind.ZSet, RedisBigKind.List]) {
            this.pulse[kind] = Math.max(0, this.pulse[kind] - dt * 2.2)
            const mat = this.mats[kind]
            if (!mat) continue
            mat.emissiveIntensity = 0.42 + 0.1 * breathe(time, 1.4, kind) + this.pulse[kind] * 2.2
        }

        for (const kind of [RedisBigKind.Hash, RedisBigKind.ZSet, RedisBigKind.List]) {
            const hotMat = this.hot[kind]
            if (hotMat) hotMat.emissiveIntensity = 2.0 + 0.9 * breathe(time, 5.5, kind)
            const warm = this.warm[kind]
            if (warm) warm.emissiveIntensity = 0.95 + 0.12 * this.pulse[kind]
        }

        this.halos.forEach((s, i) => {
            const key = hot[i]
            const on = !!key && key.live
            s.visible = on
            if (on) s.material.opacity = 0.16 + 0.12 * breathe(time, 1.6, i)
        })
    }

    private wrapBig(kind: RedisBigKind, build: () => void) {
        const group = this.host.group
        const before = new Set(group.children)
        build()
        const g = new THREE.Group()
        g.position.copy(REDIS_BIG_SPOT[kind])
        group.add(g)
        for (const child of [...group.children]) {
            if (child === g || before.has(child)) continue
            g.attach(child)
        }
        this.groups[kind] = g
    }

    ride(kind: RedisBigKind, packet: THREE.Object3D | null) {
        const g = this.groups[kind]
        if (!g) return
        if (!packet) {
            this.host.group.add(g)
            g.position.copy(REDIS_BIG_SPOT[kind])
            g.scale.setScalar(1)
            g.visible = false

            this.setStep(kind, -1)
            const lab = this.labels[kind]
            if (lab) setLabelEnabled(lab as CSS2DObject, false)
            return
        }
        g.visible = true

        const lab = this.labels[kind]
        if (lab) setLabelEnabled(lab as CSS2DObject, false)
        const area = this.areas[kind]
        const size = area?.getSize(new THREE.Vector3()) ?? null

        const centre = area?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3()
        centre.sub(REDIS_BIG_SPOT[kind])
        const longest = size ? Math.max(size.x, size.y, size.z) : 2
        this.carry(g, size, centre, packet, 2 / (longest || 1))
    }

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

        const MARKER_HALF = HEAP_PAGE / 2
        const GAP = 0.1
        const lift = MARKER_HALF + GAP + (size ? (size.y / 2) * scale : 0)
        g.position.set(-centre.x * scale, lift - centre.y * scale, -centre.z * scale)
    }

    private material(kind: RedisBigKind): THREE.MeshStandardMaterial {
        const mat = new THREE.MeshStandardMaterial({
            color: 0x0d0a16,
            emissive: REDIS_BIG_COLOR[kind],
            emissiveIntensity: 0.42,
            roughness: 0.4,
            metalness: 0.35,
        })
        this.mats[kind] = mat
        return mat
    }

    carryInto(
        g: THREE.Object3D,
        size: THREE.Vector3 | null,
        centre: THREE.Vector3,
        packet: THREE.Object3D,
        scale: number,
    ) {
        this.carry(g, size, centre, packet, scale)
    }

    box(kind: RedisBigKind): THREE.Box3 {
        return (this.areas[kind] ?? new THREE.Box3()).clone()
    }

    private buildTiers() {
        for (const kind of [RedisBigKind.Hash, RedisBigKind.ZSet, RedisBigKind.List]) {
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

    setStep(kind: RedisBigKind, n: number, of?: number) {
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

    private bucketFor(kind: RedisBigKind, buckets: number): number {
        const i = this.host.bigKeys[kind]?.i ?? 0
        return Math.abs((i * 2654435761) % buckets)
    }

    stepOf(kind: RedisBigKind): { step: number; steps: number } {
        return { step: this.step[kind], steps: this.steps[kind]?.length ?? 0 }
    }

    touched(kind: RedisBigKind) {
        this.pulse[kind] = 1
    }

    private frameOf(kind: RedisBigKind, w: number, h: number, d: number, cy: number) {
        const at = REDIS_BIG_SPOT[kind]
        const centre = new THREE.Vector3(at.x, at.y + cy, at.z)
        const size = new THREE.Vector3(w, h, d)
        const { pick, box } = this.host.frame(centre, size, REDIS_BIG_COLOR[kind], {
            dashed: true,
            opacity: 0.2,
        })

        this.areas[kind] = box
        const key = this.host.bigKeys[kind]
        if (key) {
            pick.userData.infoFor = () => this.host.keyInfo(key.i)
            this.host.addPick(pick)
        }
        const lab = label(`${REDIS_BIG_KIND_NAME[kind].toUpperCase()} · 1 KEY`)
        lab.position.set(at.x - w / 2 - 0.45, at.y + cy + h / 2 + 0.3, at.z - d / 2 - 0.1)
        this.host.group.add(lab)
        this.labels[kind] = lab
    }

    private buildBigHash() {
        const at = REDIS_BIG_SPOT[RedisBigKind.Hash]
        const mat = this.material(RedisBigKind.Hash)
        const cols = 9
        const rows = 3
        const pitch = 0.36
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
        this.steps[RedisBigKind.Hash] = steps
        this.frameOf(RedisBigKind.Hash, cols * pitch + 0.5, 1.6, rows * pitch + 1.2, 0.34)
    }

    private buildBigZset() {
        const at = REDIS_BIG_SPOT[RedisBigKind.ZSet]
        const mat = this.material(RedisBigKind.ZSet)
        const pitch = 0.42
        const heights = [5, 1, 2, 1, 4, 1, 3, 1, 2, 1, 5]
        const cols = heights.length
        const levels = 5
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
                    const link = new THREE.Mesh(
                        new THREE.BoxGeometry(x - prev - 0.14, 0.02, 0.02),
                        mat,
                    )
                    link.position.set((prev + x) / 2, y, at.z)
                    this.host.group.add(link)
                    steps[c].push(link)
                }
                prev = x
            }
        }
        this.steps[RedisBigKind.ZSet] = steps
        const dictGeo = new RoundedBoxGeometry(0.2, 0.06, 0.2, 1, 0.01)
        for (let c = 0; c < 6; c++) {
            const tile = new THREE.Mesh(dictGeo, mat)
            tile.position.set(at.x - 0.75 + c * 0.3, at.y - 0.55, at.z + 0.95)
            this.host.group.add(tile)
        }
        this.frameOf(RedisBigKind.ZSet, 5.0, 2.7, 2.5, 0.5)
    }

    private buildBigList() {
        const at = REDIS_BIG_SPOT[RedisBigKind.List]
        const mat = this.material(RedisBigKind.List)
        const nodes = 5
        const steps: THREE.Mesh[][] = Array.from({ length: nodes }, () => [])
        const nodeGeo = new RoundedBoxGeometry(0.72, 0.22, 0.34, 1, 0.02)
        const sliceGeo = new THREE.BoxGeometry(0.19, 0.23, 0.35)
        let x = at.x - 2.3
        for (let n = 0; n < nodes; n++) {
            const node = new THREE.Mesh(nodeGeo, mat)
            node.position.set(x, at.y, at.z)
            this.host.group.add(node)
            steps[n].push(node)
            for (let k = -1; k <= 1; k++) {
                const slice = new THREE.Mesh(sliceGeo, mat)
                slice.position.set(x + k * 0.21, at.y, at.z)
                this.host.group.add(slice)
                steps[n].push(slice)
            }
            if (n < nodes - 1) {
                const skip = n === 2 ? 1.5 : 0
                const link = new THREE.Mesh(new THREE.BoxGeometry(0.34 + skip, 0.03, 0.03), mat)
                link.position.set(x + 0.53 + skip / 2, at.y, at.z)
                this.host.group.add(link)
                steps[n + 1].push(link)
                x += 1.02 + skip
            }
        }
        this.steps[RedisBigKind.List] = steps
        this.frameOf(RedisBigKind.List, 7.4, 1.4, 1.9, 0.1)
    }

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
