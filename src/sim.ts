import * as THREE from 'three'
import { ANCHOR, PALETTE, PostgresInstance } from './instance'
import { QueryChain, pathCurve } from './flow'
import type { FlowSet, Paths } from './flow'
import {
  Ticker,
  easeInOutCubic,
  easeInQuad,
  easeOutCubic,
  halo,
  rand,
  randInt,
  travel,
} from './util'

export interface SimStats {
  queries: number
  hitRate: number
  latency: number
  walBytes: number
  dead: number
  note: string
  connections: number
  busyBackends: number
  backendStates: boolean[]
  checkpointing: boolean
  vacuuming: boolean
  compacting: boolean
}

function makePacket(color: number, size: number, scene: THREE.Scene) {
  const g = new THREE.Group()
  const core = new THREE.Mesh(
    new THREE.BoxGeometry(size, size, size),
    new THREE.MeshStandardMaterial({
      color: 0x0a1118,
      emissive: color,
      emissiveIntensity: 2.6,
      roughness: 0.25,
      metalness: 0.4,
    }),
  )
  g.add(core)
  g.add(halo(color, size * 5.2, 0.6))
  scene.add(g)
  return g
}

const despawn = (ticker: Ticker, scene: THREE.Scene, obj: THREE.Object3D, dur = 0.3) => {
  void ticker
    .add(dur, (k) => {
      obj.scale.setScalar(Math.max(0.001, 1 - k))
      obj.rotation.y += 0.2
    })
    .then(() => scene.remove(obj))
}

export class EngineSim {
  queries = 0
  accesses = 0
  hits = 0
  walBytes = 0
  live = 0
  indexScan = false
  note = 'shared_buffers · 8 kB pages'
  /** Which concrete page the last disk operation touched — shown in telemetry. */
  lastOp = 'idle'
  lastLatency = 0.12

  private deadTimer = 2.5
  private scanTimer = 5
  private pageTimer = 0.6
  private connTimer = 3.5
  private checkpointing = false
  private vacuuming = false
  private compacting = false
  private compactTimer = 22
  private clock = 0
  private scanning = false
  private chains: QueryChain[] = []

  constructor(
    private inst: PostgresInstance,
    private ticker: Ticker,
    private scene: THREE.Scene,
    private paths: Paths,
    private flows: FlowSet,
  ) { }

  get activeChains() {
    return this.chains.length
  }

  get clockTime() {
    return this.clock
  }

  get stats(): SimStats {
    const hitRate = this.accesses === 0 ? 0 : (this.hits / this.accesses) * 100
    return {
      queries: this.queries,
      hitRate,
      latency: this.lastLatency,
      walBytes: this.walBytes,
      dead: this.inst.deadTuples,
      note: this.note,
      connections: this.inst.activeBackendCount,
      busyBackends: this.inst.busyBackendCount,
      backendStates: this.inst.backendStates,
      checkpointing: this.checkpointing,
      vacuuming: this.vacuuming,
      compacting: this.compacting,
    }
  }

  setIndexScan(on: boolean) {
    this.indexScan = on
    this.inst.indexScan = on
    this.note = on
      ? 'index scan · b-tree lookup on (user_id)'
      : 'sequential scan · heap pages in order'
    if (on) {
      this.flows.indexToBuffer.setWeight(1.9)
      this.flows.heapToBuffer.setWeight(0.5)
    } else {
      this.flows.indexToBuffer.setWeight(0.6)
      this.flows.heapToBuffer.setWeight(1.1)
    }
  }

  async runQuery() {
    if (this.live >= 3) return
    this.live++
    try {
      await this.querySequence()
    } finally {
      this.live--
    }
  }

