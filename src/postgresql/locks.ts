import * as THREE from 'three'
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'

import { BlockField } from '../core/field'
import { makePacket } from '../core/packet'
import { OutlineBox, easeInOutCubic, label, travel, type Ticker } from '../core/util'
import { pathCurve } from './flow'
import { LOCK_COLS, LOCK_RACK, LOCK_ROWS, PALETTE } from './layout'

export type LockMode = 'AccessShare' | 'RowExclusive' | 'AccessExclusive'

// Eight modes exist; these are the three that decide what a reader, a writer and an ALTER
// do to each other. Ice is nearly white and blooms to nothing, so the weakest mode is cyan.
export const LOCK_COLOUR: Record<LockMode, number> = {
    AccessShare: PALETTE.cyan,
    RowExclusive: PALETTE.amber,
    AccessExclusive: PALETTE.magenta,
}

export interface LockWait {
    mode: LockMode
    target: number
    obj: THREE.Group
    line: THREE.Line
    home: THREE.Vector3
}

// Only the three modes the scene draws, and only their conflicts with each other: an
// access-share reader blocks an exclusive writer and nothing else.
export const LOCK_CONFLICT: Record<LockMode, LockMode[]> = {
    AccessShare: ['AccessExclusive'],
    RowExclusive: ['AccessExclusive'],
    AccessExclusive: ['AccessShare', 'RowExclusive', 'AccessExclusive'],
}

/** One entry in the table: the object that is locked, and the backends holding it. */
interface LockEntry {
    name: string
    slot: number
    mode: LockMode
    holders: number
    pips: THREE.Mesh[]
}

const PIP_SIZE = 0.075

/**
 * The lock table as what it is: one entry per locked object, a pip per backend holding it,
 * and backends parked outside because the mode they asked for does not share with a mode
 * already held. Nothing here travels on its own — a holder adds a pip, and a waiter is a
 * request that has not been let in.
 */
export class LockRack {
    readonly group = new THREE.Group()
    readonly field: BlockField
    readonly cage: OutlineBox
    readonly caption: CSS2DObject
    private readonly waits: LockWait[] = []
    private readonly entries = new Map<string, LockEntry>()
    private readonly pipGeo = new THREE.BoxGeometry(PIP_SIZE, PIP_SIZE, PIP_SIZE)

    constructor(private readonly ticker: Ticker) {
        this.field = new BlockField({
            cols: LOCK_COLS,
            rows: LOCK_ROWS,
            layers: 1,
            size: 0.28,
            pitchX: 0.31,
            pitchY: 0.29,
            pitchZ: 0,
            home: new THREE.Vector3(0, 0, 0),
            colour: PALETTE.cyan,
            dark: 0x0a1620,
            // Lock blocks must not bloom: three of them at full white read as one blob.
            glow: 0.3,
        })
        this.group.add(this.field.group)

        this.cage = new OutlineBox(LOCK_RACK.w, LOCK_RACK.h, LOCK_RACK.d, PALETTE.cyan, 0.24, {
            dashed: true,
        })
        this.cage.centre(0, 0, 0)
        this.group.add(this.cage)

        this.caption = label('lock table')
        this.caption.position.set(-LOCK_RACK.w / 2 - 0.05, LOCK_RACK.h / 2 + 0.18, 0)
        this.group.add(this.caption)

        this.group.position.set(LOCK_RACK.x, LOCK_RACK.y, LOCK_RACK.z)
    }

    /** The rack plus the queue it makes waiters stand in — what a story should frame. */
    get bounds(): THREE.Box3 {
        return new THREE.Box3().setFromCenterAndSize(
            new THREE.Vector3(LOCK_RACK.x, LOCK_RACK.y + 0.1, LOCK_RACK.z + 0.3),
            new THREE.Vector3(LOCK_RACK.w + 0.4, LOCK_RACK.h + 0.6, LOCK_RACK.d + 1.7),
        )
    }

    get held() {
        return this.entries.size
    }

    /** Backends holding something, which is one per PROCLOCK rather than one per entry. */
    get holders() {
        let n = 0
        for (const e of this.entries.values()) n += e.holders
        return n
    }

    get waiting() {
        return this.waits.length
    }

    /** Where a slot sits in the parent's space — what a tether back to the table hangs on. */
    slotPoint(slot: number): THREE.Vector3 {
        return this.field.slot(slot).add(this.group.position)
    }

    /** Takes a lock for `name`: one slot per object, one pip per backend sharing it. */
    locked(name: string) {
        return this.entries.has(name)
    }

    slotOf(name: string): number {
        return this.entries.get(name)?.slot ?? -1
    }

    /** Would this request be granted right now? Checked before a statement proceeds. */
    fits(name: string, mode: LockMode): boolean {
        const existing = this.entries.get(name)
        if (!existing) return true
        return !LOCK_CONFLICT[mode].includes(existing.mode)
    }

    acquire(name: string, mode: LockMode): { slot: number; created: boolean; granted: boolean } {
        const existing = this.entries.get(name)
        if (existing) {
            if (!this.fits(name, mode))
                return { slot: existing.slot, created: false, granted: false }
            existing.holders++
            this.addPip(existing)
            return { slot: existing.slot, created: false, granted: true }
        }
        const slot = this.field.claim()
        if (slot === null) return { slot: -1, created: false, granted: false }
        this.field.tint(slot, LOCK_COLOUR[mode])
        void this.field.grow(slot, 1, 0.22, this.ticker)
        const entry: LockEntry = { name, slot, mode, holders: 1, pips: [] }
        this.entries.set(name, entry)
        this.addPip(entry)
        return { slot, created: true, granted: true }
    }

