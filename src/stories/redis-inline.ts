import type { StoryStep } from './types'

/**
 * One lookup, end to end — the whole path a single GET takes.
 *
 * The point of the story is the ORDER, which is easy to get backwards: the
 * request arrives on a socket and waits in the queue; the one thread takes it;
 * the key is hashed to a bucket; the bucket points at a page in the heap; and
 * only on that page can the object header be read — which is how the server
 * learns the type, and sees that this payload is int or embstr rather than an
 * address. Then the reply goes back out the way it came. For an inline value
 * that is the whole trip: one page, one object, no second structure.
 *
 * Two steps, one request each, at 0.4× so the legs can be followed.
 */
export const REDIS_INLINE_STORY: StoryStep[] = [
    {
        title: 'socket → queue → loop',
        body: 'A client sends GET. The bytes enter a connection’s input buffer, the thread reads them on its next pass over epoll, and the parsed command joins the shared queue — where it waits for the one thread that drains it. Nothing has been looked up yet: the server has a key name and nothing else. This is the part that gets skipped when people say redis is a hash table — every lookup is preceded by a socket read and a place in the queue.',
        subject: (s) => s.redisRide?.() ?? null,
        dir: [0.55, 0.5, 1],
        dist: 11,
        fov: 42,
        tap: 'redis',
        op: 'object',
        send: 1,
        sustain: 1,
        sustainWhileOpen: true,
        delay: 600,
        speed: 0.4,
        expect: (c) => c.rdOps > 0,
        waitFor: 'a request on its way in',
    },
    {
        title: 'bucket → page → object → back out',
        body: 'The thread hashes the key to a bucket — 8 bytes in one array — and the bucket points at a page. Only there is anything known: the dictEntry on that page holds the key and the value pointer, and the object header it points at carries the type and the encoding. Reading it says `int` or `embstr`, which means the payload is inside the same allocation, so there is no second structure to visit. The reply turns round, climbs back to the loop, joins the connection’s output buffer and leaves the way the request came in. One page, one object, no traversal — and that is exactly where every big value differs: they continue into the heap, this one stops here.',
        subject: (s) => s.redisRide?.() ?? null,
        dir: [0.55, 0.5, 1],
        dist: 11,
        fov: 42,
        tap: 'redis',
        op: 'object',
        send: 1,
        sustain: 1,
        sustainWhileOpen: true,
        delay: 600,
        speed: 0.4,
        expect: (c) => c.rdOps > 0,
        waitFor: 'the lookup and its reply',
    },
]
