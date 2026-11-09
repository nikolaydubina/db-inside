import type { RidePhase, StoryFacts } from './types'

export const frozeAt =
    (stop: Exclude<RidePhase, null>, what: string, near = 0.3) =>
    (c: StoryFacts): string | null => {
        if (c.rdPhase !== stop) return `stopped at ${c.rdPhase ?? 'nothing'}, not ${what}`

        if (c.rdStopGap !== null && c.rdStopGap > near)
            return `${c.rdStopGap} units away from ${what}`
        return null
    }

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
