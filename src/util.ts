import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
export const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
export const easeInCubic = (t: number) => t * t * t
export const easeOutBack = (t: number) => {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}
export const easeInQuad = (t: number) => t * t

export const rand = (a: number, b: number) => a + Math.random() * (b - a)
export const randInt = (a: number, b: number) => Math.floor(rand(a, b + 1))
export const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Soft radial sprite texture, generated once. */
let radialTex: THREE.Texture | null = null
export function radialTexture(): THREE.Texture {
  if (radialTex) return radialTex
  const s = 128
  const c = document.createElement('canvas')
  c.width = c.height = s
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.18, 'rgba(255,255,255,0.75)')
  g.addColorStop(0.45, 'rgba(255,255,255,0.18)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, s, s)
  radialTex = new THREE.CanvasTexture(c)
  radialTex.colorSpace = THREE.SRGBColorSpace
  return radialTex
}

/** Additive halo sprite used for glows and packet auras. */
export function halo(color: number, scale: number, opacity = 0.55): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: radialTexture(),
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const s = new THREE.Sprite(mat)
  s.scale.setScalar(scale)
  return s
}

/** Thin additive outline of a geometry. */
export function neonEdges(geo: THREE.BufferGeometry, color: number, opacity = 0.6) {
  const eg = new THREE.EdgesGeometry(geo, 24)
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  return new THREE.LineSegments(eg, mat)
}

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

/** Plain 1 px line geometry — used only as an invisible picking proxy. */
const UNIT_BOX_PICK_GEO = (() => {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(UNIT_BOX_EDGE_POINTS, 3))
  return g
})()

/* ----------------------------- fat line support ---------------------------- */

/**
 * Fat lines (Line2 / LineSegments2) are rasterised as screen-space quads, which
 * is the fix for a 1 px GL line breaking into dashes at grazing angles.
 *
 * `LineMaterial.linewidth` is measured against `resolution`, so the two have to
 * agree. If resolution is the CSS size while the drawing buffer is CSS × DPR,
 * every line comes out DPR times too thin — at DPR 2 that is sub-pixel, and a
 * sub-pixel quad rasterises as a dotted line. So we work in device pixels:
 * resolution is the drawing buffer, and linewidth is scaled to match. Ask for a
 * width in CSS pixels and you get that width on screen at any pixel ratio.
 */
interface FatLine {
  mat: LineMaterial
  /** Width in CSS pixels, as authored. */
  cssWidth: number
}

const lineMaterials: FatLine[] = []
let lineDpr = 1

function applyLineSize(entry: FatLine) {
  entry.mat.resolution.set(window.innerWidth * lineDpr, window.innerHeight * lineDpr)
  entry.mat.linewidth = entry.cssWidth * lineDpr
}

export function registerLineMaterial(m: LineMaterial, cssWidth: number) {
  const entry = { mat: m, cssWidth }
  lineMaterials.push(entry)
  applyLineSize(entry)
  return m
}

export function releaseLineMaterial(m: LineMaterial) {
  const i = lineMaterials.findIndex((e) => e.mat === m)
  if (i >= 0) lineMaterials.splice(i, 1)
  m.dispose()
}

/** Call on resize — otherwise fat lines render at the wrong width. */
export function setLineResolution(_w: number, _h: number, dpr = 1) {
  lineDpr = dpr
  for (const entry of lineMaterials) applyLineSize(entry)
}

/**
 * A box drawn as nothing but its 12 edges — no faces, no thickness, no width.
 * One primitive for every volume we want to point at: the process cage, the
 * disk plates, the table selection marquees. Colour + bounds is the whole API,
 * so anything that outlines something outlines it the same way.
 *
 * The visible edges are fat lines, so an outline stays solid at any angle. An
 * invisible 1 px twin rides along with them purely for picking, because the
 * world-space pick radius we want cannot be expressed by a screen-space line.
 */
export class OutlineBox extends THREE.Group {
  private glowMat: LineMaterial
  private baseColor: number
  private baseOpacity: number
  readonly w: number
  readonly h: number
  readonly d: number

  constructor(w: number, h: number, d: number, color: number, opacity = 0.7) {
    super()
    this.w = w
    this.h = h
    this.d = d
    this.baseColor = color
    this.baseOpacity = opacity

    // A hairline: 0.9 CSS px is thin enough to read as an outline, and still
    // lands on 1.8 device px at DPR 2, so it does not break into dots.
    const glowWidth = 0.9
    this.glowMat = registerLineMaterial(
      new LineMaterial({
        color,
        linewidth: glowWidth,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        worldUnits: false,
      }),
      glowWidth,
    )
    const glow = new LineSegments2(
      new LineSegmentsGeometry().setPositions(UNIT_BOX_EDGE_POINTS),
      this.glowMat,
    )
    glow.frustumCulled = false
    glow.scale.set(w, h, d)
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
    this.add(pick)
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

/** Small camera-facing text tag. */
export function label(text: string, className = 'tag'): CSS2DObject {
  const el = document.createElement('div')
  el.className = className
  el.textContent = text
  const obj = new CSS2DObject(el)
  obj.center.set(0, 0.5)
  return obj
}

/** Promise-based tween clock driven by the render loop. */
export class Ticker {
  private items: {
    t: number
    dur: number
    update: (k: number) => void
    done: () => void
  }[] = []

  add(dur: number, update: (k: number) => void): Promise<void> {
    return new Promise<void>((resolve) => {
      this.items.push({ t: 0, dur: Math.max(0.0001, dur), update, done: resolve })
    })
  }

  /** Wait `dur` seconds. */
  wait(dur: number): Promise<void> {
    return this.add(dur, () => { })
  }

  update(dt: number) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]
      it.t += dt
      const k = clamp01(it.t / it.dur)
      it.update(k)
      if (k >= 1) {
        this.items.splice(i, 1)
        it.done()
      }
    }
  }
}

/** Moves an object along a curve as a tween. */
export function travel(
  ticker: Ticker,
  obj: THREE.Object3D,
  curve: THREE.Curve<THREE.Vector3>,
  dur: number,
  ease: (t: number) => number = easeInOutCubic,
): Promise<void> {
  return ticker.add(dur, (k) => {
    obj.position.copy(curve.getPointAt(ease(k)))
  })
}

/** Oscillating shimmer used for idle life. */
export const breathe = (t: number, speed = 1, phase = 0) =>
  0.5 + 0.5 * Math.sin(t * speed + phase)
