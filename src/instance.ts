import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import {
  Ticker,
  breathe,
  halo,
  label,
  neonEdges,
  rand,
  randInt,
} from './util'

export const PALETTE = {
  cyan: 0x35e0ff,
  teal: 0x2bffc3,
  amber: 0xffb03a,
  magenta: 0xff3ea5,
  violet: 0x8a7bff,
  ice: 0xbfe9ff,
}

export interface Info {
  title: string
  body: string
  meta?: string
}

export interface Page {
  mesh: THREE.Mesh
  mat: THREE.MeshStandardMaterial
  base: THREE.Color
  heat: number
  row: number
  col: number
  dirty: boolean
}

export interface Tuple {
  mesh: THREE.Mesh
  mat: THREE.MeshStandardMaterial
  dead: boolean
  home: THREE.Vector3
}

export type NodeName = 'parse' | 'plan' | 'exec' | 'result'

export interface BackendPod {
  id: number
  group: THREE.Group
  ring: THREE.MeshStandardMaterial
  glow: THREE.SpriteMaterial
  pick: THREE.Mesh
  active: boolean
  busy: boolean
  index: number
  pulse: number
}

export interface PipelineNode {
  group: THREE.Group
  core: THREE.MeshStandardMaterial
  cage: THREE.MeshStandardMaterial
  ring: THREE.Mesh
  baseScale: number
  home: THREE.Vector3
  pulse: number
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

export const ANCHOR = {
  sky: V(-11.0, 27, 0.8),
  parse: V(-9.4, 6.55, -2.0),
  plan: V(-4.4, 6.85, -2.4),
  exec: V(1.6, 6.85, -2.4),
  result: V(8.2, 6.6, -1.8),
  bufferCenter: V(-1.0, 5.5, -1.4),
  wal: V(10.4, 4.6, 2.4),
  heap: V(-7.4, 0.5, 4.0),
  index: V(4.2, 2.6, -5.6),
  disk: V(8.2, 0.5, 5.2),
  events: V(0.2, 0.5, 4.4),
  gin: V(10.3, 1.4, -3.4),
  brin: V(-1.9, 1.6, -5.3),
  hash: V(8.4, 1.2, 0.6),
  hub: V(0, 7.2, 0),
  resultSky: V(10.6, 24, 1.2),
}

const glowMat = (
  color: number,
  emissive: number,
  intensity: number,
  opts: Partial<THREE.MeshStandardMaterialParameters> = {},
) =>
  new THREE.MeshStandardMaterial({
    color,
    emissive,
    emissiveIntensity: intensity,
    roughness: 0.42,
    metalness: 0.35,
    ...opts,
  })

export class PostgresInstance {
  readonly group = new THREE.Group()
  readonly pages: Page[] = []
  readonly tuples: Tuple[] = []
  readonly pickables: THREE.Object3D[] = []
  readonly nodes: Record<NodeName, PipelineNode>
  readonly walMats: THREE.MeshStandardMaterial[] = []
  readonly walSegments: THREE.Mesh[] = []
  readonly heapMats: THREE.MeshStandardMaterial[] = []
  readonly diskMats: THREE.MeshStandardMaterial[] = []
  readonly btreeMats: THREE.MeshStandardMaterial[] = []
  readonly ginMats: THREE.MeshStandardMaterial[] = []
  readonly brinMats: THREE.MeshStandardMaterial[] = []
  readonly hashMats: THREE.MeshStandardMaterial[] = []
  readonly eventsMats: THREE.MeshStandardMaterial[] = []
  readonly lockMats: THREE.MeshStandardMaterial[] = []
  /** One port per client connection, sitting on the top boundary of the box. */
  readonly backends: BackendPod[] = []
  readonly walHead: THREE.Mesh
  readonly scanner: THREE.Mesh
  readonly vacuumDrone: THREE.Group
  readonly bufferFrame: THREE.Mesh
  motes!: THREE.Points
  haloRing!: THREE.Mesh

  indexScan = false
  walFill = 0.35
  private deadCount = 0

  constructor(private ticker: Ticker) {
    this.buildShell()
    this.buildBufferPool()
    this.buildWal()
    this.buildHeap()
    this.buildIndex()
    this.buildEvents()
    this.buildGin()
    this.buildMetrics()
    this.buildBrin()
    this.buildHash()
    this.buildDisks()
    this.buildLocks()
    this.buildBackends()
    this.nodes = this.buildPipeline()
    this.walHead = this.makeWalHead()
    this.scanner = this.makeScanner()
    this.vacuumDrone = this.makeVacuumDrone()
    this.bufferFrame = this.group.children.find(
      (o) => o.userData.bufferFrame === true,
    ) as THREE.Mesh

    // a few clients are already connected when the instance starts
    this.openBackend()
    this.openBackend()
    this.openBackend()
  }

  /* --------------------------------- building ------------------------------- */

  private register(obj: THREE.Object3D, info: Info) {
    obj.userData.info = info
    this.pickables.push(obj)
    return obj
  }

