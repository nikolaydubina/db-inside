import './style.css'
import * as THREE from 'three'
import { createWorld } from './world'
import { PostgresInstance } from './instance'
import { POSTGRES_ORIGIN } from './instance'
import type { BlockPick } from './instance'
import { RedisInstance } from './redis'
import { RedisSim } from './redis-sim'
import type { RedisStats } from './redis-sim'
import { createAxes } from './axes'
import { makeFlows, makePaths } from './flow'
import { EngineSim } from './sim'
import type { Regime } from './sim'
import { installTelemetry } from './debug'
import { createCameraRig, ALL_VIEWS } from './views'
import { createStory } from './story'
import { PLANNED_STORIES } from './story'
import type { StoryScene } from './story'
import { initCredits } from './credits'
import { initHud } from './ui'
import { Ticker, label, rand, OutlineBox } from './util'

const canvas = document.querySelector<HTMLCanvasElement>('#c')!
const labelHost = document.querySelector<HTMLElement>('#labels')!

const world = createWorld(canvas, labelHost)
const { scene, camera } = world

const ticker = new Ticker()
const instance = new PostgresInstance(ticker)
scene.add(instance.group)

// extra labels
const bufferLabel = label('SHARED BUFFERS')
// pinned to the far-left corner of the floating pool, text flowing inward
bufferLabel.position.copy(instance.bufferCorners.farLeft).add(new THREE.Vector3(-0.02, 0.34, -0.06))
instance.group.add(bufferLabel)

const paths = makePaths()
// both instances own their own traffic: paths and packets are parented to the
// cage, so moving a cage takes them with it
const flows = makeFlows(instance.group, paths)

const sim = new EngineSim(instance, ticker, scene, paths, flows)

// the second database, on the same floor
const redis = new RedisInstance(ticker)
scene.add(redis.group)
const redisSim = new RedisSim(redis, ticker)

/** Both instances answer the pointer the same way. */
const pickables: THREE.Object3D[] = [...instance.pickables, ...redis.pickables]

// measuring aid: __axes.on() / .off() / .toggle(), or open the page with ?axes
const axes = createAxes(scene)
const markPostgres = axes.mark('postgres', new THREE.Vector3(0, 0, 0))
const markRedis = axes.mark('redis', new THREE.Vector3(-36, 0, 0))

  // handy for debugging in the browser console
  ; (window as unknown as Record<string, unknown>).__psql = { scene, world, instance, sim, paths, flows }
  ; (window as unknown as Record<string, unknown>).__redis = { redis, redisSim }
  ; (window as unknown as Record<string, unknown>).__axes = axes
if (new URLSearchParams(location.search).has('axes')) axes.on()
console.info(
  '%caxes%c __axes.on() · .off() · .toggle() — or open the page with ?axes',
  'color:#ff6b6b',
  'color:inherit',
)

/* ------------------------------- layout mode ------------------------------ */
// Dragging a cage is an authoring tool, not part of the machine: you slide it
// across the floor in floor-grid steps, the coordinates print in the console,
// and __layout.export() gives you the numbers to paste back into the source.
// The arrangement also lives in localStorage, so a reload mid-session keeps it.

const LAYOUT_KEY = 'db-inside.layout.v1'
/** one floor grid cell */
const MOVE_STEP = 2
const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

/**
 * Cages are anchored by their FAR corner — max x, max z — the corner the axes
 * marks sit on. Both cages are the same size, so one half-extent fits both.
 */
const CAGE = { halfX: 13, halfZ: 8 }
type CageName = 'postgres' | 'redis'
/** Authored anchors: postgres at the origin, redis behind it on the same x. */
const CAGE_HOME: Record<CageName, [number, number]> = { postgres: [0, 0], redis: [0, -26] }

const cageGroup = (c: CageName) => (c === 'postgres' ? instance.group : redis.group)
const anchorOf = (c: CageName): [number, number] => {
  const p = cageGroup(c).position
  return [Math.round(p.x + CAGE.halfX), Math.round(p.z + CAGE.halfZ)]
}

const moveToggle = document.querySelector<HTMLInputElement>('#chk-move')!
const moveHint = document.getElementById('move-hint')!
let moveMode = false

interface DragState {
  cage: CageName
  corner0: [number, number]
  start: THREE.Vector3
  /**
   * Locked after the first real movement: from this 3/4 camera a sideways drag
   * moves mostly along z, so a free drag makes x impossible to land by hand.
   */
  axis: 'x' | 'z' | null
}
let drag: DragState | null = null

