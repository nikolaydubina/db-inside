import * as THREE from 'three'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import {
    ANCHOR,
    BUFFER_TOP_Y,
    PAGE_TOP_Y,
    PALETTE,
    bufferSlotX,
    bufferSlotZ,
} from '../postgresql/instance'
import { registerLineMaterial, releaseLineMaterial } from './util'
import { Ticker, easeInOutCubic } from './util'

export interface Paths {
    sky: THREE.CatmullRomCurve3
    parse: THREE.CatmullRomCurve3
    plan: THREE.CatmullRomCurve3
    exec: THREE.CatmullRomCurve3

    ambient: Record<AmbientName, LivePath>
    bufferTop: THREE.Vector3
    diskTop: THREE.Vector3
}

export type AmbientName = 'execToWal' | 'heapToBuffer' | 'indexToBuffer' | 'ginToBuffer'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

const curve = (pts: THREE.Vector3[]) => new THREE.CatmullRomCurve3(pts, false, 'centripetal')

export const pathCurve = (pts: THREE.Vector3[]) => curve(pts)

export type PathEnd =
    'parse' | 'plan' | 'exec' | 'walBuf' | 'walHead' | 'buffer' | 'heap' | 'index' | 'gin' | 'disk'

export interface PathHost {
    pathEnd(name: PathEnd): THREE.Vector3
}

export function bowPoints(
    a: THREE.Vector3,
    b: THREE.Vector3,
    opts: { bow?: number; lift?: number; centre?: THREE.Vector3 } = {},
): THREE.Vector3[] {
    const d = a.distanceTo(b)
    if (d < 1e-3) return [a.clone(), b.clone()]

    const mid = a.clone().add(b).multiplyScalar(0.5)
    const dir = b.clone().sub(a).normalize()

    const perp = new THREE.Vector3(-dir.z, 0, dir.x)
    if (perp.lengthSq() < 1e-4) perp.set(0, 0, 1)
    perp.normalize()

    if (opts.centre) {
        const out = mid.clone().sub(opts.centre).setY(0)
        if (out.lengthSq() > 1e-4 && perp.dot(out) < 0) perp.negate()
    }

    const amount = Math.min(opts.bow ?? d * 0.16, 2.4)
    const lift = opts.lift ?? Math.min(d * 0.1, 1.4)
    const ctrl = mid.addScaledVector(perp, amount).add(new THREE.Vector3(0, lift, 0))

    return [a.clone(), ctrl, b.clone()]
}

export class LivePath {
    private pts: THREE.Vector3[] = []
    private built: THREE.CatmullRomCurve3 | null = null

    version = 0

    constructor(private readonly resolvePts: () => THREE.Vector3[]) {}

    curve(): THREE.CatmullRomCurve3 {
        const pts = this.resolvePts()
        if (!this.built || LivePath.moved(this.pts, pts)) {
            this.pts = pts
            this.built = curve(pts)
            this.version++
        }
        return this.built
    }

    points(n: number) {
        return this.curve().getPoints(n)
    }

    private static moved(a: THREE.Vector3[], b: THREE.Vector3[]) {
        if (a.length !== b.length) return true
        for (let i = 0; i < a.length; i++) if (a[i].distanceToSquared(b[i]) > 1e-4) return true
        return false
    }
}

export function makePaths(host: PathHost): Paths {
    const bufferTop = V(bufferSlotX(6), BUFFER_TOP_Y, bufferSlotZ(3))
    const diskTop = V(ANCHOR.disk.x, PAGE_TOP_Y, ANCHOR.disk.z)

    const centre = V(0, 0, 0)
    const between = (from: PathEnd, to: PathEnd) =>
        new LivePath(() => bowPoints(host.pathEnd(from), host.pathEnd(to), { centre }))

    const ambient = {
        execToWal: between('exec', 'walBuf'),
        heapToBuffer: between('heap', 'buffer'),
        indexToBuffer: between('index', 'buffer'),
        ginToBuffer: between('gin', 'buffer'),
    }

    return {
        bufferTop,
        diskTop,
        ambient,
        sky: curve([
            V(ANCHOR.sky.x - 1.4, 31, 1.4),
            V(ANCHOR.sky.x - 0.8, 24, 1.8),
            V(ANCHOR.sky.x - 0.2, 15, 0.8),
            V(ANCHOR.sky.x + 1.0, 9.6, -0.8),
            ANCHOR.parse,
        ]),
        parse: curve([ANCHOR.parse, V(-7.8, 7.35, -2.1), V(-5.9, 7.45, -2.4), ANCHOR.plan]),
        plan: curve([ANCHOR.plan, V(-2.1, 7.45, -2.5), V(-0.4, 7.35, -2.5), ANCHOR.exec]),
        exec: curve([ANCHOR.exec, V(1.2, 6.7, -1.6), V(0.4, 6.4, -0.7), bufferTop]),
    }
}

export interface FlowOptions {
    speed?: number
    opacity?: number

    width?: number

    linger?: number
}

export class FlowLine {
    curve: THREE.CatmullRomCurve3
    readonly group = new THREE.Group()
    private lineMat: LineMaterial
    private lineGeo = new LineGeometry()
    private speed: number
    private weight: number
    private boost = 0
    private t = Math.random()
    private baseOpacity: number
    private fade = 1

    private readonly linger: number
    private since = Number.POSITIVE_INFINITY

    private basePts: THREE.Vector3[] = []

    private seen = -1
    private static readonly SEGS = 110

