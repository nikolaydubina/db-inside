/**
 * Star badge: shows the repository's star count and links to it. The count is
 * fetched once per visit and cached, because the unauthenticated GitHub API is
 * rate limited per IP — and because a badge that is blank on a repeat visit
 * looks broken. Any failure is silent: the badge still links to the repo.
 */
const REPO = 'nikolaydubina/postgresql-inside'
const CACHE_KEY = 'psql.stars'
const TTL = 6 * 60 * 60 * 1000

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export function initCredits() {
    const el = document.getElementById('gh-stars')
    if (!el) return

    const paint = (n: number) => {
        el.textContent = fmt(n)
    }

    // a cached number paints immediately, so a repeat visit never shows a dash
    try {
        const raw = localStorage.getItem(CACHE_KEY)
        if (raw) {
            const { n, t } = JSON.parse(raw) as { n?: number; t?: number }
            if (typeof n === 'number') paint(n)
            if (typeof t === 'number' && Date.now() - t < TTL) return
        }
    } catch {
        /* private mode or corrupt cache: carry on and fetch */
    }

    void fetch(`https://api.github.com/repos/${REPO}`, {
        headers: { Accept: 'application/vnd.github+json' },
    })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { stargazers_count?: number } | null) => {
            const n = j?.stargazers_count
            if (typeof n !== 'number') return
            paint(n)
            try {
                localStorage.setItem(CACHE_KEY, JSON.stringify({ n, t: Date.now() }))
            } catch {
                /* ignore */
            }
        })
        .catch(() => {
            /* offline or rate limited — the badge is still a link */
        })
}