  private async querySequence() {
    const kind: 'select' | 'insert' | 'delete' =
      Math.random() < 0.22 ? 'insert' : Math.random() < 0.2 ? 'delete' : 'select'
    const hit = kind === 'select' && Math.random() < (this.indexScan ? 0.9 : 0.78)
    this.queries++

    // pick a connection port on the top boundary — every query gets its own
    const pod = this.inst.acquireBackend()
    if (!pod) return
    const origin = pod.group.position.clone()
    const chain = new QueryChain(this.scene)
    this.chains.push(chain)

    const packet = makePacket(PALETTE.magenta, 0.42, this.scene)
    packet.position.set(origin.x, 27.5, origin.z)

    try {
      // 1. client packet falls into its connection port
      const inbound = pathCurve([
        new THREE.Vector3(origin.x, 27.5, origin.z),
        new THREE.Vector3(origin.x, 18, origin.z + 0.9),
        new THREE.Vector3(origin.x, 12.4, origin.z + 0.35),
        new THREE.Vector3(origin.x, 10.35, origin.z),
      ])
      const fIn = chain.addCurve(inbound, PALETTE.magenta, {
        arrows: 3,
        speed: 0.7,
        opacity: 0.32,
      })
      await travel(this.ticker, packet, inbound, 0.95, easeInQuad)
      fIn.flash(0.9)
      this.inst.pulseBackend(pod)

      // 2. backend hands the query to the parser, through the roof
      const toParse = pathCurve([
        new THREE.Vector3(origin.x, 10.2, origin.z - 0.2),
        new THREE.Vector3(origin.x * 0.9, 8.6, 4.6),
        new THREE.Vector3(ANCHOR.parse.x + 2.8, 7.5, 0.6),
        ANCHOR.parse.clone(),
      ])
      const fToParse = chain.addCurve(toParse, PALETTE.cyan, {
        arrows: 3,
        speed: 0.55,
        opacity: 0.36,
      })
      await travel(this.ticker, packet, toParse, 0.5)
      this.inst.pulseNode('parse', 0.8)
      fToParse.flash(0.8)

      // 3. parser → planner
      const fParse = chain.addCurve(this.paths.parse, PALETTE.cyan, {
        arrows: 3,
        speed: 0.55,
        opacity: 0.4,
      })
      await travel(this.ticker, packet, this.paths.parse, 0.4)
      this.inst.pulseNode('plan', 0.9)
      fParse.flash(0.8)
      await this.ticker.wait(0.08)

      // 4. planner → executor
      const fPlan = chain.addCurve(this.paths.plan, PALETTE.cyan, {
        arrows: 3,
        speed: 0.55,
        opacity: 0.4,
      })
      await travel(this.ticker, packet, this.paths.plan, 0.4)
      this.inst.pulseNode('exec', 1)
      fPlan.flash(0.8)

      // WAL append happens regardless of read/write
      const walPack = makePacket(PALETTE.amber, 0.2, this.scene)
      walPack.position.copy(ANCHOR.exec)
      void travel(this.ticker, walPack, this.paths.execToWal, 0.62).then(() => {
        this.inst.walFill = Math.min(1, this.inst.walFill + 0.09)
        despawn(this.ticker, this.scene, walPack, 0.22)
      })
      this.flows.execToWal.flash(0.7)

      let pageIdx = this.inst.pickBufferPage()

      if (kind === 'insert' || kind === 'delete') {
        // a write: the executor goes straight at the heap pages of a table
        const fExec = chain.addCurve(this.paths.exec, PALETTE.teal, {
          arrows: 3,
          speed: 0.5,
          opacity: 0.4,
        })
        await travel(this.ticker, packet, this.paths.exec, 0.4)
        fExec.flash(0.75)

        const touched =
          kind === 'insert' ? this.inst.insertRows(randInt(1, 3)) : this.inst.deleteRows(randInt(1, 3))
        const target = touched[0]
        if (target) {
          const to = target.home.clone().add(new THREE.Vector3(0, 0.5, 0))
          const from = packet.position.clone()
          const down = pathCurve([from, from.clone().lerp(to, 0.5).add(new THREE.Vector3(0, 1.4, 0)), to])
          const fDown = chain.addCurve(
            down,
            kind === 'insert' ? 0xc7ff5a : PALETTE.magenta,
            { arrows: 3, speed: 0.5, opacity: 0.45 },
          )
          await travel(this.ticker, packet, down, 0.55)
          fDown.flash(0.85)
          this.inst.markBlock(target, kind === 'insert' ? 0xc7ff5a : PALETTE.magenta)
          this.lastOp = `${kind} ${target.table ?? 'free'}[${target.row},${target.col}]`
        }
        despawn(this.ticker, this.scene, packet, 0.2)

        this.accesses++
        this.hits += kind === 'insert' ? 0 : 0
        this.lastLatency = rand(0.3, 1.4)
        this.note =
          kind === 'insert'
            ? `insert · ${touched.length} heap page${touched.length === 1 ? '' : 's'} written, one may be brand new`
            : `delete · ${touched.length} heap page${touched.length === 1 ? '' : 's'} marked dead`
        this.walBytes += kind === 'insert' ? 384 : 320
        if (kind === 'delete') this.inst.markDeadTuples(1)
      } else if (hit) {
        const fExec = chain.addCurve(this.paths.exec, PALETTE.teal, {
          arrows: 4,
          speed: 0.5,
          opacity: 0.44,
        })
        await travel(this.ticker, packet, this.paths.exec, 0.5)
        fExec.flash(0.8)
        const page = this.inst.pages[pageIdx]
        const from = packet.position.clone()
        const to = page.mesh.position.clone().add(new THREE.Vector3(0, 0.22, 0))
        await this.ticker.add(0.18, (k) => {
          packet.position.lerpVectors(from, to, easeOutCubic(k))
        })
        this.inst.setPageActive(pageIdx, PALETTE.teal, 1.3)
        despawn(this.ticker, this.scene, packet, 0.22)
        this.hits++
        this.accesses++
        this.lastLatency = rand(0.04, 0.18)
        this.note = 'buffer hit · page already in RAM ≈ 0.1 ms'
        this.walBytes += 128
      } else {
        // read path: buffer miss → disk → buffer
        const fExec = chain.addCurve(this.paths.exec, PALETTE.teal, {
          arrows: 3,
          speed: 0.5,
          opacity: 0.4,
        })
        await travel(this.ticker, packet, this.paths.exec, 0.35)
        fExec.flash(0.7)

        // the arrow goes to the exact block this read needs, not to "the disk"
        const target = this.inst.pickBlockForRead()
        const toBlock = target
          ? target.home.clone().add(new THREE.Vector3(0, 0.34, 0))
          : this.paths.diskTop.clone()

        const down = pathCurve([
          new THREE.Vector3(ANCHOR.bufferCenter.x - 1.6, 5.1, ANCHOR.bufferCenter.z - 0.6),
          new THREE.Vector3(0.4, 3.9, 1.0),
          toBlock.clone().add(new THREE.Vector3(0, 1.9, 0)),
          toBlock,
        ])
        const fDown = chain.addCurve(down, PALETTE.amber, {
          arrows: 3,
          speed: 0.5,
          opacity: 0.42,
        })
        await travel(this.ticker, packet, down, 0.5, easeInOutCubic)
        fDown.flash(0.9)
        if (target) {
          this.inst.touchBlocks([target], PALETTE.amber, 0.55, 1.15)
          this.inst.markBlock(target, PALETTE.amber)
          this.lastOp = `read ${target.table ?? 'free'}[${target.row},${target.col}]`
        }

        const up = pathCurve([
          toBlock,
          toBlock.clone().add(new THREE.Vector3(0, 1.9, 0)),
          new THREE.Vector3(2.2, 4.7, 1.2),
          new THREE.Vector3(ANCHOR.bufferCenter.x - 0.8, 6.15, ANCHOR.bufferCenter.z - 0.4),
        ])
        const fUp = chain.addCurve(up, PALETTE.amber, {
          arrows: 3,
          speed: 0.5,
          opacity: 0.42,
        })
        const packetCore = packet.children[0] as THREE.Mesh
          ; (packetCore.material as THREE.MeshStandardMaterial).emissive.setHex(PALETTE.amber)
        this.inst.liftFromDisk(pageIdx)
        await travel(this.ticker, packet, up, 0.5)
        fUp.flash(0.8)
        pageIdx = this.inst.pickBufferPage()
        const page = this.inst.pages[pageIdx]
        const from = packet.position.clone()
        const to = page.mesh.position.clone().add(new THREE.Vector3(0, 0.22, 0))
        await this.ticker.add(0.2, (k) => {
          packet.position.lerpVectors(from, to, easeOutCubic(k))
        })
        this.inst.setPageActive(pageIdx, PALETTE.amber, 1.2)
        void this.ticker.add(0.7, (k) => {
          page.base.lerpColors(new THREE.Color(PALETTE.amber), new THREE.Color(PALETTE.cyan), k)
        })
        despawn(this.ticker, this.scene, packet, 0.25)
        this.accesses++
        this.lastLatency = rand(0.4, 1.9)
        this.note = 'buffer miss · page fetched from disk ≈ 1 ms'
        this.walBytes += 256
        this.inst.markDeadTuples(1)
      }

      // 5. rows → result node
      const rows = makePacket(PALETTE.teal, 0.3, this.scene)
      rows.position.copy(this.paths.bufferTop)
      const fRows = chain.addCurve(this.paths.bufferToResult, PALETTE.ice, {
        arrows: 4,
        speed: 0.55,
        opacity: 0.46,
      })
      await travel(this.ticker, rows, this.paths.bufferToResult, 0.6)
      this.inst.pulseNode('result', 0.8)
      fRows.flash(0.8)

      // 6. result goes back out through the same connection
      const toPort = pathCurve([
        ANCHOR.result.clone(),
        new THREE.Vector3(ANCHOR.result.x + 0.5, 7.9, 0.2),
        new THREE.Vector3(origin.x * 0.95, 9.2, origin.z - 2.0),
        new THREE.Vector3(origin.x, 10.3, origin.z - 0.3),
      ])
      const fBack = chain.addCurve(toPort, PALETTE.teal, {
        arrows: 3,
        speed: 0.55,
        opacity: 0.4,
      })
      await travel(this.ticker, rows, toPort, 0.7)
      this.inst.pulseBackend(pod)
      fBack.flash(0.9)
      despawn(this.ticker, this.scene, rows, 0.2)

      // 7. answer leaves to the client
      const outbound = pathCurve([
        new THREE.Vector3(origin.x, 10.45, origin.z),
        new THREE.Vector3(origin.x, 17, origin.z),
        new THREE.Vector3(origin.x, 26.5, origin.z),
      ])
      chain.addCurve(outbound, PALETTE.teal, { arrows: 3, speed: 0.7, opacity: 0.3 })
      const out = makePacket(PALETTE.teal, 0.26, this.scene)
      await travel(this.ticker, out, outbound, 0.8, easeOutCubic)
      despawn(this.ticker, this.scene, out, 0.3)
    } finally {
      this.inst.releaseBackend(pod)
      chain.fadeOut(this.ticker, 1.25)
    }
  }

