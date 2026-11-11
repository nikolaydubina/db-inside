import * as THREE from 'three'
import { PALETTE } from '../layout'
import { Stage } from '../../core/stage'
import {
    glowMat,
    PostgresqlIndexKind,
    scaffoldStructure,
    V,
    type IndexStructure,
} from './structure'

const CELL = new THREE.BoxGeometry(0.075, 0.045, 0.09)

const posting = (d: ReturnType<typeof scaffoldStructure>, x: number, y: number, color: number) => {
    const mats: THREE.MeshStandardMaterial[] = []
    for (let i = 0; i < 3; i++) {
        const mat = glowMat(0x080d14, color, 0.22)
        const cell = new THREE.Mesh(CELL, mat)
        cell.position.set(x - 0.11 + i * 0.11, y, 0.2)
        d.group.add(cell)
        mats.push(mat)
    }
    return mats
}

export const buildGin = (): IndexStructure => {
    const d = scaffoldStructure()
    const root = d.page('root', PALETTE.magenta, 0, 1.05, 0, 3)
    const tag = d.page('tag', PALETTE.magenta, -0.66, 0.5, 0, 3)
    const sale = d.page('sale', PALETTE.magenta, 0.66, 0.5, 0, 3)

    const tagPost = posting(d, -0.66, 0.02, PALETTE.magenta)
    const salePost = posting(d, 0.66, 0.02, PALETTE.magenta)

    d.edge(
        'root>tag',
        root.group.position.clone().add(V(0, 0.1, 0)),
        tag.group.position.clone().add(V(0, 0.1, 0)),
    )
    d.edge(
        'root>sale',
        root.group.position.clone().add(V(0, 0.1, 0)),
        sale.group.position.clone().add(V(0, 0.1, 0)),
    )

    const postings = (mats: THREE.MeshStandardMaterial[], on: boolean) =>
        mats.forEach((m) => (m.emissiveIntensity = on ? 1.6 : 0.18))

    const beats = {
        [Stage.Root]: {
            say: 'root · two keys of the document: tag, sale',
            hot: 'root',
            edges: ['root>tag', 'root>sale'],
        },
        [Stage.Posting]: {
            say: 'tag → posting list · 3 TIDs',
            light: ['root'],
            hot: 'tag',
            edges: ['root>tag'],
        },
        [Stage.Bitmap]: {
            say: 'sale → postings · bitmap AND keeps 2 TIDs',
            light: ['root', 'tag', 'sale'],
            hot: 'sale',
            edges: ['root>sale', 'root>tag'],
        },
        [Stage.Heap]: {
            say: 'the bitmap names heap pages — a different file, 2 rows',
            light: ['root', 'tag', 'sale'],
            hot: 'sale',
            edges: ['root>sale', 'root>tag'],
        },
    }

    return {
        kind: PostgresqlIndexKind.Gin,
        group: d.group,
        pages: d.pages,
        edges: d.edges,
        beats,
        rest: () => {
            postings(tagPost, false)
            postings(salePost, false)
        },
        hook: (stage) => {
            postings(tagPost, stage === Stage.Bitmap || stage === Stage.Heap)
            postings(salePost, stage === Stage.Heap)
        },
    }
}
