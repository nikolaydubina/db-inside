import { defineConfig, devices } from '@playwright/test'

/**
 * The end-to-end rig for the drawings.
 *
 * It runs against the dev server, because there is nothing to test without a
 * renderer: these are claims about where a packet is standing when the clock
 * stops. One worker, one browser — the scene is heavy and two of them fighting
 * for the GPU makes every timing assertion a coin toss.
 */
export default defineConfig({
    testDir: './tests',
    // a step may wait for a long walk to reach its stop, and the walk is drawn at
    // 0.4× on purpose, so the budget is generous and every wait is bounded below
    timeout: 120_000,
    expect: { timeout: 20_000 },
    // One tab per story, in parallel.
    //
    // Each test drives its own page against the shared dev server, so the four
    // stories have nothing to say to each other and can run at once. The catch is
    // the GPU: every tab boots the whole scene (two cages, thousands of instanced
    // meshes), and the freeze is frame-driven, so a starved tab walks its route
    // slower in wall-clock terms. Two workers halves the wall time with the frame
    // rate intact; four is the fastest the four stories can go and is what a dev
    // machine with a real GPU should use. Drop to 2 on anything slower.
    fullyParallel: true,
    workers: 4,
    retries: 0,
    reporter: [['list']],
    use: {
        baseURL: process.env.STORY_URL ?? 'http://localhost:5199',
        viewport: { width: 1400, height: 900 },
        /**
         * Headed, deliberately. Headless Chrome renders WebGL through SwiftShader,
         * and this scene — two cages, thousands of instanced meshes — takes the
         * renderer down mid-boot: the page closes and every wait fails as "target
         * closed", which looks exactly like a broken app. A real GPU context costs a
         * window and saves an afternoon.
         */
        headless: false,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    webServer: {
        command: 'npm run dev -- --port 5199 --strictPort',
        url: 'http://localhost:5199',
        reuseExistingServer: true,
        timeout: 90_000,
    },
    // The locally installed Chrome, not a downloaded build: same engine, no
    // 140 MB fetch, and the drawing is judged in the browser the reader has.
    // `npx playwright install chromium` and dropping `channel` works too.
    projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
})
