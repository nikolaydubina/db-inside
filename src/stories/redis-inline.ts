import type { StoryStep } from './types'
import { frozeAt } from './stop'

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
 *
 * Three cards: in through the socket, into the open page, back out again. The
 * last one exists because a story that stops on the object leaves the reader in
 * a heap block with no way forward — a read has to come back, and that return leg
 * is where the depth-driven camera pulls out again.
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
        expect: (c) => c.rdPhase !== null,
        waitFor: 'a request on its way in',
        freezeAt: 'socket',
        assert: frozeAt('socket', 'the socket the request came in on'),
    },
    {
        title: 'bucket → page → object → back out',
        body: 'The thread hashes the key to a bucket — 8 bytes in one array — and the bucket points at a page. Only there is anything known: the dictEntry on that page holds the key and the value pointer, and the object header it points at carries the type and the encoding. Reading it says `int` or `embstr`, which means the payload is inside the same allocation, so there is no second structure to visit. The reply turns round, climbs back to the loop, joins the connection’s output buffer and leaves the way the request came in. One page, one object, no traversal — and that is exactly where every big value differs: they continue into the heap, this one stops here.',
        subject: (s) => s.redisRide?.() ?? null,
        // One standoff for the whole card: the camera no longer dives into the page,
        // because what a read is doing is legible from the structure it picks up at
        // the value stop and the colour it turns on the way home.
        dir: [0.5, 0.92, 0.86],
        dist: 11,
        fov: 34,
        tap: 'redis',
        op: 'object',
        send: 1,
        sustain: 1,
        sustainWhileOpen: true,
        delay: 600,
        speed: 0.4,
        expect: (c) => c.rdPhase !== null,
        waitFor: 'the object header and its reply',
        freezeAt: 'value',
        assert: frozeAt('value', 'the object header that carries the encoding'),
    },
    {
        title: 'and back out through the socket',
        body: 'The lookup is over and nothing else was touched: one bucket, one page, one object. The reply climbs back out of the arena to the command loop and leaves through the socket the request came in on, and the client has its answer. That is the whole trip for a compact value — and it is why small values are cheap: the read never left the page it landed on, so the walk that the big-value stories spend thousands of hops on is here exactly zero. The camera comes back out with it: the same cue that flew into the block pulls away again as the packet leaves the heap.',
        subject: (s) => s.redisRide?.() ?? null,
        // the reply is a leg across the cage, at the same standoff as the rest
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
        expect: (c) => c.rdPhase !== null,
        waitFor: 'the reply back at the socket',
        freezeAt: 'reply',
        assert: frozeAt('reply', 'the answer, back at the socket it came in on'),
    },
]
