import { expect, test } from '@playwright/test'

test.describe('outbound packets', () => {
    test('the camera never follows a reply past the socket', async ({ page }) => {
        await page.goto('/redis')
        await expect
            .poll(() => page.evaluate(() => window.__test!.ready()), { timeout: 30_000 })
            .toBe(true)

        await page.evaluate(() => window.__psqlStory.start('inline'))
        await expect.poll(() => page.evaluate(() => window.__test!.state().step)).toBe('1 / 3')
        for (const step of ['2 / 3', '3 / 3']) {
            await page.evaluate(() => document.getElementById('story-next')!.click())
            await expect.poll(() => page.evaluate(() => window.__test!.state().step)).toBe(step)
        }

        await page.evaluate(() => {
            const out: Array<{ phase: string | null; following: string | null }> = []
            ;(window as unknown as { __watch: typeof out }).__watch = out
            const h = setInterval(() => {
                const st = window.__redis!.redisSim.rideState()
                out.push({ phase: st.phase, following: window.__ride!().following })
                if (out.length > 400) clearInterval(h)
            }, 50)
        })

        await page.waitForTimeout(6000)

        const watch = await page.evaluate(
            () =>
                (
                    window as unknown as {
                        __watch: Array<{ phase: string | null; following: string | null }>
                    }
                ).__watch,
        )
        await page.evaluate(() => document.getElementById('story-exit')!.click())

        const outbound = watch.filter((w) => w.phase === 'reply')
        expect(outbound.length, 'the story never reached the reply leg in 6 s').toBeGreaterThan(0)
        const followed = outbound.filter((w) => w.following !== null)
        expect(
            followed.length,
            `camera followed the outbound packet in ${followed.length} of ${outbound.length} samples`,
        ).toBe(0)
    })
})
