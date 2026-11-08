import * as THREE from 'three'
import { INBUF_CELLS, PALETTE, PostgresInstance } from './instance'
import type { BackendPod } from './instance'
import { QueryChain, pathCurve } from '../core/flow'
import type { FlowSet, Paths } from '../core/flow'
import {
  Ticker,
  easeInOutCubic,
  easeInQuad,
  easeOutCubic,
  halo,
  rand,
  randInt,
  travel,
} from '../core/util'

export interface SimStats {
  queries: number
  hitRate: number
  latency: number
  walBytes: number
  /** how many of the visual segments the log has reached */
  walSegments: number
  /** WAL bytes written but not yet fsynced — memory only, not durable */
  walPending: number
  dead: number
  note: string
  connections: number
  maxConnections: number
  /** completed queries per simulated second, over a short sliding window */
  rps: number
  /** arrived, but no connection has picked them up yet */
  queued: number
  /** requests sitting in backends' input buffers, behind what they are running */
  buffered: number
  busyBackends: number
  backendStates: boolean[]
  checkpointing: boolean
  vacuuming: boolean
  compacting: boolean
}

/** window for the throughput figure, in simulated seconds */
const RPS_WINDOW = 2

function makePacket(color: number, size: number, parent: THREE.Object3D) {
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
  parent.add(g)
  return g
}

const despawn = (ticker: Ticker, parent: THREE.Object3D, obj: THREE.Object3D, dur = 0.3) => {
  void ticker
    .add(dur, (k) => {
      obj.scale.setScalar(Math.max(0.001, 1 - k))
      obj.rotation.y += 0.2
    })
    .then(() => parent.remove(obj))
}

/**
 * The statements the demo clients send. The access path is a property of the
 * statement, not a setting: `WHERE id = $1` is a point lookup the planner
 * answers from a b-tree, while a range or an unfiltered read has to walk the
 * heap. Postgres picks between them from statistics, so the scene does too —
 * there is nothing for a viewer to toggle.
 */
type Statement = {
  sql: string
  kind: 'select' | 'insert' | 'delete'
  /** answered from an index instead of scanning the heap */
  viaIndex: boolean
  /** relative share of the traffic */
  weight: number
}

const STATEMENTS: Statement[] = [
  { sql: 'select … from users where id = $1', kind: 'select', viaIndex: true, weight: 3 },
  { sql: 'select … from products where doc @> $1', kind: 'select', viaIndex: true, weight: 1.6 },
  { sql: 'select … from metrics order by ts desc limit 20', kind: 'select', viaIndex: false, weight: 2 },
  { sql: 'insert into metrics (…) values (…)', kind: 'insert', viaIndex: false, weight: 1.4 },
  { sql: 'delete from users where id = $1', kind: 'delete', viaIndex: true, weight: 1 },
]

/**
 * Workload regimes. They change the mix of statements that arrive and how fast
 * they arrive — never the code path a query takes. Some behaviour is only
 * visible under the right traffic: dirty pages need writes, backpressure needs
 * arrivals outrunning the pool, a high hit rate needs reads.
 */
export type Regime = 'default' | 'read' | 'write' | 'burst'

const REGIMES: Record<Regime, { label: string; select: number; write: number; pace: number }> = {
  default: { label: 'default', select: 1, write: 1, pace: 1 },
  read: { label: 'read heavy', select: 4, write: 0.12, pace: 0.85 },
  write: { label: 'write heavy', select: 0.35, write: 7, pace: 0.9 },
  burst: { label: 'burst', select: 1, write: 1, pace: 0.3 },
}

export const REGIME_ORDER: Regime[] = ['default', 'read', 'write', 'burst']
export const regimeLabel = (r: Regime) => REGIMES[r].label

