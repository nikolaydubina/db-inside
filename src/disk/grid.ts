import * as THREE from 'three'
import { FLOOR_Y } from '../core/util'

/**
 * The disk lattice, drawn once for every block field in the scene.
 *
 * A slot is a place a block can stand whether or not one is standing there — that
 * is what makes a hole in a table legible as free space rather than as bare
 * ground. Both disks (a postgres heap, the redis dump/AOF area) are tiled by this
 * same lattice at the same pitch, so the two are comparable by eye.
 */
export function slotLattice(x0: number, x1: number, z0: number, z1: number, pitch: number) {
  const pts: number[] = []
  for (let x = x0; x <= x1 + 1e-3; x += pitch) pts.push(x, FLOOR_Y, z0, x, FLOOR_Y, z1)
  for (let z = z0; z <= z1 + 1e-3; z += pitch) pts.push(x0, FLOOR_Y, z, x1, FLOOR_Y, z)
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
