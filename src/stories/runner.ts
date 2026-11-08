import * as THREE from 'three'
import type { CameraPose, CameraRig } from '../views'
import type { EngineSim } from '../postgresql/sim'
import type { BigKind } from '../redis/redis'
import type { RidePhase, StoryDef, StoryFacts, StoryScene, StoryStep } from './types'

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
 *
 * The stories themselves live beside this file, one per subject; this is the
 * machine that plays them.
 */

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
        /** one PUBLISH, now — the pub/sub story's cue */
        publish(): void
        /** a read aimed at one big value — the traversal story's cue */
        readBig(kind: BigKind, op?: 'point' | 'walk'): boolean
        /** a read of a compact value, drawn through the object section */
        readInline(): boolean
        /** the next ordinary socket sends SUBSCRIBE */
        subscribeNext(): boolean
        /** nobody is listening, and no episode will interrupt */
        suspendPubSub(): void
        /** hand the channel back to the background episodes */
        resumePubSub(): void
        /** which leg of its route the ridden message is on, for `freezeAt` */
        phase(): RidePhase
        stats: {
            keys: number
            ops: number
            opsPerSec: number
            bigKeys: number
            hotKeys: number
            subscribers: number
            fanouts: number
        }
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
    stories = [],
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
    /** the object the camera is riding, so a hand-over to a new one is noticed */
    let subjectObject: THREE.Object3D | null = null
    let subjectBox: THREE.Box3 | null = null
    let expected: CameraPose | null = null
    /** bumped on every step change so stale timers cannot fire into a new step */
    let token = 0
    /** the step has already stopped the clock on its own phase, once is enough */
    let frozen = false

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
            rdSubs: r?.subscribers ?? 0,
            rdFanouts: r?.fanouts ?? 0,
            rdPhase: redis?.phase() ?? null,
        }
    }

    /** One tap, aimed at the cage this step is about. */
    const tap = (step: StoryStep) => {
        if ((step.tap ?? 'postgres') === 'redis') {
            // a step about a traversal names the value; everything else is ambient
            if (step.op === 'object') redis?.readInline()
            else if (step.big) redis?.readBig(step.big, step.op ?? 'walk')
            else redis?.runCommand()
        } else void sim.runQuery()
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
        const onPose = expected ? rig.atPose(expected) : rig.settled() || rig.isAt(step.view ?? '')
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
        subjectObject = null
        subjectBox = null
        demonstrated = false
        frozen = false
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
        // The cues are set up here, not inside either branch: a step that follows a
        // packet has a subject and no view, and its publish is exactly what makes
        // that subject exist. Hanging the cue off the fixed-view branch meant the
        // camera waited for a message nobody had asked the server to send.
        if (step.publish) window.setTimeout(() => keepPublishing(mine), step.delay ?? 600)
        if (step.subscribe) window.setTimeout(() => keepSubscribing(step, mine), step.delay ?? 600)
        if (step.speed) setSpeed?.(step.speed)
        // started before the delay, not after: the message may already be on the
        // leg this step is about, and a step that only starts watching once its
        // caption lands could miss the instant it wants to stop on
        if (step.freezeAt) watchPhase(step, mine)
        // The cues belong to the STEP, not to the camera code. They used to live
        // in lockOn(), which only runs for steps that follow a live subject — so
        // every `send`/`sustain` on a step with a fixed `view` was silently dead,
        // and a story about motion showed none unless ambient traffic obliged.
        if ((step.send ?? 0) > 0 || step.sustain || step.act) {
            window.setTimeout(() => {
                if (mine !== token || !running) return
                const n = step.send ?? 0
                for (let i = 0; i < n; i++) tap(step)
                step.act?.(sim)
                hold(mine, step)
            }, step.delay ?? 800)
        }
    }

    /**
     * Stop the clock when the ridden message reaches the leg this step is about.
     *
     * A publish is one continuous flight of a few seconds and it carries several
     * captions' worth of meaning: in the socket, at the channel, in a listener's
     * buffer. Playing them as separate steps at normal speed means every caption
     * after the first describes a message that has already gone. So the step
     * resumes the clock, and freezes it the moment the drawing matches the words.
     * The next step starts from that instant, with the same packet still in the
     * air, and lets it move again.
     */
    const watchPhase = (step: StoryStep, mine: number) => {
        if (mine !== token || !running || frozen) return
        if (redis?.phase() === step.freezeAt) {
            frozen = true
            setSpeed?.(0)
            return
        }
        // polling, not an event: the sim is a frame loop, and this is a story
        // watching it, so the cheapest honest thing is to look. 80 ms is under a
        // frame of slack at the quarter speed these steps run at.
        window.setTimeout(() => watchPhase(step, mine), 80)
    }

    /**
     * Ask for a SUBSCRIBE until one lands.
     *
     * One shot is not enough: the request can arrive while the cage is still
     * reading its dump, and it is dropped rather than deferred — the server does
     * not hold a command for later, it just is not listening yet. So the step keeps
     * asking, exactly as a saturation step keeps tapping, and stops the moment its
     * own claim is true.
     */
    const keepSubscribing = (step: StoryStep, mine: number) => {
        if (mine !== token || !running) return
        if (step.expect(facts())) return
        redis?.subscribeNext()
        window.setTimeout(() => keepSubscribing(step, mine), 900)
    }

    /**
     * Keep a publish on screen for as long as the step is open. Stops with the
     * step: the token changes on every step change and on exit, so a timer that
     * outlives its caption cannot fire into the next one.
     */
    const keepPublishing = (mine: number) => {
        if (mine !== token || !running) return
        redis?.publish()
        // A step that RIDES the packet gets exactly one. The camera has to settle
        // on it and stay with it to the end of the route, and a new message every
        // beat would keep re-acquiring the camera on a different subject — which
        // is what "jittery, nothing is tracked" was. A step that also freezes on a
        // phase is walking that one message through several steps, so it must not
        // hand out a second one either.
        if (steps[index]?.subject || steps[index]?.freezeAt) return
        // A fan is over in well under a second, and the wires fade slowly, so the
        // beat has to be short enough that the step is never a caption about an
        // empty screen. It also keeps pace with the clock: at a quarter speed a
        // publish takes four times as long, and firing on the real-time beat would
        // stack them on top of each other.
        const pace = 1100 / Math.max(0.25, steps[index]?.speed ?? 1)
        window.setTimeout(() => keepPublishing(mine), pace)
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
            // the subject stopped being valid (the ride ended at the socket, or
            // the packet was despawned): release the camera HERE, or it goes on
            // riding an object that is already on its way out of the frame
            if (subjectObject) {
                rig.hold(null)
                subjectObject = null
            }
        }
        const subj = step.subject?.(scene) ?? null
        const obj = subj?.object ?? null
        if (!subj) {
            // Nothing to follow — a packet has left the cage, or has not arrived
            // yet. Let go of whatever the camera was riding, or it keeps following
            // that object out of the frame and into the sky.
            if (subjectObject) {
                rig.hold(null)
                subjectObject = null
                subjectId = null
            }
        } else if (!subjectId || obj !== subjectObject) {
            // A ride can HAND OVER from one object to another mid-route — the
            // request packet to the reply packet — and keep the same identity. The
            // camera has to be given the new object, or it goes on following the
            // one that was just despawned and never moves again.
            subjectId = subj.id
            subjectBox = subj.box
            subjectObject = obj
            if (obj && step.dist) {
                // a subject that moves: no frame tween, just a ride. The camera
                // eases onto `subject + dir × dist` and holds it, so there is
                // nothing to re-frame every tick and nothing to jitter.
                rig.hold(obj, {
                    dir: step.dir ?? [0, 0.3, 1],
                    dist: step.dist,
                    fov: step.fov,
                })
                expected = null
            } else {
                expected = rig.frame(subj.box, step.dir ?? [0, 0.3, 1], {
                    fov: step.fov,
                    padding: step.padding,
                    lookShift: step.lookShift,
                })
            }
        }
        // 200 ms, not 400: a ride hands over and ends inside a second, and the
        // poll is how fast the camera notices. At 400 ms it kept following a
        // packet that had already reached the socket and overshot the pose.
        window.setTimeout(() => lockOn(step, mine), 200)
    }

    /** Keep the client pressing until the step's own claim becomes true. */
    const hold = (mine: number, step: StoryStep) => {
        const rate = step.sustain ?? 0
        if (rate <= 0) return
        const beat = () => {
            if (mine !== token || !running) return
            if (!step.sustainWhileOpen && step.expect(facts())) return
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
