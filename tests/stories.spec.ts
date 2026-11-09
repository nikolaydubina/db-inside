import { expect, test } from '@playwright/test'
import type { TestSurface } from '../src/test-surface'

declare global {
    interface Window {
        __test: TestSurface
    }
}

const STORIES = [
    { id: 'traversal', label: 'pointer chases' },
    { id: 'zset', label: 'zset lookups' },
    { id: 'hash', label: 'hash lookups' },
    { id: 'inline', label: 'inline values' },
] as const

const STOP_BUDGET = 45_000
const GAP = 0.35

const state = (page: import('@playwright/test').Page) =>
    page.evaluate(() => window.__test.state()) as Promise<{
        ready: boolean
        speed: number
        storyId: string | null
        step: string
        index: number
        title: string
        verdict: string
        ride: {
            phase: string | null
            at: number[] | null
            stopAt: number[] | null
            gap: number | null
        }
    }>

test.describe('redis stories', () => {
    test.beforeEach(async ({ page }) => {
        const errors: string[] = []
        page.on('pageerror', (e) => errors.push(e.message))
        await page.goto('/redis')
        await expect
            .poll(
                async () => JSON.stringify(await page.evaluate(() => window.__test.readyInfo())),
                {
                    timeout: 40_000,
                    message: 'the scene never finished booting',
                },
            )
            .toContain('"ok":true')
        expect(errors).toEqual([])
    })

    test('the test surface describes itself', async ({ page }) => {
        const d = (await page.evaluate(() => window.__test.discover())) as {
            click: Record<string, string>
            stories: { id: string; label: string; steps: number }[]
            globals: string[]
            recipe: string[]
        }
        console.log(JSON.stringify(d, null, 2))
        expect(d.click.next).toBe('#story-next')
        expect(d.globals).toContain('__redis')
        expect(d.stories.map((s) => s.id)).toContain('hash')
        expect(d.recipe.length).toBeGreaterThan(2)
    })

    for (const story of STORIES) {
        test(`every card in "${story.label}" stops where its caption says`, async ({ page }) => {
            const plan = (await page.evaluate((id) => window.__test.plan(id), story.id)) as {
                index: number
                title: string
                freezeAt: string | null
                waitFor: string
            }[]
            expect(plan.length).toBeGreaterThan(0)

            await page.click('#btn-stories')
            await page.locator('#stories .sitem', { hasText: story.label }).first().click()
            await page.waitForTimeout(600)

            for (const [i, want] of plan.entries()) {
                const last = i === plan.length - 1
                if (last) {
                    await page.waitForTimeout(5000)
                    const end = await state(page)
                    expect(end.speed, 'the last card left the clock stopped').toBeGreaterThan(0)
                    expect((await page.textContent('#story-prev'))?.trim()).toContain('restart')
                    expect((await page.textContent('#story-next'))?.trim()).toContain('done')
                    expect(await page.locator('#story-next').isEnabled()).toBe(true)
                    break
                }
                const s = await page.evaluate(
                    async ({ budget }) => {
                        const t0 = Date.now()
                        let st = window.__test.state()
                        while (st.speed !== 0 && Date.now() - t0 < budget) {
                            await new Promise((r) => setTimeout(r, 100))
                            st = window.__test.state()
                        }
                        return st
                    },
                    { budget: STOP_BUDGET },
                )
                expect(
                    s.speed,
                    `step ${want.index + 1} "${want.title}": the clock never stopped`,
                ).toBe(0)
                expect(s.index, `step ${want.index + 1} is not the step on screen`).toBe(i)
                expect(s.ride.phase, `step ${want.index + 1} "${want.title}"`).toBe(want.freezeAt)
                if (want.freezeAt !== 'reply' && s.ride.stopAt) {
                    expect(
                        s.ride.gap,
                        `step ${want.index + 1} "${want.title}" is not standing on its stop`,
                    ).toBeLessThanOrEqual(GAP)
                }
                await expect
                    .poll(async () => (await state(page)).verdict, { timeout: 15_000 })
                    .toBe('as described')

                const next = page.locator('#story-next')
                if (!(await next.isEnabled())) break
                await next.click()
                await page.waitForTimeout(300)
            }
        })
    }
})
