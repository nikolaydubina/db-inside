import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'

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
 * 12 edges of a unit cube centred on the origin: two vertices per edge, 24 in
 * total. No faces, no triangles — just the skeleton of a box.
 */
const UNIT_BOX_EDGES = (() => {
  const v: number[] = []
  const c = [-0.5, 0.5]
  for (const y of c) for (const z of c) v.push(-0.5, y, z, 0.5, y, z) // along x
  for (const x of c) for (const z of c) v.push(x, -0.5, z, x, 0.5, z) // along y
  for (const x of c) for (const y of c) v.push(x, y, -0.5, x, y, 0.5) // along z
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3))
  return g
})()

/**
 * A box drawn as nothing but its 12 edges — no faces, no thickness, no width.
 * One primitive for every volume we want to point at: the process cage, the
 * disk plates, the table selection marquees. Colour + bounds is the whole API,
 * so anything that outlines something outlines it the same way.
 */
export class OutlineBox extends THREE.LineSegments {
  private baseColor: number
  private baseOpacity: number

  constructor(
    readonly w: number,
    readonly h: number,
    readonly d: number,
    color: number,
    opacity = 0.7,
  ) {
    super(
      UNIT_BOX_EDGES,
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    )
    this.baseColor = color
    this.baseOpacity = opacity
    this.scale.set(w, h, d)
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
    ;(this.material as THREE.LineBasicMaterial).color.setHex(color)
    return this
  }

  /**
   * Hover / selection state of an outline is the outline itself changing colour.
   * Never a second box drawn around the same volume.
   */
  highlight(on: boolean, color = 0xffffff) {
    const m = this.material as THREE.LineBasicMaterial
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
