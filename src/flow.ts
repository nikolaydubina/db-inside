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
} from './instance'
import { registerLineMaterial, releaseLineMaterial } from './util'
import { Ticker, easeInOutCubic } from './util'

export interface Paths {
  sky: THREE.CatmullRomCurve3
  parse: THREE.CatmullRomCurve3
  plan: THREE.CatmullRomCurve3
  exec: THREE.CatmullRomCurve3
  execToWal: THREE.CatmullRomCurve3
  bufferToResult: THREE.CatmullRomCurve3
  heapToBuffer: THREE.CatmullRomCurve3
  indexToBuffer: THREE.CatmullRomCurve3
  ginToBuffer: THREE.CatmullRomCurve3
  bufferTop: THREE.Vector3
  diskTop: THREE.Vector3
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

/**
 * Centripetal Catmull-Rom instead of the uniform variant: no cusps, no loops,
 * and the curve hugs the control polygon instead of ballooning away from it.
 * The path is exactly the curve through the control points — no extra samples
 * are displaced, so what you see is the trajectory, not a decoration of it.
 */
const curve = (pts: THREE.Vector3[]) =>
  new THREE.CatmullRomCurve3(pts, false, 'centripetal')

export const pathCurve = (pts: THREE.Vector3[]) => curve(pts)

export function makePaths(): Paths {
  // both anchors sit on a real block's top face, not in the air above it
  const bufferTop = V(bufferSlotX(6), BUFFER_TOP_Y, bufferSlotZ(3))
  const diskTop = V(ANCHOR.disk.x, PAGE_TOP_Y, ANCHOR.disk.z)

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
    parse: curve([ANCHOR.parse, V(-7.8, 7.35, -2.1), V(-5.9, 7.45, -2.4), ANCHOR.plan]),
    plan: curve([ANCHOR.plan, V(-2.1, 7.45, -2.5), V(-0.4, 7.35, -2.5), ANCHOR.exec]),
    exec: curve([ANCHOR.exec, V(1.2, 6.7, -1.6), V(0.4, 6.4, -0.7), bufferTop]),
    execToWal: curve([
      ANCHOR.exec,
      V(3.8, 6.7, -1.4),
      V(6.8, 6.1, 0.0),
      V(9.4, 5.4, 0.9),
      V(ANCHOR.wal.x, PAGE_TOP_Y, ANCHOR.wal.z),
    ]),
    bufferToResult: curve([
      V(ANCHOR.bufferCenter.x + 2.2, BUFFER_TOP_Y + 0.05, ANCHOR.bufferCenter.z + 0.9),
      V(4.4, 6.35, 0.7),
      V(6.9, 6.55, -0.5),
      ANCHOR.result,
    ]),
    heapToBuffer: curve([
      V(ANCHOR.heap.x + 1.0, PAGE_TOP_Y + 0.3, ANCHOR.heap.z - 1.2),
      V(-6.2, 2.8, 2.4),
      V(-3.8, 4.4, 1.2),
      V(ANCHOR.bufferCenter.x - 2.6, BUFFER_TOP_Y + 0.05, ANCHOR.bufferCenter.z - 0.2),
    ]),
    indexToBuffer: curve([
      V(ANCHOR.index.x, 3.2, ANCHOR.index.z),
      V(5.2, 4.4, -4.4),
      V(2.4, 5.3, -2.2),
      V(ANCHOR.bufferCenter.x + 1.2, BUFFER_TOP_Y + 0.05, ANCHOR.bufferCenter.z - 0.6),
    ]),
    ginToBuffer: curve([
      V(ANCHOR.gin.x, 2.1, ANCHOR.gin.z),
      V(8.6, 3.6, -2.4),
      V(5.0, 5.1, -1.2),
      V(ANCHOR.bufferCenter.x + 1.6, BUFFER_TOP_Y + 0.05, ANCHOR.bufferCenter.z - 0.2),
    ]),
  }
}

export interface FlowOptions {
  speed?: number
  opacity?: number
  /** Stroke width in screen pixels. */
  width?: number
}

/** A glowing curve whose brightness runs along the path. */
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
  /** Guide points, arc-length spaced (index ↔ u). */
  private basePts: THREE.Vector3[] = []
  private static readonly SEGS = 110

  constructor(points: THREE.Vector3[], color: number, opts: FlowOptions = {}) {
    this.curve = curve(points)
    this.speed = opts.speed ?? 0.16
    this.baseOpacity = opts.opacity ?? 0.3
    this.weight = 1

    // same hairline as the outline boxes, so paths and cages weigh the same
    const width = opts.width ?? 0.7
    this.lineMat = new LineMaterial({
      color,
      linewidth: width,
      transparent: true,
      opacity: this.baseOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // screen-space width: a fat line stays solid even when it is far away
      worldUnits: false,
      dashed: false,
    })
    registerLineMaterial(this.lineMat, width)
    const line = new Line2(this.lineGeo, this.lineMat)
    line.frustumCulled = false
    this.group.add(line)
    this.rebuildGuide()
  }

  /**
   * Cache the guide polyline. Arc-length spaced, so a sample index and the
   * march parameter `u` mean the same thing.
   */
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
  }

  /**
   * Re-aim the flow at a new set of points — used when the thing it points at
   * moves (the WAL head advances as the log fills). Same point count, so the
   * geometry is rewritten in place instead of rebuilt.
   */
  repoint(points: THREE.Vector3[]) {
    this.curve = curve(points)
    this.rebuildGuide()
  }

  setVisible(v: boolean) {
    this.group.visible = v
  }

  update(dt: number) {
    this.boost = Math.max(0, this.boost - dt * 1.35)
    const b = this.boost
    this.t = (this.t + dt * this.speed * (1 + b * 1.8)) % 1
    this.lineMat.opacity = (this.baseOpacity * this.weight + b * 0.45) * this.fade
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
}

export function makeFlows(scene: THREE.Scene, paths: Paths): FlowSet {
  const add = (points: THREE.Vector3[], color: number, opts?: FlowOptions) => {
    const f = new FlowLine(points, color, opts)
    scene.add(f.group)
    return f
  }

  const execToWal = add(paths.execToWal.getPoints(28), PALETTE.amber, {
    speed: 0.4,
    opacity: 0.26,
  })
  const heapToBuffer = add(paths.heapToBuffer.getPoints(24), PALETTE.teal, {
    speed: 0.3,
    opacity: 0.12,
  })
  const indexToBuffer = add(paths.indexToBuffer.getPoints(24), PALETTE.violet, {
    speed: 0.3,
    opacity: 0.12,
  })
  const ginToBuffer = add(paths.ginToBuffer.getPoints(24), PALETTE.magenta, {
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
    this.scene.remove(this.group)
  }
}