/** Anchor coordinates as { x, y, z }; y is the floor, so it is always 0. */
type AnchorOut = { x: number; y: number; z: number }
type AnchorIn = { x: number; z: number } | [number, number]
const pairOf = (a: AnchorIn): [number, number] => (Array.isArray(a) ? [a[0], a[1]] : [a.x, a.z])
const anchorOut = (c: CageName): AnchorOut => {
  const [x, z] = anchorOf(c)
  return { x, y: 0, z }
}

const layoutNow = () => ({ postgres: anchorOut('postgres'), redis: anchorOut('redis') })

function updateMoveHint() {
  const p = anchorOf('postgres')
  const r = anchorOf('redis')
  const axis = drag?.axis ? ` · locked to ${drag.axis}` : ''
  moveHint.textContent =
    `postgres ${p[0]},${p[1]} · redis ${r[0]},${r[1]} · step ${MOVE_STEP} · arrows nudge · shift = free${axis}`
  console.info(
    `%clayout%c postgres anchor (${p[0]}, ${p[1]}) · redis anchor (${r[0]}, ${r[1]})`,
    'color:#ff6b6b',
    'color:inherit',
  )
}

function moveCageTo(c: CageName, anchor: [number, number]) {
  const pos = new THREE.Vector3(anchor[0] - CAGE.halfX, 0, anchor[1] - CAGE.halfZ)
  const at = new THREE.Vector3(anchor[0], 0, anchor[1])
  if (c === 'postgres') {
    if (instance.setOrigin(pos).lengthSq() === 0) return
    markPostgres(at)
  } else {
    redis.setOrigin(pos)
    markRedis(at)
  }
  updateMoveHint()
}

const saveLayout = () => {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layoutNow()))
  } catch {
    /* private mode */
  }
}

function applyLayout(l: { postgres?: AnchorIn; redis?: AnchorIn }) {
  if (l.postgres) moveCageTo('postgres', pairOf(l.postgres))
  if (l.redis) moveCageTo('redis', pairOf(l.redis))
}

// authored default: postgres at the origin corner, redis one cage-gap to the left
applyLayout(CAGE_HOME)
try {
  const raw = localStorage.getItem(LAYOUT_KEY)
  // v1 stored cage centres, not corners; only reuse it if it looks like corners
  if (raw) applyLayout(JSON.parse(raw) as { postgres?: AnchorIn; redis?: AnchorIn })
} catch {
  /* a corrupt layout is not worth breaking boot over */
}
; (window as unknown as Record<string, unknown>).__layout = {
  get: layoutNow,
  set: (l: { postgres?: AnchorIn; redis?: AnchorIn }) => {
    applyLayout(l)
    saveLayout()
  },
  reset: () => {
    applyLayout(CAGE_HOME)
    try {
      localStorage.removeItem(LAYOUT_KEY)
    } catch {
      /* private mode */
    }
  },
  export: () => JSON.stringify(layoutNow()),
  step: MOVE_STEP,
}
  ; (window as unknown as Record<string, unknown>).__move = {
    get mode() {
      return moveMode
    },
    get cage() {
      return hoverCage ?? lastCage
    },
    get axis() {
      return drag?.axis ?? null
    },
  }

moveToggle.addEventListener('change', () => {
  moveMode = moveToggle.checked
  moveHint.hidden = !moveMode
  if (moveMode) {
    axes.on()
    // flying and dragging want the same gesture; dragging wins
    if (flyToggle.checked) {
      flyToggle.checked = false
      flyToggle.dispatchEvent(new Event('change'))
    }
  } else {
    // the ruler exists for this mode; leaving it on after a drag is clutter
    axes.off()
  }
  updateMoveHint()
})

const dragPlanePoint = new THREE.Vector3()
/** The cage arrows nudge: whatever is under the pointer, else the last one dragged. */
let lastCage: CageName | null = null
let hoverCage: CageName | null = null

function ownerCage(o: THREE.Object3D): CageName | null {
  let cur: THREE.Object3D | null = o
  while (cur) {
    if (cur === instance.group) return 'postgres'
    if (cur === redis.group) return 'redis'
    cur = cur.parent
  }
  return null
}

const ndcOf = (e: { clientX: number; clientY: number }) =>
  new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1,
  )

function groundAt(ndc: THREE.Vector2): THREE.Vector3 | null {
  raycaster.setFromCamera(ndc, camera)
  return raycaster.ray.intersectPlane(GROUND, dragPlanePoint) ? dragPlanePoint.clone() : null
}

