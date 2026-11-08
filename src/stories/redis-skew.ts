import type { StoryStep } from './types'

/**
 * The skew: a real keyspace is not a uniform field of keys. Most of it is small
 * entries, a few values are so large that they are their own data structure, and
 * a handful of small keys take most of the traffic. Every claim here is measured
 * against the redis cage's own counters, so a step cannot describe a shape the
 * drawing does not have.
 */
export const REDIS_SKEW_STORY: StoryStep[] = [
    {
        title: 'a field of small keys',
        body: 'This plane is the keyspace, and nearly all of it is small: a string, a short hash, a list with a few dozen elements. Each block is one key — a dict entry, a key string and a value object, a few hundred bytes. This is what a keyspace looks like when it is mostly fine.',
        view: 'redis-keys',
        expect: (c) => c.rdKeys > 40,
        waitFor: 'the keyspace to fill',
    },
    {
        title: 'and a few very large values',
        body: 'Three keys in here are not small, and they are not drawn as blocks: at the back of the cage are a hash, a sorted set and a list that have grown into their own structures. Same keyspace, same dict, same single thread — the difference is only how much one command against one of them can cost.',
        view: 'redis-skew',
        tap: 'redis',
        delay: 500,
        expect: (c) => c.bigKeys >= 2,
        waitFor: 'the large values drawn as areas',
    },
    {
        title: 'a sorted set is a tower',
        body: 'ZADD does not keep a list and sort it. It builds a skiplist: every member sits on the bottom level, and each one is promoted a few levels higher with probability 1/4, so the top level skips over almost all of it. That is why ZRANGEBYSCORE finds its starting point in a handful of hops, and why a range read is cheap even at 1.4 million members. The plate beside the tower is the second half of the same value: a dict answering "what score does this member have" in O(1).',
        view: 'big-zset',
        tap: 'redis',
        send: 4,
        delay: 600,
        sustain: 3,
        expect: (c) => c.bigKeys >= 2 && c.rdOps > 0,
        waitFor: 'commands running against the cage',
    },
    {
        title: 'a hash is a bucket array',
        body: 'The big hash is the ordinary hashtable, just large: hash the field, land on a bucket, follow the chain. Nothing about it changes with size except the amount a single command has to touch — HGETALL here walks five million fields, and it does so on the one thread, with every other client parked. That is the real cost of a big key, and it has nothing to do with disk.',
        view: 'big-hash',
        tap: 'redis',
        delay: 500,
        expect: (c) => c.bigKeys >= 2,
        waitFor: 'the large values drawn as areas',
    },
    {
        title: 'a list is a chain',
        body: 'A long list is a quicklist: a linked chain of nodes, each one a small listpack. Pushing at either end is O(1) — a new element goes into the head or tail node. Reading the middle is not: it walks the chain from whichever end is closer, through nodes that are nowhere near each other in memory. The long gap in this chain is where the drawing stops; the real one runs on for tens of thousands of nodes.',
        view: 'big-list',
        tap: 'redis',
        delay: 500,
        expect: (c) => c.bigKeys >= 2,
        waitFor: 'the large values drawn as areas',
    },
    {
        title: 'the hot key',
        body: 'Back on the plane, four of these little blocks carry most of the reads. They are nothing special in memory — that is exactly the point, and exactly the problem: a keyspace of a million entries can put most of its requests through one 200-byte value, on one thread. Watch which blocks keep lighting up.',
        view: 'redis-keys',
        tap: 'redis',
        send: 10,
        delay: 500,
        sustain: 4,
        expect: (c) => c.hotKeys >= 3 && c.rdOps > 0,
        waitFor: 'the hot keys taking the traffic',
    },
    {
        title: 'one command, millions of entries',
        body: 'Everything here is one thread, so a command against a big value is not a slow response — it is a pause for everyone. The queue behind it does not drain while it runs. That is the whole trade of a skew: you cannot fix it with a bigger connection pool, only by not doing it.',
        view: 'big-zset',
        tap: 'redis',
        send: 6,
        delay: 600,
        sustain: 4,
        expect: (c) => c.rdOps > 0,
        waitFor: 'commands running against the cage',
    },
]
