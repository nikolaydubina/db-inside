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
| `SHARED BUFFERS · RAM` deck | `shared_buffers` — the RAM in the picture. 8 kB pages: cyan = cached, amber = dirty, green = just served a hit |
| everything on the floor | disk — heaps, indexes and WAL all live in files down here |
| `WAL · DISK` column | write-ahead log segments. Records append as queries run; at checkpoint the segments are fsynced and recycled, and their blocks drop into the disk array |
| `DISK · PERSISTENT` voxels | an 8 kB page file: each cube is one page. Blocks light up when pages are written at checkpoint (or read back on a buffer miss) |
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

- **RAM above the floor**: `shared_buffers` (and the WAL tail in `wal_buffers`). Fast, volatile.
- **Disk on the floor**: every heap page, index page and WAL segment is a file down there.
- Reads climb up from disk into the deck on a miss; dirty deck pages fall back to disk at checkpoint.
- Watch `checkpoint`: WAL blocks drop into the disk array, then the segment stack recycles.

## Interactions

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