/** Fallback for a grab that missed every pickable: whichever cage footprint covers the point. */
function cageUnder(p: THREE.Vector3): CageName | null {
  const covers = (c: CageName) => {
    const box = new THREE.Box3().setFromObject(cageGroup(c))
    return p.x >= box.min.x - 1 && p.x <= box.max.x + 1 && p.z >= box.min.z - 1 && p.z <= box.max.z + 1
  }
  if (covers('redis')) return 'redis'
  if (covers('postgres')) return 'postgres'
  return null
}

// Capture phase on purpose: this runs before OrbitControls' own pointerdown, so
// a grab that turns out to be a cage can disable the controls before they emit
// their "start" — moving a box must not read as a camera move.
window.addEventListener(
  'pointerdown',
  (e) => {
    if (!moveMode || e.button !== 0) return
    const ndc = ndcOf(e)
    const ground = groundAt(ndc)
    if (!ground) return
    const hit = pick(ndc)
    const cage = (hit ? ownerCage(hit.root) : null) ?? cageUnder(ground)
    if (!cage) return
    drag = { cage, corner0: anchorOf(cage), start: ground, axis: null }
    world.controls.enabled = false
    // hold the camera still for the duration of the grab; this is a box moving,
    // not the camera, so the orbit preference and its timer are left alone
    world.controls.autoRotate = false
    canvas.style.cursor = 'grabbing'
    e.preventDefault()
  },
  { capture: true },
)

window.addEventListener('pointermove', (e) => {
  if (!drag) return
  const ground = groundAt(ndcOf(e))
  if (!ground) return
  const dx = ground.x - drag.start.x
  const dz = ground.z - drag.start.z
  // commit to the dominant axis once the pointer has actually travelled, so a
  // sideways drag moves along x instead of drifting in both at once
  if (!drag.axis && Math.max(Math.abs(dx), Math.abs(dz)) > MOVE_STEP * 0.75) {
    drag.axis = Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z'
    updateMoveHint()
  }
  const axis = e.shiftKey ? null : drag.axis
  const snap = (v: number) => Math.round(v / MOVE_STEP) * MOVE_STEP
  moveCageTo(drag.cage, [
    snap(drag.corner0[0] + (axis === 'z' ? 0 : dx)),
    snap(drag.corner0[1] + (axis === 'x' ? 0 : dz)),
  ])
})

window.addEventListener('pointerup', () => {
  if (!drag) return
  lastCage = drag.cage
  drag = null
  world.controls.enabled = true
  canvas.style.cursor = 'grab'
  updateMoveHint()
  saveLayout()
})

// arrow keys: exactly one grid step along exactly one axis
const NUDGE: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}
window.addEventListener('keydown', (e) => {
  if (!moveMode || !NUDGE[e.key]) return
  if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return
  const hit = pick(pointer)
  const ground = groundAt(pointer)
  const cage =
    (hit ? ownerCage(hit.root) : null) ?? hoverCage ?? lastCage ?? (ground ? cageUnder(ground) : null)
  if (!cage) return
  const dir = NUDGE[e.key]
  const corner = anchorOf(cage)
  lastCage = cage
  moveCageTo(cage, [corner[0] + dir[0] * MOVE_STEP, corner[1] + dir[1] * MOVE_STEP])
  saveLayout()
  e.preventDefault()
})

let autoOrbit = true
let flyMode = false
const flyKeys = new Set<string>()
const flyVel = new THREE.Vector3()
let speed = 1
/** What is currently pinned in the inspector, and what the pointer is over. */
interface PickInfo {
  root: THREE.Object3D
  /** stable identity, so hover does not churn when the info object is rebuilt */
  key: string
  info: { title: string; body: string; meta?: string }
  /** tight bounds, when `root` is an instanced mesh covering many things */
  box?: THREE.Box3
}
let pinned: PickInfo | null = null

// console telemetry: __psqlDebug.on() / .snapshot() / .history() / .table()
const telemetry = installTelemetry({
  sim,
  inst: instance,
  renderer: world.renderer,
  speed: () => speed,
})
  ; (window as unknown as Record<string, unknown>).__psqlDebug = telemetry.api
if (new URLSearchParams(location.search).has('debug')) telemetry.api.on(2)
// deep link straight into a walkthrough view: ?view=wal
const startView = new URLSearchParams(location.search).get('view')
if (startView) window.setTimeout(() => rig.snap(startView), 1500)
else
  console.info(
    '%cpsql%c telemetry available: __psqlDebug.on() · .snapshot() · .history() · .table("users")',
    'color:#35e0ff',
    'color:inherit',
  )

