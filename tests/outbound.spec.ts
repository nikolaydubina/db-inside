import { expect, test } from '@playwright/test'

/**
 * The camera stops at the socket.
 *
 * A reply is still a live object while it leaves the cage, so "follow the packet" and
 * "follow the answer out of the building" were the same instruction: once the return
 * leg started, the camera rode the bytes out of the frame, and every re-acquire after
 * that (a card that keeps tapping fires a new read every second) picked the outbound
 * packet straight back up.
 *
 * The rule this pins down: while the ride is on the `reply` leg the camera must hold
 * NOTHING — no hold, no re-acquire, no catch-up 200 ms later.
 */
test.describe('outbound packets', () => {
    test('the camera never follows a reply past the socket', async ({ page }) => {
        await page.goto('/redis')
        await expect.poll(() => page.evaluate(() => window.__test!.ready()), { timeout: 30_000 }).toBe(true)

        // to the last card of the inline story, which is the one about the return leg
        await page.evaluate(() => window.__psqlStory.start('inline'))
        await expect.poll(() => page.evaluate(() => window.__test!.state().step)).toBe('1 / 3')
        for (const step of ['2 / 3', '3 / 3']) {
            await page.evaluate(() => document.getElementById('story-next')!.click())
            await expect.poll(() => page.evaluate(() => window.__test!.state().step)).toBe(step)
        }

        // Sample the two facts that matter together. `phase === 'reply'` means the
        // answer is on its way out; `following !== null` means the camera is riding it.
        await page.evaluate(() => {
            const out: Array<{ phase: string | null; following: string | null }> = []
                ; (window as unknown as { __watch: typeof out }).__watch = out
            const h = setInterval(() => {
                const st = window.__redis!.redisSim.rideState()
                out.push({ phase: st.phase, following: window.__ride!().following })
                if (out.length > 400) clearInterval(h)
            }, 50)
        })

        // long enough for at least one full reply leg and the tap after it
        await page.waitForTimeout(6000)

        const watch = await page.evaluate(
            () => (window as unknown as { __watch: Array<{ phase: string | null; following: string | null }> }).__watch,
        )
        await page.evaluate(() => document.getElementById('story-exit')!.click())

        const outbound = watch.filter((w) => w.phase === 'reply')
        // the ride is short and a story may not reach it in this window on a slow
        // machine; if it never did, there is nothing to assert against — say so loudly
        // rather than passing on an empty sample
        expect(outbound.length, 'the story never reached the reply leg in 6 s').toBeGreaterThan(0)
        const followed = outbound.filter((w) => w.following !== null)
        expect(
            followed.length,
            `camera followed the outbound packet in ${followed.length} of ${outbound.length} samples`,
        ).toBe(0)
    })
})
