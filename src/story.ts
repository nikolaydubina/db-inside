import * as THREE from 'three'
import type { CameraPose, CameraRig } from './views'
import type { EngineSim, SimStats } from './sim'

/**
 * Story mode: a short guided sequence. Each step cuts to a camera view, says
 * one thing, and can fire real taps so the point is something you watch happen
 * rather than something you read.
 *
 * Deliberately no camera drift while a story runs — the scene is already busy,
 * and a moving frame on top of it makes the captions hard to follow.
 *
 * Every step also carries an `expect` predicate. That is not decoration: a
 * caption must be true of the scene at the time it is shown, so the claim is
 * measured against live simulation state and surfaced in the panel and through
 * `audit()`. If a step ever stops matching, it says so instead of lying.
 */

/**
 * The write-ahead log. The interesting claim is not "there is a log" but the
 * ordering rule: the record describing a change reaches durable storage before
 * the page it changes ever could, and a commit is exactly the wait for that.
 */
export const WAL_STORY: StoryStep[] = [
    {
        title: 'a log beside the data',
        body: 'PostgreSQL never writes a changed page straight to disk. Every change is first appended to this run of 16 MB segment blocks — the write-ahead log. If the server dies mid-write, the log is what it replays to rebuild the data files.',
        subject: (s) => ({ id: 'wal run', box: s.walRun() }),
        dir: [0.15, 0.6, 1],
        fov: 30,
        padding: 1.25,
        expect: (c) => c.walSegments >= 1,
        waitFor: 'at least one segment in use',
    },
    {
        title: 'the head moves',
        body: 'Records are appended at the head, and the head walks along the run as segments fill. Only the tail is active; everything behind it is already written. When the head reaches the end it wraps to the start and writes over the oldest segment — which is why pg_wal never grows without bound.',
        subject: (s) => s.walHead(),
        dir: [0.2, 0.5, 1],
        fov: 26,
        padding: 6.6,
        lookShift: [0, -0.5, 0],
        send: 6,
        delay: 700,
        sustain: 4,
        speed: 4,
        expect: (c) => c.walSegments >= 3,
        waitFor: 'the run filling past the third segment',
    },
    {
        title: 'wal_buffers is memory',
        body: 'The newest records sit in wal_buffers — a small circular strip of shared memory above the head, not on disk. These cubes are a staging area: if the machine loses power now, everything in them is gone. That is why they float.',
        subject: (s) => ({ id: 'wal_buffers', box: s.walBuffers() }),
        dir: [0, 0.42, 1],
        fov: 26,
        padding: 1.35,
        lookShift: [0, -0.55, 0],
        send: 6,
        delay: 450,
        speed: 3,
        expect: (c) => c.walPending > 0,
        waitFor: 'bytes sitting in the in-memory buffer',
    },
    {
        title: 'commit waits for the flush',
        body: 'COMMIT does not return when the statement finishes — it returns when the log up to that commit record has been written and fsynced. That fsync is the durability guarantee, and it is also why synchronous commits cost what they do.',
        subject: (s) => ({ id: 'wal_buffers', box: s.walBuffers() }),
        dir: [0, 0.42, 1],
        fov: 26,
        padding: 1.35,
        lookShift: [0, -0.55, 0],
        act: (s) => {
            void s.flush()
        },
        delay: 600,
        speed: 2,
        expect: (c) => c.walBytes > 0 && c.walPending === 0,
        waitFor: 'the buffer tail forced to disk',
    },
    {
        title: 'checkpoint recycles the run',
        body: 'A checkpoint flushes everything, marks the data files consistent, then recycles the old segments: they are overwritten in place, never moved elsewhere. The run does not grow forever — it comes back around to the start.',
        subject: (s) => ({ id: 'wal run', box: s.walRun() }),
        dir: [0.15, 0.6, 1],
        fov: 30,
        padding: 1.25,
        act: (s) => {
            void s.checkpoint()
        },
        delay: 500,
        speed: 2,
        expect: (c) => c.walSegments <= 2,
        waitFor: 'old segments recycled back to the start',
    },
]

/** The slice of simulation state a caption is allowed to talk about. */
export type StoryFacts = Pick<
    SimStats,
    | 'connections'
    | 'maxConnections'
    | 'busyBackends'
    | 'buffered'
    | 'queued'
    | 'rps'
    | 'queries'
    | 'walBytes'
    | 'walSegments'
    | 'walPending'