const hud = initHud({
  runQuery: () => {
    void sim.runQuery()
  },
  checkpoint: () => {
    void sim.checkpoint()
  },
  vacuum: () => {
    void sim.vacuum()
  },
  compact: () => {
    void sim.compact()
  },
  setSpeed: (v) => {
    speed = v
  },
  setRegime: (r) => sim.setRegime(r),
  setOrbit: (on) => {
    autoOrbit = on
    world.controls.autoRotate = on && !flyMode
  },
  setFly: (on) => {
    flyMode = on
    flyKeys.clear()
    flyVel.set(0, 0, 0)
    if (!on) looking = false
    // flying is driving the camera by hand: it lets go of any selected view
    if (on) rig.release()
    // while flying, a drag looks around instead of orbiting the scene
    world.controls.enableRotate = !on
    // cursor stays visible; it is only swapped for the crosshair while dragging
    crosshair.hidden = true
    canvas.style.cursor = on ? 'crosshair' : 'grab'
    // flying and drifting orbit fight each other; flying wins, and the drift
    // only comes back after the same quiet spell any camera move gets
    world.controls.autoRotate =
      !on && autoOrbit && performance.now() - lastInteraction > ORBIT_COOLDOWN
  },
  unpin: () => {
    pinned = null
    hud.unpin()
  },
})

let lastInteraction = performance.now()

/**
 * The drift pauses whenever the CAMERA is moved by hand, and comes back only
 * after this long with no further camera movement — so an orbit drag, a zoom or
 * a double-tap fly-to never lands you in a frame that is already turning.
 * Moving a cage is not camera movement and does not touch this timer.
 */
const ORBIT_COOLDOWN = 5000

let cameraMoves = 0
function noteCameraMove() {
  cameraMoves++
  lastInteraction = performance.now()
  world.controls.autoRotate = false
}

// what the drift is doing right now — handy when a gesture looks like it stuck
; (window as unknown as Record<string, unknown>).__orbit = {
  get state() {
    return {
      autoOrbit,
      flyMode,
      autoRotate: world.controls.autoRotate,
      idleMs: Math.round(performance.now() - lastInteraction),
      dragging: !!drag,
      moves: cameraMoves,
    }
  },
}

world.controls.addEventListener('start', () => {
  noteCameraMove()
  // A hand-driven camera takes over from whatever view was selected: ?view= sets
  // where you start, it is not a lock. Re-navigating to a view re-arms it.
  rig.release()
})

/* --------------------------------- views ---------------------------------- */

const orbitCheckbox = document.querySelector<HTMLInputElement>('#chk-orbit')!
const rig = createCameraRig({
  camera,
  controls: world.controls,
  ticker,
  // Navigating stops auto-orbit first, otherwise the drift drags the camera off
  // the pose. The checkbox is unticked with it, so the UI does not claim an
  // orbit that is no longer happening.
  beforeNavigate: () => {
    autoOrbit = false
    world.controls.autoRotate = false
    if (orbitCheckbox) orbitCheckbox.checked = false
  },
})
  ; (window as unknown as Record<string, unknown>).__psqlViews = rig

/* -------------------------------- story mode ------------------------------- */

/** auto-orbit as it was before the story opened, so exiting restores it */
let orbitBeforeStory = true
/** clock speed as it was before the story opened */
let speedBeforeStory = 1
/** workload regime as it was before the story opened */
let regimeBeforeStory: Regime = 'default'

const speedInput = document.querySelector<HTMLInputElement>('#speed')
const speedLabel = document.getElementById('speed-val')

/** Move the clock and keep the slider honest about it. */
function applySpeed(v: number) {
  speed = v
  if (speedInput) speedInput.value = String(v)
  if (speedLabel) speedLabel.textContent = `${v}×`
}

/**
 * What the story is allowed to point at. This is the only place that knows how
 * backends are laid out; the story just asks for "the one that is executing".
 */
const storyScene: StoryScene = {
  overview: () => new THREE.Box3().setFromObject(instance.group),
  ports: () => {
    const box = new THREE.Box3()
    for (const b of instance.backends) if (b.active) box.expandByObject(b.group)
    return box
  },
  executing: () => {
    // the busiest connection: running, and preferring one with the most queued
    const open = instance.backends.filter((b) => b.active && b.busy)
    if (open.length === 0) return null
    let best = open[0]
    for (const b of open) if (b.inbuf > best.inbuf) best = b
    // a semantic box: the port plus the input-buffer shaft hanging under it,
    // not the object's own bounds (those include the additive halo, which would
    // frame the glow instead of the thing the caption is about)
    const box = new THREE.Box3(
      best.group.position.clone().add(new THREE.Vector3(-0.8, -2.35, -0.8)),
      best.group.position.clone().add(new THREE.Vector3(0.8, 0.75, 0.8)),
    ).translate(POSTGRES_ORIGIN)
    return { id: `backend ${best.id + 1}`, box }
  },
  valid: (id: string) => {
    // only backends can stop existing mid-step; a WAL run or a buffer strip is
    // a fixed structure, and treating it as invalid made the story re-frame
    // every 400 ms, which reads as the camera twitching instead of moving
    const m = /^backend (\d+)$/.exec(id)
    if (!m) return true
    const pod = instance.backends[Number(m[1]) - 1]
    return !!pod && pod.active && pod.busy
  },
  walRun: () => instance.walRunBox(),
  walBuffers: () => instance.walBuffersBox(),
  walHead: () => ({ id: `wal head`, box: instance.walHeadBox() }),
}

