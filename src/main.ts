import './style.css'
import * as THREE from 'three'
import { createWorld } from './world'
import { PostgresInstance } from './postgresql/instance'
import { POSTGRES_ORIGIN } from './postgresql/instance'
import type { BlockPick } from './postgresql/instance'
import { RedisInstance } from './redis/redis'
import { RedisSim } from './redis/sim'
import type { RedisStats } from './redis/sim'
import { createAxes } from './axes'
import { makeFlows, makePaths } from './core/flow'
import { EngineSim } from './postgresql/sim'
import type { Regime } from './postgresql/sim'
import { installTelemetry } from './debug'
import { createCameraRig, defaultView, slugOf, viewBySlug, viewForBox, viewsFor } from './core/views'
import type { ViewDef } from './core/views'
import { createStory, PLANNED_STORIES, STORIES } from './stories'
import type { StoryScene } from './stories'
import { addressFromPath, decodePose, encodePose, pathFor } from './share'
import type { ShareDb } from './share'
import { initHud } from './ui'
import { Ticker, label, rand, OutlineBox } from './core/util'

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

const paths = makePaths(instance)
// both instances own their own traffic: paths and packets are parented to the
// cage, so moving a cage takes them with it
const flows = makeFlows(instance.group, paths)

const sim = new EngineSim(instance, ticker, scene, paths, flows)

// the second database, on the same floor
const redis = new RedisInstance(ticker)
scene.add(redis.group)
const redisSim = new RedisSim(redis, ticker)

/**
 * Is this object being drawn right now?
 *
 * `Object3D.visible` is the one bit in the scene that already means "this is not
 * on screen", and it is set by whatever hides the thing: a closed connection's
 * group, a log that has no blocks in it, a freed slot. Asking the ray about it
 * keeps the answer truthful without a second list of what is supposed to exist.
 *
 * Walks the parents because hiding a group hides its children from the renderer
 * and nothing copies that down to them.
 */
function shown(o: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = o; n; n = n.parent) if (!n.visible) return false
  return true
}

/**
 * Both instances answer the pointer the same way.
 *
 * Read live rather than copied: the moment one of these lists is a snapshot, a
 * cage that registers or retires a pick volume is editing a list nobody is
 * listening to, and the fix for a ghost cage becomes a second place to keep in
 * step.
 */
const allPicks = () => [...instance.pickables, ...redis.pickables]

/**
 * What the pointer can hit: pick volumes, minus the ones the drawing is not
 * showing.
 *
 * A pick outlives its subject by design — a connection goes away, the pick that
 * described it stays in the scene, invisible to the eye. Left selectable, that is
 * a cage you can hover around nothing: the highlight has no volume to hug, the
 * card describes something that is not on screen, and a double-tap lands on an
 * empty slot instead of the floor behind it.
 */
function cast(rc: THREE.Raycaster): THREE.Intersection[] {
  // nearest first, preserved: filtering for visibility must not reorder the ray
  return rc.intersectObjects(allPicks(), true).filter((h) => shown(h.object))
}

// measuring aid: __axes.on() / .off() / .toggle(), or open the page with ?axes
const axes = createAxes(scene)
const markPostgres = axes.mark('postgres', new THREE.Vector3(0, 0, 0))
const markRedis = axes.mark('redis', new THREE.Vector3(-36, 0, 0))

  // handy for debugging in the browser console
  ; (window as unknown as Record<string, unknown>).__psql = { scene, world, instance, sim, paths, flows }
  ; (window as unknown as Record<string, unknown>).__redis = {
    redis,
    redisSim,
    // ask the floor to prove it matches the files: returns [] when it does
    check: () => redis.verify(),
  }
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

const moveToggle = document.querySelector<HTMLButtonElement>('#btn-move')!
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

