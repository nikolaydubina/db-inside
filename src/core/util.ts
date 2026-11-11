import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'

export { OutlineBox } from './cage'

export const FLOOR_Y = 0

export const BLOCK_LIFT = 0.02

export const PULSE_TIME = 0.45

export const PULSE_WHITEN = 0.15

export function pulseHex(base: number, up = PULSE_WHITEN) {
    return new THREE.Color(base).lerp(new THREE.Color(0xffffff), up).getHex()
}

export const PULSE_GAIN = 2.4

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

export function fmtBytes(n: number): string {
    if (n < 1024) return `${Math.round(n)} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
    return `${(n / (1024 * 1024)).toFixed(2)} MiB`
}
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
export const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

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

export const DUST = {
    count: 220,
    size: 0.13,
    opacity: 0.32,
    color: 0x8fe6ff,
    inset: { x: 1.2, y: 0.3, z: 0.8 },
}

export function dustField(w: number, h: number, d: number): THREE.Points {
    const { count, inset } = DUST
    const pos = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
        pos[i * 3] = rand(-w / 2 + inset.x, w / 2 - inset.x)
        pos[i * 3 + 1] = rand(inset.y, h - inset.y)
        pos[i * 3 + 2] = rand(-d / 2 + inset.z, d / 2 - inset.z)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const points = new THREE.Points(
        geo,
        new THREE.PointsMaterial({
            color: DUST.color,
            map: radialTexture(),
            alphaTest: 0.01,
            size: DUST.size,
            transparent: true,
            opacity: DUST.opacity,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            sizeAttenuation: true,
        }),
    )
    points.userData.dust = { bottom: inset.y, top: h - inset.y }
    return points
}

export function driftDust(points: THREE.Points, dt: number, time: number) {
    const { bottom, top } = points.userData.dust as { bottom: number; top: number }
    const attr = points.geometry.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < attr.count; i++) {
        let y = attr.getY(i) + dt * 1.15
        if (y > top) y = bottom
        attr.setY(i, y)
        attr.setX(i, attr.getX(i) + Math.sin(time * 1.7 + i * 0.9) * dt * 0.22)
        attr.setZ(i, attr.getZ(i) + Math.cos(time * 1.3 + i * 1.3) * dt * 0.18)
    }
    attr.needsUpdate = true
}

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

interface FatLine {
    mat: LineMaterial
    cssWidth: number
}

const lineMaterials: FatLine[] = []
let lineDpr = 1
let lineCssW = 1
let lineCssH = 1

function applyLineSize(entry: FatLine) {
    entry.mat.resolution.set(lineCssW * lineDpr, lineCssH * lineDpr)
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

export function setLineResolution(w: number, h: number, dpr = 1) {
    lineDpr = dpr
    lineCssW = w
    lineCssH = h
    for (const entry of lineMaterials) applyLineSize(entry)
}

export const linePixelRatio = () => lineDpr
export const lineBufferWidth = () => lineCssW * lineDpr
export const lineBufferHeight = () => lineCssH * lineDpr

export const LABEL_MAX_DISTANCE = 45

const lodLabels = new Set<CSS2DObject>()
const lodWorld = new THREE.Vector3()

export function label(
    text: string,
    className = 'tag',
    maxDistance = LABEL_MAX_DISTANCE,
): CSS2DObject {
    const el = document.createElement('div')
    el.className = className
    el.textContent = text
    const obj = new CSS2DObject(el)
    obj.center.set(0, 0.5)
    obj.userData.labelMaxDistance = maxDistance
    obj.userData.labelEnabled = true
    lodLabels.add(obj)
    return obj
}

export function setLabelEnabled(obj: CSS2DObject, on: boolean) {
    obj.userData.labelEnabled = on
    obj.visible = on
}

/** Labels are registered globally, so one that rides a temporary object has to be unhooked. */
export function releaseLabel(obj: CSS2DObject) {
    lodLabels.delete(obj)
    obj.parent?.remove(obj)
    obj.element.remove()
}

export function updateLabelLOD(camera: THREE.Camera) {
    for (const obj of lodLabels) {
        obj.getWorldPosition(lodWorld)
        const max = (obj.userData.labelMaxDistance as number | undefined) ?? LABEL_MAX_DISTANCE
        const near = camera.position.distanceToSquared(lodWorld) <= max * max
        const visible = obj.userData.labelEnabled !== false && near
        if (obj.visible !== visible) obj.visible = visible
    }
}

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

    wait(dur: number): Promise<void> {
        return this.add(dur, () => {})
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

export const PACKET_SPEED = 20

export const speedTime = (curve: THREE.Curve<THREE.Vector3>) => curve.getLength() / PACKET_SPEED

export const breathe = (t: number, speed = 1, phase = 0) => 0.5 + 0.5 * Math.sin(t * speed + phase)

export function floorLabel(
    text: string,
    opts: {
        height?: number
        color?: string
        opacity?: number
        tracking?: number
        weight?: number
    } = {},
): THREE.Mesh {
    const fontPx = 44
    const tracking = opts.tracking ?? 9
    const weight = opts.weight ?? 500
    const font = `${weight} ${fontPx}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
    const paint = (ctx: CanvasRenderingContext2D) => {
        ctx.font = font
        if ('letterSpacing' in ctx) {
            ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
                `${tracking}px`
        }
    }

    const probe = document.createElement('canvas').getContext('2d')!
    paint(probe)
    const pad = 14
    const w = Math.ceil(probe.measureText(text).width) + pad * 2
    const h = Math.ceil(fontPx * 1.55)

    const canvas = document.createElement('canvas')
    canvas.width = w * 2
    canvas.height = h * 2
    const ctx = canvas.getContext('2d')!
    ctx.scale(2, 2)
    paint(ctx)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = opts.color ?? 'rgba(160, 214, 238, 0.9)'
    ctx.fillText(text, w / 2, h / 2)

    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 8

    const worldH = opts.height ?? 1.0
    const worldW = worldH * (w / h)
    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(worldW, worldH),
        new THREE.MeshBasicMaterial({
            map: tex,
            transparent: true,
            opacity: opts.opacity ?? 0.92,
            depthWrite: false,
            side: THREE.DoubleSide,
            toneMapped: false,
        }),
    )
    mesh.rotation.x = -Math.PI / 2
    mesh.userData.width = worldW
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let x0 = canvas.width
    let x1 = -1
    let y0 = canvas.height
    let y1 = -1
    for (let py = 0; py < canvas.height; py++) {
        for (let pxi = 0; pxi < canvas.width; pxi++) {
            if (px[(py * canvas.width + pxi) * 4 + 3] > 8) {
                if (pxi < x0) x0 = pxi
                if (pxi > x1) x1 = pxi
                if (py < y0) y0 = py
                if (py > y1) y1 = py
            }
        }
    }
    const known = x1 >= 0
    mesh.userData.ink = known
        ? {
              x0: -worldW / 2 + (x0 / canvas.width) * worldW,
              x1: -worldW / 2 + ((x1 + 1) / canvas.width) * worldW,
              y0: worldH / 2 - ((y1 + 1) / canvas.height) * worldH,
              y1: worldH / 2 - (y0 / canvas.height) * worldH,
          }
        : { x0: -worldW / 2, x1: worldW / 2, y0: -worldH / 2, y1: worldH / 2 }
    return mesh
}

export { slotLattice } from '../disk/grid'
