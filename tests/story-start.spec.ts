import { expect, test } from '@playwright/test'

/**
 * A story starts when you press it.
 *
 * Two things went wrong at once and looked like one bug. Ambient traffic is
 * switched off the moment a story opens, so a first card whose cue was 600–800 ms
 * away left the scene with nothing moving — and three stories had no cue on their
 * opening card at all, so nothing was ever going to arrive. Meanwhile a packet
 * left over from before the story was still in the air, which is why the first and
 * only thing that arrived was of the wrong kind.
 *
 * So: every story must issue its own packet on the frame it starts, and that
 * packet must be the kind its opening card declares — a card about a hash read
 * cannot be satisfied by an ordinary GET.
 */

const KIND: Record<string, string> = {
    queue: 'query',
    wal: 'query',
    pubsub: 'publish',
    traversal: 'big:list',
    zset: 'big:zset',
    hash: 'big:hash',
    inline: 'inline',
    raw: 'raw',
}

test.describe('story start', () => {
    test('every story issues its own packet on the frame it starts', async ({ page }) => {
        await page.goto('/redis')
        await expect.poll(() => page.evaluate(() => window.__test!.ready()), { timeout: 30_000 }).toBe(true)

        const stories = await page.evaluate(() => window.__test!.discover().stories as { id: string; db: string }[])
        expect(stories.length).toBeGreaterThan(0)

        const bad: string[] = []
        for (const s of stories) {
            // what the simulation had done before this story was started
            const before = await page.evaluate(() => ({
                ops: (window as unknown as { __redis: { redisSim: { stats: { ops: number } } } }).__redis
                    .redisSim.stats.ops,
                queries: (window as unknown as { __psql: { sim: { stats: { queries: number } } } }).__psql.sim.stats
                    .queries,
            }))
            await page.evaluate((id) => window.__psqlStory.start(id), s.id)

            // the cue itself: recorded by the runner, measured from the start call
            await expect
                .poll(() => page.evaluate(() => window.__test!.state().firstCue), { timeout: 1500 })
                .not.toBeNull()
            const cue = (await page.evaluate(() => window.__test!.state().firstCue)) as {
                kind: string
                expected: string
                ms: number
            } | null
            expect(cue, `${s.id} issued no packet at all`).not.toBeNull()

            if (cue!.kind !== KIND[s.id]) bad.push(`${s.id}: issued ${cue!.kind}, expected ${KIND[s.id]}`)
            if (cue!.kind !== cue!.expected) {
                bad.push(`${s.id}: issued ${cue!.kind} but its own card declares ${cue!.expected}`)
            }
            if (cue!.ms > 100) bad.push(`${s.id}: the packet was issued ${cue!.ms} ms after the start, not at it`)

            // and the packet actually reached the server, rather than being a call
            // that returned false because the cage was still loading. A publish is
            // not counted in `ops`, so the ride is the second witness.
            const proof = () =>
                page.evaluate(
                    (db) => {
                        const w = window as unknown as {
                            __redis: { redisSim: { stats: { ops: number } } }
                            __psql: { sim: { stats: { queries: number } } }
                        }
                        const n = db === 'redis' ? w.__redis.redisSim.stats.ops : w.__psql.sim.stats.queries
                        const ride = window.__test!.state().ride as { phase: string | null; hasPacket: boolean }
                        return { n, riding: ride.hasPacket || ride.phase !== null }
                    },
                    s.db,
                )
            const was = s.db === 'redis' ? before.ops : before.queries
            await expect
                .poll(async () => {
                    const p = await proof()
                    return p.n > was || p.riding
                }, { timeout: 6000 })
                .toBe(true)

            await page.evaluate(() => window.__psqlStory.stop())
        }

        expect(bad, bad.join('\n')).toEqual([])
    })

    test('the first card has no back button, the second one does', async ({ page }) => {
        await page.goto('/redis')
        await expect.poll(() => page.evaluate(() => window.__test!.ready()), { timeout: 30_000 }).toBe(true)
        await page.evaluate(() => window.__psqlStory.start('hash'))

        // `← back` on the first card points at nothing: there is no card behind it
        await expect.poll(() => page.evaluate(() => window.__test!.state().index)).toBe(0)
        expect(await page.evaluate(() => getComputedStyle(document.querySelector('#story-prev')!).display)).toBe('none')

        await page.evaluate(() => document.getElementById('story-next')!.click())
        await expect.poll(() => page.evaluate(() => window.__test!.state().index)).toBe(1)
        expect(await page.evaluate(() => getComputedStyle(document.querySelector('#story-prev')!).display)).not.toBe('none')
    })
})