/** The layout is an authoring tool: it prints where the cages are, every time. */
function updateMoveHint() {
  const p = anchorOf('postgres')
  const r = anchorOf('redis')
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

/**
 * Grab-the-cage mode: the only camera control left in the HUD.
 *
 * It takes the same drag gesture as flying, so entering it ends a flight; the
 * ruler only exists for this mode, so it goes away with it.
 */
function setMove(on: boolean) {
  moveMode = on
  moveToggle.classList.toggle('on', on)
  moveToggle.setAttribute('aria-pressed', String(on))
  if (on) {
    axes.on()
    if (flyMode) setFly(false)
  } else {
    axes.off()
  }
  updateMoveHint()
}

/** Leaving grab-mode from elsewhere (flight, Esc) without recursing back. */
function leaveMove() {
  if (moveMode) setMove(false)
}

/* ----------------------------------- zen ---------------------------------- */

/**
 * Zen: hide everything the app says about itself and leave the scene.
 *
 * It is a way to stop reading the interface for a minute, not a mode with rules —
 * so it has exactly one exit, and it is the one people try: any tap, any key, a
 * scroll. The whole overlay fades rather than vanishing, and stops taking the
 * pointer while it is gone: otherwise the first tap meant to wake it would land on
 * a control nobody can see.
 */
let zenMode = false

function setZen(on: boolean) {
  zenMode = on
  document.body.classList.toggle('zen', on)
  hud.setZen(on)
}

/** Any contact with the scene is the request to come back. */
function wake() {
  if (zenMode) setZen(false)
}

window.addEventListener('pointerdown', wake, { capture: true })
window.addEventListener('keydown', wake, { capture: true })
window.addEventListener('wheel', wake, { passive: true })

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
    driftOn = false
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
//
// This fires on a delay so the scene is built before the camera cuts. The delay
// is also why it is guarded: if the user has already taken the camera by hand —
// flying, orbiting, zooming — the pose they landed on is theirs, and cutting
// back to the link's pose would look like the camera being dragged out from
// under them. The deep link only decides where you START.
const startView = new URLSearchParams(location.search).get('view')
// `/postgresql` and `/redis` are the addresses: the path names a cage and, after
// a second segment, one of that cage's named shots. Handled below, once the rig
// exists.
const bootAddress = addressFromPath(location.pathname)
if (startView && !bootAddress)
  window.setTimeout(() => {
    if (userTookCamera) return
    rig.snap(startView)
  }, 1500)
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
  // redis has no statements and no planner: one command, executed by the one
  // thread, plus the background jobs it can start
  runCommand: () => redisSim.runCommand(),
  save: () => redisSim.save(),
  bgsave: () => redisSim.bgsave(),
  load: () => void redisSim.loadFromDisk(),
  rewriteAof: () => redisSim.rewriteAof(),
  setSpeed: (v) => {
    speed = v
  },
  setRegime: (r) => sim.setRegime(r),
  setMove: (on) => setMove(on),
  setZen: (on) => setZen(on),
  onDbPanel: (open) => setPanelParam(open),
  unpin: () => {
    pinned = null
    hud.unpin()
  },
})

let lastInteraction = performance.now()

/**
 * True once the user has driven the camera themselves: orbit drag, wheel, a fly
 * key, or a click on the canvas. Anything on a delay (the ?view= pose) checks
 * this and stands down.
 */
let userTookCamera = false

/**
 * The drift pauses whenever the CAMERA is moved by hand, and comes back only
 * after this long with no further camera movement — so an orbit drag, a zoom or
 * a double-tap fly-to never lands you in a frame that is already turning.
 * Moving a cage is not camera movement and does not touch this timer.
 */
const ORBIT_COOLDOWN = 5000

/**
 * The drift is ours, not OrbitControls' `autoRotate`.
 *
 * Both turn the camera around a point, but `autoRotate` can only turn it around
 * the aim point — and a cage-level shot aims PAST its cage, out in front, so the
 * machine would sweep across the frame instead of turning where it stands. Here
 * the pivot is the view's own (the middle of the cage, for a cage-level shot), so
 * the camera keeps its position and its framing and the object turns under it.
 *
 * 0.34 is the speed the old orbit ran at: OrbitControls turns 2π/60 · speed rad
 * per second, so that is one revolution in about three minutes.
 */
const ORBIT_RATE = (2 * Math.PI / 60) * 0.34
let driftOn = true
/**
 * A story owns the camera while it runs.
 *
 * The drift is not OrbitControls' autoRotate any more — it is this file turning
 * the camera on its own — so turning `autoRotate` off no longer stops it. Left
 * on, a story's frame would creep off its pose a few seconds after every step
 * opened and the panel would sit on "camera → …" forever.
 */
let storyActive = false

let cameraMoves = 0
function noteCameraMove() {
  cameraMoves++
  lastInteraction = performance.now()
  driftOn = false
}

