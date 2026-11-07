# postgresql-inside

An interactive 3D visualisation of how PostgreSQL actually works — one query's journey through
processes, memory, WAL and disks.


```bash
npm install
npm run dev      # http://localhost:5199
npm run build    # static build in dist/
```

## What you are looking at

The floating island is **one PostgreSQL process**. Clients live in the sky and drop queries through
the roof; results stream back up.

| visual | PostgreSQL concept |
| --- | --- |
| wireframe cage, labelled `POSTGRESQL PROCESS` | the running instance: postmaster, backends, shared memory |
| glowing ports on the top rim, `BACKENDS · CONNECTIONS` | one backend **process** per client connection (Postgres forks, it does not use a thread pool). Ports appear and disappear as clients connect and disconnect |
| a port lights up + vertical beam | that backend is busy serving a query |
| one thin path per query | a query enters through a port, runs parser → planner → executor → buffers, and its result leaves through the **same** port; the path fades once the query is done |
| `PARSER` → `PLANNER` → `EXECUTOR` orbs | parse tree, cost-based plan, volcano executor |
| `SHARED BUFFERS · RAM` deck | `shared_buffers` — the RAM cache. It floats above the floor, because it is a cache, not storage. 8 kB pages: cyan = cached, amber = dirty, green = just served a hit |
| the page field | orange blocks covering most of the floor, one block = one 8 kB page. They sit on a 0.5-unit lattice, so four blocks fit exactly inside one floor-grid cell |
| the blue grid floor | not storage, just the ground the whole instance sits on |
| `TABLE: users` / `products` / `metrics` | selection marquees over contiguous runs of those pages. A table is only a name plus a run of pages — that is the whole trick |
| magenta pulsing page | the page holds dead row versions. It is the page itself pulsing — no extra marker geometry |
| block height & brightness | how full that page is. A flat dark slot is a page with nothing in it yet; a tall bright block is a packed page. Fill levels start random, as they do in a real heap |
| green / magenta flash on a page | the statement just touched it: green for INSERT (page fills up, or a brand-new page gets allocated), magenta for DELETE (page drains, and at zero it becomes a flat free slot again) |
| `FREE SPACE · ALLOCATABLE` | holes in the field: no page there at all, just room the files can grow into |
| `PAGE FILE` blocks lifting off | on a buffer miss a page lifts out of the field and floats up toward the deck: that page is now in RAM |
| arrows into the disk | there is no permanent arrow to "the disk". Each read builds its own curve to the exact block it fetches and drops a ring on it; a checkpoint fires a *burst* of arrows, one per dirty page, each to its own block. A buffer hit produces no disk arrow at all |
| `WAL · DISK` run | the log is a contiguous run of page-slots at the front edge of the disk, next to the free space it grows into. A thin blade marks the write position; records append left to right, and at checkpoint the old segments are recycled **in place** — nothing is moved |
| `WAL BUFFERS · RAM` cubes | the newest WAL bytes, held in `wal_buffers` in shared memory until the WAL writer fsyncs them |
| `B-TREE` / `BRIN` / `GIN` / `HASH` | index structures floating in the air: they are shown as they exist **in memory** right now, i.e. their pages read up from the index files into shared buffers |
| `HEAP` (users) | table pages and tuples; magenta blocks are dead tuples left by MVCC updates |
| `EVENTS` | second heap, jsonb payloads — the kind of column a GIN index is for |
| `METRICS` | append-only time series, physically ordered by timestamp |
| `B-TREE` | balanced key → TID tree, three levels |
| `GIN` | inverted index: element → posting list (jsonb, arrays, full-text) |
| `BRIN` | min/max per 128-page range — a few kB for a huge table |
| `HASH` | hash → bucket, equality only |
| `AUTOVACUUM` drone | background vacuum reclaiming dead tuple space |
| arrows and packets | row/page traffic through the engine |

### Memory vs disk

- **The page field is disk.** The orange blocks cover most of the floor on purpose: that is where most
  of the data lives. The plate beneath them is colourless — the blocks are the storage, not the slab.
- **The blue grid is just a floor** — the thing the instance floats over, not storage.
- **Floating means "in RAM right now"**: the `shared_buffers` deck, the `wal_buffers` cubes and the four
  index structures hovering above the plate. A page that is lifted off the plate is a page that has just
  been read into memory.
