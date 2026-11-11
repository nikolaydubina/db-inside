import type { StoryDef, StoryStep } from '../types'
import { PostgresqlIndexKind } from '../../postgresql/indexes'
import { Stage } from '../../core/stage'
import { Db } from '../../core/db'
import { frozeIndexAt, frozeIndexAfter } from '../stop'

const LOOKUP = {
    tap: Db.Postgres,
    idx: PostgresqlIndexKind.Btree,
    subject: (s: Parameters<NonNullable<StoryStep['subject']>>[0]) => s.indexRide?.() ?? null,
} satisfies Partial<StoryStep>

const steps: StoryStep[] = [
    {
        title: 'a statement reaches a backend',
        body: 'One statement, one connection, one backend process. The postmaster forked that process when the client connected and it will serve nothing else until the connection closes. The bytes land in that connection’s input buffer; nothing has been parsed, planned, or read yet.',
        ...LOOKUP,
        dir: [0.55, 0.5, 1],
        dist: 13.0,
        fov: 40,
        send: 1,
        delay: 0,
        speed: 0.5,
        expect: (c) => c.idxStage === Stage.Socket,
        waitFor: 'the statement landing on a port',
        freezeAt: Stage.Socket,
        assert: frozeIndexAt(Stage.Socket, 'the socket it arrived on'),
    },
    {
        title: 'parsed, planned, executed',
        body: 'The parser turns the text into a tree and checks it against the catalogues. The planner prices the ways it could answer — read every page of the table, or descend an index — and picks the cheaper one. The executor then runs that plan and starts asking the buffer manager for pages. This lookup becomes an index scan because the planner decided it should be one.',
        ...LOOKUP,
        dir: [0.5, 0.45, 1],
        dist: 12.5,
        fov: 42,
        send: 1,
        delay: 900,
        speed: 0.45,
        expect: (c) => c.idxStage === Stage.Exec,
        waitFor: 'the executor receiving the plan',
        freezeAt: Stage.Exec,
        assert: frozeIndexAt(Stage.Exec, 'the executor'),
    },
    {
        title: 'the descent starts at the root page',
        body: 'The first read is page 1 of the index: the root. Inside it are hundreds of separator keys in order, and finding the right child is a binary search over them — all inside one page that is now in a shared buffer. The index is a file of 8 KiB pages exactly like a heap, and this is the first of three.',
        ...LOOKUP,
        dir: [0.5, 0.55, 1],
        dist: 7.4,
        fov: 38,
        send: 1,
        delay: 900,
        speed: 0.4,
        expect: (c) => c.idxStage === Stage.Root && c.idxPages === 1,
        waitFor: 'the root page of the index',
        freezeAt: Stage.Root,
        assert: frozeIndexAfter(Stage.Root, 'the root page', 1),
    },
    {
        title: 'internal, then leaf: three pages in all',
        body: 'The root picks one internal page, and the internal page picks one leaf. That is the whole height of the tree for a table of any size, because every page holds hundreds of children rather than two. The leaf holds the key and a TID — a heap page number and an offset — and not the row itself.',
        ...LOOKUP,
        dir: [0.5, 0.55, 1],
        dist: 7.0,
        fov: 36,
        send: 1,
        delay: 900,
        speed: 0.4,
        expect: (c) => c.idxStage === Stage.Leaf && c.idxPages >= 3,
        waitFor: 'the leaf page that holds the key',
        freezeAt: Stage.Leaf,
        assert: frozeIndexAfter(Stage.Leaf, 'the leaf page', 3),
    },
    {
        title: 'the TID is a second file to read',
        body: 'The leaf gives an address, so the row is one more page away, in the heap. Cold, that page is not in memory: it is read from disk into a buffer slot, and the tuple at that offset is checked against the snapshot. Three index pages plus one heap page is what an index scan costs when nothing is cached.',
        ...LOOKUP,
        dir: [0.45, 0.5, 1],
        dist: 7.4,
        fov: 38,
        send: 1,
        delay: 900,
        speed: 0.4,
        expect: (c) => c.idxStage === Stage.Slot && c.idxDisk >= 4 && c.idxTuples === 1,
        waitFor: 'the heap page in a buffer slot',
        freezeAt: Stage.Slot,
        assert: (c) => {
            const why = frozeIndexAt(Stage.Slot, 'the fetched heap page')(c)
            if (why) return why
            if (c.idxDisk < 4) return `${c.idxDisk} disk reads, not the 3 index pages plus the heap`
            return null
        },
    },
    {
        title: 'back to the executor with one row',
        body: 'The tuple comes back to the executor, which is where the plan meets actual data: qualifiers are rechecked against the snapshot, projections are evaluated, and the row is handed to the connection protocol. An index scan can be wrong about a row — the index told it where to look, not what it will find — so this check is not a formality.',
        ...LOOKUP,
        dir: [0.5, 0.45, 1],
        dist: 12.5,
        fov: 42,
        send: 1,
        delay: 900,
        speed: 0.45,
        expect: (c) => c.idxStage === Stage.Exec && c.idxTuples === 1,
        waitFor: 'the executor with the row',
        freezeAt: Stage.Exec,
        assert: frozeIndexAt(Stage.Exec, 'the executor'),
    },
    {
        title: 'the row leaves, the pages stay',
        body: 'The answer goes back out through the same connection it arrived on. A read writes nothing and takes no lock — but it does leave the three index pages and the heap page in shared_buffers, which is exactly what makes the next identical lookup cheap.',
        ...LOOKUP,
        dir: [0.55, 0.5, 1],
        dist: 13.0,
        fov: 40,
        send: 1,
        delay: 900,
        speed: 0.45,
        expect: (c) => c.idxStage === Stage.Reply,
        waitFor: 'the answer leaving the socket',
        freezeAt: Stage.Reply,
        assert: frozeIndexAt(Stage.Reply, 'the reply at the socket'),
    },
    {
        title: 'the same statement, warm',
        body: 'The client sends it again, and this time nothing is read from disk. The same three index pages and the same heap page are already in shared_buffers, so each stop is a pin and an unpin of memory — microseconds instead of milliseconds. That is the whole difference between the first lookup after a restart and every one after it.',
        ...LOOKUP,
        dir: [0.5, 0.55, 1],
        dist: 7.0,
        fov: 36,
        send: 1,
        delay: 900,
        speed: 0.4,
        cold: false,
        expect: (c) => c.idxStage === Stage.Leaf && c.idxDisk === 0 && c.idxHits >= 3,
        waitFor: 'the leaf reached without a disk read',
        freezeAt: Stage.Leaf,
        assert: (c) => {
            const why = frozeIndexAfter(Stage.Leaf, 'the warm leaf page', 3)(c)
            if (why) return why
            if (c.idxDisk !== 0) return `${c.idxDisk} disk reads on a warm cache`
            return null
        },
    },
]

export const BTREE_STORY: StoryDef = {
    id: 'btree',
    label: 'b-tree lookups',
    hint: 'socket → parser → planner → executor → root, internal, leaf → heap page → back out',
    steps,
}
