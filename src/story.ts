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

/** The slice of simulation state a caption is allowed to talk about. */
export type StoryFacts = Pick<
    SimStats,
    'connections' | 'maxConnections' | 'busyBackends' | 'buffered' | 'queued' | 'rps' | 'queries'
>

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
    /** wait before firing, so the caption lands before the motion */
    delay?: number
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
        body: 'As each statement finishes, that backend pulls the next bytes out of its buffer — the shaft empties from the bottom up. Nothing was ever lost, it was only delayed.',
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

export interface StoryDef {
    id: string
    label: string
    hint: string
    steps: StoryStep[]
}

export const STORIES: StoryDef[] = [
    {
        id: 'queue',
        label: 'too many requests',
        hint: 'what happens when more queries arrive than the connections can run',
        steps: QUEUE_STORY,
    },
]

export interface StoryOptions {
    rig: CameraRig
    sim: EngineSim
    /** resolves live subjects for steps that say "look at whatever is happening" */
    scene: StoryScene
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
    /** what the current step is actually pointed at, and where the camera went */
    let subjectId: string | null = null
    let subjectBox: THREE.Box3 | null = null
    let expected: CameraPose | null = null
    /** bumped on every step change so stale timers cannot fire into a new step */
    let token = 0

    /** The one place step predicates read the world from. */
    const facts = (): StoryFacts => {
        const s = sim.stats
        return {
            connections: s.connections,
            maxConnections: s.maxConnections,
            busyBackends: s.busyBackends,
            buffered: s.buffered,
            queued: s.queued,
            rps: s.rps,
            queries: s.queries,
        }
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
        const ok = a.camera.arrived && a.claim.holds
        stateEl.classList.toggle('ok', ok)
        stateEl.textContent = !a.camera.arrived
            ? `camera → ${a.subject ?? a.view ?? '…'}`
            : !a.claim.holds
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
        if (n <= 0 && !step.sustain) return
        window.setTimeout(() => {
            if (mine !== token || !running) return
            for (let i = 0; i < n; i++) void sim.runQuery()
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
            void sim.runQuery()
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