/** The drift: turn the camera about what the shot aims at, once every ~3 minutes. */
function drift(dt: number) {
  rig.turn(-ORBIT_RATE * dt)
}

// what the drift is doing right now — handy when a gesture looks like it stuck
; (window as unknown as Record<string, unknown>).__orbit = {
  get state() {
    return {
      flyMode,
      drift: driftOn,
      idleMs: Math.round(performance.now() - lastInteraction),
      dragging: !!drag,
      moves: cameraMoves,
    }
  },
}

  /**
   * Instrumentation for stories, tests and a person with the console open.
   *
   * `__clock.stop()` is the useful one: with time stopped the simulation is a still
   * frame, so every coordinate can be read and asserted without it moving under the
   * check — the camera's own follow still runs, because that is driven by real time
   * and is not part of what is being timed.
   */
  ; (window as unknown as Record<string, unknown>).__clock = {
    stop: () => applySpeed(0),
    resume: () => applySpeed(1),
    set: (v: number) => applySpeed(v),
    get speed() {
      return speed
    },
  }
  ; (window as unknown as Record<string, unknown>).__ride = () => {
    const p = redisSim.packetSubject()
    const at = p ? p.object.getWorldPosition(new THREE.Vector3()) : null
    return {
      following: rig.following(),
      settled: rig.settled(),
      packet: p?.id ?? null,
      packetAt: at ? at.toArray().map((n) => +n.toFixed(2)) : null,
      camera: camera.position.toArray().map((n) => +n.toFixed(2)),
      aim: world.controls.target.toArray().map((n) => +n.toFixed(2)),
      gap: at ? +camera.position.distanceTo(at).toFixed(2) : null,
    }
  }

world.controls.addEventListener('start', () => {
  userTookCamera = true
  noteCameraMove()
  // A hand-driven camera takes over from whatever view was selected: ?view= sets
  // where you start, it is not a lock. Re-navigating to a view re-arms it.
  rig.release()
})

// any click on the canvas is the user taking the camera, whether or not it turns
// into a drag (and whatever mode the controls are in)
canvas.addEventListener(
  'pointerdown',
  () => {
    userTookCamera = true
  },
  { capture: true },
)
canvas.addEventListener('wheel', () => (userTookCamera = true), { passive: true })

/* --------------------------------- views ---------------------------------- */

const rig = createCameraRig({
  camera,
  controls: world.controls,
  ticker,
  // Navigating stops the drift first, otherwise it drags the camera off the
  // pose. It comes back on its own after the cooldown, like after any camera move.
  beforeNavigate: () => {
    driftOn = false
  },
})
  ; (window as unknown as Record<string, unknown>).__psqlViews = rig

/* -------------------------------- addressing ------------------------------- */

/**
 * Which cage an address should name: the open panel's, else whichever cage the
 * camera is pointing at.
 */
function dbInFrame(): ShareDb {
  if (hud.db) return hud.db
  const aim = world.controls.target
  const centreOf = (g: THREE.Object3D) => new THREE.Box3().setFromObject(g).getCenter(new THREE.Vector3())
  return aim.distanceTo(centreOf(instance.group)) <= aim.distanceTo(centreOf(redis.group))
    ? 'postgres'
    : 'redis'
}

/**
 * The point a pinned pose is measured from: the cage's origin, which is where the
 * instance stands its group — the middle of the cage's footprint on the floor.
 *
 * Only `?cam=` needs this. A named shot does not: it is built from the structures
 * themselves, so it moves when they do.
 */
function cageOrigin(db: ShareDb): THREE.Vector3 {
  return (db === 'postgres' ? instance.group : redis.group).position.clone()
}

/**
 * Write the address of what is on screen.
 *
 * Two independent things, so two independent places in the URL:
 *
 *   the PATH names the cage and the shot — `/postgresql/wal`, `/redis/keys`
 *   `?db-panel=` says which database card is expanded
 *
 * They are deliberately not the same statement. Looking at the WAL run is not a
 * request for the whole postgres card, and having the redis card open does not
 * mean the camera is on the redis cage. Splitting them is also what makes a path
 * shareable on its own: `/postgresql/wal` opens the same shot for everyone, with
 * whatever cards they have open.
 *
 * `replaceState`, not `pushState`: every double-tap would otherwise leave a
 * history entry, and back would rewind the camera through a session instead of
 * leaving the page.
 */