    /** One backend let go: a pip goes, and the entry itself goes when the last one does. */
    unlock(name: string) {
        const entry = this.entries.get(name)
        if (!entry) return
        entry.holders--
        const pip = entry.pips.pop()
        if (pip) {
            this.group.remove(pip)
            ;(pip.material as THREE.Material).dispose()
        }
        this.placePips(entry)
        if (entry.holders > 0) return
        this.entries.delete(name)
        void this.field
            .grow(entry.slot, 0, 0.2, this.ticker)
            .then(() => this.field.release(entry.slot))
    }

    /** Where a statement that cannot proceed parks, in the parent's space. */
    queuePoint(index: number): THREE.Vector3 {
        return new THREE.Vector3(-0.28 + index * 0.55, 0.06, LOCK_RACK.d / 2 + 0.62).add(
            this.group.position,
        )
    }

    private addPip(entry: LockEntry) {
        const mat = new THREE.MeshStandardMaterial({
            color: 0x0a1620,
            emissive: LOCK_COLOUR[entry.mode],
            emissiveIntensity: 0.55,
            transparent: true,
            opacity: 0,
        })
        const pip = new THREE.Mesh(this.pipGeo, mat)
        this.group.add(pip)
        entry.pips.push(pip)
        this.placePips(entry)
        void this.ticker.add(0.18, (k) => {
            mat.opacity = 0.25 + 0.75 * k
        })
    }

    /** Holders sit as a row of pips along the block's front edge, in the order they took it. */
    private placePips(entry: LockEntry) {
        const at = this.field.slot(entry.slot)
        entry.pips.forEach((pip, i) => {
            pip.position.set(at.x - 0.1 + i * (PIP_SIZE + 0.035), at.y - 0.19, at.z + 0.19)
        })
    }

    private dropPips(entry: LockEntry) {
        for (const pip of entry.pips) {
            this.group.remove(pip)
            ;(pip.material as THREE.Material).dispose()
        }
        entry.pips.length = 0
    }

    release(name: string) {
        const entry = this.entries.get(name)
        if (!entry) return
        this.entries.delete(name)
        this.dropPips(entry)
        void this.field
            .grow(entry.slot, 0, 0.2, this.ticker)
            .then(() => this.field.release(entry.slot))
    }

    releaseAll() {
        for (const name of [...this.entries.keys()]) this.release(name)
    }

    park(mode: LockMode, target: number): LockWait {
        const home = new THREE.Vector3(
            -0.28 + this.waits.length * 0.55,
            0.06,
            LOCK_RACK.d / 2 + 0.62,
        )
        const obj = makePacket(LOCK_COLOUR[mode], 0.13, this.group, {
            emissive: 1.3,
            haloScale: 2.6,
            haloOpacity: 0.4,
        })
        // It arrives from the statement's own side rather than appearing in the queue.
        obj.position.copy(home).add(new THREE.Vector3(0, 2.1, 1.1))
        void travel(
            this.ticker,
            obj,
            pathCurve([
                obj.position.clone(),
                obj.position.clone().add(new THREE.Vector3(0, 0.5, -0.5)),
                home.clone(),
            ]),
            0.4,
        )

        const line = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([home.clone(), this.field.top(target)]),
            new THREE.LineDashedMaterial({
                color: LOCK_COLOUR[mode],
                dashSize: 0.05,
                gapSize: 0.05,
                transparent: true,
                opacity: 0.5,
            }),
        )
        line.computeLineDistances()
        this.group.add(line)

        const wait = { mode, target, obj, line, home }
        this.waits.push(wait)
        return wait
    }

    /** The holder let go: the waiter flies the rest of the way and takes the entry. */
    async admit(wait: LockWait, name = 'relation'): Promise<number> {
        const i = this.waits.indexOf(wait)
        if (i < 0) return -1
        this.waits.splice(i, 1)
        this.group.remove(wait.line)
        wait.line.geometry.dispose()
        ;(wait.line.material as THREE.Material).dispose()

        const { slot } = this.acquire(name, wait.mode)
        if (slot < 0) {
            this.group.remove(wait.obj)
            return -1
        }
        const curve = pathCurve([
            wait.obj.position.clone(),
            wait.home.clone().add(new THREE.Vector3(0, 0.75, -0.4)),
            this.field.top(slot),
        ])
        await travel(this.ticker, wait.obj, curve, 0.42, easeInOutCubic)
        this.group.remove(wait.obj)
        return slot
    }

    clear() {
        for (const wait of this.waits) {
            this.group.remove(wait.obj)
            this.group.remove(wait.line)
            wait.line.geometry.dispose()
            ;(wait.line.material as THREE.Material).dispose()
        }
        this.waits.length = 0
        for (const entry of this.entries.values()) this.dropPips(entry)
        this.entries.clear()
        this.field.reset()
    }

    update(_dt: number, time: number) {
        this.waits.forEach((wait, i) => {
            wait.obj.position.y = wait.home.y + Math.sin(time * 1.7 + i * 1.1) * 0.045
            wait.obj.rotation.y = time * 0.5 + i
        })
    }
}
