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

const RANGES = 6

export const buildBrin = (): IndexStructure => {
    const d = scaffoldStructure()
    const summary = d.page('brin', PALETTE.violet, -1.32, 0.5, 0.05, 2)

    const summaryMats: THREE.MeshStandardMaterial[] = []
    const runMats: THREE.MeshStandardMaterial[] = []
    const runX = (i: number) => -0.78 + i * 0.34

    for (let i = 0; i < RANGES; i++) {
        const plateMat = glowMat(0x080d14, PALETTE.violet, 0.36)
        const entry = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.05, 0.18), plateMat)
        entry.position.set(runX(i), 0.86, 0.08)
        d.group.add(entry)
        summaryMats.push(plateMat)
        d.edge(
            `brin>s${i}`,
            summary.group.position.clone().add(V(0, 0.1, 0)),
            entry.position.clone(),
        )

        const runMat = glowMat(0x060a10, PALETTE.violet, 0.18)
        const run = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.04, 0.22), runMat)
        run.position.set(runX(i), 0.06, 0.08)
        d.group.add(run)
        runMats.push(runMat)

        d.edge(`s${i}>run${i}`, entry.position.clone(), run.position.clone().add(V(0, 0.12, 0)))
    }
    const beats = {
        [Stage.Summaries]: {
            say: 'one page of min/max · 6 ranges, 128 heap pages each',
            hot: 'brin',
            edges: Array.from({ length: RANGES }, (_, i) => `brin>s${i}`),
        },
        [Stage.Prune]: {
            say: 'arithmetic prunes 4 ranges · no heap page read',
            hot: 'brin',
            edges: ['brin>s2', 'brin>s3'],
        },
        [Stage.Heap]: {
            say: 'the surviving ranges are scanned in full, then rechecked',
            light: ['brin'],
            edges: ['brin>s2', 'brin>s3'],
        },
    }
    const paint = (stage?: Stage) => {
        summaryMats.forEach((m, i) => {
            const candidate =
                stage !== undefined && stage !== Stage.Summaries && (i === 2 || i === 3)
            m.emissiveIntensity = stage === Stage.Summaries ? 1.0 : candidate ? 1.5 : 0.07
            m.emissive.setHex(candidate ? PALETTE.amber : PALETTE.violet)
        })
        runMats.forEach((m, i) => {
            const live = stage === Stage.Heap && (i === 2 || i === 3)
            m.emissiveIntensity = live ? 1.1 : stage === Stage.Prune ? 0.07 : 0.16
            m.emissive.setHex(live ? PALETTE.amber : PALETTE.violet)
        })
    }
    paint()

    return {
        kind: PostgresqlIndexKind.Brin,
        group: d.group,
        pages: d.pages,
        edges: d.edges,
        beats,
        rest: () => paint(),
        hook: (stage) => paint(stage),
    }
}