> & {
    /**
     * The redis cage. A story that happens over there measures its own claims
     * there, and the postgres numbers are still available — which is what a
     * story about both cages will need.
     */
    rdKeys: number
    rdOps: number
    rdRps: number
    bigKeys: number
    hotKeys: number
}

/**
 * What the camera can be pointed at. The story asks for a *subject* — the whole
 * instance, the port strip, whichever connection is executing right now — and
 * never for a camera position or a pod index. That means a step cannot drift
 * out of step with the scene: when the busiest backend changes, so does the
 * shot, and a test can read back exactly what was framed.
 */
export interface StorySubject {
    /** stable id, for the audit and for tests */
    id: string
    box: THREE.Box3
}

export interface StoryScene {
    /** the whole instance */
    overview(): THREE.Box3
    /** every open connection port, as one box */
    ports(): THREE.Box3
    /** the connection that is executing right now, preferring one with work buffered */
    executing(): StorySubject | null
    /** is an already-locked subject still worth looking at? */
    valid(id: string): boolean
    /** the on-disk WAL run */
    walRun(): THREE.Box3
    /** the floating wal_buffers cubes */
    walBuffers(): THREE.Box3
    /** the segment being appended to right now */
    walHead(): StorySubject | null
}

export interface StoryStep {
    title: string
    body: string
    /** fixed named view, for shots that are not about one live thing */
    view?: string
    /**
     * The live subject this step is about, resolved every time the step opens.
     * Preferred over `view`: the camera follows what is actually happening.
     */
    subject?: (scene: StoryScene) => StorySubject | null
    /** viewing direction, world space, from the subject towards the camera */
    dir?: [number, number, number]
    fov?: number
    /** extra air around the subject; >1 pulls the camera back */
    padding?: number
    /** shift the aim point, e.g. to lift the subject clear of the caption panel */
    lookShift?: [number, number, number]
    /** how many run-query taps to fire when this step opens */
    send?: number
    /** the taps go to the redis cage instead of the postgres one */
    tap?: 'postgres' | 'redis'
    /** wait before firing, so the caption lands before the motion */
    delay?: number
    /** something to trigger, e.g. a checkpoint */
    act?: (sim: EngineSim) => void
    /**
     * Slider speed to run at while this step is showing. Saturation steps want
     * the clock a few times faster or the pool takes four seconds per query to
     * fill and the caption arrives before the thing it describes.
     */
    speed?: number

    /** the caption is only honest when this holds */
    expect: (c: StoryFacts) => boolean
    /** short description of `expect`, shown while it is not yet true */
    waitFor: string
    /**
     * The subject moves under its own steam (wal_buffers rides the WAL head).
     * Framing it once would leave it behind, so the view pans to keep it in
     * shot — a pan, not a re-frame: re-framing restarts the tween every tick.
     */
    track?: boolean
    /**
     * Taps per second to keep firing until `expect` holds. A single burst is
     * not enough: the pool drains between the burst and the moment somebody
     * reads the caption, and then the step would be describing an empty scene.
     * This is also what "too many requests arrive" actually means — a rate, not
     * a one-off poke. Steps that must be seen draining leave it unset.
     */
    sustain?: number
}