function setAddress(db: ShareDb, view: ViewDef | null) {
  const q = new URLSearchParams(location.search)
  // a named shot is reproducible; the pinned pose it replaced is not needed
  q.delete('cam')
  q.delete('view')
  const path = pathFor(db, view ? slugOf(view) : '')
  const rest = q.toString()
  history.replaceState(null, '', rest ? `${path}?${rest}` : path)
}

/** Which card the address asks to have open, if any. */
function panelFromQuery(): ShareDb | null {
  const v = new URLSearchParams(location.search).get('db-panel')
  if (v === 'redis') return 'redis'
  if (v === 'postgresql' || v === 'postgres') return 'postgres'
  return null
}

/** Keep `?db-panel=` in step with the switches, and drop it when nothing is open. */
function setPanelParam(open: ShareDb | null) {
  const q = new URLSearchParams(location.search)
  if (open) q.set('db-panel', open === 'postgres' ? 'postgresql' : 'redis')
  else q.delete('db-panel')
  const rest = q.toString()
  history.replaceState(null, '', rest ? `${location.pathname}?${rest}` : location.pathname)
}

/** Authoring aid: the camera right now as a `?cam=` value, relative to its cage. */
; (window as unknown as Record<string, unknown>).__psqlCam = () => {
  const db = dbInFrame()
  const origin = cageOrigin(db)
  return encodePose(
    camera.position.clone().sub(origin),
    world.controls.target.clone().sub(origin),
    camera.fov,
  )
}

/**
 * Pin whatever the current shot is aimed at — the card a click in the middle of
 * the frame would give. A path that names a shot names a THING, so the thing
 * comes with its description; `/postgresql` alone names the whole cage and has
 * nothing extra to say, so it opens no card.
 */
/**
 * Pin the card of the thing a shot is about.
 *
 * Not "whatever is under the middle of the frame": a shot looks PAST things — the
 * big sorted set is framed from above the keyspace plane, the clients shot has the
 * RAM deck behind the ports, the backend shot has an index tree further along the
 * ray — and a card taken from the middle pixel would describe a machine part that
 * the shot is not about.
 *
 * So the rule is self-consistent instead: walk the hits from the middle outwards
 * and take the first one that THIS shot is about, using the same test a double-tap
 * uses (viewForBox). That makes the subject true by construction — the card and
 * the path cannot disagree about what is being shown.
 */
function pinShotSubject(db: ShareDb, view: ViewDef) {
  // The camera was just snapped into place, and a camera's world matrix only
  // catches up at render time. Cast with an updated one, or the rays come from
  // where the camera used to be.
  camera.updateMatrixWorld()
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera)
  for (const hit of cast(raycaster)) {
    let picked: PickInfo | null = null
    const provider = infoForRoot(hit.object)
    if (provider) {
      const res = provider(hit)
      if (res) picked = { root: hit.object, key: res.key, info: res.info, box: res.box }
    }
    if (!picked) {
      const root = infoRoot(hit.object)
      if (root?.userData.info) {
        picked = { root, key: root.userData.info.title, info: root.userData.info }
      }
    }
    if (!picked) continue
    const box = picked.box ?? new THREE.Box3().setFromObject(picked.root)
    if (viewForBox(db, box)?.id !== view.id) continue
    pinned = picked
    hud.inspect(picked.info)
    return
  }
}

/* -------------------------------- story mode ------------------------------- */

/** clock speed as it was before the story opened */
let speedBeforeStory = 1
/** workload regime as it was before the story opened */
let regimeBeforeStory: Regime = 'default'

const speedInput = document.querySelector<HTMLInputElement>('#speed')

/** Move the clock and keep the slider honest about it. */
function applySpeed(v: number) {
  speed = v
  if (speedInput) speedInput.value = String(v)
  hud.showSpeed(v)
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
    // A packet is the one subject here that is guaranteed to stop existing: it
    // leaves the cage. Its id carries the ride number, so "still valid" is exactly
    // "that same packet is still in the air" — and when it is not, the step waits
    // for the next one instead of holding a frame on empty space.
    if (id.startsWith('publish packet ')) return redisSim.packetSubject()?.id === id
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
  // the redis cage's only live subject: the copy of a publish that is in flight
  redisPacket: () => {
    const p = redisSim.packetSubject()
    if (!p) return null
    // A box the size of the packet's own position, not of its glow: setFromObject
    // would measure the additive halo sprite around it, which is five times the
    // cube, and framing that puts the camera 23 units out looking at a dot.
    const at = p.object.getWorldPosition(new THREE.Vector3())
    const box = new THREE.Box3(at.clone().addScalar(-0.5), at.clone().addScalar(0.5))
    return { id: p.id, box, object: p.object }
  },
}

