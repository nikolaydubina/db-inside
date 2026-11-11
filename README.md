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

- [ ] Hadoop
- [ ] Clickhouse
- [ ] kdb+
- [ ] TigerBee
- [ ] DuckDB
- [ ] Elasticsearch
- [ ] Weaviate
- [ ] MongoDB

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
- [ ] /dev/shm
- [ ] `effective_cache_size`
- [ ] `maintenance_work_mem`
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
- [ ] **the seq-scan ring buffer** — a bulk read streams through a 256 KiB ring so a scan does not
      evict the whole pool. The drawing walks every page of a scan with no such limit, so it implies a
      scan is free to displace everything.
- [ ] **the index cage is a shape, not memory** — the B-tree/GIN/BRIN/hash trees float permanently and
      are dashed. What actually happens is 3 page reads into 3 buffer slots, and a miss is a disk
      read first. Make the cages hold real pages, and light the slots the descent touches.
- [ ] **partitioning** — declarative range/list/hash partitions and the planner's pruning. This is what
      "shard" means inside one server; cross-server sharding is not in core and should say so rather
      than be drawn as if it were.
- [ ] **`pg_dump` / `pg_restore`** — a logical copy that becomes SQL and is replayed as individual
      `INSERT`s, which is why restoring 100 GB is hours and the WAL never sees a bulk path.
- [ ] **crash and recovery** — `kill -9` at an arbitrary instant, then start: the last checkpoint, then
      replay of everything after it from `pg_wal`, then the database is back. The single most
      convincing thing this scene could show, and it currently shows only the steady state.
- [ ] **fsync and commit latency** — `COMMIT` waits for one fsync; `synchronous_commit=off` trades
      durability for latency; a group commit amortises N commits into one flush.
- [ ] **two copies of every page** — shared_buffers *and* the OS page cache. A buffer miss is often a
      memory copy, not a disk read, and the drawing has no second level.
- [ ] **checkpoint spikes** — `full_page_writes` writes whole pages to WAL right after a checkpoint, so
      WAL volume and write latency jump for a few seconds. Nobody expects it until they see it.
- [ ] **deadlock** — two transactions each holding what the other wants; the detector kills one. This
      is the story the lock manager is needed for.

**Stories that need no new geometry**
- [ ] **a table insert, end to end** — parse → plan → exec → buffer slot → WAL record → flush. The
      single clearest walk through everything already drawn.
- [ ] **locks and transactions** — `BEGIN … UPDATE … COMMIT`, and the second session blocked on the
      same row.
- [ ] **a rollback** — the same write, then `ROLLBACK`: dead tuple, WAL record, nothing durable to keep.

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

**The command mix is too narrow**
- [ ] **one real pattern per value type** — today every command is a single-key read or write. The
      shapes that matter are the iterators and the multi-key calls: `LRANGE` over a long list,
      `HGETALL` on a big hash, `ZRANGE` down a skiplist, `LPUSH`/`LPOP` from both ends, `INCR` on a
      hot counter, `SCARD`, `SINTERSTORE` across two sets, `MSET`/`MGET` fanning one packet into N key
      lookups, `SISMEMBER`/`SADD`/`SREM`.
- [ ] **`vset`** — listed, but it is not a Redis command; it needs pinning down before it becomes a
      story.
- [ ] **`SCAN`** — a cursor, not a snapshot: one bucket range per call, no `O(N)` stall, and possible
      repeats. The visual opposite of `KEYS *`.
- [ ] **`WATCH` / `MULTI` abort** — optimistic locking: a watched key changes, and `EXEC` returns null
      instead of running. The only place Redis refuses to do what a client asked.
- [ ] **very large keys** — what the limit actually is (a string may be up to 512 MiB, a page is
      4 KiB), and what happens on the way out: the reply is assembled in the client's output buffer,
      so reading a 100 MiB value allocates 100 MiB in the server, page by page, not one hop.
- [ ] **bitmaps and hyperloglog** — `SETBIT`/`BITCOUNT`/`BITFIELD` and `PFADD`/`PFCOUNT`, the two
      encodings where a key's size is decoupled from its cardinality.
- [ ] **RedisJSON and `FT.SEARCH`** — a module type whose value is a document tree, and a search index
      that is a structure Redis core does not have at all. Both say "modules" better than prose.
- [ ] **cluster redirection** — `MOVED`/`ASK`, hash tags and the 16,384 slots. A client that gets a
      redirection has to hop to another node, which is a route the scene has never drawn.
- [ ] **regimes: pub/sub only, and distributed locks only** — two production shapes with nothing else
      in them: one where the keyspace is empty and every packet is a fan-out, one where the whole
      workload is `SET NX PX` plus `DEL`.
- [ ] **a regime blocked by bad performance** — the workload that makes the single thread the story:
      one `KEYS *` or a big `HGETALL` in the mix, and every other client waiting behind it.
- [ ] **TTL as a second dict** — expires is its own hash keyed by the same keys, sampled by the active
      cycle 20 keys at a time; a key can be logically gone and still take memory. Only lazy expiry is
      listed above; the dict itself is not drawn.
- [ ] **`UNLINK` vs `DEL`** — deleting a 100 MiB value costs the thread the whole free; `UNLINK` hands
      it to a background thread. Same command family, opposite latency.

### Overall

These are not features of a server, they are the yardsticks that make the rest readable.

- [ ] **latency to scale** — one band with L1 (~0.5 ns), RAM (~100 ns), shared_buffers hit (~1 µs),
      the loop's queue hop (~10 µs), SSD read (~100 µs), a network round trip (~500 µs), a spinning-disk
      seek (~10 ms). Everything the scene animates should be checkable against it.
- [ ] **memory to scale** — one band with a 4 KiB page, 8 KiB buffer slot, 16 MiB WAL segment, 512 MiB
      max string, 1 GiB value, and the arena in the redis cage, so "big" and "small" stop being words.
- [ ] **an accuracy ledger** — every number in an inspector card that is *not* measured from the scene
      gets one line here: what it is derived from, and whether it is measured, estimated or illustrative.
      The 80% heap occupancy and the 393 MiB big hash are estimates today and say so nowhere.

## Deploy 

```bash
npx wrangler login
npm run deploy
```

## Author

Built by Deepseek v4.1 Flash in VSCode Copilot harness.
Design and technical review by @nikolaydubina.