    constructor(points: THREE.Vector3[], color: number, opts: FlowOptions = {}) {
        this.curve = curve(points)
        this.speed = opts.speed ?? 0.16
        this.baseOpacity = opts.opacity ?? 0.3
        this.linger = opts.linger ?? Number.POSITIVE_INFINITY
        this.weight = 1

        const width = opts.width ?? 0.7
        this.lineMat = new LineMaterial({
            color,
            linewidth: width,
            transparent: true,
            opacity: this.baseOpacity,
            blending: THREE.AdditiveBlending,
            depthWrite: false,

            fog: true,

            worldUnits: false,
            dashed: false,
        })
        registerLineMaterial(this.lineMat, width)
        const line = new Line2(this.lineGeo, this.lineMat)
        line.frustumCulled = false
        this.group.add(line)
        this.rebuildGuide()
    }

    private rebuildGuide() {
        this.basePts = this.curve.getSpacedPoints(FlowLine.SEGS)
        const flat = new Float32Array(this.basePts.length * 3)
        for (let i = 0; i < this.basePts.length; i++) {
            this.basePts[i].toArray(flat, i * 3)
        }
        this.lineGeo.setPositions(flat)
    }

    flash(strength = 1) {
        this.boost = Math.max(this.boost, strength)

        this.since = 0
    }

    repoint(points: THREE.Vector3[]) {
        this.curve = curve(points)
        this.rebuildGuide()
    }

    setVisible(v: boolean) {
        this.group.visible = v
    }

    follow(path: LivePath) {
        const next = path.curve()
        if (path.version === this.seen) return
        this.seen = path.version
        this.curve = next
        this.rebuildGuide()
    }

    update(dt: number) {
        this.boost = Math.max(0, this.boost - dt * 1.35)
        const b = this.boost
        this.t = (this.t + dt * this.speed * (1 + b * 1.8)) % 1
        this.since += dt

        const presence = Number.isFinite(this.linger)
            ? Math.max(0, 1 - (this.since - 0.12) / this.linger)
            : 1
        this.lineMat.opacity = (this.baseOpacity * this.weight + b * 0.45) * this.fade * presence
    }

    setFade(v: number) {
        this.fade = v
    }

    dispose() {
        this.group.traverse((o) => {
            const mesh = o as THREE.Mesh
            if (mesh.geometry) mesh.geometry.dispose()
        })
        releaseLineMaterial(this.lineMat)
    }

    setWeight(w: number) {
        this.weight = w
    }
}

export interface FlowSet {
    execToWal: FlowLine
    heapToBuffer: FlowLine
    indexToBuffer: FlowLine
    ginToBuffer: FlowLine
    all: FlowLine[]

    live: [FlowLine, LivePath][]
}

export function makeFlows(parent: THREE.Object3D, paths: Paths): FlowSet {
    const add = (points: THREE.Vector3[], color: number, opts?: FlowOptions) => {
        const f = new FlowLine(points, color, opts)
        parent.add(f.group)
        return f
    }

    const execToWal = add(paths.ambient.execToWal.points(28), PALETTE.amber, {
        speed: 0.4,
        opacity: 0.26,
        linger: 1.1,
    })
    const heapToBuffer = add(paths.ambient.heapToBuffer.points(24), PALETTE.teal, {
        speed: 0.3,
        opacity: 0.12,
        linger: 0.7,
    })
    const indexToBuffer = add(paths.ambient.indexToBuffer.points(24), PALETTE.violet, {
        speed: 0.3,
        opacity: 0.12,
        linger: 0.7,
    })
    const ginToBuffer = add(paths.ambient.ginToBuffer.points(24), PALETTE.magenta, {
        speed: 0.28,
        opacity: 0.12,
        linger: 0.7,
    })

    const all = [execToWal, heapToBuffer, indexToBuffer, ginToBuffer]
    const live: [FlowLine, LivePath][] = [
        [execToWal, paths.ambient.execToWal],
        [heapToBuffer, paths.ambient.heapToBuffer],
        [indexToBuffer, paths.ambient.indexToBuffer],
        [ginToBuffer, paths.ambient.ginToBuffer],
    ]
    for (const [line, path] of live) line.follow(path)

    return {
        execToWal,
        heapToBuffer,
        indexToBuffer,
        ginToBuffer,
        all,
        live,
    }
}

export class QueryChain {
    readonly group = new THREE.Group()
    private flows: FlowLine[] = []
    disposed = false

    constructor(parent: THREE.Object3D) {
        parent.add(this.group)
    }

    add(points: THREE.Vector3[], color: number, opts: FlowOptions = {}) {
        const f = new FlowLine(points, color, {
            speed: 0.55,
            opacity: 0.42,
            width: 0.7,
            ...opts,
        })
        this.flows.push(f)
        this.group.add(f.group)
        return f
    }

    addCurve(curve: THREE.CatmullRomCurve3, color: number, opts: FlowOptions = {}) {
        return this.add(curve.getPoints(28), color, opts)
    }

    update(dt: number) {
        for (const f of this.flows) f.update(dt)
    }

    fadeOut(ticker: Ticker, dur = 1.1) {
        void ticker
            .add(dur, (k) => {
                const f = 1 - easeInOutCubic(k)
                for (const fl of this.flows) fl.setFade(f)
            })
            .then(() => this.dispose())
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        for (const f of this.flows) f.dispose()
        this.flows = []
        this.group.parent?.remove(this.group)
    }
}
