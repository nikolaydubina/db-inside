import { PALETTE } from '../layout'
import { Stage } from '../../core/stage'
import { PostgresqlIndexKind, scaffoldStructure, V, type IndexStructure } from './structure'

export const buildBtree = (): IndexStructure => {
    const d = scaffoldStructure()
    const root = d.page('root', PALETTE.violet, 0, 1.1, 0, 3)
    const internals = [-0.62, 0, 0.62].map((x, i) => d.page(`i${i}`, PALETTE.violet, x, 0.56, 0, 3))
    for (let j = 0; j < internals.length; j++) {
        for (let k = 0; k < 3; k++) {
            d.page(
                `l${j}${k}`,
                PALETTE.violet,
                internals[j].group.position.x - 0.21 + k * 0.21,
                0.02,
                0,
                3,
            )
        }
    }

    for (let i = 0; i < internals.length; i++) {
        d.edge(
            `root>i${i}`,
            root.group.position.clone().add(V(0, 0.1, 0)),
            internals[i].group.position.clone().add(V(0, 0.1, 0)),
        )
        for (let k = 0; k < 3; k++) {
            d.edge(
                `i${i}>l${i}${k}`,
                internals[i].group.position.clone().add(V(0, 0.1, 0)),
                d.pages[`l${i}${k}`].group.position.clone().add(V(0, 0.1, 0)),
            )
        }
    }

    const beats = {
        [Stage.Root]: {
            say: 'root page · binary search over child pointers',
            hot: 'root',
            edges: ['root>i1'],
        },
        [Stage.Internal]: {
            say: 'internal page · one pointer taken',
            light: ['root'],
            hot: 'i1',
            edges: ['root>i1', 'i1>l11'],
        },
        [Stage.Leaf]: {
            say: 'leaf page · key found',
            light: ['root', 'i1'],
            hot: 'l11',
            items: { l11: [1] },
            edges: ['i1>l11'],
        },
        [Stage.Tid]: {
            say: 'leaf entry · TID (12,3) — a page and an offset',
            light: ['root', 'i1'],
            hot: 'l11',
            items: { l11: [1] },
        },
        [Stage.Heap]: {
            say: 'the TID names a heap page — a different file, one row',
            light: ['root', 'i1'],
            hot: 'l11',
            items: { l11: [1] },
            edges: ['i1>l11'],
        },
    }

    return {
        kind: PostgresqlIndexKind.Btree,
        group: d.group,
        pages: d.pages,
        edges: d.edges,
        beats,
        rest: () => {},
    }
}
