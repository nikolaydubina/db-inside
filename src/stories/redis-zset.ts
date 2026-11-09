import type { StoryStep } from './types'
import { frozeAt, frozeAtCell } from './stop'

/**
 * A sorted set, followed: the point lookup and the range scan.
 *
 * A converted zset is two structures — a dict for "what score does this member
 * have" and a skiplist for the ordering — and the two reads that matter take a
 * different one. ZSCORE is a hash lookup inside the value (not inside the
 * keyspace), so it ends after one bucket and one page. ZRANGEBYSCORE starts at a
 * level and then walks the bottom list, and every node it lands on is a separate
 * allocation. Neither read touches the whole value.
 */
export const REDIS_ZSET_STORY: StoryStep[] = [
    {
        title: 'two structures, one value',
        body: 'A sorted set is not a list that happens to be ordered. It is a twin: a skiplist for anything that depends on order, and a dict for anything that depends on a member. Both hang off the same value object, both are allocations in the heap, and the dict’s array is as real as the tower. That is what the two halves of this drawing are — not a decoration of one structure, but the two structures the value actually is.',
        subject: (s) => s.redisRide?.() ?? null,
        dir: [0.55, 0.5, 1],
        dist: 12,
        fov: 42,
        tap: 'redis',
        big: 'zset',
        op: 'point',
        send: 1,
        sustain: 1,
        sustainWhileOpen: true,
        delay: 600,
        speed: 0.4,
        expect: (c) => c.rdPhase !== null && c.bigKeys >= 2,
        waitFor: 'the value with its two halves in view',
        freezeAt: 'value',
        assert: frozeAt('value', 'the value object with its two halves'),
    },
    {
        title: 'ZSCORE: one member, one bucket',
        body: 'Five stops, same as a hash. The keyspace bucket the key hashed to; the page the keyspace entry sits on; this cage; the dict plate beside the tower, where the member hashes to one bucket; and the page holding that member’s entry. The tower is never touched — that is what makes a point read O(1) inside a value of a million members.',
        subject: (s) => s.redisRide?.() ?? null,
        dir: [0.55, 0.5, 1],
        dist: 10,
        fov: 40,
        tap: 'redis',
        big: 'zset',
        op: 'point',
        send: 1,
        sustain: 1,
        sustainWhileOpen: true,
        delay: 600,
        speed: 0.4,
        expect: (c) => c.rdPhase !== null,
        waitFor: 'the bucket the member hashed to',
        freezeAt: 'field',
        assert: frozeAt('field', 'the bucket the member hashed to'),
    },
    {
        title: 'ZRANGEBYSCORE: find a start, then walk',
        body: 'A range cannot be answered by hashing, so it takes the tower. The read finds its starting node by following the top level down — a few hops that skip most of the set — and then walks the bottom level, one node at a time, until the score range ends. The tower of the node it is on lights up with it, and the links behind it stay lit: that trail is the part of the set the range has already read. Every node it lands on was allocated on its own, so each step is a pointer to an unrelated page: the packet stopping at each node and each page IS the cost. It is proportional to what the range returns, not to the size of the set.',
        subject: (s) => s.redisRide?.() ?? null,
        dir: [0.55, 0.5, 1],
        dist: 13,
        fov: 44,
        tap: 'redis',
        big: 'zset',
        op: 'walk',
        send: 1,
        sustain: 1,
        sustainWhileOpen: true,
        delay: 600,
        speed: 0.4,
        expect: (c) => c.rdPhase !== null,
        waitFor: 'a range walking the tower',
        freezeAt: 'node',
        freezeAtStep: 2,
        assert: frozeAtCell('node', 'a node partway along the bottom level', 2),
    },
    {
        title: 'and the one thread pays for it',
        body: 'Both reads happen on the same thread as everything else, so the walk is not just this client waiting: it is the queue waiting. A range that returns a lot of members is a long walk, and a long walk is a stall. Nothing here touches disk, so a bigger instance does not help and neither does a faster disk — the only fixes are a smaller range, a smaller value, or not doing it on the thread that serves everyone.',
        subject: (s) => s.redisRide?.() ?? null,
        dir: [0.55, 0.5, 1],
        dist: 13,
        fov: 44,
        tap: 'redis',
        big: 'zset',
        op: 'walk',
        send: 1,
        sustain: 1,
        sustainWhileOpen: true,
        delay: 600,
        speed: 0.4,
        expect: (c) => c.rdPhase !== null,
        waitFor: 'the walk still running on the one thread',
        freezeAt: 'node',
        assert: frozeAt('node', 'a node of the walk, one thread still inside it'),
    },
]