- Reads climb up from disk into the deck on a miss (one block visibly lifts out of the array); dirty deck
  pages fall back to disk at checkpoint.
- Each table keeps a fixed reserved area, which is a simplification: in reality Postgres grows a heap
  one page at a time wherever the filesystem puts it. Inside the reserved run, pages are allocated and
  freed as rows are inserted and deleted.
- Fragmentation is a gradient across the disk: packed solid on the WAL side, starting to thin out around
  60% of the way across, and the outer 20% has no pages in it at all — only the slot lattice. That tail is
  the disk space files could still grow into.
- Rough numbers: a buffer hit is ~0.1 µs–1 µs of CPU, a disk read 100 µs–10 ms, and an `fsync` on
  `COMMIT` is the thing that actually costs you latency.

### What VACUUM does, and what it does not

- **It reclaims space inside pages.** Dead row versions left by UPDATE/DELETE become reusable for
  future rows on that same page. The page stays exactly where it is, in the same file.
- **It never deletes pages**, never moves rows between pages, and never shrinks the files. It may
  truncate a run of pages that are empty *at the very end* of a relation, which is the only file
  shrinkage plain VACUUM can do.
- **Defragmentation is someone else's job**: `VACUUM FULL`, `CLUSTER` and `pg_repack` rewrite the
  whole table into a fresh, densely packed file. That returns disk space, and it is why they take an
  `ACCESS EXCLUSIVE` lock (except pg_repack, which works around it with triggers).
- **New pages are not created by VACUUM.** Pages are allocated when a statement needs room for a new
  row (INSERT, or an UPDATE that cannot fit the new version on the existing page), and when a relation
  is created or an index is built.

### "Heap" means table file, not heap memory

The three table-ish things in the scene — `TABLE: users`, `TABLE: products`, `TABLE: metrics` — are **demo
schema**, not PostgreSQL internals. Each is just a selection outline over a contiguous run of 8 kB pages
on the disk plate, which is precisely what a table is at the storage layer. They exist to motivate the
four index types: B-tree on `users`, GIN on `products`' jsonb, BRIN on `metrics`' timestamps, hash for
equality.

In PostgreSQL, *heap* is the name of the unordered pile of 8 kB pages a table is stored in (the "heap
file"). It is a file on disk, and has nothing to do with heap memory / malloc.

## Debugging

The simulation dumps its real state instead of you squinting at a screenshot:

```js
__psqlDebug.on()            // one line per 2s of virtual time
__psqlDebug.on(0.5)         // faster
__psqlDebug.off()
__psqlDebug.snapshot()      // current state as an object
__psqlDebug.history(40)     // the last N ticks
__psqlDebug.table('users')  // page-fill histogram for one relation
```

A tick looks like:

```
[psql 12.5s 1x] buffer miss · page fetched from disk ≈ 1 ms
  q=7 hit=71% lat=1.2ms dead=12 conn=3(1 busy) wal=1536B fill=0.53
  chains=1 disk=565/816 free=251 deadPages=12 avgFill=0.57
  buf=0d/32 draw=363 fps=120
```

`draw`/`fps` come from `renderer.info` summed across the bloom passes, so instancing
regressions show up immediately. Open the page with `?debug` to have telemetry on from boot.

## Interactions

- **fly · wasd** (checkbox in Simulate) — `W A S D` to move, `Q`/`E` down/up, `Shift` for 3× boost.
  **Hold the mouse button and drag to look around** (no pointer lock, no mode you cannot escape); release
  and it stops. While flying, a drag rotates the view instead of orbiting the island. Flying suspends
  auto-orbit.
- **space** or `run query` — send a query: falls from the sky, through parser/planner/executor, into
  buffers (hit) or down to disk (miss), then rows rise back to the client.
- **c** — checkpoint: dirty pages flushed, WAL fsynced.
- **v** — vacuum: dead tuples reclaimed by the autovacuum drone.
- **i** — toggle index scan vs sequential scan.
- drag to orbit, scroll to zoom, hover to identify, click to pin an explanation in the inspector.

## Stack

TypeScript + [three.js](https://threejs.org) + Vite, with an `EffectComposer` bloom pass, PCF shadows,
CSS2D labels and a small promise-based tween engine driving the simulation.

## Deploy 

```bash
npx wrangler login
npm run deploy
```

## Author

Built by Deepseek v4.1 Flash in VSCode Copilot harness.
Design and technical review by @nikolaydubina.
