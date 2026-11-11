import { expect, test } from '@playwright/test'
import type { TestSurface } from '../src/test-surface'

declare global {
    interface Window {
        __test: TestSurface
        __psql: {
            sim: {
                misses: number
                runQuery(): void
            }
        }
    }
}

type Audit = ReturnType<TestSurface['packets']>

// Packets alive at once are one per busy backend plus the handful of WAL, row and
// reply packets that live for a few hundred milliseconds. A backlog blocked on
// backpressure is parked above the ports and is counted on its own, so it never
// counts against this — anything else that piles up is a leak, not traffic.
const LIVE_CAP = 64

const strays = (audits: Audit[]) =>
    audits.flatMap((a) => a.stuck).map((p) => ({ at: p.at, color: p.color, age: p.age }))

const boot = async (page: import('@playwright/test').Page) => {
    await page.goto('/postgresql')
    await expect
        .poll(() => page.evaluate(() => !!window.__test && window.__test.ready()), {
            timeout: 40_000,
            message: 'the scene never finished booting',
        })
        .toBe(true)
    await page.evaluate(() => window.__test.fast(6))
}

test.describe('packets settle', () => {
    // A buffer miss sends the request packet down to a disk block and back. That leg
    // used to throw on a bad property path, after the packet had landed: the request
    // stayed on the disk in magenta forever, one per miss, for as long as the page ran.
    test('a long run leaves nothing standing on the disk', async ({ page }) => {
        await boot(page)
        const before = await page.evaluate(() => window.__psql.sim.misses)

        const audits: Audit[] = []
        const sample = async () => audits.push(await page.evaluate(() => window.__test.packets()))

        // A buffer miss is what sends the request packet down to a disk block and
        // back, and which statement misses is random — so keep the engine busy rather
        // than hope the ambient timer rolls one inside the window.
        const busyUntil = Date.now() + 18_000
        while (Date.now() < busyUntil) {
            await page.evaluate(() => window.__psql.sim.runQuery())
            await page.waitForTimeout(500)
            await sample()
        }
        // The detector needs a few scene-seconds of a still packet to fire, so watch
        // the scene after the last statement lands, not only while they are running.
        for (let i = 0; i < 8; i++) {
            await page.waitForTimeout(500)
            await sample()
        }

        const misses = (await page.evaluate(() => window.__psql.sim.misses)) - before
        expect(
            misses,
            'no page was ever fetched from disk, so the read path was not exercised',
        ).toBeGreaterThan(0)
        expect(strays(audits), 'packets stopped moving and will never be despawned').toEqual([])
        expect(
            Math.max(...audits.map((a) => a.live)),
            'packets piled up over the run',
        ).toBeLessThanOrEqual(LIVE_CAP)
    })

    // The one case that is allowed to accumulate: more requests than the input
    // buffers hold wait above the ports. They are parked, not lost, and they drain.
    test('a burst parks its backlog and then drains it', async ({ page }) => {
        await boot(page)
        await page.evaluate(() => {
            for (let i = 0; i < 24; i++) window.__psql.sim.runQuery()
        })

        const audits: Audit[] = []
        let backlog = 0
        let drained = false
        const deadline = Date.now() + 25_000
        while (Date.now() < deadline) {
            await page.waitForTimeout(150)
            const a = await page.evaluate(() => window.__test.packets())
            audits.push(a)
            backlog = Math.max(backlog, a.parked)
            if (backlog > 0 && a.parked === 0) {
                drained = true
                break
            }
        }

        expect(backlog, 'the burst never produced a backlog to test').toBeGreaterThan(0)
        expect(drained, 'the backlog never drained').toBe(true)
        expect(strays(audits), 'packets stopped moving during the burst').toEqual([])
        expect(audits[audits.length - 1].live).toBeLessThanOrEqual(LIVE_CAP)
    })
})