const story = createStory({
  rig,
  sim,
  scene: storyScene,
  redis: redisSim,
  stories: STORIES,
  setSpeed: applySpeed,
  onEnter: () => {
    // no camera drift during a story: the scene is already moving enough, and
    // a turning frame makes the captions hard to follow
    speedBeforeStory = speed
    regimeBeforeStory = sim.regime
    world.controls.autoRotate = false
    sim.ambient = false
    // a story's captions assume the default mix: a write-heavy workload would
    // starve the read steps and a read-heavy one would never grow the WAL
    hud.setRegime('default')
    // start from a clean pool: leave one connection, so "one request, one
    // connection" describes what is actually on screen
    instance.closeIdleBackendsTo(1)
    // and an empty channel on the redis floor: a story about pub/sub says something
    // about a socket turning violet, so it has to start with nobody listening and
    // no background episode arriving mid-caption
    redisSim.suspendPubSub()
    // the list you picked the story from is not part of the story: its panel closes
    // so the card and the scene have the room
    hud.closePanels()
    // the drift belongs to the idle page, not to a caption: it would carry the
    // camera off the step's pose a few seconds after the step opened
    storyActive = true
    driftOn = false
  },
  onExit: () => {
    sim.ambient = true
    redisSim.resumePubSub()
    storyActive = false
    applySpeed(speedBeforeStory)
    hud.setRegime(regimeBeforeStory)
    // the drift comes back on its own once the cooldown passes
    noteCameraMove()
  },
})
  ; (window as unknown as Record<string, unknown>).__psqlStory = story

