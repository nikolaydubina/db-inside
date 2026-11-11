import type * as THREE from 'three'
import type { Story } from './stories/runner'
import type { StoryStep } from './stories/types'

import { STAGE_NAME, Stage } from './core/stage'
import { POSTGRESQL_INDEX_NAME } from './postgresql/indexes'
import type { PostgresqlIndexKind } from './postgresql/indexes'
import { REDIS_BIG_KIND_NAME } from './redis/values'
import { DB_SCOPE_NAME } from './core/db'

interface RideSim {
    stats: { loading: boolean; keys: number; note: string }
    phase(): Stage | null
    rideState(): {
        phase: Stage | null
        at: number[] | null
        stopAt: number[] | null
        gap: number | null
        hasPacket: boolean
    }
    readCursor(): { kind: string; step: number; steps: number } | null
}

const CLICK = {
    storiesButton: '#btn-stories',
    storyMenu: '#stories .sitem',
    next: '#story-next',
    prev: '#story-prev',
    exit: '#story-exit',
    speed: '#speed',
} as const

const READ = {
    card: '#story',
    step: '#story-step',
    title: '#story-title',
    body: '#story-body',
    verdict: '#story-state',
    speedValue: '#speed-val',
} as const

const plan = (steps: StoryStep[]) =>
    steps.map((s, i) => ({
        index: i,
        title: s.title,
        waitFor: s.waitFor,

        freezeAt: s.freezeAt === undefined ? null : STAGE_NAME[s.freezeAt],

        asserts: !!s.assert,
        subject: s.subject ? 'live subject' : (s.view ?? 'none'),
        big: s.big === undefined ? null : REDIS_BIG_KIND_NAME[s.big],
        op: s.op ?? null,
        idx: s.idx === undefined ? null : POSTGRESQL_INDEX_NAME[s.idx],
        speed: s.speed ?? null,
    }))

export interface PacketAudit {
    live: number
    parked: number

    stuck: { at: number[]; color: string | null; age: number }[]
}

export interface TestSurface {
    discover(): Record<string, unknown>
    plan(storyId?: string): unknown
    ready(): boolean
    readyInfo(): { ok: boolean; loading: boolean; keys: number; hasNext: boolean; note: string }
    state(): Record<string, unknown>
    packets(): PacketAudit
    log(): void

    fast(scale: number): number
}

// A packet is animated every frame it is alive, and `clock` only advances while the
// scene runs, so a packet that has not moved in this much scene time is one that no
// ticker item will ever move again — a stranded request. Every leg (including a
// despawn and a story settle) is well under a second; parked requests keep turning.
const STUCK_AFTER = 3

declare global {
    interface Window {
        __test?: TestSurface
    }
}