const story = createStory({
  rig,
  sim,
  scene: storyScene,
  setSpeed: applySpeed,
  onEnter: () => {
    // no camera drift during a story: the scene is already moving enough, and
    // a turning frame makes the captions hard to follow
    orbitBeforeStory = autoOrbit
    speedBeforeStory = speed
    regimeBeforeStory = sim.regime
    autoOrbit = false
    world.controls.autoRotate = false
    if (orbitCheckbox) orbitCheckbox.checked = false
    sim.ambient = false
    // a story's captions assume the default mix: a write-heavy workload would
    // starve the read steps and a read-heavy one would never grow the WAL
    hud.setRegime('default')
    // start from a clean pool: leave one connection, so "one request, one
    // connection" describes what is actually on screen
    instance.closeIdleBackendsTo(1)
  },
  onExit: () => {
    sim.ambient = true
    applySpeed(speedBeforeStory)
    hud.setRegime(regimeBeforeStory)
    // hand the camera back the way we found it
    autoOrbit = orbitBeforeStory
    world.controls.autoRotate = orbitBeforeStory
    if (orbitCheckbox) orbitCheckbox.checked = orbitBeforeStory
  },
})
  ; (window as unknown as Record<string, unknown>).__psqlStory = story
initCredits()

// build the story list from the same registry the stories themselves come from
const storiesEl = document.getElementById('stories')
if (storiesEl) {
  for (const s of story.stories) {
    const b = document.createElement('button')
    b.className = 'sitem'
    b.dataset.story = s.id
    b.textContent = s.label
    b.title = s.hint
    b.addEventListener('click', () => {
      story.start(s.id)
      for (const el of storiesEl.querySelectorAll('.sitem')) el.classList.remove('on')
      b.classList.add('on')
    })
    storiesEl.appendChild(b)
  }
  // not built yet: listed with a tag rather than hidden, so the gaps in the
  // scene are visible and named
  for (const p of PLANNED_STORIES) {
    const b = document.createElement('button')
    b.className = 'sitem soon'
    b.disabled = true
    b.title = p.hint
    b.innerHTML = '<span class="soon-label"></span><i class="soon-tag">soon</i>'
    b.querySelector('.soon-label')!.textContent = p.label
    storiesEl.appendChild(b)
  }
}

// build the view buttons from the single source of truth
const viewsEl = document.getElementById('views')
if (viewsEl) {
  for (const v of ALL_VIEWS) {
    const b = document.createElement('button')
    b.className = 'vbtn'
    b.dataset.view = v.id
    b.textContent = v.label
    b.title = v.hint
    b.addEventListener('click', () => {
      rig.go(v.id)
      lastInteraction = performance.now()
      for (const el of viewsEl.querySelectorAll('.vbtn')) el.classList.remove('on')
      b.classList.add('on')
    })
    viewsEl.appendChild(b)
  }
}

window.addEventListener('keydown', (e) => {
  if (isTyping(e.target)) return
  if (e.key >= '0' && e.key <= '9') {
    const ids = ALL_VIEWS.map((v) => v.id)
    const idx = e.key === '0' ? (ids.indexOf(rig.current() ?? '') + 1) % ids.length : Number(e.key) - 1
    const id = ids[idx]
    if (id) {
      rig.go(id)
      viewsEl?.querySelectorAll('.vbtn').forEach((el, i) => {
        el.classList.toggle('on', i === idx)
      })
    }
  }
})

/* ------------------------------- hover picking ----------------------------- */

const raycaster = new THREE.Raycaster()
// the process cage is a bare line box, so its edges need a pick radius — small
// enough that an edge crossing the view does not steal picks from what is behind
raycaster.params.Line = { threshold: 0.1 }
const pointer = new THREE.Vector2(-2, -2)
let pointerPx = { x: 0, y: 0 }
let hovered: PickInfo | null = null

