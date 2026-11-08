import * as THREE from 'three'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { registerLineMaterial } from './util'

/**
 * 12 edges of a unit cube centred on the origin, stored as separate segments:
 * [x1,y1,z1, x2,y2,z2, …] for each edge. No faces, no triangles.
 */
const UNIT_BOX_EDGE_POINTS: number[] = (() => {
  const v: number[] = []
  const c = [-0.5, 0.5]
  for (const y of c) for (const z of c) v.push(-0.5, y, z, 0.5, y, z) // along x
  for (const x of c) for (const z of c) v.push(x, -0.5, z, x, 0.5, z) // along y
  for (const x of c) for (const y of c) v.push(x, y, -0.5, x, y, 0.5) // along z
  return v
})()

/**
 * The same 12 edges at a real size, for outlines that are dashed.
 *
 * A dash is a distance along the geometry. Scaling a unit box non-uniformly
 * scales the distances with it, so the same dash setting comes out long on the
 * long side and short on the short side — which reads as "the pattern is
 * different on every edge". Building the edges at their actual size puts every
 * dash in world units, and then one dash size is one dash size everywhere.
 */
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

/** Plain 1 px line geometry — used only as an invisible picking proxy. */
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

    // Dashes are measured along the geometry, which is a unit box that gets
    // scaled — so the dash length is divided by the largest side to keep it the
    // same size in the world no matter how big the box is.
    // A hairline: 0.7 CSS px lands on 1.4 device px at DPR 2, which is the
    // thinnest a screen-space quad can go before it starts breaking into dots.
    // Dashed outlines go thinner still: a broken line already carries more
    // visual weight than a continuous one of the same width, and at 0.7 px the
    // dashes read as beads.
    const glowWidth = this.dashed ? 0.45 : 0.7
    // Dash and gap are world units, and stayed constant across every outline:
    // the pattern is a property of the notation, not of the box it is wrapped
    // around.
    this.glowMat = registerLineMaterial(
      new LineMaterial({
        color,
        linewidth: glowWidth,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
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
    // scale the picker itself, not its parent: three divides the raycast
    // threshold by the object's own scale, and a unit-scaled line inside a
    // scaled group would get a pick radius 20x too fat
    pick.scale.set(w, h, d)
    this.picker = pick
    this.add(pick)
  }

  /**
   * Regrow the box in place. Same box, new bounds — used by anything that marks
   * a file whose length is a property of the data rather than a constant.
   */
  resize(w: number, h: number, d: number) {
    this.w = w
    this.h = h
    this.d = d
    this.glow.scale.set(w, h, d)
    this.picker.scale.set(w, h, d)
    return this
  }

  /** Place by centre point. */
  centre(x: number, y: number, z: number) {
    this.position.set(x, y, z)
    return this
  }

  /** Place by floor corner plus size — reads like a box statement. */
  fromFloor(x: number, y: number, z: number) {
    this.position.set(x, y + this.h / 2, z)
    return this
  }

  setColor(color: number) {
    this.baseColor = color
    this.glowMat.color.setHex(color)
    return this
  }

  /**
   * Hover / selection state of an outline is the outline itself changing colour.
   * Never a second box drawn around the same volume.
   */
  highlight(on: boolean, color = 0xffffff) {
    const m = this.glowMat
    m.color.setHex(on ? color : this.baseColor)
    m.opacity = on ? Math.min(1, this.baseOpacity + 0.5) : this.baseOpacity
    return this
  }
}