export const QUEUE_STORY: StoryStep[] = [
    {
        title: 'the setup',
        body: 'One PostgreSQL instance, one client pressing run, and six connection slots — max_connections = 6. Everything from here happens inside this one server.',
        view: 'overview',
        expect: (c) => c.connections <= 1,
        waitFor: 'pool back down to one connection',
    },
    {
        title: 'one request, one connection',
        body: 'A tap is sent immediately. The magenta wire is the request, the green one is the answer coming back. One backend picked it up and is executing it; every other slot is idle.',
        subject: (s) => s.executing(),
        dir: [0, 0.25, 1],
        fov: 22,
        padding: 2.4,
        lookShift: [0, -0.8, 0],
        expect: (c) => c.busyBackends === 1,
        waitFor: 'one statement running, everything else idle',
        send: 1,
        delay: 500,
    },
    {
        title: 'more clients connect',
        body: 'More taps reuse idle connections first, then open new ones. Every port is a separate process with its own memory. Six is as many as this server will accept.',
        subject: (s) => ({ id: 'all ports', box: s.ports() }),
        dir: [0, 0.3, 1],
        fov: 36,
        padding: 1.3,
        lookShift: [0, -1.6, 0],
        expect: (c) => c.connections === c.maxConnections,
        waitFor: 'all six connection slots open',
        send: 6,
        delay: 800,
        speed: 2,
    },
    {
        title: 'every connection is busy',
        body: 'All six are executing now. PostgreSQL does not split one connection across cores: a connection runs one statement at a time, in order. Extra requests cannot go faster, only further.',
        subject: (s) => ({ id: 'all ports', box: s.ports() }),
        dir: [0, 0.3, 1],
        fov: 36,
        padding: 1.3,
        lookShift: [0, -1.6, 0],
        expect: (c) => c.busyBackends === c.maxConnections,
        waitFor: 'a statement running on every connection',
        send: 5,
        delay: 800,
        sustain: 4,
        speed: 3,
    },
    {
        title: 'waiting in the input buffer',
        body: 'Each backend reads ahead into a buffer in its own process memory — the violet cells. Those requests have already arrived and are queued there. That is private heap, not shared_buffers, and no other backend can see it.',
        // the busiest connection: the one with the most cells actually lit
        subject: (s) => s.executing(),
        dir: [0, 0.25, 1],
        fov: 22,
        padding: 2.4,
        lookShift: [0, -0.8, 0],
        expect: (c) => c.buffered >= 2,
        waitFor: 'requests waiting in input buffers',
        send: 4,
        delay: 800,
        sustain: 4,
        speed: 3,
    },
    {
        title: 'buffer full — backpressure',
        body: 'When a buffer is full the backend simply stops reading the socket. TCP pushes back, the client\u2019s send() blocks, and the requests pile up as bytes on the wire. Nothing is dropped: there is no server-side queue to overflow.',
        subject: (s) => s.executing(),
        dir: [0, 0.25, 1],
        fov: 22,
        padding: 2.4,
        lookShift: [0, -0.8, 0],
        expect: (c) => c.queued >= 1,
        waitFor: 'bytes blocked in a socket',
        // capacity across the pool is 6 connections × 2 buffered cells, so this
        // has to overshoot it for bytes to actually spill into the sockets
        send: 16,
        delay: 800,
        sustain: 5,
        speed: 3,
    },
    {
        title: 'throughput plateaus',
        body: 'More taps no longer buy more throughput. Six connections at one statement each is the ceiling, so RPS goes flat while latency climbs. The queue you feel is the wait.',
        view: 'overview',
        expect: (c) => c.busyBackends === c.maxConnections && c.queued > 0,
        waitFor: 'every connection at its ceiling, with a backlog',
        send: 4,
        delay: 800,
        sustain: 5,
        speed: 3,
    },
    {
        title: 'and it drains',
        body: 'As each statement finishes, that backend pulls the next bytes out of its buffer — the stack empties from the bottom up. Nothing was ever lost, it was only delayed.',
        subject: (s) => ({ id: 'all ports', box: s.ports() }),
        dir: [0, 0.3, 1],
        fov: 36,
        padding: 1.3,
        lookShift: [0, -1.6, 0],
        expect: (c) => c.queued === 0,
        waitFor: 'the socket backlog to clear',
        speed: 4,
    },
]

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

export interface StoryDef {
    id: string
    label: string
    hint: string
    /** which engine's section this story belongs in */
    db?: 'postgres' | 'redis' | 'both'
    steps: StoryStep[]
}

/**
 * What a cluster accumulates when it runs for a long time without anybody
 * looking. Not playable yet — listed so the gaps are visible instead of
 * implicit, and each one names the state it would have to show.
 */
