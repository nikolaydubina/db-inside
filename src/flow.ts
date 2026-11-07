import * as THREE from 'three'
import { ANCHOR, PALETTE } from './instance'
import { Ticker, easeInOutCubic } from './util'

export interface Paths {
  sky: THREE.CatmullRomCurve3
  parse: THREE.CatmullRomCurve3
  plan: THREE.CatmullRomCurve3
  exec: THREE.CatmullRomCurve3
  execToWal: THREE.CatmullRomCurve3
  walToDisk: THREE.CatmullRomCurve3
  bufferToDisk: THREE.CatmullRomCurve3
  diskToBuffer: THREE.CatmullRomCurve3
  bufferToResult: THREE.CatmullRomCurve3
  resultToSky: THREE.CatmullRomCurve3
  heapToBuffer: THREE.CatmullRomCurve3
  indexToBuffer: THREE.CatmullRomCurve3
  ginToBuffer: THREE.CatmullRomCurve3
  bufferTop: THREE.Vector3
  diskTop: THREE.Vector3
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const curve = (pts: THREE.Vector3[], tension = 0.35) =>
  new THREE.CatmullRomCurve3(pts, false, 'catmullrom', tension)

export const pathCurve = (pts: THREE.Vector3[], tension = 0.35) => curve(pts, tension)

export function makePaths(): Paths {
  const bufferTop = V(ANCHOR.bufferCenter.x, 6.15, ANCHOR.bufferCenter.z)
  const diskTop = V(ANCHOR.disk.x, 1.15, ANCHOR.disk.z)

  return {
    bufferTop,
    diskTop,
    sky: curve([
      V(ANCHOR.sky.x - 1.4, 31, 1.4),
      V(ANCHOR.sky.x - 0.8, 24, 1.8),
      V(ANCHOR.sky.x - 0.2, 15, 0.8),
      V(ANCHOR.sky.x + 1.0, 9.6, -0.8),
      ANCHOR.parse,
    ]),
    parse: curve(
      [ANCHOR.parse, V(-7.8, 7.35, -2.1), V(-5.9, 7.45, -2.4), ANCHOR.plan],
      0.4,
    ),
    plan: curve(
      [ANCHOR.plan, V(-2.1, 7.45, -2.5), V(-0.4, 7.35, -2.5), ANCHOR.exec],
      0.4,
    ),
    exec: curve([ANCHOR.exec, V(1.2, 6.7, -1.6), V(0.4, 6.4, -0.7), bufferTop]),
    execToWal: curve([
      ANCHOR.exec,
      V(3.8, 6.7, -1.4),
      V(6.8, 6.1, 0.0),
      V(9.4, 5.4, 0.9),
      V(ANCHOR.wal.x, 4.85, ANCHOR.wal.z),
    ]),
    walToDisk: curve([
      V(ANCHOR.wal.x, 4.6, ANCHOR.wal.z),
      V(10.4, 3.4, 2.9),
      V(9.3, 2.2, 4.2),
      diskTop,
    ]),
    bufferToDisk: curve([
      V(ANCHOR.bufferCenter.x - 1.6, 5.1, ANCHOR.bufferCenter.z - 0.6),
      V(0.4, 3.9, 1.0),
      V(3.6, 2.6, 3.4),
      V(6.6, 1.5, 4.9),
      diskTop,
    ]),
    diskToBuffer: curve([
      diskTop,
      V(6.4, 1.8, 4.4),
      V(3.4, 3.4, 2.4),
      V(0.0, 4.8, 0.6),
      V(ANCHOR.bufferCenter.x - 0.8, 6.15, ANCHOR.bufferCenter.z - 0.4),
    ]),
    bufferToResult: curve([
      V(ANCHOR.bufferCenter.x + 2.2, 6.15, ANCHOR.bufferCenter.z + 0.9),
      V(4.4, 6.35, 0.7),
      V(6.9, 6.55, -0.5),
      ANCHOR.result,
    ]),
    resultToSky: curve([
      ANCHOR.result,
      V(9.2, 10.0, -1.4),
      V(9.8, 17.0, -1.0),
      V(ANCHOR.resultSky.x - 0.4, 25.5, 0.2),
    ]),
    heapToBuffer: curve([
      V(ANCHOR.heap.x + 1.0, 1.1, ANCHOR.heap.z - 1.2),
      V(-6.2, 2.8, 2.4),
      V(-3.8, 4.4, 1.2),
      V(ANCHOR.bufferCenter.x - 2.6, 5.9, ANCHOR.bufferCenter.z - 0.2),
    ]),
    indexToBuffer: curve([
      V(ANCHOR.index.x, 3.2, ANCHOR.index.z),
      V(5.2, 4.4, -4.4),
      V(2.4, 5.3, -2.2),
      V(ANCHOR.bufferCenter.x + 1.2, 6.0, ANCHOR.bufferCenter.z - 0.6),
    ]),
    ginToBuffer: curve([
      V(ANCHOR.gin.x, 2.1, ANCHOR.gin.z),
      V(8.6, 3.6, -2.4),
      V(5.0, 5.1, -1.2),
      V(ANCHOR.bufferCenter.x + 1.6, 6.0, ANCHOR.bufferCenter.z - 0.2),
    ]),
  }
}

export interface FlowOptions {
  arrows?: number
  speed?: number
  opacity?: number
  size?: number
}

/** A thin glowing curve with travelling arrowheads. */
export class FlowLine {
  readonly curve: THREE.CatmullRomCurve3
  readonly group = new THREE.Group()
  private cones: THREE.Mesh[] = []
  private lineMat: THREE.LineBasicMaterial
  private arrowMat: THREE.MeshBasicMaterial
  private speed: number
  private weight: number
  private boost = 0
  private t = Math.random()
  private baseOpacity: number
  private baseScale: number
  private fade = 1