  async checkpoint() {
    if (this.checkpointing) return
    this.checkpointing = true
    this.note = 'checkpoint · flushing dirty pages + fsync wal'
    try {
      await this.inst.dirtyPages(12)
      await this.inst.flushWal()

      // the WAL is already on disk: at checkpoint its old segments are simply
      // recycled in place — nothing is moved to another place
      const segs = this.inst.walFilledSegments
      for (let i = 0; i < segs; i++) {
        this.inst.flashWalSegment(i)
        await this.ticker.wait(0.05)
      }
      await this.ticker.wait(0.4)

      // a checkpoint is batched: many dirty pages leave at once, each one to its
      // own block in the heap — that is why it is one fsync storm, not many I/Os
      for (let i = 0; i < 7; i++) {
        const page = this.inst.pages[randInt(0, this.inst.pages.length - 1)]
        const target = this.inst.pickBlockForRead()
        const copy = makePacket(PALETTE.amber, 0.26, this.scene)
        copy.position.copy(page.mesh.position)
        const dest = target
          ? target.home.clone().add(new THREE.Vector3(0, 0.34, 0))
          : this.paths.diskTop.clone()
        const curve = pathCurve([
          page.mesh.position.clone(),
          page.mesh.position.clone().lerp(dest, 0.45).add(new THREE.Vector3(0, 1.6, 0)),
          dest,
        ])
        void travel(this.ticker, copy, curve, 0.75).then(() => {
          if (target) {
            this.inst.markBlock(target, PALETTE.amber)
            this.lastOp = `checkpoint write ${target.table ?? 'free'}[${target.row},${target.col}]`
          }
          this.inst.flashDisk()
          despawn(this.ticker, this.scene, copy, 0.2)
        })
        await this.ticker.wait(0.06)
      }

      await this.ticker.wait(0.85)
      this.inst.flashDisk()
      this.inst.cleanAllPages()
      this.inst.walFill = 0.1
      this.note = 'checkpoint complete · dirty pages + WAL durable, segments recycled'
    } finally {
      this.checkpointing = false
    }
  }

