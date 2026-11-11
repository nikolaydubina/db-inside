import { STAGE_NAME } from '../core/stage'
import { Stage } from '../core/stage'
import type { StoryFacts } from './types'

export const frozeAt =
    (stop: Stage, what: string, near = 0.3) =>
    (c: StoryFacts): string | null => {
        if (c.rdPhase !== stop)
            return `stopped at ${c.rdPhase === null ? 'nothing' : STAGE_NAME[c.rdPhase]}, not ${what}`

        if (c.rdStopGap !== null && c.rdStopGap > near)
            return `${c.rdStopGap} units away from ${what}`
        return null
    }

export const frozeAtCell =
    (stop: Stage, what: string, minStep: number, near = 0.3) =>
    (c: StoryFacts): string | null => {
        const why = frozeAt(stop, what, near)(c)
        if (why) return why
        if (!c.rdCursor) return `nothing carried, so ${what} has no cells`
        if (c.rdCursor.step < minStep)
            return `${c.rdCursor.kind} cursor on cell ${c.rdCursor.step}, not past ${minStep}`
        return null
    }

export const frozeIndexAt =
    (stop: Stage, what: string, near = 0.4) =>
    (c: StoryFacts): string | null => {
        if (c.idxStage !== stop)
            return `index stopped at ${c.idxStage === null ? 'nothing' : STAGE_NAME[c.idxStage]}, not ${what}`
        if (c.idxGap !== null && c.idxGap > near) return `${c.idxGap} units away from ${what}`
        return null
    }

export const frozeIndexAfter =
    (stop: Stage, what: string, pages: number, near = 0.4) =>
    (c: StoryFacts): string | null => {
        const why = frozeIndexAt(stop, what, near)(c)
        if (why) return why
        if (c.idxPages < pages) return `${c.idxPages} index pages read, not ${pages}`
        return null
    }