  private buildShell() {
    const shellH = 9.8
    const shellW = 25.2
    const shellD = 16.0
    const shellGeo = new THREE.BoxGeometry(shellW, shellH, shellD)

    // wireframe cage only — faces would hide the internals
    const edges = neonEdges(shellGeo, 0x3fa8cc, 0.3)
    edges.position.y = shellH / 2
    this.group.add(edges)

    const edges2 = neonEdges(shellGeo, 0x1d5f78, 0.5)
    edges2.position.y = shellH / 2
    edges2.scale.set(0.999, 0.998, 0.999)
    this.group.add(edges2)

    // corner posts
    const postGeo = new RoundedBoxGeometry(0.14, shellH, 0.14, 2, 0.03)
    const postMat = glowMat(0x0a1a26, 0x2fa6c8, 0.55)
    for (const x of [-12.5, 12.5]) {
      for (const z of [-7.9, 7.9]) {
        const p = new THREE.Mesh(postGeo, postMat)
        p.position.set(x, shellH / 2, z)
        p.castShadow = true
        this.group.add(p)
      }
    }

    // roof rim
    const roof = new THREE.Mesh(
      new RoundedBoxGeometry(shellW, 0.1, shellD, 2, 0.04),
      new THREE.MeshStandardMaterial({
        color: 0x061019,
        metalness: 0.6,
        roughness: 0.4,
        transparent: true,
        opacity: 0.55,
      }),
    )
    roof.position.y = shellH + 0.02
    roof.scale.set(1.001, 1, 1.001)
    roof.visible = false
    this.group.add(roof)
    const roofEdge = neonEdges(
      new THREE.BoxGeometry(shellW, 0.08, shellD),
      0x35e0ff,
      0.3,
    )
    roofEdge.position.y = shellH + 0.02
    this.group.add(roofEdge)

    // city-block pad the whole instance sits on
    const pad = new THREE.Mesh(
      new RoundedBoxGeometry(27.6, 0.06, 18.4, 2, 0.1),
      new THREE.MeshStandardMaterial({
        color: 0x081420,
        emissive: 0x04141f,
        emissiveIntensity: 0.9,
        roughness: 0.85,
        metalness: 0.2,
      }),
    )
    pad.position.y = 0.05
    pad.receiveShadow = true
    this.group.add(pad)

    const padLineMat = new THREE.LineBasicMaterial({
      color: 0x1a5f78,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    })
    const padPts: number[] = []
    for (let x = -13; x <= 13; x += 2) {
      padPts.push(x, 0.09, -8.6, x, 0.09, 8.6)
    }
    for (let z = -8; z <= 8; z += 2) {
      padPts.push(-13.5, 0.09, z, 13.5, 0.09, z)
    }
    const padGeo = new THREE.BufferGeometry()
    padGeo.setAttribute('position', new THREE.Float32BufferAttribute(padPts, 3))
    this.group.add(new THREE.LineSegments(padGeo, padLineMat))

    const padEdge = neonEdges(new THREE.BoxGeometry(27.6, 0.06, 18.4), 0x35e0ff, 0.45)
    padEdge.position.y = 0.05
    this.group.add(padEdge)

    const processLabel = label('POSTGRESQL PROCESS')
    processLabel.position.set(-12.3, 10.15, 8.1)
    this.group.add(processLabel)

    // drifting data motes inside the instance
    const count = 220
    const pos = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      pos[i * 3] = rand(-11.8, 11.8)
      pos[i * 3 + 1] = rand(0.3, 9.5)
      pos[i * 3 + 2] = rand(-7.2, 7.2)
    }
    const moteGeo = new THREE.BufferGeometry()
    moteGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const motes = new THREE.Points(
      moteGeo,
      new THREE.PointsMaterial({
        color: 0x8fe6ff,
        size: 0.06,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      }),
    )
    this.group.add(motes)
    this.motes = motes

    const haloRing = new THREE.Mesh(
      new THREE.TorusGeometry(14.6, 0.02, 4, 160),
      new THREE.MeshBasicMaterial({
        color: 0x2f9fbf,
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    haloRing.rotation.x = Math.PI / 2
    haloRing.position.y = 9.15
    this.group.add(haloRing)
    this.haloRing = haloRing

    this.register(roof, {
      title: 'PostgreSQL process',
      body: 'One running postgres instance: a postmaster, backend processes and shared memory. Everything inside this cage — parser, planner, executor, buffers, WAL — is part of it. Clients sit outside, in the sky.',
      meta: 'process · postmaster + backends · shared memory',
    })
  }

  private buildBufferPool() {
    const frameW = 11.4
    const frameD = 4.3
    const frame = new THREE.Mesh(
      new RoundedBoxGeometry(frameW, 0.26, frameD, 2, 0.06),
      glowMat(0x071420, 0x1f6f8c, 0.38, { metalness: 0.3, roughness: 0.55 }),
    )
    frame.position.set(ANCHOR.bufferCenter.x, 5.06, ANCHOR.bufferCenter.z)
    frame.castShadow = true
    frame.receiveShadow = true
    frame.userData.bufferFrame = true
    this.group.add(frame)
    this.register(frame, {
      title: 'Shared buffers',
      body: 'The page cache every backend shares — this is the RAM in the picture. Reads and writes hit 8 kB pages here first; a miss pulls a page from disk and evicts another one with the clock-sweep algorithm.',
      meta: 'shared_buffers · RAM · 8 kB pages · clock sweep',
    })

    const frameEdge = neonEdges(new THREE.BoxGeometry(frameW, 0.26, frameD), 0x35e0ff, 0.5)
    frameEdge.position.copy(frame.position)
    this.group.add(frameEdge)

    // support columns
    const colGeo = new RoundedBoxGeometry(0.12, 4.5, 0.12, 2, 0.03)
    const colMat = glowMat(0x061018, 0x1d5f78, 0.7)
    for (const [x, z] of [
      [-6.4, -3.55],
      [4.4, -3.55],
      [4.4, 0.65],
    ]) {
      const c = new THREE.Mesh(colGeo, colMat)
      c.position.set(x, 2.8, z)
      c.castShadow = true
      this.group.add(c)
    }

    const cols = 8
    const rows = 4
    const gapX = 1.3
    const gapZ = 0.93
    const originX = ANCHOR.bufferCenter.x - ((cols - 1) * gapX) / 2
    const originZ = ANCHOR.bufferCenter.z - ((rows - 1) * gapZ) / 2
    const pageGeo = new RoundedBoxGeometry(1.08, 0.12, 0.64, 2, 0.03)

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const mat = glowMat(0x0b2230, PALETTE.cyan, 0.22, { metalness: 0.5, roughness: 0.35 })
        const mesh = new THREE.Mesh(pageGeo, mat)
        mesh.position.set(originX + c * gapX, 5.28, originZ + r * gapZ)
        mesh.castShadow = true
        mesh.receiveShadow = true
        this.group.add(mesh)
        this.pages.push({
          mesh,
          mat,
          base: new THREE.Color(PALETTE.cyan),
          heat: rand(0, 0.25),
          row: r,
          col: c,
          dirty: false,
        })
      }
    }

    // invisible pick volume over the whole pool
    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(cols * gapX, 0.9, rows * gapZ),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pick.position.set(ANCHOR.bufferCenter.x, 5.35, ANCHOR.bufferCenter.z)
    this.group.add(pick)
    this.register(pick, {
      title: 'Shared buffer pages',
      body: 'Each tile is one 8 kB page of a table or index. Cyan means cached and clean, amber means dirty (changed, waiting to be written), green means a hit just served a query.',
      meta: '40 pages · ~320 kB shown',
    })
  }

