import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
    testDir: './tests',
    timeout: 120_000,
    expect: { timeout: 20_000 },
    fullyParallel: true,
    workers: 4,
    retries: 0,
    reporter: [['list']],
    use: {
        baseURL: process.env.STORY_URL ?? 'http://localhost:5199',
        viewport: { width: 1400, height: 900 },
        headless: false,
        launchOptions: {
            args: [
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--disable-backgrounding-occluded-windows',
            ],
        },
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    webServer: {
        command: 'npm run dev -- --port 5199 --strictPort',
        url: 'http://localhost:5199',
        reuseExistingServer: true,
        timeout: 90_000,
    },
    projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
})
