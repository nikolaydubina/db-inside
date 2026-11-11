import type { StoryDef, StoryStep } from '../types'
import { Stage } from '../../core/stage'
import { RedisReadOp } from '../../redis/values'
import { Db, DbScope } from '../../core/db'
import { frozeAt } from '../stop'

const steps: StoryStep[] = [
    {
        title: 'socket → queue → loop',
        body: 'A client sends GET. The bytes enter a connection’s input buffer, the thread reads them on its next pass over epoll, and the parsed command joins the shared queue — where it waits for the one thread that drains it. Nothing has been looked up yet: the server has a key name and nothing else. This is the part that gets skipped when people say redis is a hash table — every lookup is preceded by a socket read and a place in the queue.',
        subject: (s) => s.redisRide?.() ?? null,
        dir: [0.55, 0.5, 1],
        dist: 11,
        fov: 42,
        tap: Db.Redis,
        op: RedisReadOp.Object,
        send: 1,
        sustain: 1,
        sustainWhileOpen: true,
        delay: 600,
        speed: 0.4,
        expect: (c) => c.rdPhase !== null,
        waitFor: 'a request on its way in',
        freezeAt: Stage.Socket,
        assert: frozeAt(Stage.Socket, 'the socket the request came in on'),
    },
    {
        title: 'bucket → page → object → back out',
        body: 'The thread hashes the key to a bucket — 8 bytes in one array — and the bucket points at a page. Only there is anything known: the dictEntry on that page holds the key and the value pointer, and the object header it points at carries the type and the encoding. Reading it says `int` or `embstr`, which means the payload is inside the same allocation, so there is no second structure to visit. The reply turns round, climbs back to the loop, joins the connection’s output buffer and leaves the way the request came in. One page, one object, no traversal — and that is exactly where every big value differs: they continue into the heap, this one stops here.',
        subject: (s) => s.redisRide?.() ?? null,

        dir: [0.5, 0.92, 0.86],
        dist: 11,
        fov: 34,
        tap: Db.Redis,
        op: RedisReadOp.Object,
        send: 1,
        sustain: 1,
        sustainWhileOpen: true,
        delay: 600,
        speed: 0.4,
        expect: (c) => c.rdPhase !== null,
        waitFor: 'the object header and its reply',
        freezeAt: Stage.Value,
        assert: frozeAt(Stage.Value, 'the object header that carries the encoding'),
    },
    {
        title: 'and back out through the socket',
        body: 'The lookup is over and nothing else was touched: one bucket, one page, one object. The reply climbs back out of the arena to the command loop and leaves through the socket the request came in on, and the client has its answer. That is the whole trip for a compact value — and it is why small values are cheap: the read never left the page it landed on, so the walk that the big-value stories spend thousands of hops on is here exactly zero. The camera comes back out with it: the same cue that flew into the block pulls away again as the packet leaves the heap.',
        subject: (s) => s.redisRide?.() ?? null,

        dir: [0.55, 0.5, 1],
        dist: 11,
        fov: 42,
        tap: Db.Redis,
        op: RedisReadOp.Object,
        send: 1,
        sustain: 1,
        sustainWhileOpen: true,
        delay: 600,
        speed: 0.4,
        expect: (c) => c.rdPhase !== null,
        waitFor: 'the reply back at the socket',
        freezeAt: Stage.Reply,
        assert: frozeAt(Stage.Reply, 'the answer, back at the socket it came in on'),
    },
]

export const REDIS_INLINE_STORY: StoryDef = {
    id: 'inline',
    label: 'inline values',
    hint: 'the values that end inside their own 16-byte object: int, embstr, shared ints',
    db: DbScope.Redis,
    steps,
}
