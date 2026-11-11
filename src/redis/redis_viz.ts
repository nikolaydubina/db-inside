import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { BLOCK_PICK_RANGE, PALETTE } from '../postgresql/instance'
import type { Info } from '../postgresql/instance'
import { PULSE_GAIN, PULSE_TIME, Ticker, fmtBytes, label, pulseHex, rand } from '../core/util'
import type { DictTable } from './dict'
import { BLOCK, CELL, DICT, HEAP, HEAP_PAGE, PITCH, dictX, dictZ, heapX, heapZ } from './layout'
import { RedisBigKind } from './values'
import { REDIS_BIG_REAL, mixHex } from './types'
import type { RedisKey } from './types'

export interface VizHost {
    group: THREE.Group
    ticker: Ticker
    pickables: THREE.Object3D[]
    register(obj: THREE.Object3D, info: Info): void
    keys: readonly RedisKey[]
}

export class DictView {
    private mesh!: THREE.InstancedMesh
    private tableLab!: CSS2DObject
    private shade: number[] = []
    private tmpObj = new THREE.Object3D()
    private tmpColor = new THREE.Color()

    constructor(
        private host: VizHost,
        private table: DictTable,
    ) { }

    build() {
        const { group } = this.host
        const geo = new RoundedBoxGeometry(0.3, 0.07, 0.3, 1, 0.015)
        const mat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            emissive: PALETTE.cyan,
            emissiveIntensity: 0.28,
            roughness: 0.4,
            metalness: 0.35,
        })
        const mesh = new THREE.InstancedMesh(geo, mat, DICT.cols * DICT.rows)
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        group.add(mesh)
        this.mesh = mesh

        let i = 0
        for (let r = 0; r < DICT.rows; r++) {
            for (let c = 0; c < DICT.cols; c++) {
                this.tmpObj.position.set(dictX(c), DICT.y, dictZ(r))
                this.tmpObj.scale.setScalar(1)
                this.tmpObj.updateMatrix()
                mesh.setMatrixAt(i, this.tmpObj.matrix)
                this.shade[i] = rand(0.25, 0.5)
                i++
            }
        }
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
        this.paint()

        const w = DICT.cols * PITCH
        const d = DICT.rows * PITCH
        const pick = new THREE.Mesh(
            new THREE.BoxGeometry(w, 0.6, d),
            new THREE.MeshBasicMaterial({ visible: false }),
        )
        pick.position.set(0, DICT.y, DICT.cz)
        group.add(pick)
        this.host.register(pick, {
            title: 'Hash table — the bucket array, and the rehash',
            body: 'The dictionary is what makes Redis O(1): hash the key, land on a bucket, follow its chain. This plane is the bucket array itself, sitting in the process heap — one contiguous allocation of pointers, and each of those pointers leads to a key entry floating in the plane above. A bucket is one pointer — 8 B on a 64-bit build — so the array costs capacity × 8 B; the keys and their dictEntry chains are the separate allocations above. Measured against the data this is nothing: the whole array is 1 KiB, so the 393 MiB hash at the back of the cage is about 420,000 arrays of this size. Each tile here is a bucket and nothing else, and the faint line leaving it is the pointer — the bytes are always at the far end. The two 16×8 halves are the two tables: 32 buckets is 16×2, 64 is 16×4, 128 is 16×8. There is no index to choose and no planner to consult — the data structure is the query plan. It also GROWS: when the entries outnumber the buckets, redis allocates a second table at twice the size and migrates buckets into it one at a time — the tiles vanishing on one half and lighting up on the other. Both tables are live meanwhile, and every lookup checks both, which is why the growth is incremental: a stop-the-world rehash of a million keys would be a latency spike, and a billion-key one would be a stall you could not hide. The two halves during a rehash are literal: there really are two tables allocated at once.',
            meta: 'dict · ht_table[2] · 8 B per bucket · incremental rehash',
            stats: () => this.table.stats([...this.host.keys]),
        })

        const dictLab = label('DICT · BUCKETS')
        dictLab.position.set(-w / 2 - 0.3, DICT.y + 0.55, DICT.cz - d / 2)
        group.add(dictLab)

        const tableLab = label('')
        tableLab.position.set(-w / 2 - 0.3, DICT.y + 0.22, DICT.cz - d / 2)
        group.add(tableLab)
        this.tableLab = tableLab
        this.paint()
    }

    bucketTop(key: RedisKey): THREE.Vector3 {
        const place = this.table.placeOf(key.i)
        const tile = this.table.tile(place.half, place.bucket)
        return new THREE.Vector3(
            dictX(tile % DICT.cols),
            DICT.y + 0.05,
            dictZ(Math.floor(tile / DICT.cols)),
        )
    }

    paint() {
        if (!this.mesh) return
        const d = this.table
        const n = DICT.cols * DICT.rows
        const usedOld = d.used([...this.host.keys], d.size)
        const usedNew = d.size1 > 0 ? d.used([...this.host.keys], d.size1) : null
        const liveHalf = d.half
        const otherHalf = (liveHalf === 0 ? 1 : 0) as 0 | 1
        const empty = mixHex(0x0d3a48, PALETTE.cyan, 0.14)

        for (let id = 0; id < n; id++) {
            const bOld = d.bucketAtTile(liveHalf, id)
            const bNew = d.bucketAtTile(otherHalf, id)
            let live = false
            let used = false
            if (d.size1 > 0) {
                if (bOld >= 0 && bOld < d.size && bOld >= d.idx) {
                    live = true
                    used = usedOld.has(bOld)
                } else if (bNew >= 0 && bNew < d.idx) {
                    live = true
                    used = usedNew?.has(bNew) ?? false
                }
            } else if (bOld >= 0 && bOld < d.size) {
                live = true
                used = usedOld.has(bOld)
            }

            this.tmpObj.position.set(
                dictX(id % DICT.cols),
                DICT.y,
                dictZ(Math.floor(id / DICT.cols)),
            )
            this.tmpObj.scale.setScalar(live ? 1 : 0.001)
            this.tmpObj.updateMatrix()
            this.mesh.setMatrixAt(id, this.tmpObj.matrix)
            const hex = used
                ? mixHex(0x0d3a48, PALETTE.cyan, 0.5 * (this.shade[id] ?? 0.4) + 0.25)
                : empty
            this.mesh.setColorAt(id, this.tmpColor.setHex(hex))
        }
        this.mesh.instanceMatrix.needsUpdate = true
        if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true

        const text =
            d.size1 > 0
                ? `ht[0] ${d.size} → ht[1] ${d.size1} · ${d.idx}/${d.size}`
                : `ht[0] ${d.size} buckets`
        const el = this.tableLab?.element as HTMLElement | undefined
        if (el && el.textContent !== text) el.textContent = text
    }

    pulse(key: RedisKey) {
        const place = this.table.placeOf(key.i)
        const tile = this.table.tile(place.half, place.bucket)
        this.mesh.setColorAt(tile, this.tmpColor.setHex(pulseHex(PALETTE.ice, 0.4)))
        if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
        void this.host.ticker.add(PULSE_TIME, (k) => {
            this.mesh.setColorAt(
                tile,
                this.tmpColor
                    .setHex(pulseHex(PALETTE.ice, 0.4))
                    .multiplyScalar(1 + (PULSE_GAIN - 1) * (1 - k)),
            )
            if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
        })
        void this.host.ticker.wait(PULSE_TIME).then(() => this.paint())
    }
}

