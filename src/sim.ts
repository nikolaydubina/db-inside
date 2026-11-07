import * as THREE from 'three'
import { ANCHOR, PALETTE, PostgresInstance } from './instance'
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
  activeBackends: number
  backendCapacity: number
  checkpointing: boolean
  vacuuming: boolean
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
  lastLatency = 0.12

  private deadTimer = 2.5
  private scanTimer = 5
  private pageTimer = 0.6
  private checkpointing = false
  private vacuuming = false
  private scanning = false

  constructor(
    private inst: PostgresInstance,
    private ticker: Ticker,
    private scene: THREE.Scene,
    private paths: Paths,
    private flows: FlowSet,
  ) { }

  get stats(): SimStats {
    const hitRate = this.accesses === 0 ? 0 : (this.hits / this.accesses) * 100
    return {
      queries: this.queries,
      hitRate,
      latency: this.lastLatency,
      walBytes: this.walBytes,
      dead: this.inst.deadTuples,
      note: this.note,
      activeBackends: this.live,
      backendCapacity: 4,
      checkpointing: this.checkpointing,
      vacuuming: this.vacuuming,
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
    this.inst.backendLoad = this.live
    try {
      await this.querySequence()
    } finally {
      this.live--
      this.inst.backendLoad = this.live
    }
  }

  private async querySequence() {
    const hit = Math.random() < (this.indexScan ? 0.9 : 0.78)
    this.queries++

    const packet = makePacket(PALETTE.magenta, 0.42, this.scene)
    packet.position.copy(ANCHOR.sky)
    this.flows.sky.flash(0.6)

    await travel(this.ticker, packet, this.paths.sky, 0.85, easeInQuad)
    this.inst.pulseNode('parse', 0.8)
    this.flows.parse.flash(0.8)
    await this.ticker.wait(0.06)

    await travel(this.ticker, packet, this.paths.parse, 0.4)
    this.inst.pulseNode('plan', 0.9)
    this.flows.plan.flash(0.8)
    await this.ticker.wait(0.1)

    await travel(this.ticker, packet, this.paths.plan, 0.4)
    this.inst.pulseNode('exec', 1)
    this.flows.exec.flash(1)

    // WAL append happens regardless of read/write
    const walPack = makePacket(PALETTE.amber, 0.2, this.scene)
    walPack.position.copy(ANCHOR.exec)
    void travel(this.ticker, walPack, this.paths.execToWal, 0.62).then(() => {
      this.inst.walFill = Math.min(1, this.inst.walFill + 0.09)
      despawn(this.ticker, this.scene, walPack, 0.22)
    })
    this.flows.execToWal.flash(0.7)

    let pageIdx = this.inst.pickBufferPage()

    if (hit) {
      await travel(this.ticker, packet, this.paths.exec, 0.5)
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
      await travel(this.ticker, packet, this.paths.exec, 0.35)
      this.flows.bufferToDisk.flash(1.2)
      this.flows.diskToBuffer.flash(0.8)
      await travel(this.ticker, packet, this.paths.bufferToDisk, 0.42, easeInOutCubic)
      this.inst.flashDisk()
      this.inst.flashDisk(randInt(0, 2))
      await this.ticker.wait(0.14)
      const packetCore = packet.children[0] as THREE.Mesh
        ; (packetCore.material as THREE.MeshStandardMaterial).emissive.setHex(PALETTE.amber)
      await travel(this.ticker, packet, this.paths.diskToBuffer, 0.5)
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

    // rows travel back to the client
    const rows = makePacket(PALETTE.teal, 0.3, this.scene)
    rows.position.copy(this.paths.bufferTop)
    this.flows.bufferToResult.flash(0.9)
    await travel(this.ticker, rows, this.paths.bufferToResult, 0.62)
    this.inst.pulseNode('result', 0.8)
    this.flows.resultToSky.flash(0.7)
    await travel(this.ticker, rows, this.paths.resultToSky, 0.8, easeOutCubic)
    despawn(this.ticker, this.scene, rows, 0.3)
  }

  async checkpoint() {
    if (this.checkpointing) return
    this.checkpointing = true
    this.note = 'checkpoint · flushing dirty pages + fsync wal'
    try {
      await this.inst.dirtyPages(12)
      this.flows.walToDisk.flash(1.2)
      this.flows.bufferToDisk.flash(0.9)
      await this.inst.flushWal()

      // checkpoint: fsynced WAL blocks are written out, then segments recycle
      const segs = this.inst.walFilledSegments
      for (let i = 0; i < segs; i++) {
        const block = makePacket(PALETTE.amber, 0.32, this.scene)
        block.position.copy(this.inst.walBlockPosition(i))
        void travel(this.ticker, block, this.paths.walToDisk, 0.85, easeInOutCubic).then(() => {
          this.inst.flashDisk()
          despawn(this.ticker, this.scene, block, 0.2)
        })
        await this.ticker.wait(0.06)
      }
      await this.ticker.wait(0.5)

      for (let i = 0; i < 7; i++) {
        const page = this.inst.pages[randInt(0, this.inst.pages.length - 1)]
        const copy = makePacket(PALETTE.amber, 0.26, this.scene)
        copy.position.copy(page.mesh.position)
        void travel(this.ticker, copy, this.paths.bufferToDisk, 0.75).then(() => {
          this.inst.flashDisk(randInt(0, 2))
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

    this.inst.update(dt, performance.now() * 0.001)

    // ambient MVCC churn
    this.deadTimer -= dt
    if (this.deadTimer <= 0) {
      this.deadTimer = rand(3.2, 6.5)
      this.inst.markDeadTuples(randInt(1, 2))
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
