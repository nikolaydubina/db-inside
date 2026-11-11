import * as THREE from 'three'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { registerLineMaterial } from './util'

const UNIT_BOX_EDGE_POINTS: number[] = (() => {
    const v: number[] = []
    const c = [-0.5, 0.5]
    for (const y of c) for (const z of c) v.push(-0.5, y, z, 0.5, y, z)
    for (const x of c) for (const z of c) v.push(x, -0.5, z, x, 0.5, z)
    for (const x of c) for (const y of c) v.push(x, y, -0.5, x, y, 0.5)
    return v
})()

const boxEdgePoints = (w: number, h: number, d: number) => {
    const v: number[] = []
    const xs = [-w / 2, w / 2]
    const ys = [-h / 2, h / 2]
    const zs = [-d / 2, d / 2]
    for (const y of ys) for (const z of zs) v.push(xs[0], y, z, xs[1], y, z)
    for (const x of xs) for (const z of zs) v.push(x, ys[0], z, x, ys[1], z)
    for (const x of xs) for (const y of ys) v.push(x, y, zs[0], x, y, zs[1])
    return v
}

const UNIT_BOX_PICK_GEO = (() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(UNIT_BOX_EDGE_POINTS, 3))
    return g
})()

export class OutlineBox extends THREE.Group {
    private glowMat: LineMaterial
    private baseColor: number
    private baseOpacity: number
    private glow!: LineSegments2
    private picker!: THREE.LineSegments
    w: number
    h: number
    d: number
    readonly dashed: boolean

    constructor(
        w: number,
        h: number,
        d: number,
        color: number,
        opacity = 0.7,
        opts: { dashed?: boolean } = {},
    ) {
        super()
        this.w = w
        this.h = h
        this.d = d
        this.baseColor = color
        this.baseOpacity = opacity
        this.dashed = opts.dashed ?? false

        const glowWidth = this.dashed ? 0.45 : 0.7

        this.glowMat = registerLineMaterial(
            new LineMaterial({
                color,
                linewidth: glowWidth,
                transparent: true,
                opacity,
                blending: THREE.AdditiveBlending,
                depthWrite: false,

                fog: true,
                worldUnits: false,
                dashed: this.dashed,
                dashSize: 0.22,
                gapSize: 0.2,
                dashScale: 1,
            }),
            glowWidth,
        )
        const glow = new LineSegments2(
            new LineSegmentsGeometry().setPositions(
                this.dashed ? boxEdgePoints(w, h, d) : UNIT_BOX_EDGE_POINTS,
            ),
            this.glowMat,
        )
        glow.frustumCulled = false
        if (!this.dashed) glow.scale.set(w, h, d)
        else glow.computeLineDistances()
        this.glow = glow
        this.add(glow)

        const pick = new THREE.LineSegments(
            UNIT_BOX_PICK_GEO,
            new THREE.LineBasicMaterial({ visible: false }),
        )
        pick.name = 'pick'

        pick.scale.set(w, h, d)
        this.picker = pick
        this.add(pick)
    }

    resize(w: number, h: number, d: number) {
        this.w = w
        this.h = h
        this.d = d
        this.glow.scale.set(w, h, d)
        this.picker.scale.set(w, h, d)
        return this
    }

    centre(x: number, y: number, z: number) {
        this.position.set(x, y, z)
        return this
    }

    fromFloor(x: number, y: number, z: number) {
        this.position.set(x, y + this.h / 2, z)
        return this
    }

    setColor(color: number) {
        this.baseColor = color
        this.glowMat.color.setHex(color)
        return this
    }

    highlight(on: boolean, color = 0xffffff) {
        const m = this.glowMat
        m.color.setHex(on ? color : this.baseColor)
        m.opacity = on ? Math.min(1, this.baseOpacity + 0.5) : this.baseOpacity
        return this
    }
}
