import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { PALETTE } from '../postgresql/instance'
import type { Info } from '../postgresql/instance'
import { OutlineBox, breathe, label, radialTexture, setLabelEnabled } from '../core/util'
import { KEY, KIND_COLOR, HEAP_PAGE } from './layout'

export type BigKind = 'hash' | 'zset' | 'list'

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

    private mats: Partial<Record<BigKind, THREE.MeshStandardMaterial>> = {}

    private warm: Partial<Record<BigKind, THREE.MeshStandardMaterial>> = {}
    private hot: Partial<Record<BigKind, THREE.MeshStandardMaterial>> = {}

    private steps: Partial<Record<BigKind, THREE.Mesh[][]>> = {}

    private step: Record<BigKind, number> = { hash: -1, zset: -1, list: -1 }
    private pulse: Record<BigKind, number> = { hash: 0, zset: 0, list: 0 }
    private halos: THREE.Sprite[] = []

    constructor(host: Host) {
        this.host = host
    }

    build(keys: Iterable<{ big?: BigKind; i: number }>, hotKeys: Array<{ home: THREE.Vector3 }>) {
        for (const key of keys) {
            if (key.big) this.host.bigKeys[key.big] = key
        }

        this.wrapBig('hash', () => this.buildBigHash())
        this.wrapBig('zset', () => this.buildBigZset())
        this.wrapBig('list', () => this.buildBigList())

        this.buildTiers()

        for (const kind of ['hash', 'zset', 'list'] as const) this.ride(kind, null)
        this.buildHotHalos(hotKeys)
    }

    get hotHalos(): THREE.Sprite[] {
        return this.halos
    }

    update(dt: number, time: number, hot: Array<{ live: boolean }>) {
        for (const kind of ['hash', 'zset', 'list'] as BigKind[]) {
            this.pulse[kind] = Math.max(0, this.pulse[kind] - dt * 2.2)
            const mat = this.mats[kind]
            if (!mat) continue
            mat.emissiveIntensity =
                0.42 + 0.1 * breathe(time, 1.4, kind.length) + this.pulse[kind] * 2.2
        }

        for (const kind of ['hash', 'zset', 'list'] as BigKind[]) {
            const hotMat = this.hot[kind]
            if (hotMat) hotMat.emissiveIntensity = 2.0 + 0.9 * breathe(time, 5.5, kind.length)
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

    ride(kind: BigKind, packet: THREE.Object3D | null) {
        const g = this.groups[kind]
        if (!g) return
        if (!packet) {
            this.host.group.add(g)
            g.position.copy(BIG_SPOT[kind])
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
        centre.sub(BIG_SPOT[kind])
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

    carryInto(
        g: THREE.Object3D,
        size: THREE.Vector3 | null,
        centre: THREE.Vector3,
        packet: THREE.Object3D,
        scale: number,
    ) {
        this.carry(g, size, centre, packet, scale)
    }

    box(kind: BigKind): THREE.Box3 {
        return (this.areas[kind] ?? new THREE.Box3()).clone()
    }

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

    private bucketFor(kind: BigKind, buckets: number): number {
        const i = this.host.bigKeys[kind]?.i ?? 0
        return Math.abs((i * 2654435761) % buckets)
    }

    stepOf(kind: BigKind): { step: number; steps: number } {
        return { step: this.step[kind], steps: this.steps[kind]?.length ?? 0 }
    }

    touched(kind: BigKind) {
        this.pulse[kind] = 1
    }

    private frameOf(kind: BigKind, w: number, h: number, d: number, cy: number) {
        const at = BIG_SPOT[kind]
        const centre = new THREE.Vector3(at.x, at.y + cy, at.z)
        const size = new THREE.Vector3(w, h, d)
        const { pick, box } = this.host.frame(centre, size, KIND_COLOR[kind], {
            dashed: true,
            opacity: 0.2,
        })

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

    private buildBigHash() {
        const at = BIG_SPOT.hash
        const mat = this.material('hash')
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
        this.steps.hash = steps
        this.frameOf('hash', cols * pitch + 0.5, 1.6, rows * pitch + 1.2, 0.34)
    }

    private buildBigZset() {
        const at = BIG_SPOT.zset
        const mat = this.material('zset')
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
        this.steps.zset = steps
        const dictGeo = new RoundedBoxGeometry(0.2, 0.06, 0.2, 1, 0.01)
        for (let c = 0; c < 6; c++) {
            const tile = new THREE.Mesh(dictGeo, mat)
            tile.position.set(at.x - 0.75 + c * 0.3, at.y - 0.55, at.z + 0.95)
            this.host.group.add(tile)
        }
        this.frameOf('zset', 5.0, 2.7, 2.5, 0.5)
    }

    private buildBigList() {
        const at = BIG_SPOT.list
        const mat = this.material('list')
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
        this.steps.list = steps
        this.frameOf('list', 7.4, 1.4, 1.9, 0.1)
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