  private buildWal() {
    const x = ANCHOR.wal.x
    const z = ANCHOR.wal.z
    const segGeo = new RoundedBoxGeometry(0.85, 0.3, 0.85, 2, 0.04)
    for (let i = 0; i < 7; i++) {
      const mat = glowMat(0x140d04, 0x8a4a10, 0.62, {
        roughness: 0.45,
        metalness: 0.25,
      })
      const seg = new THREE.Mesh(segGeo, mat)
      seg.position.set(x, 0.85 + i * 0.42, z)
      seg.castShadow = true
      seg.receiveShadow = true
      this.group.add(seg)
      this.walSegments.push(seg)
      this.walMats.push(mat)

      const seam = neonEdges(segGeo, 0xffb03a, 0.85)
      seam.position.copy(seg.position)
      this.group.add(seam)
    }

    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 5.4, 1.5),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pick.position.set(x, 3.1, z)
    this.group.add(pick)
    this.register(pick, {
      title: 'Write-ahead log (on disk)',
      body: 'A file sequence on disk, appended to on every change. Its tail sits in wal_buffers in RAM until the WAL writer issues a write + fsync; COMMIT only returns once that fsync is done. A checkpoint then flushes dirty pages and recycles old segments — the blocks you see falling into the disk array.',
      meta: 'pg_wal · disk files · buffered in wal_buffers · fsync',
    })

    const lab = label('WAL · DISK')
    lab.position.set(x - 1.5, 4.75, z + 0.4)
    this.group.add(lab)
  }

