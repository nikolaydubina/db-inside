import type { RidePhase, StoryFacts } from './types'

/**
 * A step's claim about the instant it froze on.
 *
 * `freezeAt` says WHEN to stop the clock; this says WHAT the caption then claims
 * is on screen, and it is written separately on purpose. The pair that produced
 * the bug this exists to catch read `freezeAt: 'value'` under a caption about the
 * value's own bucket array: the two were the same line of thought, so nothing
 * disagreed, and the story stopped two stops early on the value object in the
 * heap. Stated twice, from two directions, the mistake shows up as a red
 * `wrong instant` instead of a plausible drawing.
 *
 * Only evaluated once the clock has stopped — a route is always between stops
 * while it runs, and reporting that as wrong would make the panel red for every
 * second of the ride.
 */
export const frozeAt =
    (stop: Exclude<RidePhase, null>, what: string, near = 0.3) =>
        (c: StoryFacts): string | null => {
            if (c.rdPhase !== stop) return `stopped at ${c.rdPhase ?? 'nothing'}, not ${what}`
            // the label can be right while the place is wrong: the phase used to be
            // announced as the leg SET OFF, so 'inner' meant "still at value, on its
            // way". The gap is the packet's own position, so it cannot be fooled by
            // a renamed stop.
            if (c.rdStopGap !== null && c.rdStopGap > near)
                return `${c.rdStopGap} units away from ${what}`
            return null
        }

/**
 * The same claim, plus how far into the carried structure the read must have got.
 *
 * Two cards can name the same stop and still be about different instants: a walk
 * is at `node` once per node, so the card that says "node after node" has to be
 * deeper into the structure than the one that says "the head node". Without the
 * count both freeze on the first node and the second caption describes a picture
 * that has not changed. The number comes from the drawing itself, so it is a
 * measurement of the animation rather than a second opinion about it.
 */
export const frozeAtCell =
    (stop: Exclude<RidePhase, null>, what: string, minStep: number, near = 0.3) =>
        (c: StoryFacts): string | null => {
            const why = frozeAt(stop, what, near)(c)
            if (why) return why
            if (!c.rdCursor) return `nothing carried, so ${what} has no cells`
            if (c.rdCursor.step < minStep)
                return `${c.rdCursor.kind} cursor on cell ${c.rdCursor.step}, not past ${minStep}`
            return null
        }
