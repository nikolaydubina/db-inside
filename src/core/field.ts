import * as THREE from 'three'
import type { Ticker } from './util'

export interface FieldOptions {
    cols: number
    rows: number
    layers: number

    size: number
    pitchX: number
    pitchY: number
    pitchZ: number

    home: THREE.Vector3
    colour: number
    dark?: number
}

/**
 * A cage of blocks, aligned in 3D, filled the way the disk floor is: a slot that holds
 * nothing draws nothing, and a slot that holds something grows from transparent to full
 * size and colour. Slots are claimed in order, so a producer can ask for the next free
 * one and animate something into it.
 */
export class BlockField {
    readonly group = new THREE.Group()
    readonly cols: number
    readonly rows: number
    readonly layers: number
    readonly size: number
    private readonly home0: THREE.Vector3
    private readonly pitchX: number
    private readonly pitchY: number
    private readonly pitchZ: number
    private readonly dark: THREE.Color
    private readonly bright: THREE.Color
    private readonly meshes: THREE.Mesh[] = []
    private readonly mats: THREE.MeshStandardMaterial[] = []
    private readonly fill: number[] = []
    private readonly held: boolean[] = []

    constructor(opts: FieldOptions) {
        this.cols = opts.cols
        this.rows = opts.rows
        this.layers = opts.layers
        this.size = opts.size
        this.pitchX = opts.pitchX
        this.pitchY = opts.pitchY
        this.pitchZ = opts.pitchZ
        this.home0 = opts.home.clone()
        this.dark = new THREE.Color(opts.dark ?? 0x101a12)
        this.bright = new THREE.Color(opts.colour)

        const geo = new THREE.BoxGeometry(opts.size, opts.size, opts.size)
        for (let i = 0; i < this.capacity; i++) {
            const mat = new THREE.MeshStandardMaterial({
                color: this.dark.clone(),
                emissive: opts.colour,
                emissiveIntensity: 0.2,
                transparent: true,
                opacity: 0,
                roughness: 0.4,
                metalness: 0.35,
            })
            const mesh = new THREE.Mesh(geo, mat)
            this.group.add(mesh)
            this.meshes.push(mesh)
            this.mats.push(mat)
            this.fill.push(0)
            this.held.push(false)
            this.set(i, 0)
        }
    }

    get capacity() {
        return this.cols * this.rows * this.layers
    }

    get used() {
        return this.held.filter(Boolean).length
    }

    slot(i: number): THREE.Vector3 {
        const col = i % this.cols
        const row = Math.floor(i / this.cols) % this.rows
        const layer = Math.floor(i / (this.cols * this.rows))
        return new THREE.Vector3(
            this.home0.x + (col - (this.cols - 1) / 2) * this.pitchX,
            this.home0.y + (row - (this.rows - 1) / 2) * this.pitchY,
            this.home0.z + (layer - (this.layers - 1) / 2) * this.pitchZ,
        )
    }

    top(i: number): THREE.Vector3 {
        return this.slot(i).add(new THREE.Vector3(0, this.size / 2 + 0.12, 0))
    }

    claim(): number | null {
        const i = this.held.indexOf(false)
        if (i < 0) return null
        this.held[i] = true
        return i
    }

    release(i: number) {
        if (i < 0 || i >= this.capacity) return
        this.held[i] = false
    }

    reset() {
        for (let i = 0; i < this.capacity; i++) {
            this.held[i] = false
            this.set(i, 0)
        }
    }

    set(i: number, k: number) {
        const f = Math.max(0, Math.min(1, k))
        this.fill[i] = f
        const mesh = this.meshes[i]
        const mat = this.mats[i]
        // Same rule as the disk: a slot that holds nothing draws nothing. The cage is the
        // grid; a block exists only where something has been recorded.
        mesh.position.copy(this.slot(i))
        mesh.visible = f > 0.004
        if (!mesh.visible) return
        mesh.scale.setScalar(0.7 + 0.3 * f)
        mat.opacity = 0.35 + 0.65 * f
        mat.depthWrite = f > 0.5
        mat.color.copy(this.dark).lerp(this.bright, f)
        mat.emissiveIntensity = 0.15 + 0.6 * f
    }

    grow(i: number, to: number, dur: number, ticker: Ticker): Promise<void> {
        const from = this.fill[i]
        return ticker.add(dur, (k) => this.set(i, from + (to - from) * k))
    }
}