const hoverBox = new OutlineBox(1, 1, 1, 0x35e0ff, 0.6)
hoverBox.visible = false
scene.add(hoverBox)

/** The outline currently tinted by hover/selection, so it can be restored. */
let glowing: OutlineBox | null = null
const _boxSize = new THREE.Vector3()
const _boxCentre = new THREE.Vector3()

canvas.addEventListener('pointermove', (e) => {
  pointerPx = { x: e.clientX, y: e.clientY }
  pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1)
})

function infoRoot(o: THREE.Object3D | null): THREE.Object3D | null {
  let cur: THREE.Object3D | null = o
  while (cur) {
    if (cur.userData.info) return cur
    cur = cur.parent
  }
  return null
}

/** The nearest ancestor that answers per-hit rather than per-object. */
function infoForRoot(o: THREE.Object3D | null) {
  let cur: THREE.Object3D | null = o
  while (cur) {
    const f = cur.userData.infoFor as ((hit: THREE.Intersection) => BlockPick | null) | undefined
    if (f) return f
    cur = cur.parent
  }
  return null
}

function pick(ndc: THREE.Vector2): PickInfo | null {
  raycaster.setFromCamera(ndc, camera)
  const hits = raycaster.intersectObjects(pickables, true)
  // Two passes on purpose. A block answers for one instance of one mesh and
  // declines when the camera is far away; the table-region boxes hover *above*
  // the blocks, so they are usually the nearer hit and would otherwise eat
  // every block click. Close up, the block wins; from afar, the region does.
  let fallback: PickInfo | null = null
  for (const hit of hits) {
    const provider = infoForRoot(hit.object)
    if (provider) {
      const res = provider(hit)
      if (res) return { root: hit.object, key: res.key, info: res.info, box: res.box }
      continue
    }
    if (!fallback) {
      const root = infoRoot(hit.object)
      if (root?.userData.info) {
        fallback = { root, key: root.userData.info.title, info: root.userData.info }
      }
    }
  }
  return fallback
}

// debug helper: what is under a screen point?
; (window as unknown as Record<string, unknown>).__pickAt = (x: number, y: number) => {
  const ndc = new THREE.Vector2(
    (x / window.innerWidth) * 2 - 1,
    -(y / window.innerHeight) * 2 + 1,
  )
  return pick(ndc)?.info.title ?? null
}

let downAt = { x: 0, y: 0 }
canvas.addEventListener('pointerdown', (e) => {
  downAt = { x: e.clientX, y: e.clientY }
  lastInteraction = performance.now()
})

canvas.addEventListener('pointerup', (e) => {
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y)
  if (moved > 6) return
  // in move mode a click on a cage is a grab, not an inspection
  if (moveMode) return
  const root = pick(pointer)
  if (root) {
    if (pinned?.key === root.key) {
      pinned = null
      hud.unpin()
    } else {
      pinned = root
      hud.inspect(root.info)
    }
  } else {
    pinned = null
    hud.unpin()
  }
})

/* ----------------------------------- flying -------------------------------- */

const crosshair = document.querySelector<HTMLElement>('#crosshair')!
/** True while the mouse button is held down in fly mode — hold to look around. */
let looking = false

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')

// the system cursor only vanishes for as long as the button is held
canvas.addEventListener('pointerdown', (e) => {
  if (!flyMode || e.button !== 0) return
  looking = true
  canvas.style.cursor = 'none'
  crosshair.hidden = false
  crosshair.style.opacity = '0.9'
})
window.addEventListener('pointerup', () => {
  if (!looking) return
  looking = false
  canvas.style.cursor = flyMode ? 'crosshair' : 'grab'
  crosshair.hidden = true
})

const lookOffset = new THREE.Vector3()
const lookSph = new THREE.Spherical()

document.addEventListener('mousemove', (e) => {
  if (!flyMode || !looking) return
  const sens = 0.0026
  lookOffset.copy(world.controls.target).sub(camera.position)
  lookSph.setFromVector3(lookOffset)
  // same convention as an FPS: drag right turns right, drag down looks down
  lookSph.theta -= e.movementX * sens
  lookSph.phi = THREE.MathUtils.clamp(lookSph.phi + e.movementY * sens, 0.12, Math.PI - 0.12)
  lookOffset.setFromSpherical(lookSph)
  world.controls.target.copy(camera.position).add(lookOffset)
  lastInteraction = performance.now()
})

const FLY_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'])
const flyToggle = document.querySelector<HTMLInputElement>('#chk-fly')!

/* ------------------------------ double click ------------------------------ */

