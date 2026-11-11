import { PALETTE } from '../layout'
import { Stage } from '../../core/stage'
import { PostgresqlIndexKind, scaffoldStructure, V, type IndexStructure } from './structure'

export const buildHash = (): IndexStructure => {
    const d = scaffoldStructure()
    const meta = d.page('meta', PALETTE.teal, 0, 1.05, 0, 2)
    const buckets = [-1.02, -0.51, 0, 0.51, 1.02].map((x, i) => {
        const page = d.page(`b${i}`, PALETTE.teal, x, 0.5, 0, 3)
        d.edge(
            `meta>b${i}`,
            meta.group.position.clone().add(V(0, 0.1, 0)),
            page.group.position.clone().add(V(0, 0.1, 0)),
        )
        return page
    })
    const overflow = d.page('overflow', PALETTE.teal, 1.02, 0.02, 0.26, 2)

    d.edge(
        'b3>overflow',
        buckets[3].group.position.clone().add(V(0, 0.1, 0)),
        overflow.group.position.clone().add(V(0, 0.1, 0)),
    )

    const beats = {
        [Stage.Meta]: {
            say: 'metapage · how many buckets this index has',
            hot: 'meta',
            edges: ['meta>b3'],
        },
        [Stage.Bucket]: {
            say: 'hash(key) picks one bucket page',
            light: ['meta'],
            hot: 'b3',
            edges: ['meta>b3'],
        },
        [Stage.Overflow]: {
            say: 'bucket overflowed · one more page in the chain',
            light: ['meta', 'b3'],
            hot: 'overflow',
            edges: ['meta>b3', 'b3>overflow'],
        },
        [Stage.Heap]: {
            say: 'the bucket entry names a heap page — a different file',
            light: ['meta', 'b3', 'overflow'],
            hot: 'overflow',
            edges: ['meta>b3', 'b3>overflow'],
        },
    }

    return {
        kind: PostgresqlIndexKind.Hash,
        group: d.group,
        pages: d.pages,
        edges: d.edges,
        beats,
        rest: () => {},
    }
}
