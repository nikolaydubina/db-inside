import * as THREE from 'three'
import type { EngineSim, SimStats } from '../postgresql/sim'
import type { BigKind } from '../redis/redis'

/**
 * The shapes a story is written in.
 *
 * Only the types live here, so a story file imports what it must describe and
 * nothing else: no runner, no DOM, no camera. That is what keeps a story a
 * piece of prose about the server rather than a piece of UI.
 */

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
    /** sockets in subscriber mode */
    rdSubs: number
    /** PUBLISH commands run so far */
    rdFanouts: number
    /**
     * Which leg of its route the message a step is riding is on, if one is being
     * ridden at all. It is how a step that froze the clock knows the clock can
     * stay frozen: the caption and the picture are about the same instant.
     */
    rdPhase: RidePhase
    /**
     * How far the ridden object is from the point its current leg ends at, in cage
     * units — null when there is no ride, or when the leg is one in the air rather
     * than a stop. A frozen step whose caption names a place is only honest when
     * this is ~0, and the number is what makes that checkable.
     */
    rdStopGap: number | null
}

/**
 * The legs of a published message: down into a socket, at the channel where the
 * subscriber list is walked, and delivered into one listener's output buffer.
 *
 * A cued command reuses the same ride and adds its address chain. The stops are
 * named after the thing the packet is standing on, not after a position in the
 * route, because the routes are not the same length: a compact string is bucket →
 * page → value, while a big hash point read is bucket → page → value → the
 * value's own bucket array → the field's bucket → that entry's page. Naming by
 * index once put a caption about the bucket array on a freeze two stops early.
 */
export type RidePhase =
    | 'socket'
    | 'channel'
    | 'delivered'
    /** the keyspace bucket the key hashed to */
    | 'bucket'
    /** the heap page an entry sits on */
    | 'page'
    /** the dictEntry itself, when the entry cube is drawn */
    | 'entry'
    /** the value object, where the encoding is read */
    | 'value'
    /** the value's OWN bucket array — a second hash table, inside the value */
    | 'inner'
    /** the bucket inside that inner table that the field or member hashes to */
    | 'field'
    /** a node of a big value: a list node, a skiplist node, a field's entry */
    | 'node'
    /** the page such a node was allocated on: the pointer chase, made visible */
    | 'hop'
    | 'reply'
    | null

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
    /**
     * The object itself, when the subject is a thing that moves.
     *
     * A box describes where something was when it was measured. A packet is a node
     * in the scene with a position of its own, so a step can hand the camera the
     * object and let the rig's own follow keep it framed — the way a dragged cage
     * or a drifting buffer strip is already held.
     */
    object?: THREE.Object3D
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
    /**
     * The packet a story may ride, if one is in the air.
     *
     * Both kinds of ride surface here: a published message (socket → channel → a
     * listener) and a cued command (socket → queue → loop → bucket → page →
     * value → reply). The camera holds on to the object, so one caption can follow
     * a single request from the socket to the way out.
     */
    redisRide?: () => StorySubject | null
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
    /**
     * How far to sit from a subject that is an OBJECT rather than a box — a packet,
     * in practice. A packet is a quarter of a unit across, so "fit it in frame"
     * means standing on top of it; the standoff is the shot.
     */
    dist?: number
    /** shift the aim point, e.g. to lift the subject clear of the caption panel */
    lookShift?: [number, number, number]
    /** how many run-query taps to fire when this step opens */
    send?: number
    /** the taps go to the redis cage instead of the postgres one */
    tap?: 'postgres' | 'redis'
    /**
     * Keep publishing to the channel while this step is open.
     *
     * A publish is over in about a second, and a caption about a fan-out that has
     * already faded is a caption about nothing — so the step asks for the command
     * rather than hoping the 7 % of the mix that publishes comes round.
     */
    publish?: boolean
    /**
     * Have a client send SUBSCRIBE, so the step can show how a socket becomes a
     * listener. Once per step: a socket cannot subscribe twice.
     */
    subscribe?: boolean
    /**
     * Aim this step's taps at one of the big values instead of the ambient mix.
     *
     * A caption about walking a quicklist cannot wait for the 8 % of reads that
     * happen to land on a big key, so the step names the value and the sim runs a
     * range read against it — the ordinary path, with the key forced.
     */
    big?: BigKind
    /**
     * Which read of that value: a point lookup (ZSCORE, HGET) or a walk (a range
     * scan, an HGETALL). Two different routes, and the story is about the
     * difference — so the step says which one it means.
     */
    op?: 'point' | 'walk' | 'object'
    /**
     * Keep tapping for as long as the step is open, instead of stopping once the
     * claim has been seen true.
     *
     * `sustain` exists to make a claim come true; a caption about something
     * CONTINUOUS — a walk that happens on every read — needs the motion to go on
     * after the first one, or the reader arrives at a still frame.
     */
    sustainWhileOpen?: boolean
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
    /**
     * Stop the clock the moment the ridden message reaches this leg of its route.
     *
     * One publish can then be walked through several steps instead of each step
     * racing a message that has already gone: the step resumes the clock, waits
     * for the message to arrive where its caption says it is, and freezes again.
     * The next step starts with the same object still in the air.
     */
    freezeAt?: Exclude<RidePhase, null>
    /**
     * What the FROZEN instant must show, in words — or why it does not.
     *
     * `freezeAt` says which stop to wait for and this says what the caption then
     * claims is on screen, which catches the case where the two agree on a label
     * and disagree about the picture. When it returns a string the panel shows
     * `wrong instant · <that>` and the step never reports itself as described, so a
     * drifted stop is a visible failure instead of a plausible drawing.
     */
    assert?: (c: StoryFacts) => string | null

    /**
     * The caption is only honest when this holds.
     *
     * A step that freezes the clock is mid-command BY DEFINITION, so a claim about
     * the command having finished (`rdOps > 0`) is false at exactly the instant the
     * caption describes — the panel sat on `not yet` while the picture was already
     * right. A claim on such a step belongs to the frozen instant: where the packet
     * is, what the drawing shows.
     */
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

export interface StoryDef {
    id: string
    label: string
    hint: string
    /** which engine's section this story belongs in */
    db?: 'postgres' | 'redis' | 'both'
    steps: StoryStep[]
}
