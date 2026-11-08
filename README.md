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

## Stack

TypeScript + [three.js](https://threejs.org) + Vite, with an `EffectComposer` bloom pass, PCF shadows,
CSS2D labels and a small promise-based tween engine driving the simulation.

## TODO

Things the scene does not show yet. The first block is already listed in the Stories card with a
`soon` tag, so the gaps are visible in the app as well as here.

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
- [ ] WAL story prose says "16 MB segment blocks" while the run is drawn as 12 blocks; the inspector
      copy already states 16 MB per segment.
- [ ] a few 3D labels still collide (`WAL BUFFERS · RAM`, `PARSER`, `SHARED BUFFERS · RAM`).
- [ ] this README predates story mode and the workload regimes.

## Deploy 

```bash
npx wrangler login
npm run deploy
```

## Author

Built by Deepseek v4.1 Flash in VSCode Copilot harness.
Design and technical review by @nikolaydubina.