export const PLANNED_STORIES: { label: string; hint: string; db?: 'postgres' | 'redis' }[] = [
    {
        label: 'a slot that pins the WAL',
        hint: 'an inactive replication slot stops the ring recycling: pg_wal grows until the disk fills',
    },
    {
        label: 'catalog bloat',
        hint: 'repeated create/alter/drop leaves dead tuples in pg_class and pg_attribute; VACUUM reuses the space but the files never shrink',
    },
    {
        label: 'a transaction that never ends',
        hint: 'an old xmin stops VACUUM everywhere: dead tuples pile up in every table and pg_xact cannot be truncated',
    },
    {
        label: 'multixact accumulation',
        hint: 'heavy SELECT … FOR SHARE concurrency grows pg_multixact/members, with its own wraparound hazard',
    },
    {
        label: 'a blocking command',
        hint: 'BLPOP does not stall the server: the client is parked and the thread moves on — unlike KEYS *, which does stall it',
        db: 'redis',
    },
    {
        label: 'MULTI / EXEC and Lua',
        hint: 'queued, then executed in one burst; and BUSY after lua-time-limit, the only reply of its kind redis sends',
        db: 'redis',
    },
    {
        label: 'replication and the backlog',
        hint: 'a replica, PSYNC, and the repl backlog — a fixed-size ring, the one buffer here whose policy is the opposite of a log that only grows',
        db: 'redis',
    },
    {
        label: 'pub/sub',
        hint: 'no keys, no storage, pure fan-out to N sockets: a path that never touches the keyspace or the log',
        db: 'redis',
    },
    {
        label: 'eviction policy',
        hint: 'LRU/LFU sampling: maxmemory-samples keys, the least recently used of the sample, and whether keys with a TTL go first',
        db: 'redis',
    },
    {
        label: 'io-threads',
        hint: 'redis 6+ reads and writes sockets on several threads while command execution stays serial',
        db: 'redis',
    },
]

export const STORIES: StoryDef[] = [
    {
        id: 'queue',
        label: 'too many requests',
        hint: 'what happens when more queries arrive than the connections can run',
        steps: QUEUE_STORY,
    },
    {
        id: 'wal',
        label: 'the write-ahead log',
        hint: 'why a change is written to a log before the page it changes',
        steps: WAL_STORY,
    },
    {
        id: 'skew',
        label: 'one big value',
        db: 'redis',
        hint: 'what a large list, hash or sorted set looks like — and why the one thread makes it hurt',
        steps: REDIS_SKEW_STORY,
    },
]

export interface StoryOptions {
    rig: CameraRig
    sim: EngineSim
    /** resolves live subjects for steps that say "look at whatever is happening" */
    scene: StoryScene
    /**
     * The redis cage, for stories that happen in it. Structural on purpose: a
     * story needs to tap it and read its numbers, and nothing else.
     */
    redis?: {
        runCommand(): void
        stats: { keys: number; ops: number; opsPerSec: number; bigKeys: number; hotKeys: number }
    }
    stories?: StoryDef[]
    /** set the clock speed for steps that ask for one */
    setSpeed?: (v: number) => void
    /** freeze camera drift and ambient traffic while the story runs */
    onEnter?: (story: StoryDef) => void
    onExit?: () => void
}