  async compact() {
    if (this.compacting) return
    this.compacting = true
    this.note = 'vacuum full · rewriting a table into a packed new file'
    try {
      const res = await this.inst.compact()
      this.note = `vacuum full · ${res.table} rewritten, ${res.pages} pages packed, tail freed`
    } finally {
      this.compacting = false
    }
  }

  async vacuum() {
    if (this.vacuuming) return
    this.vacuuming = true
    try {
      const n = await this.inst.vacuum()
      this.note = n
        ? `vacuum · ${n} dead tuple${n > 1 ? 's' : ''} reclaimed for reuse`
        : 'vacuum · nothing to reclaim, heap is clean'
    } finally {
      this.vacuuming = false
    }
  }

  update(dt: number) {
    for (const f of this.flows.all) f.update(dt)

    // per-query paths: animate, then drop the finished ones
    this.chains = this.chains.filter((c) => {
      c.update(dt)
      return !c.disposed
    })

    this.clock += dt
    this.inst.update(dt, this.clock)

    // clients connect and disconnect
    this.connTimer -= dt
    if (this.connTimer <= 0) {
      this.connTimer = rand(3.5, 8.5)
      const active = this.inst.activeBackendCount
      if (active < 2) this.inst.openBackend()
      else if (active < 6 && Math.random() < 0.6) this.inst.openBackend()
      else if (active > 2) this.inst.closeBackend()
    }

    // ambient MVCC churn
    this.deadTimer -= dt
    if (this.deadTimer <= 0) {
      this.deadTimer = rand(3.2, 6.5)
      this.inst.markDeadTuples(randInt(1, 2))
    }

    // autovacuum's heavier cousin: a periodic rewrite of one relation
    this.compactTimer -= dt
    if (this.compactTimer <= 0 && !this.compacting) {
      this.compactTimer = rand(30, 55)
      this.note = 'pg_repack · rebuilding a table online, pages packed'
      this.compacting = true
      void this.inst.compact().then((res) => {
        this.note = `pg_repack · ${res.table} packed into ${res.pages} pages`
        this.compacting = false
      })
    }

    // ambient scans keep the heap/index alive
    this.scanTimer -= dt
    if (this.scanTimer <= 0 && !this.scanning) {
      this.scanTimer = rand(6.5, 11)
      this.scanning = true
      const flow = this.indexScan ? this.flows.indexToBuffer : this.flows.heapToBuffer
      flow.flash(0.7)
      if (this.indexScan && Math.random() < 0.5) this.flows.ginToBuffer.flash(0.6)
      const run = this.indexScan ? this.inst.scanIndex() : this.inst.scanHeap()
      void run.then(() => {
        this.scanning = false
      })
    }

    // idle page churn so the pool never looks frozen
    this.pageTimer -= dt
    if (this.pageTimer <= 0) {
      this.pageTimer = rand(0.45, 1.3)
      const p = this.inst.pages[randInt(0, this.inst.pages.length - 1)]
      p.heat = Math.max(p.heat, rand(0.12, 0.4))
    }
  }
}
