import type { Story } from './stories/runner'
import type { StoryStep } from './stories/types'

interface RideSim {
    stats: { loading: boolean; keys: number; note: string }
    phase(): string | null
    rideState(): {
        phase: string | null
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

        freezeAt: s.freezeAt ?? null,

        asserts: !!s.assert,
        subject: s.subject ? 'live subject' : (s.view ?? 'none'),
        big: s.big ?? null,
        op: s.op ?? null,
        speed: s.speed ?? null,
    }))

export interface TestSurface {
    discover(): Record<string, unknown>

    plan(storyId?: string): unknown

    ready(): boolean

    readyInfo(): { ok: boolean; loading: boolean; keys: number; hasNext: boolean; note: string }

    state(): Record<string, unknown>

    log(): void
}

declare global {
    interface Window {
        __test?: TestSurface
    }
}

export function installTestSurface(opts: { story: Story; redisSim: RideSim }): void {
    const { story, redisSim } = opts

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
            ride: {
                phase: ride.phase,
                at: ride.at,
                stopAt: ride.stopAt,
                gap: ride.gap,
                hasPacket: ride.hasPacket,
                cursor: redisSim.readCursor(),
            },
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
                db: d.db ?? 'postgres',
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
        readyInfo,
        state,

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