// Double-click frames whatever is under the cursor and hands the orbit to it.
// Empty space frames the whole instance, which doubles as "zoom out".
canvas.addEventListener('dblclick', (e) => {
  if (moveMode) return
  const ndc = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1,
  )
  const root = pick(ndc)
  // the two pointerups of a double click leave the pin toggled off; re-pin here
  if (root) {
    pinned = root
    hud.inspect(root.info)
  } else {
    pinned = null
    hud.unpin()
  }
  // flying moves the camera and its target together, which fights a fixed orbit
  if (flyMode) {
    flyToggle.checked = false
    flyToggle.dispatchEvent(new Event('change'))
  }
  void rig.focus(
    root
      ? (root.box ?? root.root)
      : new THREE.Box3().setFromObject(instance.group).union(new THREE.Box3().setFromObject(redis.group)),
  ).then(() => {
    // the fly-to is camera movement: keep the preference on, but leave the
    // drift to the cooldown instead of starting it in the same breath
    autoOrbit = true
    if (orbitCheckbox) orbitCheckbox.checked = true
    noteCameraMove()
  })
  noteCameraMove()
})

window.addEventListener('keydown', (e) => {
  if (isTyping(e.target)) return
  // pressing a movement key is itself the request to enter fly mode
  if (!flyMode && FLY_CODES.has(e.code)) {
    flyToggle.checked = true
    flyToggle.dispatchEvent(new Event('change'))
  }
  if (!flyMode || !FLY_CODES.has(e.code)) return
  flyKeys.add(e.code)
  e.preventDefault()
})

// shift is only a boost modifier, it must not switch modes on its own
window.addEventListener('keydown', (e) => {
  if (flyMode && !isTyping(e.target) && (e.code === 'ShiftLeft' || e.code === 'ShiftRight')) {
    flyKeys.add(e.code)
  }
})
window.addEventListener('keyup', (e) => flyKeys.delete(e.code))
window.addEventListener('blur', () => flyKeys.clear())

const flyFwd = new THREE.Vector3()
const flyRight = new THREE.Vector3()
const flyDir = new THREE.Vector3()
const flyMove = new THREE.Vector3()

/** WASD/QE flight: the camera and its orbit target move together. */
function updateFly(dt: number) {
  if (!flyMode) {
    flyVel.set(0, 0, 0)
    return
  }
  camera.getWorldDirection(flyFwd)
  flyRight.crossVectors(flyFwd, camera.up).normalize()
  flyDir.set(0, 0, 0)
  if (flyKeys.has('KeyW')) flyDir.add(flyFwd)
  if (flyKeys.has('KeyS')) flyDir.sub(flyFwd)
  if (flyKeys.has('KeyD')) flyDir.add(flyRight)
  if (flyKeys.has('KeyA')) flyDir.sub(flyRight)
  if (flyKeys.has('KeyE')) flyDir.y += 1
  if (flyKeys.has('KeyQ')) flyDir.y -= 1

  const boost = flyKeys.has('ShiftLeft') || flyKeys.has('ShiftRight') ? 3.2 : 1
  if (flyDir.lengthSq() > 0) {
    flyDir.normalize().multiplyScalar(11 * boost)
    lastInteraction = performance.now()
    if (world.controls.autoRotate) world.controls.autoRotate = false
  }
  flyVel.lerp(flyDir, 1 - Math.exp(-dt * 9))
  if (flyVel.lengthSq() < 1e-5) return

  flyMove.copy(flyVel).multiplyScalar(dt)
  const next = camera.position.clone().add(flyMove)
  next.x = THREE.MathUtils.clamp(next.x, -64, 64)
  next.y = THREE.MathUtils.clamp(next.y, 1.2, 46)
  next.z = THREE.MathUtils.clamp(next.z, -64, 64)
  flyMove.copy(next).sub(camera.position)
  camera.position.add(flyMove)
  world.controls.target.add(flyMove)
}

/* -------------------------------- redis hud ------------------------------- */

const rd = {
  keys: document.getElementById('rd-keys')!,
  ops: document.getElementById('rd-ops')!,
  hit: document.getElementById('rd-hit')!,
  lat: document.getElementById('rd-lat')!,
  mem: document.getElementById('rd-mem')!,
  evict: document.getElementById('rd-evict')!,
  aof: document.getElementById('rd-aof')!,
  bar: document.getElementById('rd-bar')!,
  note: document.getElementById('rd-note')!,
}

const fmtBytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} kB`
      : `${(n / (1024 * 1024)).toFixed(2)} MB`

/** The redis card is fed straight from its own sim — it has no shared model. */
function updateRedisCard(s: RedisStats) {
  rd.keys.textContent = `${s.keys}/${s.capacity}`
  rd.ops.textContent = `${Math.round(s.opsPerSec)} ops/s`
  rd.hit.textContent = s.hitRate > 0 ? `${s.hitRate.toFixed(1)}%` : '—'
  rd.lat.textContent = s.latency > 0 ? `${s.latency.toFixed(2)} ms` : '—'
  rd.mem.textContent = `${s.memPct.toFixed(0)}%`
  rd.evict.textContent = String(s.evictions)
  rd.aof.textContent = fmtBytes(s.aofBytes)
  rd.bar.style.width = `${Math.min(100, s.memPct)}%`
  if (rd.note.textContent !== s.note) rd.note.textContent = s.note
}

/* --------------------------------- ambient -------------------------------- */

instance.markDeadTuples(7)

let trafficTimer = 2.4
let booted = false
let lastTime = performance.now()

function frame() {
  const now = performance.now()
  const raw = Math.min((now - lastTime) / 1000, 0.05)
  lastTime = now
  // the speed slider scales the whole simulation clock, not the render rate
  const dt = raw * speed

  ticker.update(dt)
  sim.update(dt)
  // redis runs on the same clock and pauses with the postgres ambient traffic,
  // so a story about one instance is not competing with traffic in the other
  redisSim.ambient = sim.ambient
  redisSim.update(dt)
  redis.update(dt, now * 0.001)
  updateFly(raw)
  // keep the camera on the subject of the current view while it moves — on real
  // time, not sim time, so the follow feels the same at any clock speed
  rig.follow(raw)

  // ambient traffic so the machine always feels alive; a story switches it off
  // so the only load on screen is the load it just described
  if (sim.ambient) {
    trafficTimer -= dt
    if (trafficTimer <= 0) {
      trafficTimer = rand(3.6, 7.2) * sim.arrivalGap
      void sim.runQuery()
    }
  }

  // hover highlight
  const root = pick(pointer)
  hoverCage = root ? ownerCage(root.root) : null
  // pointing at a cage also selects it, so arrow keys keep working after the
  // pointer drifts off it (the camera keeps orbiting)
  if (hoverCage) lastCage = hoverCage
  if ((root?.key ?? null) !== (hovered?.key ?? null)) {
    hovered = root
    hud.hover(root?.info ?? null, pointerPx.x, pointerPx.y)
    if (!flyMode) canvas.style.cursor = root ? 'pointer' : 'grab'
  } else if (hovered) {
    hud.hover(hovered.info, pointerPx.x, pointerPx.y)
  }
  const target = hovered ?? pinned
  // anything that already owns an outline highlights that outline; drawing a
  // second box around the same volume would just be the same box twice
  const outline: OutlineBox | null = target
    ? target.root instanceof OutlineBox
      ? target.root
      : ((target.root.userData.outline as OutlineBox | undefined) ?? null)
    : null
  if (glowing && glowing !== outline) {
    glowing.highlight(false)
    glowing = null
  }
  if (target && outline) {
    outline.highlight(true, target === pinned ? 0xffffff : 0x8fe6ff)
    glowing = outline
    hoverBox.visible = false
  } else if (target && target.root.userData.noOutline) {
    // some picks are volumes of empty space; outlining them would draw a box
    // around nothing
    hoverBox.visible = false
  } else if (target) {
    const box = target.box ? target.box.clone() : new THREE.Box3().setFromObject(target.root)
    box.expandByScalar(0.08)
    const size = box.getSize(_boxSize)
    const centre = box.getCenter(_boxCentre)
    hoverBox.position.copy(centre)
    hoverBox.scale.set(
      Math.max(size.x, 0.05),
      Math.max(size.y, 0.05),
      Math.max(size.z, 0.05),
    )
    hoverBox.setColor(target === pinned ? 0xffffff : 0x35e0ff)
    hoverBox.visible = true
  } else {
    hoverBox.visible = false
  }

  // resume the slow orbit after the user stops interacting
  // resume the slow orbit after a quiet spell — every camera move pushes this out
  if (
    autoOrbit &&
    !flyMode &&
    !drag &&
    !world.controls.autoRotate &&
    performance.now() - lastInteraction > ORBIT_COOLDOWN
  ) {
    world.controls.autoRotate = true
  }

  world.render(raw, dt)
  telemetry.tick(dt, raw)
  hud.setStats(sim.stats)
  updateRedisCard(redisSim.stats)

  if (!booted) {
    booted = true
    window.setTimeout(() => hud.bootDone(), 260)
  }

  requestAnimationFrame(frame)
}

window.addEventListener('resize', () => {
  world.resize()
})
requestAnimationFrame(frame)