  constructor(points: THREE.Vector3[], color: number, opts: FlowOptions = {}) {
    this.curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.35)
    const count = opts.arrows ?? 4
    this.speed = opts.speed ?? 0.16
    this.baseOpacity = opts.opacity ?? 0.3
    this.weight = 1
    this.baseScale = opts.size ?? 1

    const pts = this.curve.getPoints(110)
    const geo = new THREE.BufferGeometry().setFromPoints(pts)
    this.lineMat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: this.baseOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    this.group.add(new THREE.Line(geo, this.lineMat))

    const size = 0.075 * this.baseScale
    const coneGeo = new THREE.ConeGeometry(size, size * 3.1, 5)
    this.arrowMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(coneGeo, this.arrowMat)
      this.cones.push(m)
      this.group.add(m)
    }
  }

  flash(strength = 1) {
    this.boost = Math.max(this.boost, strength)
  }

  setVisible(v: boolean) {
    this.group.visible = v
  }

  update(dt: number) {
    this.boost = Math.max(0, this.boost - dt * 1.35)
    const b = this.boost
    this.t = (this.t + dt * this.speed * (1 + b * 1.8)) % 1
    const n = this.cones.length
    const up = new THREE.Vector3(0, 1, 0)
    for (let i = 0; i < n; i++) {
      const u = (this.t + i / n) % 1
      const p = this.curve.getPointAt(u)
      const tan = this.curve.getTangentAt(u).normalize()
      const m = this.cones[i]
      m.position.copy(p)
      m.quaternion.setFromUnitVectors(up, tan)
      const s = 1 + b * 0.85
      m.scale.set(s, s, s)
    }
    this.lineMat.opacity = (this.baseOpacity * this.weight + b * 0.45) * this.fade
    this.arrowMat.opacity = Math.min(1, 0.55 * this.weight + b * 0.5) * this.fade
  }

  setFade(v: number) {
    this.fade = v
  }

  dispose() {
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
    })
    this.lineMat.dispose()
    this.arrowMat.dispose()
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
}

export function makeFlows(scene: THREE.Scene, paths: Paths): FlowSet {
  const add = (points: THREE.Vector3[], color: number, opts?: FlowOptions) => {
    const f = new FlowLine(points, color, opts)
    scene.add(f.group)
    return f
  }

  const execToWal = add(paths.execToWal.getPoints(28), PALETTE.amber, {
    arrows: 3,
    speed: 0.4,
    opacity: 0.26,
  })
  const heapToBuffer = add(paths.heapToBuffer.getPoints(24), PALETTE.teal, {
    arrows: 2,
    speed: 0.3,
    opacity: 0.12,
  })
  const indexToBuffer = add(paths.indexToBuffer.getPoints(24), PALETTE.violet, {
    arrows: 2,
    speed: 0.3,
    opacity: 0.12,
  })
  const ginToBuffer = add(paths.ginToBuffer.getPoints(24), PALETTE.magenta, {
    arrows: 2,
    speed: 0.28,
    opacity: 0.12,
  })

  const all = [execToWal, heapToBuffer, indexToBuffer, ginToBuffer]

  return {
    execToWal,
    heapToBuffer,
    indexToBuffer,
    ginToBuffer,
    all,
  }
}

/**
 * The transient path of a single query: sky → connection port → parser → …
 * → result → the same port → sky. It draws itself segment by segment and
 * fades out once the query finishes.
 */
export class QueryChain {
  readonly group = new THREE.Group()
  private flows: FlowLine[] = []
  disposed = false

  constructor(private scene: THREE.Scene) {
    scene.add(this.group)
  }

  add(points: THREE.Vector3[], color: number, opts: FlowOptions = {}) {
    const f = new FlowLine(points, color, {
      arrows: 4,
      speed: 0.55,
      opacity: 0.42,
      size: 1.25,
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
    this.scene.remove(this.group)
  }
}
