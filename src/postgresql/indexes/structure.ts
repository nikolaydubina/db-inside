import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { Stage } from '../../core/stage'
import { PAGE_GRID, PALETTE } from '../layout'

export const enum PostgresqlIndexKind {
    Btree = 1,
    Gin = 2,
    Brin = 3,
    Hash = 4,
}

export const POSTGRESQL_INDEX_NAME: Record<PostgresqlIndexKind, string> = {
    [PostgresqlIndexKind.Btree]: 'btree',
    [PostgresqlIndexKind.Gin]: 'gin',
    [PostgresqlIndexKind.Brin]: 'brin',
    [PostgresqlIndexKind.Hash]: 'hash',
}

export const POSTGRESQL_INDEX_LABEL: Record<PostgresqlIndexKind, string> = {
    [PostgresqlIndexKind.Btree]: 'B-TREE',
    [PostgresqlIndexKind.Gin]: 'GIN',
    [PostgresqlIndexKind.Brin]: 'BRIN',
    [PostgresqlIndexKind.Hash]: 'HASH',
}

export const enum PageMark {
    Idle = 1,
    Read = 2,
    Hot = 3,
    Pruned = 4,
    Match = 5,
    Heap = 6,
}

export interface IndexBeat {
    say: string
    light?: string[]
    hot?: string
    pruned?: string[]
    items?: Record<string, number[]>
    edges?: string[]
}

export type IndexBeats = Partial<Record<Stage, IndexBeat>>

const PAGE_W = PAGE_GRID.bw
const PAGE_H = PAGE_GRID.bh
const PAGE_D = PAGE_GRID.bd

const pageGeo = new RoundedBoxGeometry(PAGE_W, PAGE_H, PAGE_D, 1, 0.02)
const slotGeo = new THREE.BoxGeometry(0.05, 0.04, 0.07)
const cellGeo = new THREE.BoxGeometry(0.08, 0.05, 0.1)

const PAGE_SCALE = 0.34

export const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

export const glowMat = (color: number, emissive: number, intensity: number) =>
    new THREE.MeshStandardMaterial({
        color,
        emissive,
        emissiveIntensity: intensity,
        roughness: 0.42,
        metalness: 0.35,
    })

export class PageGlyph {
    readonly group = new THREE.Group()
    readonly mat: THREE.MeshStandardMaterial
    readonly slots: THREE.MeshStandardMaterial[] = []

    constructor(
        readonly name: string,
        color: number,
        cells = 3,
        scale = PAGE_SCALE,
    ) {
        this.mat = glowMat(0x0a0f18, color, 0.2)
        const mesh = new THREE.Mesh(pageGeo, this.mat)
        this.group.add(mesh)

        for (let i = 0; i < cells; i++) {
            const mat = glowMat(0x05080d, color, 0.24)
            const slot = new THREE.Mesh(cells > 3 ? cellGeo : slotGeo, mat)
            slot.position.set(
                (-PAGE_W * 0.62) / 2 + (i * (PAGE_W * 0.62)) / Math.max(1, cells - 1),
                PAGE_H / 2 + 0.02,
                0,
            )
            this.group.add(slot)
            this.slots.push(mat)
        }
        this.group.scale.setScalar(scale)
    }

    at(x: number, y: number, z = 0) {
        this.group.position.set(x, y, z)
        return this
    }

    mark(mark: PageMark, lit: number[] = []) {
        const color =
            mark === PageMark.Pruned
                ? 0x243039
                : mark === PageMark.Hot
                  ? PALETTE.ice
                  : mark === PageMark.Match
                    ? PALETTE.amber
                    : mark === PageMark.Heap
                      ? PALETTE.teal
                      : this.mat.userData.baseColor

        const intensity =
            mark === PageMark.Idle
                ? 0.18
                : mark === PageMark.Read
                  ? 0.7
                  : mark === PageMark.Hot
                    ? 1.5
                    : mark === PageMark.Pruned
                      ? 0.04
                      : 1.15

        this.mat.emissive.setHex(color)
        this.mat.emissiveIntensity = intensity
        this.slots.forEach((m, i) => {
            const on = mark !== PageMark.Pruned && (lit.length === 0 || lit.includes(i))
            m.emissive.setHex(mark === PageMark.Pruned ? 0x1e2830 : color)
            m.emissiveIntensity = mark === PageMark.Pruned ? 0.05 : on ? 1.7 : 0.16
        })
    }
}

export interface IndexStructure {
    kind: PostgresqlIndexKind

    group: THREE.Group
    pages: Record<string, PageGlyph>
    edges: Record<string, THREE.LineBasicMaterial>
    beats: IndexBeats
    rest(): void
    hook?: (stage: Stage, beat: IndexBeat) => void
}

export interface StructureScaffold {
    group: THREE.Group
    pages: Record<string, PageGlyph>
    edges: Record<string, THREE.LineBasicMaterial>
    page(name: string, color: number, x: number, y: number, z?: number, cells?: number): PageGlyph
    edge(id: string, a: THREE.Vector3, b: THREE.Vector3): void
    box(): THREE.Box3
}

export const makeEdgeMaterial = () =>
    new THREE.LineBasicMaterial({
        color: 0x6b5bd0,
        transparent: true,
        opacity: 0.14,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    })

export const scaffoldStructure = (): StructureScaffold => {
    const group = new THREE.Group()
    const pages: Record<string, PageGlyph> = {}
    const edges: Record<string, THREE.LineBasicMaterial> = {}

    return {
        group,
        pages,
        edges,
        page(name, color, x, y, z = 0, cells = 3) {
            const p = new PageGlyph(name, color, cells)
            p.mat.userData.baseColor = color
            group.add(p.group)
            p.at(x, y, z)
            pages[name] = p
            return p
        },
        edge(id, a, b) {
            const mat = makeEdgeMaterial()
            const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), mat)
            line.frustumCulled = false
            group.add(line)
            edges[id] = mat
        },
        box: () => new THREE.Box3().setFromObject(group),
    }
}

export const applyBeat = (structure: IndexStructure, stage: Stage) => {
    const beat = structure.beats[stage]
    const live = beat ?? { say: '' }
    for (const [name, page] of Object.entries(structure.pages)) {
        if (live.pruned?.includes(name)) page.mark(PageMark.Pruned)
        else if (live.hot === name) page.mark(PageMark.Hot, live.items?.[name] ?? [])
        else if (live.light?.includes(name)) page.mark(PageMark.Read, live.items?.[name] ?? [])
        else page.mark(PageMark.Idle)
    }
    for (const [id, mat] of Object.entries(structure.edges)) {
        const on = live.edges?.includes(id)
        mat.opacity = on ? 0.8 : 0.14
        mat.color.setHex(on ? 0xcfeeff : 0x6b5bd0)
    }
    structure.hook?.(stage, beat ?? { say: '' })
}
