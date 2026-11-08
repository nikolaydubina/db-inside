import type { StoryStep } from './types'

/**
 * Pub/sub: the life of one message.
 *
 * A published message exists for the length of one walk down a list of sockets, so
 * this story is about a route rather than a structure — it starts at a socket like
 * every other command, reaches the channel (a name, not a key), is copied once per
 * listener, and leaves. The list has to be built by somebody, which is why the
 * second step is the SUBSCRIBE that puts a socket on it.
 *
 * Steps 3 to 5 are one message, not three. Each resumes the clock, waits for the
 * packet to reach the leg its caption names, and freezes again — so the drawing
 * is showing the exact instant being described instead of racing past it. That is
 * what `freezeAt` is for, and it is why only the first of them publishes.
 *
 * Captions are about the server, not about the drawing: what a command does, what
 * it costs, what it leaves behind. Nobody needs telling that the clock is slow or
 * which way the camera is pointed — they can see both.
 */
export const REDIS_PUBSUB_STORY: StoryStep[] = [
    {
        title: 'a channel with nobody on it',
        body: 'PUBLISH is addressed to a channel, not to a key. A channel is a name in its own dictionary — pubsub_channels — and the only thing hanging off that name is a list of connected sockets. Here the list is empty, and publishing to an empty list is not an error in Redis: the command succeeds and reaches nobody. That is the difference between this and a write: nothing is created to hold the message.',
        view: 'redis-pubsub',
        expect: (c) => c.rdSubs === 0,
        waitFor: 'an empty channel',
    },
    {
        title: 'a client subscribes',
        body: 'SUBSCRIBE is an ordinary command: it arrives on a socket, waits in the shared queue, and the one thread runs it. What it does is add that connection\u2019s file descriptor to the channel\u2019s list. From that moment the connection is in subscriber mode — it may only SUBSCRIBE, UNSUBSCRIBE and PING — so this server will never run a GET for it, which is why a subscriber is not a key-space client at all.',
        view: 'redis-pubsub',
        subscribe: true,
        delay: 600,
        expect: (c) => c.rdSubs >= 1,
        waitFor: 'a socket joining the channel',
    },
    {
        title: 'a broadcast message arrives',
        body: 'PUBLISH comes in on a socket like any other command, and then it sits in that socket\u2019s input buffer until the one thread comes round to it. Nothing about it is looked up in the keyspace: no key is hashed, no bucket is probed, no page is read. The name in the command is the channel, and the channel is a list of sockets — so the work ahead is a walk down that list, not a lookup.',
        subject: (s) => s.redisPacket?.() ?? null,
        dir: [0.62, 0.4, 1],
        fov: 32,
        dist: 12,
        speed: 0.25,
        publish: true,
        delay: 500,
        freezeAt: 'socket',
        expect: (c) => c.rdPhase === 'socket',
        waitFor: 'the command waiting in a socket',
    },
    {
        title: 'the thread makes one copy per listener',
        body: 'The message reaches the channel and the list is walked: for every socket on it the thread writes the same bytes into that connection\u2019s output buffer, one after another, on the single thread. They are copies, not a shared object — each listener gets its own. That is also the cost model: a thousand subscribers is a thousand writes by the one thread, so a fan-out is not free just because nothing is stored.',
        subject: (s) => s.redisPacket?.() ?? null,
        dir: [0.62, 0.4, 1],
        fov: 36,
        dist: 18,
        speed: 0.25,
        freezeAt: 'channel',
        expect: (c) => c.rdPhase === 'channel',
        waitFor: 'the subscriber list being walked',
    },
    {
        title: 'the copy leaves for its client',
        body: 'The bytes do not stop at the socket. They sit in that connection\u2019s output buffer until the kernel takes them, and the thread moves on without waiting for the client to read. So a listener that reads slower than the publish rate makes its own buffer grow, and the limit on that growth is client-output-buffer-limit: past it Redis closes the connection rather than hold an unbounded copy for one slow client.',
        subject: (s) => s.redisPacket?.() ?? null,
        dir: [0.62, 0.4, 1],
        fov: 38,
        dist: 22,
        speed: 0.25,
        freezeAt: 'delivered',
        expect: (c) => c.rdPhase === 'delivered',
        waitFor: 'the copy in a listener\u2019s output buffer',
    },
    {
        title: 'and nothing is left behind',
        body: 'No key was created, nothing was appended to the AOF, nothing reached the dump. The reply the publisher gets is a number: how many clients the message reached. A listener that was not on the list at that instant never learns the message existed — there is no backlog, no replay, no acknowledgement. Holding bytes for a client that fell behind is a different structure with a different policy: the replication backlog.',
        view: 'redis-pubsub',
        speed: 1,
        delay: 700,
        expect: (c) => c.rdPhase === null && c.rdFanouts >= 1,
        waitFor: 'the message leaving nothing behind',
    },
]
