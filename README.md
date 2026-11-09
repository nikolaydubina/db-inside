# db-inside

An interactive 3D visualisation of databases.

```bash
npm install
npm run dev      # http://localhost:5199
npm run build    # static build in dist/
```

## Walkthrough views

Camera poses live in `src/views.ts` as named shots derived from live anchors, not from magic
numbers — move a structure and its view moves with it.

```js
__psqlViews.list()            // ids, labels, which entity each one is about
__psqlViews.go('wal')         // fly there over 0.85s
__psqlViews.snap('buffers')   // cut straight there
__psqlViews.isAt('wal')       // true if the camera is on that pose (assert in tests)
__psqlViews.pose('wal')       // { pos, target, fov } without moving
__psqlViews.anchor('wal')     // live anchor vector, for authoring new views
__psqlViews.lookAt(vec3, [0,3,8], 36)   // ad-hoc framing
```

Deep link for screenshots and tests:

```
http://localhost:5199/?view=wal          # or ?view=pages&debug
```

Playwright:

```js
await page.goto('http://localhost:5199/?view=pages')
await page.waitForTimeout(600)           // let the boot tween settle
await page.screenshot({ path: 'pages.png' })
```

Because every pose is a plain function of the anchors, adding a shot for a new entity is two lines:

```ts
{ id: 'gin', label: 'gin', entity: 'gin index', hint: 'jsonb postings',
  pose: () => shot(ANCHOR.gin, [2.5, 2.5, 5], 32) }
```

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

Arrows are checked against the geometry, not by eye — every statement arrow records
where it landed, so you can confirm it hit a real block:

```js
__psql.sim.lastOp         // "read products[9,39]"
__psql.sim.lastArrowEnd   // Vector3 — exactly inst.blockTop(that block)
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

The redis cage is one instanced mesh with no idea what is in it, and its files are a handful of
indices, so the two can drift apart. Instead of squinting at it, ask it to prove itself:

```js
__redis.check()             // [] = the drawn blocks are exactly the blocks the files have
```

It reads the instance matrices back and checks that the log is exactly blocks `0..head` at their
own slots, that the floor past the end is empty, that the base file is its blocks with a partial
tail, that no block is in both files, that each cage equals its file's footprint, that no staged
block survives a rewrite, and that no drawn block is black. `?debug` runs the same check after
every layout, save, load and rewrite and throws on the first broken statement.

The clock slides all the way to zero, and zero is a real setting: the simulation stops, so every
coordinate in the scene holds still and can be read and asserted. The camera keeps working — its
follow is driven by real time, not by the simulation clock — so a frozen packet still gets framed.

```js
__clock.stop()              // freeze; __clock.resume(), __clock.set(0.25), __clock.speed
__ride()                    // what the camera is riding: packet id, packet, camera, aim, gap
```

`__ride()` is how the pub/sub story's follow is checked: with time stopped, the camera should settle
at `aim == packet` and `gap == the shot's dist`, and any drift shows up as a number.

## Stack

TypeScript + [three.js](https://threejs.org) + Vite, with an `EffectComposer` bloom pass, PCF shadows,
CSS2D labels and a small promise-based tween engine driving the simulation.

## TODO

Things the scene does not show yet. The first block is already listed in the Stories card with a
`soon` tag, so the gaps are visible in the app as well as here.

### PostgreSQL

**Long-running-instance failures**
- [ ] **a slot that pins the WAL** — an inactive replication slot stops the ring recycling, so
      `pg_wal` grows past the run until the disk fills.
- [ ] **catalog bloat** — repeated `CREATE`/`ALTER`/`DROP` leaves dead tuples in `pg_class`,
      `pg_attribute`, `pg_type` and `pg_depend`; VACUUM reuses the space but the files never shrink.
- [ ] **a transaction that never ends** — an old `xmin` stops VACUUM everywhere: dead tuples pile up
      in every table and `pg_xact` cannot be truncated.
- [ ] **multixact accumulation** — heavy `SELECT … FOR SHARE` concurrency grows
      `pg_multixact/members`, which has its own wraparound hazard.

**Missing structure**
- [ ] **locks and waiting** — the biggest omission. A blocked query waits on a lock with no visual at
      all; the lock manager exists only as an invisible pick target.
- [ ] **`work_mem` and spills** — sorts, hash joins and `pgsql_tmp` temp files are not represented, so
      execution looks allocation-free.
- [ ] **MVCC horizon** — dead tuples are drawn, but `xmin`/snapshots/freezing are not, which is what
      the "transaction that never ends" story needs.
- [ ] **TOAST** — out-of-line storage for wide values (the `jsonb` in `products`) is not drawn.
- [ ] **replication** — standbys, WAL senders and slots exist only as planned stories.
- [ ] **planner statistics** — the planner node claims cost-based decisions but there is no
      `pg_statistic`/ANALYZE surface behind it.

**Correctness / polish**
- [ ] WAL story prose says "16 MiB segment blocks" while the run is drawn as 12 blocks; the inspector
      copy already states 16 MiB per segment.
- [ ] a few 3D labels still collide (`PARSER`).
- [ ] this README predates story mode and the workload regimes.

### Redis

The redis cage has one thread, a shared command queue, a dict, five value types, TTL expiry,
eviction, the AOF (growth, `appendfsync`, rewrite, start-up load) and the RDB (`bgsave`, `save`,
load). The connection path is drawn down to the kernel: a socket is a doughnut on the top rim, and
`epoll`'s registered fds are a dashed plate of tiles under the queue that light on connect and flash
when the loop actually reads from that fd. Values carry their encoding too: a compact value is one
block, and a conversion stacks the new structure on top of it. These are the structure-level things
it still cannot show.

- [ ] **blocking commands** — `BLPOP` does not stall the server: the client is parked and the thread
      moves on. The cage currently says a slow command stalls everyone, which is true of `KEYS *`
      and false of `BLPOP`, and that distinction is the most commonly misunderstood thing in Redis.
- [ ] **`MULTI`/`EXEC` and Lua** — queued, then executed in one burst; and `BUSY` after
      `lua-time-limit`, the only reply of its kind Redis ever sends.
- [ ] **`KEYS *`** — absent from the command mix, so the queue never shows a real stall.
- [ ] **replication** — replica, `PSYNC`, and the **repl backlog: a fixed-size ring buffer** — the one
      structure here whose policy is the opposite of the AOF that only ever grows. Full resync is an
      RDB transfer followed by a stream.
- [ ] **LRU/LFU eviction** — eviction picks a random key today. Redis samples `maxmemory-samples`
      keys and evicts the least recently used of the sample, and `allkeys-*` vs `volatile-*` decides
      whether keys with a TTL are preferred victims.
- [ ] **lazy expiry** — only the active cycle exists, so a key whose TTL passed is still served until
      the cycle reaches it.
- [ ] **io-threads** — Redis 6+ reads and writes sockets on several threads while command execution
      stays serial. Worth showing because "is it single-threaded?" is the question everyone asks.
- [ ] **client buffers** — `output-buffer-limit`, `query-buffer-limit` and the `OOM command not
      allowed` reply are not drawn, so backpressure has no visual.

## Deploy 

```bash
npx wrangler login
npm run deploy
```

## Author

Built by Deepseek v4.1 Flash in VSCode Copilot harness.
Design and technical review by @nikolaydubina.