export function installTestSurface(opts: {
    story: Story
    redisSim: RideSim
    indexRide?: { state(): Record<string, unknown> }
    packets?: {
        roots(): THREE.Object3D[]
        parked(): number
        clock(): number
    }
}): void {
    const { story, redisSim, indexRide, packets } = opts

    const packetSeen = new WeakMap<THREE.Object3D, { sig: string; since: number }>()

    const auditPackets = (): PacketAudit => {
        if (!packets) return { live: 0, parked: 0, stuck: [] }
        const now = packets.clock()
        const live: THREE.Object3D[] = []
        for (const root of packets.roots()) {
            root.traverse((o) => {
                if (o.userData.marker) live.push(o)
            })
        }
        const stuck: PacketAudit['stuck'] = []
        for (const o of live) {
            const sig = [o.position.x, o.position.y, o.position.z, o.rotation.y, o.scale.x]
                .map((n) => n.toFixed(3))
                .join('|')
            const seen = packetSeen.get(o)
            if (!seen || seen.sig !== sig) {
                packetSeen.set(o, { sig, since: now })
                continue
            }
            if (now - seen.since <= STUCK_AFTER) continue
            const core = o.userData.core as THREE.Mesh | undefined
            const mat = core?.material as THREE.MeshStandardMaterial | undefined
            stuck.push({
                at: o.position.toArray().map((n) => +n.toFixed(2)),
                color: mat?.emissive ? mat.emissive.getHexString() : null,
                age: +(now - seen.since).toFixed(1),
            })
        }
        return { live: live.length, parked: packets.parked(), stuck }
    }

    const ids = (map: Record<string, string>) => {
        const out: Record<string, string> = {}
        for (const [name, sel] of Object.entries(map)) {
            out[name] = document.querySelector(sel) ? sel : `${sel} (absent)`
        }
        return out
    }

    const readyInfo = () => {
        const s = redisSim.stats
        const hasNext = !!document.querySelector(CLICK.next)
        return {
            ok: !s.loading && s.keys > 0 && hasNext,
            loading: s.loading,
            keys: s.keys,
            hasNext,
            note: s.note,
        }
    }
    const ready = () => readyInfo().ok

    const state = () => {
        const ride = redisSim.rideState()
        const ix = (indexRide?.state() ?? null) as Record<string, any> | null
        const stepText = document.getElementById('story-step')?.textContent?.trim() ?? ''
        return {
            ready: ready(),
            speed: Number(
                (document.getElementById('speed') as HTMLInputElement | null)?.value ?? -1,
            ),
            storyId: story.storyId(),
            step: stepText,
            index: story.index(),
            title: document.getElementById('story-title')?.textContent?.trim() ?? '',
            verdict: document.getElementById('story-state')?.textContent?.trim() ?? '',
            firstCue: story.firstCue(),
            packets: auditPackets(),
            ride: {
                phase: ride.phase === null ? null : STAGE_NAME[ride.phase],
                at: ride.at,
                stopAt: ride.stopAt,
                gap: ride.gap,
                hasPacket: ride.hasPacket,
                cursor: redisSim.readCursor(),
            },
            indexRead: ix
                ? {
                      kind:
                          ix.kind === null
                              ? null
                              : POSTGRESQL_INDEX_NAME[ix.kind as PostgresqlIndexKind],
                      stage: ix.stage === null ? null : STAGE_NAME[ix.stage as Stage],
                      pages: ix.pages,
                      disk: ix.disk,
                      hits: ix.hits,
                      heap: ix.heap,
                      tuples: ix.tuples,
                      gap: ix.gap,
                  }
                : null,
        }
    }

    const surface: TestSurface = {
        discover: () => ({
            url: location.href,
            ready: readyInfo(),
            click: ids(CLICK),
            read: ids(READ),
            globals: Object.keys(window).filter((k) => k.startsWith('__')),
            stories: story.stories.map((d) => ({
                id: d.id,
                label: d.label,
                db: d.db === undefined ? null : DB_SCOPE_NAME[d.db],
                steps: d.steps.length,
            })),
            recipe: [
                "await page.goto('/redis')",
                'await expect.poll(() => page.evaluate(() => window.__test!.ready())).toBe(true)',
                'const plan = await page.evaluate(() => window.__test!.plan("<storyId>"))',
                'click #story-next, then poll window.__test!.state() until speed === 0',
                'assert state.ride.phase === plan[i].freezeAt && state.ride.gap <= 0.3',
            ],
        }),

        plan: (storyId?: string): unknown => {
            const pick = story.stories.filter((d) => !storyId || d.id === storyId)
            const out: Record<string, unknown> = {}
            for (const d of pick) out[d.id] = plan(d.steps)
            return storyId ? (out[storyId] ?? []) : out
        },

        ready,
        fast: (scale: number) => story.fast(scale),
        readyInfo,
        state,
        packets: auditPackets,

        log: () => {
            const s = state()
            console.info(
                '%c[db-inside]%c window.__test.discover() · .plan() · .state() — what an outside driver may click and read',
                'color:#2bffc3',
                'color:inherit',
            )
            console.table(s as unknown as Record<string, unknown>)
        },
    }

    window.__test = surface
    console.info(
        '%c[db-inside]%c test surface: window.__test.discover() — ids, story plan, live ride state',
        'color:#2bffc3',
        'color:inherit',
    )
}
