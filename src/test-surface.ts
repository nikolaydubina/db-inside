import type { Story } from './stories/runner'
import type { StoryStep } from './stories/types'

/**
 * What a test — or a person with a console open — is allowed to drive and read.
 *
 * The page has grown a dozen debug globals (`__psql`, `__redis`, `__psqlStory`,
 * `__pickAt`, …), each added when something needed looking at, and none of them
 * says what it is for. That is fine inside the editor and useless from outside:
 * a Playwright test that wants to walk a story has to guess at ids, classes and
 * the shape of `rideState()`, and guessing is how a test ends up asserting
 * against the harness instead of against the scene.
 *
 * So this is the ONE surface an outside driver is meant to use, and its first job
 * is to describe itself: `__test.discover()` returns the DOM ids, the story menu,
 * every step's declared stop, and a sample of the call that reads the live state.
 * A test that prints it once has everything it needs to connect, and a test that
 * reads `state()` cannot be fooled by the panel's own opinion — the phase and the
 * gap come from the simulation, the verdict is the panel's, and the declared stop
 * comes from the story source.
 *
 * The three are deliberately separate: a story that stops on the wrong stop is
 * then a disagreement between two independent readings rather than one number
 * quoted twice.
 */

/** The ride machinery, as the outside world needs to see it. */
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
    /** which cell of a carried structure the read is on, if any */
    readCursor(): { kind: string; step: number; steps: number } | null
}

/** The DOM a driver clicks and reads. One list, so it cannot rot in one place. */
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
/** A step, as a test needs it: what it says, and where it says the clock stops. */
const plan = (steps: StoryStep[]) =>
    steps.map((s, i) => ({
        index: i,
        title: s.title,
        waitFor: s.waitFor,
        /** the stop this step claims — the thing an outside test checks */
        freezeAt: s.freezeAt ?? null,
        /** does the step also assert its own instant, in words */
        asserts: !!s.assert,
        subject: s.subject ? 'live subject' : (s.view ?? 'none'),
        big: s.big ?? null,
        op: s.op ?? null,
        speed: s.speed ?? null,
    }))

export interface TestSurface {
    /** everything an outside driver needs in order to connect */
    discover(): Record<string, unknown>
    /** the steps of one story, or of every story */
    plan(storyId?: string): unknown
    /** is the scene listening yet, and is anything in memory */
    ready(): boolean
    /**
     * The same answer, with its reasons.
     *
     * A bare `false` from a boot that takes a second is indistinguishable from a
     * page that never booted at all, and the difference matters to whoever is
     * reading the failure: the components below are `loading`, `keys` and whether
     * the story card exists, so a timeout says which one was wrong.
     */
    readyInfo(): { ok: boolean; loading: boolean; keys: number; hasNext: boolean; note: string }
    /** the live state, in numbers: the panel's words and the sim's position */
    state(): Record<string, unknown>
    /** the same information, printed as one console line plus a table */
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
            // report the selector AND whether it is on this page right now: a test
            // that clicks a missing id fails with a timeout that says nothing
            out[name] = document.querySelector(sel) ? sel : `${sel} (absent)`
        }
        return out
    }

    const readyInfo = () => {
        const s = redisSim.stats
        // CLICK, not READ: `next` is a button, and reading a selector table by the
        // wrong name gave `querySelector(undefined)` — which returns null, made every
        // wait for the boot fail, and looked like a broken app from the outside.
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
            /** 0 means the clock is stopped, which is what a frozen step looks like */
            speed: Number((document.getElementById('speed') as HTMLInputElement | null)?.value ?? -1),
            storyId: story.storyId(),
            step: stepText,
            index: story.index(),
            title: document.getElementById('story-title')?.textContent?.trim() ?? '',
            /** the panel's own words: 'as described' only when its claim holds */
            verdict: document.getElementById('story-state')?.textContent?.trim() ?? '',
            /**
             * The first packet this story asked for, and whether it was the kind its
             * opening card declares.
             *
             * `ms` is measured from the start of the story, so "the story starts"
             * has a number attached: anything above a frame or two means the card was
             * showing nothing while the panel said it was playing.
             */
            firstCue: story.firstCue(),
            ride: {
                phase: ride.phase,
                /** where the ridden object is, in the space the route is drawn in */
                at: ride.at,
                /** where the leg it is on ends */
                stopAt: ride.stopAt,
                /** the distance between them: ~0 means it really is on that stop */
                gap: ride.gap,
                hasPacket: ride.hasPacket,
                /**
                 * the cell inside the carried structure the read is touching, and
                 * how many cells there are — the animation, as a number. `step`
                 * rises as the walk progresses and returns to -1 when the structure
                 * is put back, so a test can assert the walk actually happened.
                 */
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
            /** every global this page installs, so nobody has to guess they exist */
            globals: Object.keys(window).filter((k) => k.startsWith('__')),
            stories: story.stories.map((d) => ({
                id: d.id,
                label: d.label,
                db: d.db ?? 'postgres',
                steps: d.steps.length,
            })),
            /**
             * How to read one step from outside, and what "correct" means:
             * the clock is stopped (`speed === 0`), the sim says the ride is on the
             * phase the story declared (`freezeAt`), the ridden object is standing
             * on that stop (`gap` ≈ 0), and the panel agrees (`verdict`).
             */
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
    // one line at boot, because a surface nobody knows about is not a surface
    console.info(
        '%c[db-inside]%c test surface: window.__test.discover() — ids, story plan, live ride state',
        'color:#2bffc3',
        'color:inherit',
    )
}
