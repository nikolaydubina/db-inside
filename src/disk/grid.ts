import * as THREE from 'three'
import { FLOOR_Y } from '../core/util'

export function slotLattice(
    x0: number,
    x1: number,
    z0: number,
    z1: number,
    stepX: number,
    stepZ: number = stepX,
) {
    const pts: number[] = []
    for (let x = x0; x <= x1 + 1e-3; x += stepX) pts.push(x, FLOOR_Y, z0, x, FLOOR_Y, z1)
    for (let z = z0; z <= z1 + 1e-3; z += stepZ) pts.push(x0, FLOOR_Y, z, x1, FLOOR_Y, z)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    return new THREE.LineSegments(
        geo,
        new THREE.LineBasicMaterial({
            color: 0x1d4a5e,
            transparent: true,
            opacity: 0.5,
            depthWrite: false,
        }),
    )
}
