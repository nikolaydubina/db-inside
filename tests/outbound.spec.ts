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

        // Polled a few times per frame, not once per frame: the whole point is to
        // catch the frames of a leg that lasts a fraction of a second, and rAF is
        // throttled under parallel load exactly when this test runs.
        await page.evaluate(() => {
            const out: Array<{
                phase: string | null
                packet: string | null
                following: string | null
            }> = []
            ;(window as unknown as { __watch: typeof out }).__watch = out
            let seen = false
            const h = setInterval(() => {
                const phase = (window.__test!.state().ride as { phase: string | null }).phase
                const ride = window.__ride!()
                out.push({ phase, packet: ride.packet, following: ride.following })
                if (phase === 'reply') seen = true
                if (out.length > 6000 || (seen && phase !== 'reply')) clearInterval(h)
            }, 4)
        })

        const seenReply = () =>
            page.evaluate(() =>
                (window as unknown as { __watch: Array<{ phase: string | null }> }).__watch.some(
                    (w) => w.phase === 'reply',
                ),
            )
        await expect
            .poll(seenReply, { timeout: 40_000, message: 'the story never reached the reply leg' })
            .toBe(true)
        await expect
            .poll(
                () =>
                    page.evaluate(() => {
                        const w = (
                            window as unknown as {
                                __watch: Array<{ phase: string | null }>
                            }
                        ).__watch
                        return w.length > 3000 || w[w.length - 1].phase !== 'reply'
                    }),
                { timeout: 40_000, message: 'the reply leg never ended' },
            )
            .toBe(true)

        const watch = await page.evaluate(
            () =>
                (
                    window as unknown as {
                        __watch: Array<{
                            phase: string | null
                            packet: string | null
                            following: string | null
                        }>
                    }
                ).__watch,
        )
        await page.evaluate(() => document.getElementById('story-exit')!.click())

        // Both halves of the same guarantee: the sim hands out no subject for a
        // reply, and the rig is released on the frame that happens, so the camera
        // never trails one out of the socket.
        const outbound = watch.filter((w) => w.phase === 'reply')
        expect(outbound.length, 'the reply leg was never sampled').toBeGreaterThan(0)
        const held = outbound.filter((w) => w.packet !== null)
        expect(
            held.length,
            `the camera was put on the reply in ${held.length} of ${outbound.length} samples`,
        ).toBe(0)
        const followed = outbound.filter((w) => w.following !== null)
        expect(
            followed.length,
            `the camera followed ${[...new Set(followed.map((w) => w.following))].join(
                '/',
            )} in ${followed.length} of ${outbound.length} reply samples`,
        ).toBe(0)
    })
})