// build the story list from the same registry the stories themselves come from.
// One list at root level — a story may later span both cages — but grouped by
// engine, because "too many requests" and "one big value" are not the same kind
// of thing and reading them as one flat list hides which cage each one is about.
const storiesEl = document.getElementById('stories')
if (storiesEl) {
  const groups: { db: 'postgres' | 'redis'; label: string }[] = [
    { db: 'postgres', label: 'PostgreSQL' },
    { db: 'redis', label: 'Redis' },
  ]
  const addStory = (s: (typeof STORIES)[number]) => {
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
  for (const g of groups) {
    const head = document.createElement('div')
    head.className = 'sgroup'
    head.textContent = g.label
    storiesEl.appendChild(head)
    for (const s of STORIES.filter((x) => (x.db ?? 'postgres') === g.db)) addStory(s)
    // not built yet: listed with a tag rather than hidden, so the gaps in the
    // scene are visible and named
    for (const p of PLANNED_STORIES.filter((x) => (x.db ?? 'postgres') === g.db)) {
      const b = document.createElement('button')
      b.className = 'sitem soon'
      b.disabled = true
      b.title = p.hint
      b.innerHTML = '<span class="soon-label"></span><i class="soon-tag">soon</i>'
      b.querySelector('.soon-label')!.textContent = p.label
      storiesEl.appendChild(b)
    }
  }
}

// The view buttons, built into the panel of the cage they belong to: the psql
// shots under the postgres card, the redis shots under the redis card. One
// registry, filtered — a view cannot end up listed under the wrong engine.
const viewHosts = [
  { el: document.getElementById('views'), db: 'postgres' as const },
  { el: document.getElementById('views-redis'), db: 'redis' as const },
]
const viewButtons: { el: HTMLButtonElement; id: string }[] = []
const markView = (id: string) => {
  for (const v of viewButtons) v.el.classList.toggle('on', v.id === id)
}
for (const host of viewHosts) {
  if (!host.el) continue
  for (const v of viewsFor(host.db)) {
    const b = document.createElement('button')
    b.className = 'vbtn'
    b.dataset.view = v.id
    b.textContent = v.label
    b.title = v.hint
    b.addEventListener('click', () => {
      rig.go(v.id)
      lastInteraction = performance.now()
      markView(v.id)
      // the button and the path are the same statement: this shot, in this cage
      setAddress(host.db, v)
      // a pinned card describes a block somebody picked; asking for a shot is
      // asking for something else, so the card goes rather than start lying
      pinned = null
      hud.unpin()
    })
    host.el.appendChild(b)
    viewButtons.push({ el: b, id: v.id })
  }
}

window.addEventListener('keydown', (e) => {
  if (isTyping(e.target)) return
  if (e.key >= '0' && e.key <= '9') {
    // numbered within the panel you are looking at, so "3" means the third
    // button on screen and not the third button in some other cage's list
    const db = hud.db ?? 'postgres'
    const list = viewsFor(db)
    const idx =
      e.key === '0'
        ? (list.findIndex((v) => v.id === rig.current()) + 1) % list.length
        : Number(e.key) - 1
    const view = list[idx]
    if (view) {
      rig.go(view.id)
      markView(view.id)
      setAddress(db, view)
      pinned = null
      hud.unpin()
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
  const hits = cast(raycaster)
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
    // A click inspects; it does not open the database's panel. The panel is
    // something you ask for with the switch at the top, not a side effect of
    // pointing at a block.
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
/** the row tells you how to get out, but only while you are in */
const flyHint = document.getElementById('fly-hint')

/**
 * Flight. There is no switch for it: pressing a movement key enters it, and Esc
 * leaves it. It drives the camera by hand, so it releases any selected view.
 */
function setFly(on: boolean) {
  flyMode = on
  flyKeys.clear()
  flyVel.set(0, 0, 0)
  if (!on) looking = false
  // flying is driving the camera by hand: it lets go of any selected view, and
  // it means a delayed ?view= pose must not fire later
  if (on) {
    userTookCamera = true
    rig.release()
    // flight and grab-the-cage want the same drag: only one can be on
    leaveMove()
  }
  // while flying, a drag looks around instead of orbiting the scene
  world.controls.enableRotate = !on
  // cursor stays visible; it is only swapped for the crosshair while dragging
  crosshair.hidden = true
  canvas.style.cursor = on ? 'crosshair' : 'grab'
  if (flyHint) flyHint.hidden = !on
  // flying and the drifting orbit fight each other; flight wins, and the drift
  // only comes back after the same quiet spell any camera move gets
  driftOn = !on && performance.now() - lastInteraction > ORBIT_COOLDOWN
}

/* ------------------------------ double click ------------------------------ */

// Double-click frames whatever is under the cursor and hands the orbit to it.
//
// If what was tapped has a NAMED shot, that is where the camera goes, and the
// path becomes its address (/postgresql/wal, /redis/keys). Predefined, because a
// path has to be reproducible: an arbitrary box framed from wherever you happened
// to be standing is not something a URL can honestly name. A tap on something
// with no named shot is still framed, and the address then says only which cage
// you are in — which is true, where inventing a name would not be.
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
  if (flyMode) setFly(false)

  const db = root ? ownerCage(root.root) : null
  const box = root ? (root.box ?? new THREE.Box3().setFromObject(root.root)) : null
  const view = db && box ? viewForBox(db, box) : null

  if (view && db) {
    rig.go(view.id)
    markView(view.id)
    setAddress(db, view)
  } else if (box) {
    void rig.focus(box)
    setAddress(db ?? dbInFrame(), null)
  } else {
    // Nothing under the cursor is "zoom out": the floor's shot, which has no
    // address of its own, so the path keeps naming the last thing you asked for
    // rather than inventing a place the floor does not have.
    rig.go('overview')
    markView('overview')
  }
  // the fly-to is camera movement: the drift stays off until the cooldown
  noteCameraMove()
})

window.addEventListener('keydown', (e) => {
  if (isTyping(e.target)) return
  // Esc is the way out: of flight, and of grab-the-cage. No switches, none needed
  if (e.code === 'Escape') {
    if (flyMode) setFly(false)
    if (moveMode) setMove(false)
    return
  }
  // pressing a movement key is itself the request to enter fly mode
  if (!flyMode && FLY_CODES.has(e.code)) {
    userTookCamera = true
    setFly(true)
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
    driftOn = false
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
  skew: document.getElementById('rd-skew')!,
  ops: document.getElementById('rd-ops')!,
  hit: document.getElementById('rd-hit')!,
  lat: document.getElementById('rd-lat')!,
  mem: document.getElementById('rd-mem')!,
  evict: document.getElementById('rd-evict')!,
  aof: document.getElementById('rd-aof')!,
  rdb: document.getElementById('rd-rdb')!,
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
  rd.skew.textContent = `${s.bigKeys} big · ${s.hotKeys} hot`
  rd.ops.textContent = `${Math.round(s.opsPerSec)} ops/s`
  rd.hit.textContent = s.hitRate > 0 ? `${s.hitRate.toFixed(1)}%` : '—'
  rd.lat.textContent = s.latency > 0 ? `${s.latency.toFixed(2)} ms` : '—'
  rd.mem.textContent = `${s.memPct.toFixed(0)}%`
  rd.evict.textContent = String(s.evictions)
  rd.aof.textContent = fmtBytes(s.aofBytes)
  rd.rdb.textContent = fmtBytes(s.rdbBytes)
  rd.bar.style.width = `${Math.min(100, s.memPct)}%`
  if (rd.note.textContent !== s.note) rd.note.textContent = s.note
  hud.setRedisBusy(s)
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
  // 0 is a real setting, not an accident: the clock stops, the scene becomes a
  // still frame, and every coordinate in it can be read and asserted. The drift
  // is gated on it below for the same reason — a frozen scene that keeps turning
  // is not frozen.
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

  // resume the slow drift after a quiet spell — every camera move pushes this out.
  // Stopped time counts as a reason not to: a frozen scene that goes on turning
  // is not frozen, and a story that stops the clock wants the frame it stopped at.
  if (
    speed > 0 &&
    !storyActive &&
    !flyMode &&
    !drag &&
    !driftOn &&
    performance.now() - lastInteraction > ORBIT_COOLDOWN
  ) {
    driftOn = true
  }
  if (driftOn && speed > 0) drift(raw)

  world.render(raw, dt)
  telemetry.tick(dt, raw)
  hud.setStats(sim.stats)
  updateRedisCard(redisSim.stats)
  hud.refreshStats()

  if (!booted) {
    booted = true
    window.setTimeout(() => hud.bootDone(), 260)
  }

  requestAnimationFrame(frame)
}

window.addEventListener('resize', () => {
  world.resize()
})

/* ----------------------------------- boot --------------------------------- */

/**
 * Where the page opens.
 *
 * Applied HERE, before the first frame: the first frame IS the shot. It used to
 * be a 1.5 s timer, which meant the page first drew the camera the world happens
 * to start with — aimed at the origin from the old default vantage — and then
 * cut: a flash of a frame that describes nothing. Nothing needed the wait. The
 * scene is built synchronously and a snap is a cut, not a tween.
 *
 * The card is the query's business, never the path's: `/redis` is the cage from
 * its own shot, with whatever cards you happen to have open.
 */
const bootPanel = panelFromQuery()
if (bootPanel) hud.setDb(bootPanel)

if (bootAddress) {
  // `?cam=` is a precise override, so it wins over whatever the path names
  const pose = decodePose(new URLSearchParams(location.search).get('cam'))
  if (pose) {
    const origin = cageOrigin(bootAddress.db)
    rig.release()
    camera.position.copy(origin.clone().add(pose.pos))
    camera.fov = pose.fov
    camera.updateProjectionMatrix()
    world.controls.target.copy(origin.clone().add(pose.target))
    world.controls.update()
    lastInteraction = performance.now()
  } else {
    // A path that names nothing (a typo, or `/postgres` for `/postgresql`) still
    // lands on the cage, and the address is rewritten to say what it shows.
    const view = viewBySlug(bootAddress.db, bootAddress.slug) ?? defaultView(bootAddress.db)
    rig.snap(view.id)
    markView(view.id)
    setAddress(bootAddress.db, view)
    // only an explicit shot brings a card; snapping the whole cage does not
    if (bootAddress.slug) pinShotSubject(bootAddress.db, view)
  }
}

// Every redis on the planet starts the same way: the process has files and no
// data, so it reads the base dump, replays the log on top of it, and only then
// opens its ports. Starting the page in the middle of that is the honest
// picture of a running server, and it makes "the dataset came off the disk"
// something you have watched rather than something you were told.
window.setTimeout(() => {
  void redisSim.boot()
}, 300)

requestAnimationFrame(frame)
