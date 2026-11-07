import './style.css'
import * as THREE from 'three'
import { createWorld } from './world'
import { PostgresInstance } from './instance'
import { makeFlows, makePaths } from './flow'
import { EngineSim } from './sim'
import { installTelemetry } from './debug'
import { createCameraRig, ALL_VIEWS } from './views'
import { initHud } from './ui'
import { Ticker, label, rand, OutlineBox, setLineResolution } from './util'

const canvas = document.querySelector<HTMLCanvasElement>('#c')!
const labelHost = document.querySelector<HTMLElement>('#labels')!

const world = createWorld(canvas, labelHost)
const { scene, camera } = world

const ticker = new Ticker()
const instance = new PostgresInstance(ticker)
scene.add(instance.group)

// extra labels
const bufferLabel = label('SHARED BUFFERS · RAM')
// pinned to the far-left corner of the floating pool, text flowing inward
bufferLabel.position.copy(instance.bufferCorners.farLeft).add(new THREE.Vector3(-0.02, 0.34, -0.06))
instance.group.add(bufferLabel)

const paths = makePaths()
const flows = makeFlows(scene, paths)
// fat lines are drawn in screen space, so they need the viewport size
setLineResolution(window.innerWidth, window.innerHeight)

const sim = new EngineSim(instance, ticker, scene, paths, flows)

  // handy for debugging in the browser console
  ; (window as unknown as Record<string, unknown>).__psql = { scene, world, instance, sim, paths, flows }

let autoOrbit = true
let flyMode = false
const flyKeys = new Set<string>()
const flyVel = new THREE.Vector3()
let speed = 1
let pinned: THREE.Object3D | null = null

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
  setIndexScan: (on) => sim.setIndexScan(on),
  setOrbit: (on) => {
    autoOrbit = on
    world.controls.autoRotate = on && !flyMode
  },
  setFly: (on) => {
    flyMode = on
    flyKeys.clear()
    flyVel.set(0, 0, 0)
    if (!on) looking = false
    // while flying, a drag looks around instead of orbiting the island
    world.controls.enableRotate = !on
    // cursor stays visible; it is only swapped for the crosshair while dragging
    crosshair.hidden = true
    canvas.style.cursor = on ? 'crosshair' : 'grab'
    // flying and drifting orbit fight each other; flying wins
    world.controls.autoRotate = on ? false : autoOrbit
  },
  unpin: () => {
    pinned = null
    hud.unpin()
  },
})

let lastInteraction = performance.now()
world.controls.addEventListener('start', () => {
  lastInteraction = performance.now()
})

/* --------------------------------- views ---------------------------------- */

const orbitCheckbox = document.querySelector<HTMLInputElement>('#chk-orbit')!
const rig = createCameraRig({
  camera,
  controls: world.controls,
  ticker,
  beforeNavigate: () => {
    autoOrbit = false
    world.controls.autoRotate = false
    if (orbitCheckbox) orbitCheckbox.checked = false
  },
})
  ; (window as unknown as Record<string, unknown>).__psqlViews = rig

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
let hovered: THREE.Object3D | null = null

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

function pick(ndc: THREE.Vector2) {
  raycaster.setFromCamera(ndc, camera)
  const hit = raycaster.intersectObjects(instance.pickables, true)[0]
  return infoRoot(hit?.object ?? null)
}

// debug helper: what is under a screen point?
; (window as unknown as Record<string, unknown>).__pickAt = (x: number, y: number) => {
  const ndc = new THREE.Vector2(
    (x / window.innerWidth) * 2 - 1,
    -(y / window.innerHeight) * 2 + 1,
  )
  return pick(ndc)?.userData.info?.title ?? null
}

let downAt = { x: 0, y: 0 }
canvas.addEventListener('pointerdown', (e) => {
  downAt = { x: e.clientX, y: e.clientY }
  lastInteraction = performance.now()
})

canvas.addEventListener('pointerup', (e) => {
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y)
  if (moved > 6) return
  const root = pick(pointer)
  if (root?.userData.info) {
    if (pinned === root) {
      pinned = null
      hud.unpin()
    } else {
      pinned = root
      hud.inspect(root.userData.info)
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
  const ndc = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1,
  )
  const root = pick(ndc)
  // the two pointerups of a double click leave the pin toggled off; re-pin here
  if (root?.userData.info) {
    pinned = root
    hud.inspect(root.userData.info)
  } else {
    pinned = null
    hud.unpin()
  }
  // flying moves the camera and its target together, which fights a fixed orbit
  if (flyMode) {
    flyToggle.checked = false
    flyToggle.dispatchEvent(new Event('change'))
  }
  void rig.focus(root ?? instance.group).then(() => {
    autoOrbit = true
    if (orbitCheckbox) orbitCheckbox.checked = true
    world.controls.autoRotate = true
  })
  lastInteraction = performance.now()
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
  updateFly(raw)

  // ambient traffic so the machine always feels alive
  trafficTimer -= dt
  if (trafficTimer <= 0) {
    trafficTimer = rand(3.6, 7.2)
    void sim.runQuery()
  }

  // hover highlight
  const root = pick(pointer)
  if (root !== hovered) {
    hovered = root
    const info = (root?.userData.info ?? null) as Parameters<typeof hud.hover>[0]
    hud.hover(info, pointerPx.x, pointerPx.y)
    if (!flyMode) canvas.style.cursor = info ? 'pointer' : 'grab'
  } else if (hovered) {
    hud.hover(hovered.userData.info, pointerPx.x, pointerPx.y)
  }
  const target = hovered ?? pinned
  // anything that already owns an outline highlights that outline; drawing a
  // second box around the same volume would just be the same box twice
  const outline: OutlineBox | null =
    target instanceof OutlineBox
      ? target
      : ((target?.userData.outline as OutlineBox | undefined) ?? null)
  if (glowing && glowing !== outline) {
    glowing.highlight(false)
    glowing = null
  }
  if (target && outline) {
    outline.highlight(true, target === pinned ? 0xffffff : 0x8fe6ff)
    glowing = outline
    hoverBox.visible = false
  } else if (target) {
    const box = new THREE.Box3().setFromObject(target)
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
  if (autoOrbit && !flyMode && !world.controls.autoRotate && performance.now() - lastInteraction > 6000) {
    world.controls.autoRotate = true
  }

  world.render(raw)
  telemetry.tick(dt, raw)
  hud.setStats(sim.stats)

  if (!booted) {
    booted = true
    window.setTimeout(() => hud.bootDone(), 260)
  }

  requestAnimationFrame(frame)
}

window.addEventListener('resize', () => {
  world.resize()
  setLineResolution(window.innerWidth, window.innerHeight)
})
requestAnimationFrame(frame)