  private makeWalHead() {
    const head = new THREE.Group()
    const core = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 0.08, 0.95),
      new THREE.MeshBasicMaterial({
        color: 0xffd089,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
      }),
    )
    head.add(core)
    head.add(halo(PALETTE.amber, 1.9, 0.24))
    head.position.set(ANCHOR.wal.x, 2.6, ANCHOR.wal.z)
    this.group.add(head)
    return core
  }

  private buildHeap() {
    const base = new THREE.Mesh(
      new RoundedBoxGeometry(6.9, 0.5, 4.1, 3, 0.07),
      glowMat(0x061019, 0x0f5a4c, 0.55, { metalness: 0.5, roughness: 0.45 }),
    )
    base.position.set(ANCHOR.heap.x, 0.32, ANCHOR.heap.z)
    base.castShadow = true
    base.receiveShadow = true
    this.group.add(base)
    this.heapMats.push(base.material as THREE.MeshStandardMaterial)

    const edges = neonEdges(new THREE.BoxGeometry(6.9, 0.5, 4.1), 0x2bffc3, 0.3)
    edges.position.copy(base.position)
    this.group.add(edges)

    const cols = 8
    const rows = 5
    const gx = 0.78
    const gz = 0.74
    const ox = ANCHOR.heap.x - ((cols - 1) * gx) / 2
    const oz = ANCHOR.heap.z - ((rows - 1) * gz) / 2
    const tupleGeo = new RoundedBoxGeometry(0.54, 0.22, 0.54, 1, 0.03)

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const mat = glowMat(0x0b2a24, PALETTE.teal, 0.34)
        const mesh = new THREE.Mesh(tupleGeo, mat)
        const pos = new THREE.Vector3(ox + c * gx, 0.68, oz + r * gz)
        mesh.position.copy(pos)
        mesh.castShadow = true
        this.group.add(mesh)
        this.tuples.push({ mesh, mat, dead: false, home: pos.clone() })
      }
    }

    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(7.2, 1.1, 4.3),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pick.position.set(ANCHOR.heap.x, 0.5, ANCHOR.heap.z)
    this.group.add(pick)
    this.register(pick, {
      title: 'Heap (table storage)',
      body: 'Rows are stored in 8 kB heap pages. An UPDATE writes a new version and leaves the old one dead; VACUUM later marks that space reusable. This is MVCC made visible.',
      meta: 'heap pages · tuples · MVCC',
    })

    const lab = label('HEAP')
    lab.position.set(ANCHOR.heap.x - 0.5, 1.4, ANCHOR.heap.z + 2.35)
    this.group.add(lab)
  }

  private buildIndex() {
    const cx = ANCHOR.index.x
    const cz = ANCHOR.index.z
    const tree = new THREE.Group()
    const nodeGeo = new RoundedBoxGeometry(0.66, 0.26, 0.66, 2, 0.04)

    const levels = [
      { y: 3.1, xs: [cx] },
      { y: 2.2, xs: [cx - 1.45, cx, cx + 1.45] },
      { y: 1.3, xs: [cx - 2.9, cx - 1.9, cx - 0.95, cx, cx + 0.95, cx + 1.9, cx + 2.9] },
    ]
    const pts: THREE.Vector3[][] = []
    for (const level of levels) {
      const rowPts: THREE.Vector3[] = []
      for (const x of level.xs) {
        const mat = glowMat(0x0a1f2c, PALETTE.violet, 0.55, { metalness: 0.5 })
        const m = new THREE.Mesh(nodeGeo, mat)
        m.position.set(x, level.y, cz)
        m.castShadow = true
        tree.add(m)
        this.btreeMats.push(mat)
        rowPts.push(m.position.clone())
      }
      pts.push(rowPts)
    }

    // edges: each parent connects to 2-3 children
    const segs: number[] = []
    for (let l = 0; l < 2; l++) {
      const parents = pts[l]
      const children = pts[l + 1]
      parents.forEach((p, i) => {
        const span = children.length / parents.length
        const start = Math.floor(i * span)
        const end = Math.floor((i + 1) * span)
        for (let c = start; c < end; c++) {
          segs.push(p.x, p.y, p.z, children[c].x, children[c].y, children[c].z)
        }
      })
    }
    const edgeGeo = new THREE.BufferGeometry()
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3))
    const edges = new THREE.LineSegments(
      edgeGeo,
      new THREE.LineBasicMaterial({
        color: 0x8a7bff,
        transparent: true,
        opacity: 0.45,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    tree.add(edges)

    const base = new THREE.Mesh(
      new RoundedBoxGeometry(6.5, 0.24, 2.0, 2, 0.05),
      glowMat(0x080f1a, 0x3b2f8f, 0.4),
    )
    base.position.set(cx, 0.95, cz)
    tree.add(base)

    this.group.add(tree)

    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(6.8, 3.1, 1.4),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pick.position.set(cx, 2.2, cz)
    this.group.add(pick)
    this.register(pick, {
      title: 'B-tree index',
      body: 'A balanced tree over key → TID. Internal pages live near the top and stay hot in shared buffers; leaves point at heap tuples. An index scan touches ~3 pages instead of the whole table.',
      meta: 'b-tree · 3 levels · key → TID',
    })

    const lab = label('B-TREE')
    lab.position.set(cx - 1.6, 3.65, cz + 1.4)
    this.group.add(lab)
  }

  private buildEvents() {
    const cx = ANCHOR.events.x
    const cz = ANCHOR.events.z

    const base = new THREE.Mesh(
      new RoundedBoxGeometry(5.8, 0.5, 3.2, 3, 0.07),
      glowMat(0x061019, 0x0f5a4c, 0.5, { metalness: 0.5, roughness: 0.45 }),
    )
    base.position.set(cx, 0.32, cz)
    base.castShadow = true
    base.receiveShadow = true
    this.group.add(base)

    const edges = neonEdges(new THREE.BoxGeometry(5.8, 0.5, 3.2), 0x2bffc3, 0.26)
    edges.position.copy(base.position)
    this.group.add(edges)

    const cols = 7
    const rows = 4
    const gx = 0.74
    const gz = 0.72
    const ox = cx - ((cols - 1) * gx) / 2
    const oz = cz - ((rows - 1) * gz) / 2
    const tupleGeo = new RoundedBoxGeometry(0.5, 0.3, 0.5, 1, 0.03)
    const docGeo = new RoundedBoxGeometry(0.28, 0.12, 0.28, 1, 0.02)

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const toasted = Math.random() < 0.18
        const mat = glowMat(
          0x0b2a24,
          toasted ? PALETTE.amber : PALETTE.teal,
          toasted ? 0.6 : 0.26,
        )
        const m = new THREE.Mesh(tupleGeo, mat)
        m.position.set(ox + c * gx, 0.68, oz + r * gz)
        m.castShadow = true
        this.group.add(m)
        this.eventsMats.push(mat)

        // jsonb payload sitting on the row
        if (Math.random() < 0.55) {
          const doc = new THREE.Mesh(docGeo, mat)
          doc.position.set(m.position.x, 0.9, m.position.z)
          this.group.add(doc)
        }
      }
    }

    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(6.0, 1.1, 3.4),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pick.position.set(cx, 0.6, cz)
    this.group.add(pick)
    this.register(pick, {
      title: 'Heap: events',
      body: 'A second table, wider and insert-heavy: each row carries a jsonb payload. Rows are still 8 kB heap pages, but the interesting access path is containment and key lookup inside jsonb — which a B-tree cannot help with.',
      meta: 'heap · jsonb payload · append mostly',
    })

    const lab = label('EVENTS')
    lab.position.set(cx - 2.9, 1.15, cz + 1.9)
    this.group.add(lab)
  }

  private buildGin() {
    const cx = ANCHOR.gin.x
    const cz = ANCHOR.gin.z

    const base = new THREE.Mesh(
      new RoundedBoxGeometry(3.4, 0.26, 2.6, 2, 0.06),
      glowMat(0x140a18, 0x6a1f4d, 0.6, { metalness: 0.4, roughness: 0.5 }),
    )
    base.position.set(cx, 0.36, cz)
    base.castShadow = true
    base.receiveShadow = true
    this.group.add(base)

    const pinGeo = new THREE.BoxGeometry(0.09, 1, 0.09)
    const cols = 6
    const rows = 4
    const gx = 0.5
    const gz = 0.52
    const ox = cx - ((cols - 1) * gx) / 2
    const oz = cz - ((rows - 1) * gz) / 2

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const h = 0.45 + Math.random() * 1.15
        const mat = glowMat(0x2a0a1e, PALETTE.magenta, 0.75)
        const m = new THREE.Mesh(pinGeo, mat)
        m.scale.y = h
        m.position.set(ox + c * gx, 0.5 + h / 2, oz + r * gz)
        m.castShadow = true
        this.group.add(m)
        this.ginMats.push(mat)
      }
    }

    // posting-list rail across the top of the keys
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(3.0, 0.02, 0.03),
      new THREE.MeshBasicMaterial({
        color: 0xff8ac8,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    rail.position.set(cx, 1.95, cz - 0.78)
    this.group.add(rail)

    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(3.6, 2.2, 2.8),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pick.position.set(cx, 1.3, cz)
    this.group.add(pick)
    this.register(pick, {
      title: 'GIN — Generalized Inverted Index',
      body: 'Maps each element of a composite value — a jsonb key, an array element, a full-text lexeme — to a posting list of row TIDs. Fast for containment (`@>`, `?`, `@@`) and full-text search, expensive to update because one row can write many postings.',
      meta: 'gin · element → posting list · jsonb / arrays / tsvector',
    })

    const lab = label('GIN')
    lab.position.set(cx - 1.3, 2.75, cz + 0.3)
    this.group.add(lab)
  }

  private buildMetrics() {
    const cx = ANCHOR.brin.x
    const cz = ANCHOR.brin.z

    const base = new THREE.Mesh(
      new RoundedBoxGeometry(4.8, 0.4, 1.9, 2, 0.06),
      glowMat(0x060c18, 0x1a3c6a, 0.5, { metalness: 0.45, roughness: 0.5 }),
    )
    base.position.set(cx, 0.26, cz)
    base.castShadow = true
    base.receiveShadow = true
    this.group.add(base)

    const slabGeo = new RoundedBoxGeometry(0.26, 0.38, 0.34, 1, 0.02)
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 12; c++) {
        const mat = glowMat(0x081426, 0x2c5fbf, 0.4)
        const m = new THREE.Mesh(slabGeo, mat)
        m.position.set(cx - 2.0 + c * 0.36, 0.66, cz - 0.55 + r * 0.55)
        this.group.add(m)
      }
    }

    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(5.0, 1.0, 2.1),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pick.position.set(cx, 0.5, cz)
    this.group.add(pick)
    this.register(pick, {
      title: 'Heap: metrics (time series)',
      body: 'Append-only measurements inserted in timestamp order. Because the physical order matches the sort key, ranges of pages hold narrow value ranges — exactly the assumption a BRIN index exploits.',
      meta: 'heap · insert-only · naturally ordered',
    })

    const lab = label('METRICS')
    lab.position.set(cx - 2.2, 0.9, cz + 1.45)
    this.group.add(lab)
  }

  private buildBrin() {
    const cx = ANCHOR.brin.x
    const cz = ANCHOR.brin.z
    const slabGeo = new RoundedBoxGeometry(0.32, 0.42, 0.78, 2, 0.03)
    const dotGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1)

    for (let i = 0; i < 8; i++) {
      const mat = glowMat(0x0c0a24, PALETTE.violet, 0.7)
      const m = new THREE.Mesh(slabGeo, mat)
      m.position.set(cx - 2.1 + i * 0.6, 1.55, cz)
      m.castShadow = true
      this.group.add(m)
      this.brinMats.push(mat)

      for (const dz of [-0.2, 0.2]) {
        const dot = new THREE.Mesh(dotGeo, mat)
        dot.position.set(m.position.x, 1.82, cz + dz)
        this.group.add(dot)
      }
    }

    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(4.8, 0.9, 1.2),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pick.position.set(cx, 1.55, cz)
    this.group.add(pick)
    this.register(pick, {
      title: 'BRIN — Block Range Index',
      body: 'Stores only min/max per range of pages (default 128). It is a few kilobytes even for huge tables. Perfect when data is naturally ordered by the indexed column; useless when values are scattered, because every range then matches.',
      meta: 'brin · min/max per 128 pages · tiny',
    })

    const lab = label('BRIN')
    lab.position.set(cx + 0.1, 2.55, cz + 1.0)
    this.group.add(lab)
  }

  private buildHash() {
    const cx = ANCHOR.hash.x
    const cz = ANCHOR.hash.z

    const hubMat = glowMat(0x0a1a14, PALETTE.teal, 0.8, { metalness: 0.5 })
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.5, 16), hubMat)
    hub.position.set(cx, 0.55, cz)
    hub.castShadow = true
    this.group.add(hub)
    this.hashMats.push(hubMat)

    const bucketGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.42, 12)
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      const mat = glowMat(0x081a16, PALETTE.teal, 0.5, { metalness: 0.55 })
      const b = new THREE.Mesh(bucketGeo, mat)
      b.position.set(cx + Math.cos(a) * 1.12, 0.5, cz + Math.sin(a) * 1.12)
      b.castShadow = true
      this.group.add(b)
      this.hashMats.push(mat)
    }

    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(2.7, 1.0, 2.7),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pick.position.set(cx, 0.6, cz)
    this.group.add(pick)
    this.register(pick, {
      title: 'Hash index',
      body: 'Hashes the key into one of N buckets and stores TIDs there. Equality lookups only — no range scans, no ordering. Compact and cheap for exact matches on wide keys; not WAL-logged safely before PostgreSQL 10.',
      meta: 'hash · 32-bit hash → bucket · equality only',
    })

    const lab = label('HASH')
    lab.position.set(cx + 0.2, 1.55, cz + 1.7)
    this.group.add(lab)
  }

  private buildDisks() {
    const cx = ANCHOR.disk.x
    const cz = ANCHOR.disk.z

    const base = new THREE.Mesh(
      new RoundedBoxGeometry(5.9, 0.34, 4.0, 3, 0.06),
      glowMat(0x060c14, 0x123649, 0.3, { metalness: 0.6, roughness: 0.45 }),
    )
    base.position.set(cx, 0.28, cz)
    base.castShadow = true
    base.receiveShadow = true
    this.group.add(base)

    const baseEdge = neonEdges(new THREE.BoxGeometry(5.9, 0.34, 4.0), 0xffb03a, 0.4)
    baseEdge.position.copy(base.position)
    this.group.add(baseEdge)

    const cols = 12
    const rows = 8
    const gx = 0.46
    const gz = 0.44
    const ox = cx - ((cols - 1) * gx) / 2
    const oz = cz - ((rows - 1) * gz) / 2
    const voxelGeo = new RoundedBoxGeometry(0.37, 0.32, 0.35, 1, 0.025)

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const mat = glowMat(0x0a1620, 0xffb03a, 0.14 + Math.random() * 0.14, {
          roughness: 0.5,
          metalness: 0.35,
        })
        const m = new THREE.Mesh(voxelGeo, mat)
        m.position.set(ox + c * gx, 0.45, oz + r * gz)
        m.castShadow = true
        m.receiveShadow = true
        this.group.add(m)
        this.diskMats.push(mat)

        // a few blocks carry colour: written pages
        if (Math.random() < 0.12) mat.emissiveIntensity = 0.6
      }
    }

    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(6.1, 0.9, 4.2),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pick.position.set(cx, 0.5, cz)
    this.group.add(pick)
    this.register(pick, {
      title: 'Disk — pages on persistent storage',
      body: 'The ground level of the whole scene is disk. Every block is an 8 kB page file: heap pages, index pages and WAL segments all live down here. Pages arrive when the buffer pool evicts a dirty page at checkpoint, or when a read misses.',
      meta: 'disk · 8 kB blocks · ~100 µs–10 ms / read',
    })

    const lab = label('DISK · PERSISTENT')
    lab.position.set(cx - 2.5, 1.2, cz + 2.25)
    this.group.add(lab)
  }

  private buildLocks() {
    const cluster = new THREE.Group()
    cluster.position.set(0.4, 2.5, -3.9)
    const geo = new THREE.BoxGeometry(0.26, 0.26, 0.26)
    for (let i = 0; i < 7; i++) {
      const mat = glowMat(0x160a18, PALETTE.magenta, 0.35)
      const m = new THREE.Mesh(geo, mat)
      m.position.set(rand(-0.7, 0.7), rand(-0.3, 0.4), rand(-0.4, 0.4))
      m.rotation.set(rand(0, 1), rand(0, 1), rand(0, 1))
      cluster.add(m)
      this.lockMats.push(mat)
    }
    this.group.add(cluster)
    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 1.2, 1.4),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pick.position.copy(cluster.position)
    this.group.add(pick)
    this.register(pick, {
      title: 'Lock manager',
      body: 'Table and row locks plus MVCC snapshots let many transactions run at once. Contention shows up here as wait events.',
      meta: 'locks · MVCC snapshots',
    })
  }

  private buildBackends() {
    const slots = [-9.6, -5.75, -1.9, 1.9, 5.75, 9.6]
    const baseGeo = new THREE.CylinderGeometry(0.46, 0.54, 0.3, 20)
    const ringGeo = new THREE.TorusGeometry(0.56, 0.042, 6, 32)
    const LEDGeo = new THREE.SphereGeometry(0.16, 12, 10)
    const baseMat = glowMat(0x07131c, 0x1a4d63, 0.45, { metalness: 0.6, roughness: 0.3 })
    const pickGeo = new THREE.BoxGeometry(1.36, 0.62, 1.36)

    slots.forEach((x, i) => {
      const g = new THREE.Group()
      g.position.set(x, 9.88, 5.8)
      g.visible = false
      g.scale.setScalar(0.001)

      const base = new THREE.Mesh(baseGeo, baseMat)
      base.castShadow = true
      g.add(base)

      const ring = new THREE.MeshStandardMaterial({
        color: 0x0a1018,
        emissive: PALETTE.cyan,
        emissiveIntensity: 0.7,
        roughness: 0.3,
        metalness: 0.4,
      })
      const ringMesh = new THREE.Mesh(ringGeo, ring)
      ringMesh.rotation.x = Math.PI / 2
      ringMesh.position.y = 0.16
      g.add(ringMesh)

      const ledMat = new THREE.MeshStandardMaterial({
        color: 0x0a1018,
        emissive: PALETTE.cyan,
        emissiveIntensity: 0.9,
        roughness: 0.4,
      })
      const led = new THREE.Mesh(LEDGeo, ledMat)
      led.position.y = 0.24
      g.add(led)

      const gl = halo(PALETTE.cyan, 2.4, 0)
      gl.position.y = 0.3
      g.add(gl)

      // invisible hover/selection box that hugs this connection
      const pick = new THREE.Mesh(
        pickGeo,
        new THREE.MeshBasicMaterial({ visible: false }),
      )
      pick.position.copy(g.position)
      pick.userData.info = {
        title: `Backend · connection ${i + 1}`,
        body: 'One live client connection, handled by its own backend process. It parses, plans and executes its own queries, then returns the result through this same slot. Ports appear and disappear as clients connect and disconnect.',
        meta: 'process · one per connection · not a thread',
      }

      this.group.add(g)
      this.group.add(pick)
      this.backends.push({
        id: i,
        group: g,
        ring,
        glow: gl.material,
        pick,
        active: false,
        busy: false,
        index: i,
        pulse: 0,
      })
    })

    const lab = label('BACKENDS · CONNECTIONS')
    lab.position.set(-10.6, 11.05, 5.8)
    this.group.add(lab)
  }

  /* ---------------------------- backends lifecycle --------------------------- */

  private findBackend(id: number) {
    return this.backends.find((b) => b.id === id)
  }

  openBackend(): BackendPod | null {
    const free = this.backends.find((b) => !b.active)
    if (!free) return null
    free.active = true
    free.busy = false
    if (!this.pickables.includes(free.pick)) this.pickables.push(free.pick)
    return free
  }

  closeBackend(): boolean {
    const idle = this.backends.filter((b) => b.active && !b.busy)
    if (idle.length === 0) return false
    const victim = idle[randInt(0, idle.length - 1)]
    victim.active = false
    victim.busy = false
    const idx = this.pickables.indexOf(victim.pick)
    if (idx >= 0) this.pickables.splice(idx, 1)
    return true
  }

  acquireBackend(): BackendPod | null {
    let active = this.backends.filter((b) => b.active)
    if (active.length === 0) {
      const opened = this.openBackend()
      if (!opened) return null
      active = [opened]
    }
    const free = active.filter((b) => !b.busy)
    const pod =
      free.length > 0 ? free[randInt(0, free.length - 1)] : active[randInt(0, active.length - 1)]
    pod.busy = true
    return pod
  }

  releaseBackend(pod: BackendPod) {
    const b = this.findBackend(pod.id)
    if (b) b.busy = false
  }

  pulseBackend(pod: BackendPod) {
    const b = this.findBackend(pod.id)
    if (b) b.pulse = 1
  }

  get activeBackendCount() {
    return this.backends.filter((b) => b.active).length
  }

  get busyBackendCount() {
    return this.backends.filter((b) => b.active && b.busy).length
  }

  get backendStates() {
    return this.backends.filter((b) => b.active).map((b) => b.busy)
  }

  private buildPipeline(): Record<NodeName, PipelineNode> {
    const defs: { name: NodeName; pos: THREE.Vector3; color: number; text: string; info: Info }[] = [
      {
        name: 'parse',
        pos: ANCHOR.parse,
        color: PALETTE.cyan,
        text: 'PARSER',
        info: {
          title: 'Parser + rewriter',
          body: 'The SQL text becomes a parse tree, syntax is checked, and the rewriter expands views and rules before planning.',
          meta: 'raw_parser · rewrite',
        },
      },
      {
        name: 'plan',
        pos: ANCHOR.plan,
        color: PALETTE.violet,
        text: 'PLANNER',
        info: {
          title: 'Planner / optimizer',
          body: 'A cost-based optimizer enumerates access paths — seq scan, index scan, nested loop, hash join — estimates rows from statistics, and keeps the cheapest plan.',
          meta: 'pg_planner · cost model',
        },
      },
      {
        name: 'exec',
        pos: ANCHOR.exec,
        color: PALETTE.teal,
        text: 'EXECUTOR',
        info: {
          title: 'Executor',
          body: 'Walks the plan tree tuple by tuple, evaluating quals, joins and aggregates. Every page request goes through the buffer manager.',
          meta: 'executor · volcano model',
        },
      },
      {
        name: 'result',
        pos: ANCHOR.result,
        color: PALETTE.ice,
        text: 'RESULT',
        info: {
          title: 'Result → client',
          body: 'Rows stream back over the wire protocol as DataRow messages. A query ends when the portal is closed and the transaction commits.',
          meta: 'DataRow · CommandComplete',
        },
      },
    ]

    const out = {} as Record<NodeName, PipelineNode>
    for (const def of defs) {
      const group = new THREE.Group()
      group.position.copy(def.pos)

      const coreMat = new THREE.MeshStandardMaterial({
        color: 0x08131c,
        emissive: def.color,
        emissiveIntensity: 1.0,
        roughness: 0.25,
        metalness: 0.5,
      })
      const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 1), coreMat)
      group.add(core)

      const cageMat = new THREE.MeshStandardMaterial({
        color: 0x0d2431,
        emissive: def.color,
        emissiveIntensity: 0.4,
        wireframe: true,
        transparent: true,
        opacity: 0.55,
      })
      const cage = new THREE.Mesh(new THREE.IcosahedronGeometry(0.82, 1), cageMat)
      group.add(cage)

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1.02, 0.016, 6, 64),
        new THREE.MeshBasicMaterial({
          color: def.color,
          transparent: true,
          opacity: 0.65,
          blending: THREE.AdditiveBlending,
        }),
      )
      ring.rotation.x = Math.PI / 2
      group.add(ring)

      group.add(halo(def.color, 2.6, 0.2))

      const lab = label(def.text)
      lab.position.set(0.95, 0.05, 0)
      group.add(lab)

      this.register(group, def.info)
      this.group.add(group)
      out[def.name] = {
        group,
        core: coreMat,
        cage: cageMat,
        ring,
        baseScale: 1,
        home: def.pos.clone(),
        pulse: 0,
      }
    }
    return out
  }

  private makeScanner() {
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.05, 4.0),
      new THREE.MeshBasicMaterial({
        color: PALETTE.teal,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
      }),
    )
    beam.position.set(ANCHOR.heap.x, 1.05, ANCHOR.heap.z + 2)
    this.group.add(beam)
    return beam
  }

  private makeVacuumDrone() {
    const drone = new THREE.Group()
    const body = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.3, 1),
      glowMat(0x101a12, 0xc7ff5a, 1.1),
    )
    drone.add(body)
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.52, 0.02, 6, 40),
      new THREE.MeshBasicMaterial({ color: 0xc7ff5a, transparent: true, opacity: 0.6 }),
    )
    ring.rotation.x = Math.PI / 2
    drone.add(ring)
    drone.add(halo(0xc7ff5a, 2.4, 0.4))
    drone.position.set(-8.5, 2.6, 5.4)
    const lab = label('AUTOVACUUM')
    lab.position.set(0.55, 0.35, 0)
    drone.add(lab)
    this.group.add(drone)
    return drone
  }

  /* ---------------------------------- runtime -------------------------------- */

  setPageActive(idx: number, color: THREE.ColorRepresentation, heat = 1) {
    const p = this.pages[idx]
    if (!p) return
    p.base.set(color)
    p.heat = Math.max(p.heat, heat)
  }

  pickBufferPage(): number {
    // prefer cool pages so the animation reads clearly
    const sorted = this.pages
      .map((p, i) => ({ i, h: p.heat }))
      .sort((a, b) => a.h - b.h)
    return sorted[randInt(0, Math.min(5, sorted.length - 1))].i
  }

  async scanHeap(): Promise<number> {
    const beam = this.scanner
    beam.visible = true
    const speed = 0.9
    const from = ANCHOR.heap.z - 1.9
    const to = ANCHOR.heap.z + 1.9
    await this.ticker.add(speed, (k) => {
      beam.position.z = from + (to - from) * k
        ; (beam.material as THREE.MeshBasicMaterial).opacity = 0.15 + 0.5 * Math.sin(k * Math.PI)
    })
    beam.visible = false
    return 0
  }

  async scanIndex(): Promise<number[]> {
    const touched: number[] = []
    const order = [0, 1, 2, 1, 2, 2, 3, 2, 3, 3, 3]
    for (let i = 0; i < 6; i++) {
      const idx = order[i]
      const mat = this.btreeMats[idx]
      if (mat) {
        mat.emissiveIntensity = 1.4
        touched.push(idx)
        void this.ticker.add(0.45, (k) => {
          mat.emissiveIntensity = 1.4 - 0.9 * k
        })
      }
      await this.ticker.wait(0.09)
    }
    return touched
  }

  async flushWal(): Promise<void> {
    const lit = this.walFilledSegments
    for (let i = 0; i < lit; i++) {
      const m = this.walMats[i]
      void this.ticker.add(0.55, (k) => {
        m.emissiveIntensity = 0.6 + 2.2 * Math.sin(k * Math.PI)
      })
      await this.ticker.wait(0.05)
    }
    await this.ticker.wait(0.35)
  }

  async vacuum(): Promise<number> {
    const dead = this.tuples.filter((t) => t.dead)
    if (dead.length === 0) return 0
    this.droneBusy = true
    // drone flies to the heap
    const drone = this.vacuumDrone
    const start = drone.position.clone()
    const end = new THREE.Vector3(ANCHOR.heap.x - 3.4, 1.8, ANCHOR.heap.z + 2.2)
    await this.ticker.add(0.9, (k) => {
      drone.position.lerpVectors(start, end, k)
      drone.position.y += Math.sin(k * Math.PI) * 1.2
    })

    for (const t of dead) {
      const from = t.mesh.position.clone()
      t.dead = false
      void this.ticker.add(0.55, (k) => {
        t.mesh.position.lerpVectors(from, end, k)
        t.mesh.position.y += Math.sin(k * Math.PI) * 0.6
        t.mesh.scale.setScalar(1 - 0.9 * k)
        t.mat.emissiveIntensity = 1.6 * (1 - k)
        t.mat.emissive.setHex(0xc7ff5a)
      })
      await this.ticker.wait(0.06)
    }
    await this.ticker.wait(0.5)

    for (const t of this.tuples) {
      t.dead = false
      t.mesh.position.copy(t.home)
      t.mesh.scale.setScalar(1)
      t.mat.emissive.setHex(PALETTE.teal)
      t.mat.emissiveIntensity = 0.34
    }
    this.deadCount = 0

    // drone returns to patrol
    const back = drone.position.clone()
    await this.ticker.add(1.0, (k) => {
      drone.position.lerpVectors(back, start, k)
    })
    this.droneBusy = false
    return dead.length
  }

  markDeadTuples(n: number): number {
    let made = 0
    for (let i = 0; i < n; i++) {
      const live = this.tuples.filter((t) => !t.dead && t.mesh.scale.x > 0.99)
      if (live.length === 0) break
      const t = live[randInt(0, live.length - 1)]
      t.dead = true
      t.mat.emissive.setHex(0xff3ea5)
      t.mat.emissiveIntensity = 0.55
      made++
    }
    this.deadCount += made
    return made
  }

  async dirtyPages(n: number): Promise<void> {
    const chosen = this.pages
      .map((p, i) => ({ p, i }))
      .sort(() => Math.random() - 0.5)
      .slice(0, n)
    for (const { p } of chosen) {
      p.dirty = true
      p.base.set(PALETTE.amber)
      p.heat = 1
      await this.ticker.wait(0.03)
    }
  }

  cleanAllPages(): void {
    for (const p of this.pages) {
      p.dirty = false
      p.base.set(PALETTE.cyan)
    }
  }

  pulseNode(name: NodeName, strength = 1) {
    const n = this.nodes[name]
    if (n) n.pulse = Math.max(n.pulse, strength)
  }

  flashDisk(_idx = -1) {
    for (let k = 0; k < 9; k++) {
      const mat = this.diskMats[randInt(0, this.diskMats.length - 1)]
      if (!mat) continue
      mat.emissiveIntensity = 2.4
      void this.ticker.add(1.6, (t) => {
        mat.emissiveIntensity = 2.4 - 1.9 * t
      })
    }
  }

  get deadTuples() {
    return this.deadCount
  }

  walBlockPosition(i: number) {
    return new THREE.Vector3(ANCHOR.wal.x, 0.85 + i * 0.42, ANCHOR.wal.z)
  }

  get walFilledSegments() {
    return Math.max(1, Math.round(this.walFill * this.walSegments.length))
  }

  update(dt: number, time: number) {
    // buffer page shimmer + heat decay
    for (const p of this.pages) {
      p.heat = Math.max(0, p.heat - dt * 0.75)
      const idle = breathe(time, 0.8, p.row * 0.7 + p.col * 0.4) * 0.08
      const dirty = p.dirty ? 0.65 : 0
      p.mat.emissive.copy(p.base)
      p.mat.emissiveIntensity = 0.22 + idle + p.heat * 1.15 + dirty * 0.5
    }

    // WAL head rides the fill level
    const walTop = 0.85 + this.walFill * 6 * 0.42
    this.walHead.position.y += (walTop - this.walHead.position.y) * Math.min(1, dt * 3)
    this.walHead.rotation.y += dt * 2.2

    for (let i = 0; i < this.walMats.length; i++) {
      const on = i / this.walMats.length < this.walFill
      this.walMats[i].emissiveIntensity =
        (on ? 0.62 : 0.03) + (on ? breathe(time, 1.4, i * 0.6) * 0.1 : 0)
    }

    // pipeline nodes drift like slow satellites and breathe when they work
    for (const key of Object.keys(this.nodes) as NodeName[]) {
      const n = this.nodes[key]
      const phase = n.home.x * 0.7 + n.home.z
      n.pulse = Math.max(0, n.pulse - dt * 1.9)
      n.ring.rotation.z += dt * (key === 'exec' ? 1.5 : 0.7)
      n.group.position.set(
        n.home.x + Math.sin(time * 0.42 + phase) * 0.1,
        n.home.y +
        Math.sin(time * 0.75 + phase * 1.3) * 0.16 +
        Math.sin(time * 1.9 + phase) * 0.04 +
        n.pulse * 0.12,
        n.home.z + Math.cos(time * 0.5 + phase) * 0.1,
      )
      n.group.rotation.y += dt * 0.12
      n.core.emissiveIntensity = 1.0 + n.pulse * 1.6
      n.group.scale.setScalar(1 + Math.sin(time * 1.2 + phase) * 0.035 + n.pulse * 0.12)
    }

    // index highlight when index scan is on
    this.btreeMats.forEach((m, i) => {
      const target = this.indexScan ? 0.55 + 0.35 * Math.sin(time * 2 + i) : 0.4
      m.emissiveIntensity += (target - m.emissiveIntensity) * Math.min(1, dt * 4)
    })

    // locks twinkle
    this.lockMats.forEach((m, i) => {
      m.emissiveIntensity = 0.25 + 0.3 * breathe(time, 1.7, i)
    })

    // backend connection ports: scale in/out, glow while busy
    for (const b of this.backends) {
      b.pulse = Math.max(0, b.pulse - dt * 2.2)
      const target = b.active ? 1 : 0
      const s = b.group.scale.x + (target - b.group.scale.x) * Math.min(1, dt * 7)
      b.group.scale.setScalar(Math.max(0.001, s + b.pulse * 0.07))
      b.group.visible = s > 0.02

      if (b.busy) {
        b.ring.emissiveIntensity = 2.2 + 0.5 * Math.sin(time * 7 + b.id) + b.pulse * 2
        b.glow.opacity = 0.45
      } else {
        b.ring.emissiveIntensity =
          (b.active ? 0.75 + 0.2 * breathe(time, 1.1, b.id) : 0.1) + b.pulse * 2
        b.glow.opacity = b.active ? 0.08 : 0
      }
    }

    // index structures shimmer at different rhythms
    this.ginMats.forEach((m, i) => {
      m.emissiveIntensity = 0.62 + 0.34 * breathe(time, 2.0, i * 0.55)
    })
    this.brinMats.forEach((m, i) => {
      m.emissiveIntensity = 0.6 + 0.3 * breathe(time, 0.8, i * 0.8)
    })
    this.hashMats.forEach((m, i) => {
      m.emissiveIntensity = 0.35 + 0.3 * breathe(time, 1.5, i * 0.9)
    })

    // disks twinkle softly so the array looks powered
    // motes drift upward and wrap
    const attr = this.motes.geometry.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < attr.count; i++) {
      let y = attr.getY(i) + dt * 0.35
      if (y > 9.6) y = 0.25
      attr.setY(i, y)
    }
    attr.needsUpdate = true
    this.haloRing.rotation.z += dt * 0.12

    // dead tuple pulse
    for (const t of this.tuples) {
      if (t.dead) t.mat.emissiveIntensity = 0.4 + 0.35 * breathe(time, 3, t.home.x)
    }

    // vacuum drone idle orbit
    if (!this.droneBusy) {
      const a = time * 0.35
      const target = new THREE.Vector3(-8.6 + Math.cos(a) * 0.9, 2.4 + Math.sin(time * 0.9) * 0.3, 5.5 + Math.sin(a) * 0.9)
      this.vacuumDrone.position.lerp(target, Math.min(1, dt * 1.5))
      this.vacuumDrone.rotation.y += dt * 0.8
    } else {
      this.vacuumDrone.rotation.y += dt * 2.4
    }
  }

  droneBusy = false
}
