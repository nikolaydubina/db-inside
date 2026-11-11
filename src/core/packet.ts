import * as THREE from 'three'
import { halo } from './util'

export interface PacketOptions {
    emissive?: number
    haloScale?: number
    haloOpacity?: number
}

export function makePacket(
    color: number,
    size: number,
    parent: THREE.Object3D,
    opts: PacketOptions = {},
): THREE.Group {
    const small = size < 0.19
    const group = new THREE.Group()

    const marker = new THREE.Group()
    group.add(marker)

    const core = new THREE.Mesh(
        new THREE.BoxGeometry(size, size, size),
        new THREE.MeshStandardMaterial({
            color: 0x0a1118,
            emissive: color,
            emissiveIntensity: opts.emissive ?? (small ? 0.45 : 2.4),
            roughness: 0.25,
            metalness: 0.4,
        }),
    )
    marker.add(core)
    marker.add(
        halo(
            color,
            size * (opts.haloScale ?? (small ? 2.2 : 2.6)),
            opts.haloOpacity ?? (small ? 0.18 : 0.4),
        ),
    )

    group.userData.marker = marker
    group.userData.core = core
    parent.add(group)
    return group
}

export const packetMarker = (obj: THREE.Object3D): THREE.Object3D =>
    (obj.userData.marker as THREE.Object3D | undefined) ?? obj

export function recolorPacket(obj: THREE.Object3D, hex: number) {
    obj.traverse((o) => {
        const mat = (o as THREE.Mesh).material as
            THREE.MeshStandardMaterial | THREE.SpriteMaterial | undefined
        if (!mat) return
        const standard = mat as THREE.MeshStandardMaterial
        if (standard.emissive) standard.emissive.setHex(hex)
        else (mat as THREE.SpriteMaterial).color?.setHex(hex)
    })
}

export interface CarryOptions {
    width?: number
    lift?: number
}

export function carryOnPacket(
    obj: THREE.Object3D,
    packet: THREE.Object3D,
    opts: CarryOptions = {},
) {
    const marker = packetMarker(packet)
    marker.add(obj)

    if (opts.width) {
        const box = new THREE.Box3().setFromObject(obj)
        const size = box.getSize(new THREE.Vector3())
        const centre = box.getCenter(new THREE.Vector3())
        const scale = opts.width / Math.max(0.001, size.x)
        obj.scale.setScalar(scale)
        obj.position.set(-centre.x * scale, 0, -centre.z * scale)
        const half = opts.lift ?? 0.12
        obj.position.y = half + (size.y / 2) * scale - centre.y * scale
        return
    }

    obj.position.set(0, opts.lift ?? 0.12, 0)
}
