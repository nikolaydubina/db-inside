import * as THREE from 'three'
import type { EngineSim, SimStats } from '../postgresql/sim'

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
}

/**
 * The legs of a published message: down into a socket, at the channel where the
 * subscriber list is walked, and delivered into one listener's output buffer.
 */
export type RidePhase = 'socket' | 'channel' | 'delivered' | null

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
     * The copy of a publish that is in flight, if one is.
     *
     * The redis cage has no live subjects of its own, so a step that wants to ride
     * a packet asks for this: it appears when a PUBLISH starts, moves through the
     * cage, and is null again the instant the bytes leave — which is how the step
     * knows to wait for the next one.
     */
    redisPacket?: () => StorySubject | null
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

export interface StoryDef {
    id: string
    label: string
    hint: string
    /** which engine's section this story belongs in */
    db?: 'postgres' | 'redis' | 'both'
    steps: StoryStep[]
}