export interface HeapHost extends VizHost {
    heapMask: Uint8Array | undefined
    heapPages: number[]
    bigKeys: Partial<Record<RedisBigKind, RedisKey>>
}

export class HeapView {
    private mesh!: THREE.InstancedMesh
    private ghost!: THREE.Mesh
    private ghostPage: number | null = null
    private tmpObj = new THREE.Object3D()
    private tmpColor = new THREE.Color()

    constructor(private host: HeapHost) { }

    get pageCount() {
        return HEAP.cols * HEAP.rows
    }

    build() {
        const { group } = this.host
        const geo = new RoundedBoxGeometry(HEAP_PAGE, HEAP_PAGE, HEAP_PAGE, 1, 0.01)
        const mat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            emissive: PALETTE.cyan,
            emissiveIntensity: 0.05,
            roughness: 0.5,
            metalness: 0.3,
        })
        const mesh = new THREE.InstancedMesh(geo, mat, this.pageCount)
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        for (let r = 0; r < HEAP.rows; r++) {
            for (let c = 0; c < HEAP.cols; c++) {
                const id = r * HEAP.cols + c
                this.tmpObj.position.set(heapX(c), HEAP.y, heapZ(r))
                this.tmpObj.scale.setScalar(1)
                this.tmpObj.updateMatrix()
                mesh.setMatrixAt(id, this.tmpObj.matrix)
            }
        }
        group.add(mesh)
        this.mesh = mesh
        mesh.userData.infoFor = (hit: THREE.Intersection) => this.pageInfo(hit)
        this.host.pickables.push(mesh)

        const ghostGeo = new THREE.BoxGeometry(HEAP_PAGE * 1.04, HEAP_PAGE * 1.04, HEAP_PAGE * 1.04)
        const ghost = new THREE.Mesh(
            ghostGeo,
            new THREE.MeshStandardMaterial({
                color: 0x0a2f38,
                emissive: PALETTE.ice,
                emissiveIntensity: 0.3,
                transparent: true,
                opacity: 0.14,
                depthWrite: false,
            }),
        )
        ghost.add(
            new THREE.LineSegments(
                new THREE.EdgesGeometry(ghostGeo),
                new THREE.LineBasicMaterial({
                    color: PALETTE.ice,
                    transparent: true,
                    opacity: 0.5,
                }),
            ),
        )
        ghost.visible = false
        ghost.renderOrder = 2
        group.add(ghost)
        this.ghost = ghost
    }

    paint() {
        if (!this.mesh) return
        const free = mixHex(0x04141c, PALETTE.cyan, 0.07)
        const mask = this.host.heapMask
        for (let id = 0; id < this.pageCount; id++) {
            const row = Math.floor(id / HEAP.cols)
            const col = id % HEAP.cols
            const on = mask?.[id] === 1
            this.tmpObj.position.set(heapX(col), HEAP.y, heapZ(row))
            this.tmpObj.scale.setScalar(on ? 1 : 0.001)
            this.tmpObj.updateMatrix()
            this.mesh.setMatrixAt(id, this.tmpObj.matrix)
            const hex = on ? mixHex(0x06222c, PALETTE.cyan, 0.82) : free
            this.mesh.setColorAt(id, this.tmpColor.setHex(hex))
        }
        this.mesh.instanceMatrix.needsUpdate = true
        if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
        this.applyGhost()
    }

    fade(page: number, on: boolean) {
        const row = Math.floor(page / HEAP.cols)
        const col = page % HEAP.cols
        const from = on ? 0.001 : 1
        const to = on ? 1 : 0.001
        const hex = on ? mixHex(0x06222c, PALETTE.cyan, 0.82) : mixHex(0x04141c, PALETTE.cyan, 0.07)
        this.mesh.setColorAt(page, this.tmpColor.setHex(hex))
        if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
        void this.host.ticker
            .add(0.32, (k) => {
                const s = from + (to - from) * Math.min(1, k)
                this.tmpObj.position.set(heapX(col), HEAP.y, heapZ(row))
                this.tmpObj.scale.setScalar(Math.max(0.001, s))
                this.tmpObj.updateMatrix()
                this.mesh.setMatrixAt(page, this.tmpObj.matrix)
                this.mesh.instanceMatrix.needsUpdate = true
            })
            .then(() => this.paint())
    }

    pulse(page: number) {
        this.mesh.setColorAt(page, this.tmpColor.setHex(pulseHex(PALETTE.ice, 0.5)))
        if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
        void this.host.ticker.add(PULSE_TIME, (k) => {
            this.mesh.setColorAt(
                page,
                this.tmpColor
                    .setHex(pulseHex(PALETTE.ice, 0.5))
                    .multiplyScalar(1 + (PULSE_GAIN - 1) * (1 - k)),
            )
            if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
        })
        void this.host.ticker.wait(PULSE_TIME).then(() => this.paint())
    }

    focus(at: THREE.Vector3 | null) {
        const page = at ? this.pageAtPoint(at) : null
        if (page === this.ghostPage) return
        if (this.ghostPage !== null) this.closeGhost()
        this.ghostPage = page
        this.applyGhost()
    }

    private pageAtPoint(at: THREE.Vector3): number | null {
        if (Math.abs(at.y - HEAP.y) > HEAP_PAGE * 2) return null
        const c = Math.round(at.x / CELL + (HEAP.cols - 1) / 2)
        const r = Math.round((at.z - HEAP.cz) / CELL + (HEAP.rows - 1) / 2)
        if (c < 0 || c >= HEAP.cols || r < 0 || r >= HEAP.rows) return null
        const page = r * HEAP.cols + c
        return this.host.heapMask?.[page] === 1 ? page : null
    }

    private closeGhost() {
        const page = this.ghostPage
        this.ghostPage = null
        if (page === null) return
        this.paintPage(page)
        if (this.ghost) this.ghost.visible = false
    }

    private applyGhost() {
        const page = this.ghostPage
        if (page === null || !this.ghost) return
        const col = page % HEAP.cols
        const row = Math.floor(page / HEAP.cols)
        const at = new THREE.Vector3(heapX(col), HEAP.y, heapZ(row))
        this.ghost.position.copy(at)
        this.ghost.visible = true
        this.tmpObj.position.copy(at)
        this.tmpObj.scale.setScalar(0.0001)
        this.tmpObj.rotation.set(0, 0, 0)
        this.tmpObj.updateMatrix()
        this.mesh.setMatrixAt(page, this.tmpObj.matrix)
        this.mesh.instanceMatrix.needsUpdate = true
    }

    private paintPage(page: number) {
        if (!this.mesh) return
        const col = page % HEAP.cols
        const row = Math.floor(page / HEAP.cols)
        const used = this.host.heapMask?.[page] === 1
        this.tmpObj.position.set(heapX(col), HEAP.y, heapZ(row))
        this.tmpObj.scale.setScalar(used ? 1 : 0.001)
        this.tmpObj.rotation.set(0, 0, 0)
        this.tmpObj.updateMatrix()
        this.mesh.setMatrixAt(page, this.tmpObj.matrix)
        this.mesh.instanceMatrix.needsUpdate = true
    }

    private pageInfo(hit: THREE.Intersection): { key: string; info: Info; box: THREE.Box3 } | null {
        if (hit.distance > BLOCK_PICK_RANGE) return this.volumeInfo()
        const id = hit.instanceId
        if (id === undefined || id < 0 || id >= this.pageCount) return null
        const used = this.host.heapMask?.[id] === 1
        const row = Math.floor(id / HEAP.cols)
        const col = id % HEAP.cols
        const box = new THREE.Box3().setFromCenterAndSize(
            new THREE.Vector3(heapX(col), HEAP.y, heapZ(row)),
            new THREE.Vector3(HEAP_PAGE, HEAP_PAGE, HEAP_PAGE),
        )
        const inUse = this.host.heapMask
            ? this.host.heapMask.reduce((n, v) => n + (v ? 1 : 0), 0)
            : 0
        return {
            key: `redis-heap-${id}`,
            info: {
                title: `heap page #${id} — ${used ? 'in use' : 'free'} · 4 KiB`,
                body: used
                    ? 'One 4 KiB page of the process heap, and it is allocated. The keys and values are allocated on pages like this one: the bucket array holds pointers, the dictEntry holds the key and value pointers, and the bytes at the end of those pointers live in memory of this kind. A page is the operating system unit; jemalloc hands out larger runs and carves them into size classes, so several small objects can share one page, and a large value is spread over many. Nothing about this page is a file and nothing about it is a cache: it is the dataset.'
                    : 'One 4 KiB page of the process heap, and nothing is allocated on it. The arena includes it, but no object lives here — it is free space left where an allocation once was or has never been used. Nothing compacts it into the used region: the OS does not defragment RAM, and the allocator only reuses a page when the next allocation fits.',
                meta: `heap page · 4 KiB · ${used ? 'allocated' : 'free'} · ${inUse}/${this.pageCount} pages in use`,
            },
            box: this.toWorld(box),
        }
    }

    private volumeInfo(): { key: string; info: Info; box: THREE.Box3 } {
        const w = (HEAP.cols - 1) * CELL + HEAP_PAGE
        const d = (HEAP.rows - 1) * CELL + HEAP_PAGE
        const box = new THREE.Box3().setFromCenterAndSize(
            new THREE.Vector3(0, HEAP.y, HEAP.cz),
            new THREE.Vector3(w, Math.max(BLOCK.h, HEAP_PAGE) + 0.06, d),
        )
        const inUse = this.host.heapMask
            ? this.host.heapMask.reduce((n, v) => n + (v ? 1 : 0), 0)
            : 0
        const small = this.host.keys.filter((k) => k.live && !k.big)
        const smallBytes = small.reduce((n, k) => n + k.bytes, 0)
        const bigBytes = [RedisBigKind.Hash, RedisBigKind.ZSet, RedisBigKind.List].reduce(
            (n, k) => n + (this.host.bigKeys[k]?.live ? REDIS_BIG_REAL[k].mib * 1024 * 1024 : 0),
            0,
        )
        const pct = Math.round((inUse / this.pageCount) * 100)
        const pageBytes = 4096
        return {
            key: 'redis-heap',
            info: {
                title: 'Memory (Heap)',
                body: "This is the heap: the RAM the dataset occupies, drawn as its own volume, separate from the dashed keyspace above. It is one contiguous arena of 4 KiB page cubes, and it is drawn at a working occupancy — 80% of its pages in use, the free fifth scattered between them. That is the same convention as the postgres disk: a mostly packed volume with fragmentation, not an empty grid and not a solid slab. The pattern comes from a seeded run-allocator model — pages are handed out in runs and freed runs leave holes — not from a repeating rule; the 80% and the run-and-hole shape are the claim, the exact page indices are a model. The pages are scattered by that history, not packed from the start, and nothing reorders them — the OS does not compact RAM. The dashed keyspace above is the representational view of the same bytes: it is not this volume and does not contain it. The bucket array between them holds pointers; the bytes those pointers lead to are counted here. The three dashed areas at the back are the payloads of the big values; their ~676 MiB is counted in resident but cannot be drawn as pages in this arena. The arena itself is a slice of the process address space, not all of the machine's RAM.",
                meta: `heap · ${this.pageCount} x 4 KiB · ${fmtBytes(this.pageCount * pageBytes)} arena · scattered pages · separate volume`,
                stats: () => [
                    { label: 'pages', value: `${this.pageCount} x 4 KiB` },
                    { label: 'arena', value: fmtBytes(this.pageCount * pageBytes) },
                    { label: 'in use', value: `${inUse} · ${pct}%` },
                    { label: 'free', value: `${this.pageCount - inUse} · ${100 - pct}%` },
                    { label: 'dataset', value: fmtBytes(smallBytes) },
                    { label: 'big values', value: `≈ ${fmtBytes(bigBytes)}` },
                    { label: 'resident', value: `≈ ${fmtBytes(smallBytes + bigBytes)}` },
                ],
            },
            box: this.toWorld(box),
        }
    }

    private toWorld(box: THREE.Box3): THREE.Box3 {
        this.host.group.updateMatrixWorld()
        return box.applyMatrix4(this.host.group.matrixWorld)
    }
}
