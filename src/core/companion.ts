import * as THREE from 'three'
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { OutlineBox, label } from './util'
import { carryOnPacket } from './packet'

export interface CompanionOptions {
    parent: THREE.Object3D

    width?: number
    height?: number
    depth?: number
    color?: number
    lift?: number
}

export class Companion {
    readonly group = new THREE.Group()
    private readonly cage: OutlineBox
    private readonly bodyHost = new THREE.Group()
    private readonly readout: CSS2DObject
    private readonly home: THREE.Object3D
    private readonly width: number
    private readonly height: number
    private readonly depth: number
    private readonly lift: number
    private host: THREE.Object3D | null = null
    private body: THREE.Object3D | null = null
    private caption = ''

    constructor(opts: CompanionOptions) {
        this.home = opts.parent
        this.width = opts.width ?? 1.9
        this.height = opts.height ?? 1.24
        this.depth = opts.depth ?? 0.86
        this.lift = opts.lift ?? 0.5
        this.cage = new OutlineBox(
            this.width,
            this.height,
            this.depth,
            opts.color ?? 0x8a7bff,
            0.46,
            { dashed: true },
        )
        this.cage.centre(0, this.height / 2, 0)
        this.group.add(this.cage)
        this.group.add(this.bodyHost)
        this.group.visible = false
        this.readout = label('', 'tag companion', 40)
        this.readout.position.set(-this.width / 2 - 0.02, this.height + 0.16, 0)
        this.group.add(this.readout)
        this.home.add(this.group)
    }

    get carried() {
        return this.host !== null
    }

    get visible() {
        return this.group.visible
    }

    get fullWidth() {
        return this.width
    }

    setBody(body: THREE.Object3D) {
        if (this.body === body) return
        if (this.body) this.body.visible = false
        this.body = body
        body.visible = true
        const box = new THREE.Box3().setFromObject(body)
        const size = box.getSize(new THREE.Vector3())
        const centre = box.getCenter(new THREE.Vector3())
        const fit = 0.84
        const scale =
            Math.min(
                this.width / Math.max(0.001, size.x),
                (this.height * fit) / Math.max(0.001, size.y),
                (this.depth * fit) / Math.max(0.001, size.z),
            ) * fit
        body.scale.setScalar(scale)
        body.position.set(
            -centre.x * scale,
            this.height / 2 - centre.y * scale,
            -centre.z * scale,
        )
        this.bodyHost.add(body)
    }

    attach(packet: THREE.Object3D) {
        this.host = packet
        carryOnPacket(this.group, packet, { lift: this.lift })
        this.group.visible = true
    }

    release() {
        if (!this.host) return
        this.host = null
        this.home.add(this.group)
        this.group.visible = false
        this.group.position.set(0, 0, 0)
        this.group.scale.setScalar(1)
    }

    say(text: string) {
        if (text === this.caption) return
        this.caption = text
        const el = this.readout.element as HTMLElement
        el.textContent = text
    }

    get captionText() {
        return this.caption
    }
}
