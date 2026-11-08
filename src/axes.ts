import * as THREE from 'three'
import { label } from './util'

/**
 * A hidden measuring aid, not part of the scene's art. It answers the one
 * question the picture cannot: "where is that, in world units?" — because
 * "left of the orange cage" is not a coordinate.
 *
 *   __axes.on()        show axes, ticks, coordinate labels and origin marks
 *   __axes.off()
 *   __axes.toggle()
 *   ?axes              same as calling __axes.on() at boot
 *
 * Axes are drawn with depthTest off on purpose: a debug ruler you cannot see
 * through geometry is a ruler you cannot use.
 */
export interface Axes {
    readonly group: THREE.Group
    on(): void
    off(): void
    toggle(): boolean
    isOn(): boolean
    /** Moves a mark — return value of mark(), call it when the thing it labels moves. */
    mark(name: string, pos: THREE.Vector3): (next: THREE.Vector3) => void
}

const AXIS_X = 0xff6b6b
const AXIS_Y = 0x7bff9e
const AXIS_Z = 0x6b9bff

export function createAxes(
    scene: THREE.Scene,
    opts: { extentX?: number; extentZ?: number; tick?: number; labelEvery?: number } = {},
): Axes {
    const extentX = opts.extentX ?? 64
    const extentZ = opts.extentZ ?? 40
    const tick = opts.tick ?? 2
    const labelEvery = opts.labelEvery ?? 8

    const group = new THREE.Group()
    group.visible = false
    scene.add(group)

    const segments = (pts: number[], color: number, opacity: number, width = 1) => {
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
        const mat = new THREE.LineBasicMaterial({
            color,
            transparent: true,
            opacity,
            // always visible: the point of a ruler is to be readable through the model
            depthTest: false,
            depthWrite: false,
            linewidth: width,
        })
        const line = new THREE.LineSegments(geo, mat)
        line.renderOrder = 900
        line.frustumCulled = false
        group.add(line)
        return line
    }

    /* ---------------------------------- axes --------------------------------- */

    segments([-extentX, 0, 0, extentX, 0, 0], AXIS_X, 0.65)
    segments([0, 0, -extentZ, 0, 0, extentZ], AXIS_Z, 0.65)
    segments([0, 0.001, 0, 0, 14, 0], AXIS_Y, 0.65)

    // ticks: one per grid square (the floor grid is 2 units), so counting cells
    // between two labelled points is exact
    const xTicks: number[] = []
    for (let x = -extentX; x <= extentX; x += tick) xTicks.push(x, 0, -0.45, x, 0, 0.45)
    segments(xTicks, AXIS_X, 0.28)
    const zTicks: number[] = []
    for (let z = -extentZ; z <= extentZ; z += tick) zTicks.push(-0.45, 0, z, 0.45, 0, z)
    segments(zTicks, AXIS_Z, 0.28)
    const yTicks: number[] = []
    for (let y = 0; y <= 14; y += 2) yTicks.push(-0.3, y, 0, 0.3, y, 0)
    segments(yTicks, AXIS_Y, 0.28)

    /* -------------------------------- labels --------------------------------- */

    const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`)

    for (let x = -extentX; x <= extentX; x += labelEvery) {
        if (x === 0) continue
        const l = label(`x ${signed(x)}`)
        l.position.set(x, 0.35, 1.1)
        group.add(l)
    }
    for (let z = -extentZ; z <= extentZ; z += labelEvery) {
        if (z === 0) continue
        const l = label(`z ${signed(z)}`)
        l.position.set(1.1, 0.35, z)
        group.add(l)
    }
    for (let y = 2; y <= 14; y += 2) {
        const l = label(`y ${y}`)
        l.position.set(1.0, y, 0)
        group.add(l)
    }

    const origin = label('0,0')
    origin.position.set(0.5, 0.35, -0.9)
    group.add(origin)

    const tipX = label('+X · long side')
    tipX.position.set(extentX + 1, 0.5, 0)
    group.add(tipX)
    const tipZ = label('+Z · toward camera')
    tipZ.position.set(0.5, 0.5, extentZ + 1)
    group.add(tipZ)
    const tipY = label('+Y')
    tipY.position.set(0.6, 15, 0)
    group.add(tipY)
    const cells = label('ticks every 2 units · floor grid cell = 2')
    cells.position.set(0.5, 0.35, 2.2)
    group.add(cells)

    /* --------------------------------- marks --------------------------------- */

    // built at the origin and then placed, so moving a mark is a position write
    const markCross = (color: number) => {
        const g = new THREE.BufferGeometry()
        const s = 1.6
        g.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(
                [-s, 0.02, 0, s, 0.02, 0, 0, 0.02, -s, 0, 0.02, s],
                3,
            ),
        )
        const line = new THREE.LineSegments(
            g,
            new THREE.LineBasicMaterial({
                color,
                transparent: true,
                opacity: 0.9,
                depthTest: false,
                depthWrite: false,
            }),
        )
        line.renderOrder = 902
        group.add(line)
        return line
    }

    return {
        group,
        on() {
            group.visible = true
        },
        off() {
            group.visible = false
        },
        toggle() {
            group.visible = !group.visible
            return group.visible
        },
        isOn() {
            return group.visible
        },
        mark(name: string, pos: THREE.Vector3) {
            const cross = markCross(AXIS_Y)
            const l = label('')
            group.add(l)

            const place = (p: THREE.Vector3) => {
                cross.position.copy(p)
                l.position.set(p.x + 1.8, p.y + 1.2, p.z)
                l.element.textContent = `${name} · x ${signed(Math.round(p.x))}, z ${signed(Math.round(p.z))}`
            }
            place(pos)
            return place
        },
    }
}