export function createStory({
    rig,
    sim,
    scene,
    redis,
    stories = STORIES,
    setSpeed,
    onEnter,
    onExit,
}: StoryOptions) {
    const el = document.getElementById('story')
    const titleEl = document.getElementById('story-title')
    const bodyEl = document.getElementById('story-body')
    const stepEl = document.getElementById('story-step')
    const stateEl = document.getElementById('story-state')
    const prevBtn = document.getElementById('story-prev') as HTMLButtonElement | null
    const nextBtn = document.getElementById('story-next') as HTMLButtonElement | null
    const exitBtn = document.getElementById('story-exit') as HTMLButtonElement | null

    let storyId = stories[0]?.id ?? ''
    let steps: StoryStep[] = stories[0]?.steps ?? []
    let index = 0
    let running = false
    /**
     * Set once the camera has actually reached the step's pose. Reset on every
     * step change. This is deliberately measured against the camera rather than
     * trusted from the rig's label: `go()` updates the label immediately but the
     * camera takes 0.85s to fly there, and a clobbered tween used to leave them
     * disagreeing — the panel said "clients" while the frame showed the buffers.
     */
    let arrived = false
    /** the current step's claim has been seen true at least once */
    let demonstrated = false
    /** subject centre at the last follow tick, so a pan covers only the drift */
    let trackCentre: THREE.Vector3 | null = null
    /** what the current step is actually pointed at, and where the camera went */
    let subjectId: string | null = null
    let subjectBox: THREE.Box3 | null = null
    let expected: CameraPose | null = null
    /** bumped on every step change so stale timers cannot fire into a new step */
    let token = 0

    /** The one place step predicates read the world from. */
    const facts = (): StoryFacts => {
        const s = sim.stats
        const r = redis?.stats
        return {
            connections: s.connections,
            maxConnections: s.maxConnections,
            busyBackends: s.busyBackends,
            buffered: s.buffered,
            queued: s.queued,
            rps: s.rps,
            queries: s.queries,
            walBytes: s.walBytes,
            walSegments: s.walSegments,
            walPending: s.walPending,
            rdKeys: r?.keys ?? 0,
            rdOps: r?.ops ?? 0,
            rdRps: r?.opsPerSec ?? 0,
            bigKeys: r?.bigKeys ?? 0,
            hotKeys: r?.hotKeys ?? 0,
        }
    }

    /** One tap, aimed at the cage this step is about. */
    const tap = (step: StoryStep) => {
        if ((step.tap ?? 'postgres') === 'redis') redis?.runCommand()
        else void sim.runQuery()
    }

    /**
     * Is the camera on the right thing, and is the caption true right now?
     * This is the contract the panel displays and that tests assert against.
     */
    const audit = () => {
        const step = steps[index]
        if (!step) return null
        const f = facts()
        // live check against the camera, not against a label
        const onPose = expected ? rig.atPose(expected) : rig.isAt(step.view ?? '')
        if (onPose) arrived = true
        return {
            story: storyId,
            step: index,
            total: steps.length,
            title: step.title,
            view: step.view ?? null,
            /** what was framed — the useful half of this for a test */
            subject: subjectId,
            /** is that subject actually in frame, and how big? */
            framing: subjectBox ? rig.projectBox(subjectBox) : null,
            camera: {
                current: rig.current(),
                onPose,
                arrived,
                pose: expected
                    ? {
                        pos: expected.pos.toArray(),
                        target: expected.target.toArray(),
                    }
                    : null,
            },
            facts: f,
            claim: { holds: step.expect(f), expects: step.waitFor },
            /** the whole step is honest only when both halves hold */
            ok: arrived && step.expect(f),
        }
    }

    const refreshState = () => {
        if (!stateEl) return
        const a = audit()
        if (!a) return
        // latch: some claims are true in pulses (records sitting in wal_buffers
        // drain on the next fsync), and a caption that flips every 200 ms reads
        // as a bug. Once demonstrated, it stays described for this step.
        if (a.claim.holds) demonstrated = true
        // follow a subject that drifts, otherwise it slides out of the frame
        const stepNow = steps[index]
        if (a.camera.arrived && stepNow?.track && subjectId && stepNow.subject) {
            const box = stepNow.subject(scene)?.box
            if (box) {
                const centre = box.getCenter(new THREE.Vector3())
                if (trackCentre) rig.pan(centre.clone().sub(trackCentre).multiplyScalar(0.45))
                trackCentre = centre
                subjectBox = box
            }
        }
        const ok = a.camera.arrived && demonstrated
        stateEl.classList.toggle('ok', ok)
        stateEl.textContent = !a.camera.arrived
            ? `camera → ${a.subject ?? a.view ?? '…'}`
            : !demonstrated
                ? `not yet · ${a.claim.expects}`
                : 'as described'
    }
    window.setInterval(() => {
        if (running) refreshState()
    }, 200)

    const render = () => {
        const step = steps[index]
        if (!step) return
        if (titleEl) titleEl.textContent = step.title
        if (bodyEl) bodyEl.textContent = step.body
        if (stepEl) stepEl.textContent = `${index + 1} / ${steps.length}`
        if (prevBtn) prevBtn.disabled = index === 0
        if (nextBtn) nextBtn.disabled = index === steps.length - 1
        refreshState()
    }

    const play = () => {
        const step = steps[index]
        if (!step) return
        const mine = ++token
        arrived = false
        expected = null
        subjectId = null
        subjectBox = null
        demonstrated = false
        trackCentre = null
        render()
        // a live subject wins over a fixed view: the step says what it is about
        // and the camera goes there — but the thing may not exist yet (nothing
        // is executing the instant a step opens), so keep trying until it does
        if (step.subject) {
            lockOn(step, mine)
        } else if (step.view) {
            subjectId = step.view
            rig.go(step.view)
        }
        if (step.speed) setSpeed?.(step.speed)
    }

    /**
     * Wait for the step's subject to exist, frame it, then hold. It is re-framed
     * only when the locked subject stops being valid — a camera that chases the
     * busiest backend every tick would never sit still long enough to read.
     */
    const lockOn = (step: StoryStep, mine: number) => {
        if (mine !== token || !running) return
        if (subjectId && step.subject && !scene.valid(subjectId)) {
            subjectId = null
            subjectBox = null
            arrived = false
        }
        if (!subjectId) {
            const subj = step.subject?.(scene) ?? null
            if (subj) {
                subjectId = subj.id
                subjectBox = subj.box
                expected = rig.frame(subj.box, step.dir ?? [0, 0.3, 1], {
                    fov: step.fov,
                    padding: step.padding,
                    lookShift: step.lookShift,
                })
            }
        }
        window.setTimeout(() => lockOn(step, mine), 400)
        const n = step.send ?? 0
        if (n <= 0 && !step.sustain && !step.act) return
        window.setTimeout(() => {
            if (mine !== token || !running) return
            for (let i = 0; i < n; i++) tap(step)
            step.act?.(sim)
            hold(mine, step)
        }, step.delay ?? 800)
    }

    /** Keep the client pressing until the step's own claim becomes true. */
    const hold = (mine: number, step: StoryStep) => {
        const rate = step.sustain ?? 0
        if (rate <= 0) return
        const beat = () => {
            if (mine !== token || !running) return
            if (step.expect(facts())) return
            tap(step)
            window.setTimeout(beat, 1000 / rate)
        }
        beat()
    }

    const start = (id?: string) => {
        const def = stories.find((s) => s.id === id) ?? stories[0]
        if (!def) return
        if (running) stop()
        storyId = def.id
        steps = def.steps
        running = true
        index = 0
        if (el) el.hidden = false
        onEnter?.(def)
        play()
    }

    const stop = () => {
        if (!running) return
        running = false
        token++
        if (el) el.hidden = true
        onExit?.()
    }

    const next = () => {
        if (!running || index >= steps.length - 1) return
        index++
        play()
    }

    const prev = () => {
        if (!running || index === 0) return
        index--
        play()
    }

    nextBtn?.addEventListener('click', next)
    prevBtn?.addEventListener('click', prev)
    exitBtn?.addEventListener('click', stop)

    window.addEventListener('keydown', (e) => {
        if (!running) return
        const t = e.target as HTMLElement | null
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
        if (e.key === 'ArrowRight') {
            e.preventDefault()
            next()
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault()
            prev()
        } else if (e.key === 'Escape') {
            e.preventDefault()
            stop()
        }
    })

    return {
        start,
        stop,
        next,
        prev,
        stories,
        steps: () => steps,
        active: () => running,
        index: () => (running ? index : -1),
        storyId: () => (running ? storyId : null),
        /** camera + claim verification for the current step */
        audit,
        /** audit every step of a story without playing it, for tests */
        auditAll(id?: string) {
            const def = stories.find((s) => s.id === id) ?? stories[0]
            if (!def) return []
            const keepSteps = steps
            const keepIndex = index
            const keepId = storyId
            storyId = def.id
            steps = def.steps
            const out = def.steps.map((step, i) => {
                index = i
                const f = facts()
                const subj = step.subject?.(scene) ?? null
                return {
                    step: i,
                    title: step.title,
                    view: step.view ?? null,
                    subject: subj ? subj.id : null,
                    subjectBox: subj
                        ? { min: subj.box.min.toArray(), max: subj.box.max.toArray() }
                        : null,
                    claimHolds: step.expect(f),
                    expects: step.waitFor,
                    facts: f,
                }
            })
            steps = keepSteps
            index = keepIndex
            storyId = keepId
            return out
        },
        /** jump straight to a step — for testing and deep links */
        goto(i: number) {
            if (!running || i < 0 || i >= steps.length) return false
            index = i
            play()
            return true
        },
    }
}

export type Story = ReturnType<typeof createStory>
