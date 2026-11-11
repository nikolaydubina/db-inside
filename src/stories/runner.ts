import * as THREE from 'three'
import type { CameraPose, CameraRig } from '../views'
import type { EngineSim } from '../postgresql/sim'
import type { PostgresqlIndexKind } from '../postgresql/indexes'
import { REDIS_BIG_KIND_NAME, RedisBigKind, RedisReadOp } from '../redis/values'
import { Stage } from '../core/stage'
import type { StageHub } from '../core/stage'
import { Db } from '../core/db'
import type { StoryDef, StoryFacts, StoryScene, StoryStep } from './types'

export interface StoryOptions {
    rig: CameraRig
    sim: EngineSim

    scene: StoryScene

    redis?: {
        runCommand(): void

        publish(): void

        readBig(kind: RedisBigKind, op?: RedisReadOp): boolean

        readInline(): boolean

        readRaw?(): boolean

        subscribeNext(): boolean

        suspendPubSub(): void

        resumePubSub(): void

        phase(): Stage | null

        stages?: StageHub

        setPacketScale?(scale: number): void

        rideState(): {
            ride: number
            gap: number | null
            cursor?: { kind: string; step: number; steps: number } | null
        }
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
    index?: {
        run(kind: PostgresqlIndexKind, opts?: { cold?: boolean }): void
        stages?: StageHub
        state(): {
            kind: PostgresqlIndexKind | null
            stage: Stage | null
            say: string
            trip: number
            running: boolean
            cold: boolean
            pages: number
            disk: number
            hits: number
            heap: number
            tuples: number
            gap: number | null
        }
    }
    stories?: StoryDef[]

    setSpeed?: (v: number) => void

    onEnter?: (story: StoryDef) => void
    onExit?: () => void
}

export function createStory({
    rig,
    sim,
    scene,
    redis,
    index: indexRide,
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

    let arrived = false

    let demonstrated = false

    let trackCentre: THREE.Vector3 | null = null

    let subjectId: string | null = null

    let subjectObject: THREE.Object3D | null = null
    let subjectBox: THREE.Box3 | null = null
    let expected: CameraPose | null = null

    let token = 0

    let frozen = false

    let speedScale = 1

    let openedAt = -1

    let startAt = 0
    let firstCue: { kind: string; expected: string; ms: number } | null = null

    const cueKind = (step: StoryStep): string => {
        if (step.publish) return 'publish'
        if (step.subscribe) return 'subscribe'
        if (step.idx || (step.tap ?? Db.Postgres) !== Db.Redis) return 'query'
        if (step.raw) return 'raw'
        if (step.op === RedisReadOp.Object) return 'inline'
        if (step.big !== undefined) return `big:${REDIS_BIG_KIND_NAME[step.big]}`
        return 'command'
    }

    const noteCue = (kind: string) => {
        if (firstCue) return
        firstCue = {
            kind,
            expected: cueKind(steps[index]),
            ms: Math.round(performance.now() - startAt),
        }
    }

    const facts = (): StoryFacts => {
        const s = sim.stats
        const r = redis?.stats
        const ix = indexRide?.state()
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
            locksHeld: s.locksHeld,
            locksHolding: s.locksHolding,
            locksWaiting: s.locksWaiting,
            rdKeys: r?.keys ?? 0,
            rdOps: r?.ops ?? 0,
            rdRps: r?.opsPerSec ?? 0,
            bigKeys: r?.bigKeys ?? 0,
            hotKeys: r?.hotKeys ?? 0,
            rdSubs: r?.subscribers ?? 0,
            rdFanouts: r?.fanouts ?? 0,
            rdPhase: redis?.phase() ?? null,
            rdStopGap: redis?.rideState().gap ?? null,
            rdCursor: redis?.rideState().cursor ?? null,
            idxKind: ix?.kind ?? null,
            idxStage: ix?.stage ?? null,
            idxPages: ix?.pages ?? 0,
            idxDisk: ix?.disk ?? 0,
            idxHits: ix?.hits ?? 0,
            idxHeap: ix?.heap ?? 0,
            idxTuples: ix?.tuples ?? 0,
            idxGap: ix?.gap ?? null,
        }
    }

    const keepsRide = (step: StoryStep) => {
        if (!step.idx) return false
        const st = indexRide?.state()
        if (!st?.running || st.trip === 0) return false
        return st.kind === step.idx && st.cold === (step.cold !== false)
    }

    const tap = (step: StoryStep) => {
        noteCue(cueKind(step))
        if (step.idx) {
            indexRide?.run(step.idx, { cold: step.cold !== false })
            return
        }
        if ((step.tap ?? Db.Postgres) === Db.Redis) {
            if (step.raw) redis?.readRaw?.()
            else if (step.op === RedisReadOp.Object) redis?.readInline()
            else if (step.big !== undefined) redis?.readBig(step.big, step.op ?? RedisReadOp.Walk)
            else redis?.runCommand()
        } else void sim.runQuery()
    }

    const audit = () => {
        const step = steps[index]
        if (!step) return null
        const f = facts()
        const onPose = expected ? rig.atPose(expected) : rig.settled() || rig.isAt(step.view ?? '')
        if (onPose) arrived = true
        return {
            story: storyId,
            step: index,
            total: steps.length,
            title: step.title,
            view: step.view ?? null,
            subject: subjectId,
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
            wrong: frozen ? (step.assert?.(f) ?? null) : null,
            ok: arrived && step.expect(f) && !(frozen && step.assert?.(f)),
        }
    }

    const refreshState = () => {
        if (!stateEl) return
        const a = audit()
        if (!a) return
        if (a.claim.holds) demonstrated = true
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
        stateEl.classList.toggle('ok', ok && !a.wrong)
        stateEl.classList.toggle('wrong', !!a.wrong)
        stateEl.textContent = a.wrong
            ? `wrong instant · ${a.wrong}`
            : !a.camera.arrived
              ? stepNow?.subject && !a.subject
                  ? demonstrated
                      ? 'as described'
                      : `waiting · ${stepNow.waitFor ?? 'the next command'}`
                  : `camera → ${a.subject ?? a.view ?? '…'}`
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

        const last = index === steps.length - 1
        if (prevBtn) {
            prevBtn.textContent = last ? 'restart ↺' : '← back'
            prevBtn.disabled = false

            prevBtn.style.display = index === 0 ? 'none' : ''
        }
        if (nextBtn) {
            nextBtn.textContent = last ? 'done' : 'next →'
            nextBtn.disabled = false
        }
        refreshState()
    }

    const play = () => {
        const step = steps[index]
        if (!step) return
        const mine = ++token
        disarmFreeze()
        arrived = false
        expected = null
        subjectId = null
        subjectObject = null
        subjectBox = null
        demonstrated = false
        frozen = false
        trackCentre = null
        openedAt = redis?.rideState().cursor?.step ?? -1
        render()
        if (step.subject) {
            lockOn(step, mine)
        } else if (step.view) {
            subjectId = step.view
            rig.go(step.view)
        }
        const delay = index === 0 ? 0 : (step.delay ?? 600)
        if (step.publish) window.setTimeout(() => keepPublishing(mine), delay)
        if (step.subscribe) window.setTimeout(() => keepSubscribing(step, mine), delay)
        const last = index === steps.length - 1
        if (step.speed) setSpeed?.(last ? 1 : step.speed * speedScale)
        redis?.setPacketScale?.(1)
        if (step.freezeAt && !last) armFreeze(step, mine)
        const carried = keepsRide(step)
        if (!carried && ((step.send ?? 0) > 0 || step.sustain || step.act)) {
            window.setTimeout(() => {
                if (mine !== token || !running) return
                const n = step.send ?? 0
                for (let i = 0; i < n; i++) tap(step)
                step.act?.(sim)
                hold(mine, step)
            }, delay)
        }
    }

    let stageHook: (() => void) | null = null

    const watchPhase = (step: StoryStep, mine: number, left = false) => {
        if (mine !== token || !running) return
        if (frozen) return
        const cursor = redis?.rideState().cursor ?? null
        const deepEnough =
            step.freezeAtStep === undefined || (cursor?.step ?? -1) >= step.freezeAtStep
        const phase = step.idx ? (indexRide?.state().stage ?? null) : redis?.phase()
        if (phase === step.freezeAt && deepEnough) {
            const deeper = cursor !== null && cursor.step > openedAt
            if (left || deeper) {
                frozen = true
                setSpeed?.(0)
                return
            }
        } else {
            left = true
        }
        window.setTimeout(() => watchPhase(step, mine, left), 80)
    }

    const armFreeze = (step: StoryStep, mine: number) => {
        if (!step.freezeAt) return
        disarmFreeze()
        const continuing = keepsRide(step)
        const base = step.idx ? (indexRide?.state().trip ?? 0) : (redis?.rideState().ride ?? 0)
        const target = step.idx ? indexRide : redis
        if (target?.stages) {
            stageHook = target.stages.add((stage: Stage, ride: number) => {
                if (mine !== token || !running || frozen) return
                if (stage !== step.freezeAt) return
                if (continuing ? ride !== base : ride === base) return
                const cursor = redis?.rideState().cursor ?? null
                if (step.freezeAtStep !== undefined && (cursor?.step ?? -1) < step.freezeAtStep)
                    return
                frozen = true
                setSpeed?.(0)
            })
        }
        watchPhase(step, mine)
    }

    const disarmFreeze = () => {
        stageHook?.()
        stageHook = null
    }

    const keepSubscribing = (step: StoryStep, mine: number) => {
        if (mine !== token || !running) return
        if (step.expect(facts())) return
        noteCue('subscribe')
        redis?.subscribeNext()
        window.setTimeout(() => keepSubscribing(step, mine), 900)
    }

    const keepPublishing = (mine: number) => {
        if (mine !== token || !running) return
        noteCue('publish')
        redis?.publish()
        if (steps[index]?.subject || steps[index]?.freezeAt) return
        const pace = 1100 / Math.max(0.25, steps[index]?.speed ?? 1)
        window.setTimeout(() => keepPublishing(mine), pace)
    }

    const lockOn = (step: StoryStep, mine: number) => {
        if (mine !== token || !running) return
        if (subjectId && step.subject && !scene.valid(subjectId)) {
            subjectId = null
            subjectBox = null
            arrived = false
            if (subjectObject) {
                rig.hold(null)
                subjectObject = null
            }
        }
        const subj = step.subject?.(scene) ?? null
        const obj = subj?.object ?? null
        if (!subj) {
            if (subjectObject) {
                rig.hold(null)
                subjectObject = null
                subjectId = null
            }
        } else if (!subjectId || obj !== subjectObject) {
            subjectId = subj.id
            subjectBox = subj.box
            subjectObject = obj
            if (obj && step.dist) {
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
        window.setTimeout(() => lockOn(step, mine), 200)
    }

    const hold = (mine: number, step: StoryStep) => {
        const rate = step.sustain ?? 0
        if (rate <= 0) return
        const beat = () => {
            if (mine !== token || !running) return
            if (frozen) return window.setTimeout(beat, 1000 / rate)
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
        startAt = performance.now()
        firstCue = null
        if (el) el.hidden = false
        onEnter?.(def)
        play()
    }

    const stop = () => {
        if (!running) return
        running = false
        token++
        disarmFreeze()
        if (el) el.hidden = true
        redis?.setPacketScale?.(1)
        onExit?.()
    }

    const next = () => {
        if (!running) return
        if (index >= steps.length - 1) {
            stop()
            return
        }
        index++
        play()
    }

    const prev = () => {
        if (!running) return
        if (index >= steps.length - 1) {
            index = 0
            play()
            return
        }
        if (index === 0) return
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
        firstCue: () => firstCue,
        audit,
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
        goto(i: number) {
            if (!running || i < 0 || i >= steps.length) return false
            index = i
            play()
            return true
        },
        fast(scale: number) {
            // Scales the scene clock for every card from here on; the ceiling is
            // set by the frame's 0.05 s dt clamp in main.ts — past ~10× a ride leg
            // no longer spans a frame and freezes overshoot their stop.
            speedScale = Math.max(0.05, scale)
            if (running) {
                const step = steps[index]
                setSpeed?.(step?.speed ? step.speed * speedScale : speedScale)
            }
            return speedScale
        },
    }
}

export type Story = ReturnType<typeof createStory>