export class EngineSim {
  queries = 0
  accesses = 0
  hits = 0
  walBytes = 0
  live = 0
  /** The statement in flight is answered from an index rather than the heap. */
  indexScan = false
  /** bytes already forced to disk since the run started */
  private flushedBytes = 0
  /** bytes sitting in wal_buffers, counted as written but not yet durable */
  private bufferedBytes = 0
  /** countdown to the next write+fsync by the WAL writer */
  private walFlushTimer = 0.6
  private flushing = false
  /** ambient background traffic; a story turns it off so its own taps are the only load */
  ambient = true
  /** which mix of statements arrives — see REGIMES */
  regime: Regime = 'default'
  note = 'shared_buffers · 8 kB pages'
  /** Arrivals whose bytes are sitting in a socket because a buffer was full. */
  private parked: { pod: BackendPod; packet: THREE.Group }[] = []
  /** Connections with a statement in progress right now. */
  private running = new Set<number>()
  /** Completion times on the simulation clock, for the throughput figure. */
  private completions: number[] = []
  /** Which concrete page the last disk operation touched — shown in telemetry. */
  lastOp = 'idle'
  /** Where the last page arrow landed — always a block's top face, never air. */
  lastArrowEnd: THREE.Vector3 | null = null
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
    /** Kept for the signature; traffic belongs to the cage, not the scene. */
    _scene: THREE.Scene,
    private paths: Paths,
    private flows: FlowSet,
  ) { }

  /**
   * Where packets and query paths are parented. The cage, not the scene: a
   * path drawn for this instance is part of the instance and has to move with
   * it, exactly like the redis command paths.
   */
  private get scene(): THREE.Object3D {
    return this.inst.group
  }

  get activeChains() {
    return this.chains.length
  }

  /** Completed queries per simulated second over the last RPS_WINDOW seconds. */
  get rps() {
    const from = this.clock - RPS_WINDOW
    let n = 0
    for (const t of this.completions) if (t > from) n++
    return n / RPS_WINDOW
  }

  get clockTime() {
    return this.clock
  }

  get stats(): SimStats {
    const hitRate = this.accesses === 0 ? 0 : (this.hits / this.accesses) * 100
    const max = this.inst.maxBackendCount
    return {
      queries: this.queries,
      hitRate,
      latency: this.lastLatency,
      walBytes: this.walBytes,
      walSegments: this.inst.walFilledSegments,
      walPending: Math.max(0, this.walBytes - this.flushedBytes),
      dead: this.inst.deadTuples,
      note:
        this.queued > 0
          ? `${this.queued} request${this.queued === 1 ? '' : 's'} blocked in socket buffers · backpressure, nothing dropped`
          : this.note,
      connections: this.inst.activeBackendCount,
      maxConnections: max,
      rps: this.rps,
      queued: this.queued,
      buffered: this.inst.backends.reduce((n, b) => n + b.inbuf, 0),
      busyBackends: this.inst.busyBackendCount,
      backendStates: this.inst.backendStates,
      checkpointing: this.checkpointing,
      vacuuming: this.vacuuming,
      compacting: this.compacting,
    }
  }

  /**
   * Executor → a page. The curve ends exactly on the centre of that block's
   * top face, so an arrow never stops at some point in mid-air.
   */
  private execTo(from: THREE.Vector3, target: THREE.Vector3) {
    return pathCurve([
      from.clone(),
      from.clone().add(new THREE.Vector3(0.55, -0.75, -0.9)),
      new THREE.Vector3(from.x * 0.35, 6.6, 0.4),
      target.clone().add(new THREE.Vector3(0, 1.2, 0)),
      target,
    ])
  }

  /** wal_buffers → the segment head: the write + fsync a commit waits on. */
  private readonly walFlushArc = (from: THREE.Vector3, head: THREE.Vector3) =>
    pathCurve([
      from,
      from.clone().add(new THREE.Vector3(0, 0.85, 0.15)),
      head.clone().add(new THREE.Vector3(0, 1.15, 0)),
      head,
    ])

  /**
   * Requests held by TCP backpressure. Not a queue postgres keeps — these bytes
   * are in a socket because the backend stopped reading while its input buffer
   * was full. Nothing here can be dropped.
   */
  get queued() {
    return this.parked.length
  }

  /**
   * Where a tap's bytes go, in the order a real client would try:
   *  1. an idle pooled connection — reuse beats connecting
   *  2. a new backend, up to max_connections
   *  3. whichever working connection has the least in its input buffer
   * Nothing waits for a connection here. Waiting happens on the wire, later.
   */
  private pickPod(): BackendPod | null {
    const pods = this.inst.backends
    const open = pods.filter((b) => b.active)
    // "free" means idle *and* not already holding a request in flight, so two
    // taps in the same burst cannot both think they own the same connection
    const free = open.filter((b) => !b.busy && b.pending === 0)
    if (free.length > 0) {
      const pod = free[randInt(0, free.length - 1)]
      pod.pending++
      return pod
    }
    if (open.length < pods.length) {
      const fresh = this.inst.openBackend()
      if (!fresh) return null
      fresh.pending++
      return fresh
    }
    // at max_connections: spread by load, counting bytes already on their way
    let best = open[0]
    for (const b of open) if (b.inbuf + b.pending < best.inbuf + best.pending) best = b
    best.pending++
    return best
  }

  /**
   * One connection works through its own input buffer in order, one statement
   * at a time. Nothing runs in parallel on a single connection — pipelining
   * only saves the round trip, it does not add concurrency.
   */
  private async serve(pod: BackendPod) {
    try {
      for (; ;) {
        await this.querySequence(pod)
        this.completions.push(this.clock)
        if (pod.inbuf <= 0) break
        // the next pipelined request is pulled out of the buffer and executed
        pod.inbuf--
      }
    } catch {
      /* one bad query must never take the whole connection down */
      pod.inbuf = 0
    } finally {
      this.running.delete(pod.id)
      pod.busy = false
      this.inst.releaseBackend(pod)
      this.live--
    }
  }

  /**
   * A tap sends the signal immediately: the packet leaves for a connection on
   * the same frame. It does not wait anywhere first, because postgres has no
   * queue in front of a backend — the client writes, and the bytes are in that
   * backend's input buffer as fast as the network allows.
   */
  async runQuery() {
    const pod = this.pickPod()
    if (!pod) return
    void this.send(pod)
  }

  /** The wire: the tap's packet falls into the port it was given. */
  private async send(pod: BackendPod) {
    const origin = pod.group.position.clone()
    const inPort = new THREE.Vector3(origin.x, 10.35, origin.z - 0.34)
    const packet = makePacket(PALETTE.magenta, 0.42, this.scene)
    // well above the top of the frame: the client is not drawn at all, the
    // packet simply enters the picture already on its way down
    packet.position.set(inPort.x, 42, inPort.z)
    this.inst.pulseBackend(pod)
    const inbound = pathCurve([
      packet.position.clone(),
      new THREE.Vector3(inPort.x, 26, inPort.z + 0.8),
      new THREE.Vector3(inPort.x, 13.4, inPort.z + 0.3),
      inPort,
    ])
    // the request's own wire, drawn the whole way from the source into the port
    // in the same magenta the packets use — green is the answer coming back
    const wire = new QueryChain(this.scene)
    const fIn = wire.addCurve(inbound, PALETTE.magenta, { speed: 0.7, opacity: 0.32 })
    await travel(this.ticker, packet, inbound, 0.8, easeInQuad)
    fIn.flash(0.9)
    // keep the wire up for a beat after it lands, then release it so a hammered
    // button does not silt the scene up with permanent lines
    void this.ticker.wait(0.4).then(() => wire.fadeOut(this.ticker, 0.9))
    this.arrive(pod, packet)
  }

  /**
   * The bytes reached the backend. If its input buffer has room they go straight
   * in; if it is full they stay in the socket and the client blocks — TCP
   * backpressure. That is why hammering the button never loses a query.
   */
  private arrive(pod: BackendPod, packet: THREE.Group) {
    // the reservation made when the tap was sent is done with
    if (pod.pending > 0) pod.pending--
    if (this.canAdmit(pod)) this.admit(pod, packet)
    else this.parked.push({ pod, packet })
  }

  private canAdmit(pod: BackendPod) {
    // an idle connection takes a statement at once; a working one only if there
    // is a free cell behind the statement it is executing
    if (!this.running.has(pod.id)) return true
    return pod.inbuf < INBUF_CELLS - 1
  }

  private admit(pod: BackendPod, packet: THREE.Group) {
    // the bytes drop down the shaft into the buffer, then execute in order. The
    // cube they fill is not a guess: an idle connection takes cell 0 and starts
    // executing it, a busy one takes the cell above whatever is already stacked
    // behind its head — this is the only place that counts those
    const queued = this.running.has(pod.id) ? pod.inbuf + 1 : 0
    const entry = this.inst.backendBufferEntry(pod, queued)
    void travel(this.ticker, packet, pathCurve([packet.position.clone(), entry]), 0.2).then(
      () => despawn(this.ticker, this.scene, packet, 0.15),
    )
    this.inst.pulseBackend(pod)
    if (!this.running.has(pod.id)) {
      this.running.add(pod.id)
      pod.busy = true
      this.live++
      void this.serve(pod)
    } else {
      pod.inbuf++
    }
  }

  private async querySequence(pod: BackendPod) {
    const stmt = this.pickStatement()
    const kind = stmt.kind
    const hit = kind === 'select' && Math.random() < (stmt.viaIndex ? 0.9 : 0.78)
    // what this statement needs decides which structures light up: the index
    // glows for a point lookup, the heap pages for a sequential scan
    this.indexScan = stmt.viaIndex
    this.inst.indexScan = stmt.viaIndex
    if (stmt.viaIndex) this.flows.indexToBuffer.flash(0.5)
    this.queries++

    const origin = pod.group.position.clone()
    // Two strands of one cable: answers leave on the far side of the port, so
    // both directions run side by side instead of drawing over each other.
    const outPort = new THREE.Vector3(origin.x, 10.35, origin.z + 0.34)
    const chain = new QueryChain(this.scene)
    this.chains.push(chain)

    // the bytes are already inside the backend, so the work starts at the
    // bottom of its input buffer — the shaft is what the flow passes through
    const bufferExit = this.inst.backendBufferExit(pod)
    const pipe = pod.pipeline.nodes
    const parse = pipe.parse.group.position.clone()
    const plan = pipe.plan.group.position.clone()
    const exec = pipe.exec.group.position.clone()
    const packet = makePacket(PALETTE.magenta, 0.42, this.scene)
    packet.position.copy(bufferExit)

    try {
      // 1. backend hands the query to the parser — the line picks up at the
      // bottom of the input buffer, so the flow reads as one continuous route:
      // client wire → port → buffer shaft → this process's own parser
      const toParse = pathCurve([
        bufferExit,
        new THREE.Vector3(origin.x, 8.4, 5.3),
        new THREE.Vector3(parse.x + 0.75, 8.62, 5.0),
        parse.clone(),
      ])
      const fToParse = chain.addCurve(toParse, PALETTE.cyan, {
        speed: 0.55,
        opacity: 0.36,
      })
      await travel(this.ticker, packet, toParse, 0.5)
      this.inst.pulseNode(pod, 'parse', 0.8)
      fToParse.flash(0.8)

      // 3. parser → planner, in the same process
      const parseCurve = pathCurve([
        parse,
        parse.clone().lerp(plan, 0.5).add(new THREE.Vector3(0.45, 0.18, 0)),
        plan,
      ])
      const fParse = chain.addCurve(parseCurve, PALETTE.cyan, {
        speed: 0.55,
        opacity: 0.4,
      })
      await travel(this.ticker, packet, parseCurve, 0.4)
      this.inst.pulseNode(pod, 'plan', 0.9)
      fParse.flash(0.8)
      await this.ticker.wait(0.08)

      // 4. planner → executor, still this backend's own lane
      const planCurve = pathCurve([
        plan,
        plan.clone().lerp(exec, 0.5).add(new THREE.Vector3(0.45, 0.18, 0)),
        exec,
      ])
      const fPlan = chain.addCurve(planCurve, PALETTE.cyan, {
        speed: 0.55,
        opacity: 0.4,
      })
      await travel(this.ticker, packet, planCurve, 0.4)
      this.inst.pulseNode(pod, 'exec', 1)
      fPlan.flash(0.8)

      // WAL first — but only when something actually changes, and only into
      // shared memory, not to disk. The record is produced by the access method
      // the executor calls, immediately before that same call modifies the page
      // in a buffer slot; a read-only statement writes no WAL at all.
      const writes = kind === 'insert' || kind === 'delete'
      if (writes) {
        const walBytesFor = kind === 'insert' ? 384 : 320
        const walTo = this.inst.pathEnd('walBuf')
        const walFrom = exec.clone()
        const walCurve = pathCurve([
          walFrom,
          walFrom.clone().add(new THREE.Vector3(0.35, -0.7, -0.9)),
          walTo.clone().add(new THREE.Vector3(0, 1.0, 0)),
          walTo,
        ])
        const walPack = makePacket(PALETTE.amber, 0.2, this.scene)
        walPack.position.copy(walFrom)
        void travel(this.ticker, walPack, walCurve, 0.4).then(() => {
          this.inst.appendWal(0.3)
          this.walBytes += walBytesFor
          this.bufferedBytes += walBytesFor
          despawn(this.ticker, this.scene, walPack, 0.22)
        })
        this.flows.execToWal.flash(0.7)
      }

      let pageIdx = this.inst.pickBufferPage()

      if (kind === 'insert' || kind === 'delete') {
        // a write never touches a disk block: the executor modifies the copy in
        // a shared buffer slot, which turns dirty and waits for the checkpointer
        const execCurve = this.execTo(exec, this.paths.bufferTop.clone())
        const fExec = chain.addCurve(execCurve, PALETTE.teal, {
          speed: 0.5,
          opacity: 0.4,
        })
        await travel(this.ticker, packet, execCurve, 0.4)
        fExec.flash(0.75)

        const slot = this.inst.writeIntoBuffer(kind)
        if (slot) {
          const to = this.inst.pageTop(slot.page)
          const from = packet.position.clone()
          const down = pathCurve([from, from.clone().lerp(to, 0.5).add(new THREE.Vector3(0, 1.4, 0)), to])
          const fDown = chain.addCurve(
            down,
            kind === 'insert' ? 0xc7ff5a : PALETTE.magenta,
            { speed: 0.5, opacity: 0.45 },
          )
          await travel(this.ticker, packet, down, 0.55)
          fDown.flash(0.85)
          this.inst.setPageActive(slot.idx, kind === 'insert' ? 0xc7ff5a : PALETTE.magenta, 1.2)
          const owner = slot.page.block?.table
          this.lastOp = `${kind} → buffer slot ${slot.idx}${owner ? ` (${owner})` : ''} · dirty`
          this.lastArrowEnd = to.clone()
        }
        despawn(this.ticker, this.scene, packet, 0.2)

        this.accesses++
        this.hits += kind === 'insert' ? 0 : 0
        this.lastLatency = rand(0.3, 1.4)
        this.note =
          kind === 'insert'
            ? 'insert · buffer page dirtied, still only in RAM until the checkpointer writes it back'
            : 'delete · buffer page dirtied, dead tuples stay in the page until VACUUM'
        if (kind === 'delete') this.inst.markDeadTuples(1)
      } else if (hit) {
        // the arrow lands on the top face of the exact buffer page it will read
        const page = this.inst.pages[pageIdx]
        const toPage = this.inst.pageTop(page)
        const execCurve = this.execTo(exec, toPage)
        const fExec = chain.addCurve(execCurve, PALETTE.teal, {
          speed: 0.5,
          opacity: 0.44,
        })
        await travel(this.ticker, packet, execCurve, 0.5)
        fExec.flash(0.8)
        this.inst.setPageActive(pageIdx, PALETTE.teal, 1.3)
        this.lastArrowEnd = toPage.clone()
        this.note = `${stmt.viaIndex ? 'index scan' : 'seq scan'} · buffer hit, page already in RAM ≈ 0.1 ms`
        despawn(this.ticker, this.scene, packet, 0.22)
        this.hits++
        this.accesses++
        this.lastLatency = rand(0.04, 0.18)
      } else {
        // read path: buffer miss → disk → buffer. The slot the clock sweep is
        // about to hand out is chosen first, so every arrow can end on a real
        // page top face instead of a point somewhere above the pool.
        pageIdx = this.inst.pickBufferPage()
        const page = this.inst.pages[pageIdx]
        const slotTop = this.inst.pageTop(page)

        const execCurve = this.execTo(exec, slotTop)
        const fExec = chain.addCurve(execCurve, PALETTE.teal, {
          speed: 0.5,
          opacity: 0.4,
        })
        await travel(this.ticker, packet, execCurve, 0.4)
        fExec.flash(0.7)

        // the arrow goes to the exact block this read needs, not to "the disk"
        const target = this.inst.pickBlockForRead()
        const toBlock = target ? this.inst.blockTop(target) : this.paths.diskTop.clone()

        // starts on the buffer slot's top face — never at a point in mid-air
        const down = pathCurve([
          slotTop,
          slotTop.clone().lerp(toBlock, 0.4).add(new THREE.Vector3(0, 0.6, 0)),
          toBlock.clone().add(new THREE.Vector3(0, 1.6, 0)),
          toBlock,
        ])
        const fDown = chain.addCurve(down, PALETTE.amber, {
          speed: 0.5,
          opacity: 0.42,
        })
        await travel(this.ticker, packet, down, 0.5, easeInOutCubic)
        fDown.flash(0.9)
        this.lastArrowEnd = toBlock.clone()
        if (target) {
          this.inst.touchBlocks([target], PALETTE.amber, 0.55, 1.15)
          this.lastOp = `read ${target.table ?? 'free'}[${target.row},${target.col}]`
        }

        const up = pathCurve([
          toBlock,
          toBlock.clone().add(new THREE.Vector3(0, 1.9, 0)),
          new THREE.Vector3(2.2, 4.7, 1.2),
          slotTop.clone().add(new THREE.Vector3(0, 2.4, 0)),
          slotTop,
        ])
        const fUp = chain.addCurve(up, PALETTE.amber, {
          speed: 0.5,
          opacity: 0.42,
        })
        const packetCore = packet.children[0] as THREE.Mesh
          ; (packetCore.material as THREE.MeshStandardMaterial).emissive.setHex(PALETTE.amber)
        this.inst.liftFromDisk(pageIdx)
        await travel(this.ticker, packet, up, 0.62)
        fUp.flash(0.8)
        this.inst.setPageActive(pageIdx, PALETTE.amber, 1.2)
        // the copy that arrives carries the density of the page it came from,
        // and the slot now stands for that specific block
        void this.inst.swapBufferPage(pageIdx, target ? target.fill : 0.5, target)
        void this.ticker.add(0.7, (k) => {
          page.base.lerpColors(new THREE.Color(PALETTE.amber), new THREE.Color(PALETTE.cyan), k)
        })
        despawn(this.ticker, this.scene, packet, 0.25)
        this.accesses++
        this.lastLatency = rand(0.4, 1.9)
        this.note = `${stmt.viaIndex ? 'index scan' : 'seq scan'} · buffer miss, page fetched from disk ≈ 1 ms`
        this.inst.markDeadTuples(1)
      }

      // COMMIT waits for durability, but it does not own the fsync: the WAL
      // writer drains whatever is buffered on its own cadence, and every commit
      // that arrives in the same window rides the same flush (group commit).
      // A read-only statement has nothing to wait for.
      if (writes) await this.walDurable()

      // 5. rows leave the executor and go straight back out through the same
      // connection. There is no "result" stage in postgres: tuples are handed
      // to the wire protocol as they are produced, so they stream out of the
      // port the query arrived on.
      const rows = makePacket(PALETTE.teal, 0.3, this.scene)
      rows.position.copy(exec)
      const toPort = pathCurve([
        exec,
        new THREE.Vector3(origin.x * 0.95, 9.2, origin.z - 2.0),
        outPort.clone(),
      ])
      const fRows = chain.addCurve(toPort, PALETTE.ice, {
        speed: 0.55,
        opacity: 0.44,
      })
      await travel(this.ticker, rows, toPort, 0.75)
      this.inst.pulseBackend(pod)
      fRows.flash(0.85)
      despawn(this.ticker, this.scene, rows, 0.2)

      // 7. answer leaves along the same run of cable, a strand to the side of
      // the request that came down, and exits the frame the same way it came in
      const outbound = pathCurve([
        outPort,
        new THREE.Vector3(outPort.x + 0.3, 13.4, outPort.z + 0.3),
        new THREE.Vector3(outPort.x + 0.5, 26, outPort.z + 0.8),
        new THREE.Vector3(outPort.x + 0.5, 42, outPort.z + 0.6),
      ])
      chain.addCurve(outbound, PALETTE.teal, { speed: 0.7, opacity: 0.3 })
      const out = makePacket(PALETTE.teal, 0.26, this.scene)
      await travel(this.ticker, out, outbound, 0.8, easeOutCubic)
      despawn(this.ticker, this.scene, out, 0.3)
    } finally {
      // the connection's own lifecycle belongs to serve(), not to one query:
      // releasing here dropped `busy` while pipelined work was still buffered,
      // so the ambient churn could close the pod and orphan that work
      chain.fadeOut(this.ticker, 1.25)
    }
  }

  /** How much longer the ambient clients wait between requests, per regime. */
  get arrivalGap() {
    return REGIMES[this.regime].pace
  }

  setRegime(r: Regime) {
    if (r === this.regime) return
    this.regime = r
    this.note = `workload · ${REGIMES[r].label}`
  }

  /** Weighted by the current regime: reads and writes get scaled independently. */
  private pickStatement(): Statement {
    const mix = REGIMES[this.regime]
    const weightOf = (s: Statement) => s.weight * (s.kind === 'select' ? mix.select : mix.write)
    let total = 0
    for (const s of STATEMENTS) total += weightOf(s)
    let r = Math.random() * total
    for (const s of STATEMENTS) {
      r -= weightOf(s)
      if (r <= 0) return s
    }
    return STATEMENTS[0]
  }

  /**
   * Wait until everything appended so far has been written and fsynced. The
   * wait is not proportional to this statement's own bytes: whatever else was
   * buffered rides the same flush, which is what makes group commit cheap.
   */
  private async walDurable(timeout = 3) {
    let waited = 0
    while (this.inst.walBuffered > 0.02 && waited < timeout) {
      await this.ticker.wait(0.08)
      waited += 0.08
    }
  }

  /**
   * A commit-level flush: the tail of the log is written and fsynced, and the
   * commit returns. This is the only moment WAL bytes become durable.
   */
  async flush() {
    if (this.flushing) return
    this.flushing = true
    try {
      this.note = 'commit · XLogFlush waiting for the WAL tail to reach disk'
      await this.inst.flushWal()
      this.flushedBytes = this.walBytes
      this.note = 'commit returned · everything up to this LSN is durable'
    } finally {
      this.flushing = false
    }
  }

  async checkpoint() {
    if (this.checkpointing) return
    this.checkpointing = true
    this.note = 'checkpoint · flushing dirty pages + fsync wal'
    try {
      // this is the only place a buffer page reaches the disk field: writes in
      // the executor only ever dirtied slots
      const dirty = this.inst.pages.filter((p) => p.dirty && p.block)
      await this.inst.dirtyPages(12)
      await this.inst.flushWal()
      this.flushedBytes = this.walBytes

      // the WAL is already on disk: at checkpoint its old segments are simply
      // recycled in place — nothing is moved to another place
      const segs = this.inst.walFilledSegments
      for (let i = 0; i < segs; i++) {
        this.inst.flashWalSegment(i)
        await this.ticker.wait(0.05)
      }
      await this.ticker.wait(0.4)

      // a checkpoint is batched: the dirty pages leave together, each one to the
      // block it caches — that is why it is one fsync storm, not many I/Os
      const leaving = dirty.length > 0 ? dirty : this.inst.pages.slice(0, 7)
      for (const page of leaving.slice(0, 7)) {
        const target = page.block
        const copy = makePacket(PALETTE.amber, 0.26, this.scene)
        const start = this.inst.pageTop(page)
        copy.position.copy(start)
        const dest = target ? this.inst.blockTop(target) : this.paths.diskTop.clone()
        const curve = pathCurve([
          start,
          start.clone().lerp(dest, 0.45).add(new THREE.Vector3(0, 1.6, 0)),
          dest,
        ])
        void travel(this.ticker, copy, curve, 0.75).then(() => {
          if (target) {
            this.inst.touchBlocks([target], PALETTE.amber, 0.55, 1.15)
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
      this.inst.recycleWal()
      // the checkpoint flushed everything, so nothing is left staged in memory
      this.inst.walBuffered = 0
      this.bufferedBytes = 0
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
    // Ambient paths hold the parts at their ends, not the numbers those parts
    // had at boot: following them here is all it takes to stay attached while
    // the executor bobs and the buffer strip drifts with the write head.
    for (const [line, path] of this.flows.live) line.follow(path)
    for (const f of this.flows.all) f.update(dt)

    // per-query paths: animate, then drop the finished ones
    this.chains = this.chains.filter((c) => {
      c.update(dt)
      return !c.disposed
    })

    this.clock += dt
    // bytes that hit a full buffer wait in the socket, stacked above their port,
    // and are let in the moment a cell frees. Nothing is ever discarded.
    const perPod = new Map<number, number>()
    for (let i = 0; i < this.parked.length; i++) {
      const p = this.parked[i]
      if (this.canAdmit(p.pod)) {
        this.admit(p.pod, p.packet)
        this.parked.splice(i--, 1)
        continue
      }
      const n = perPod.get(p.pod.id) ?? 0
      perPod.set(p.pod.id, n + 1)
      const target = p.pod.group.position.clone().add(new THREE.Vector3(0, 1.9 + n * 0.6, 0))
      p.packet.position.lerp(target, Math.min(1, dt * 5))
      p.packet.rotation.y += dt * 1.6
    }

    // invariant: a connection holding buffered requests must always have a
    // worker pulling them out. If the two ever disagree, the buffer would sit
    // there forever and the step caption would be describing nothing.
    for (const b of this.inst.backends) {
      if (b.active && b.inbuf > 0 && !this.running.has(b.id)) {
        this.running.add(b.id)
        b.busy = true
        this.live++
        void this.serve(b)
      }
    }
    // keep the throughput window bounded — it is read by the HUD every frame
    if (this.completions.length > 0) {
      const from = this.clock - RPS_WINDOW
      while (this.completions.length > 0 && this.completions[0] <= from) this.completions.shift()
    }
    this.inst.update(dt, this.clock)

    // clients connect and disconnect — ambient churn stops during a story so the
    // state on screen is only what the story's own taps produced
    if (this.ambient) {
      this.connTimer -= dt
      if (this.connTimer <= 0) {
        this.connTimer = rand(3.5, 8.5)
        const active = this.inst.activeBackendCount
        if (active < 2) this.inst.openBackend()
        else if (active < 6 && Math.random() < 0.6) this.inst.openBackend()
        else if (active > 2) this.inst.closeBackend()
      }
    }

    // ambient MVCC churn
    this.deadTimer -= dt
    if (this.deadTimer <= 0) {
      this.deadTimer = rand(3.2, 6.5)
      this.inst.markDeadTuples(randInt(1, 2))
    }

    // The WAL writer. Backends only ever append to wal_buffers; this is what
    // turns that staging memory into a segment on disk, in batches, one
    // write + fsync at a time. Commits queue behind the same flush.
    if (this.inst.walBuffered > 0.02) {
      this.walFlushTimer -= dt
      if (this.walFlushTimer <= 0) {
        this.walFlushTimer = rand(1.3, 1.9)
        const from = this.inst.walBufferTop()
        const head = this.inst.walHeadTop()
        // capture what is on disk-bound at this instant: anything appended
        // while the arrow is in flight belongs to the next flush
        const flushingBytes = this.bufferedBytes
        const pack = makePacket(PALETTE.ice, 0.22, this.scene)
        pack.position.copy(from)
        void travel(this.ticker, pack, this.walFlushArc(from, head), 0.42).then(() => {
          if (this.inst.flushWalBuffers() > 0) {
            this.flushedBytes += flushingBytes
            this.bufferedBytes = Math.max(0, this.bufferedBytes - flushingBytes)
          }
          despawn(this.ticker, this.scene, pack, 0.18)
        })
      }
    } else {
      // idle: re-arm, so the first record that arrives always sits in the
      // buffer for a beat before the writer picks it up
      this.walFlushTimer = 1.2
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
      // ambient traffic alternates: some clients look things up by key, others
      // read ranges — nothing external picks the plan
      const viaIndex = Math.random() < 0.5
      const flow = viaIndex ? this.flows.indexToBuffer : this.flows.heapToBuffer
      flow.flash(0.7)
      if (viaIndex && Math.random() < 0.5) this.flows.ginToBuffer.flash(0.6)
      const run = viaIndex ? this.inst.scanIndex() : this.inst.scanHeap()
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
