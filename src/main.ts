import './style.css'
import * as THREE from 'three'
import { createWorld } from './world'
import { ANCHOR, PostgresInstance } from './instance'
import { makeFlows, makePaths } from './flow'
import { EngineSim } from './sim'
import { installTelemetry } from './debug'
import { initHud } from './ui'
import { Ticker, label, rand } from './util'

const canvas = document.querySelector<HTMLCanvasElement>('#c')!
const labelHost = document.querySelector<HTMLElement>('#labels')!

const world = createWorld(canvas, labelHost)
const { scene, camera } = world

const ticker = new Ticker()
const instance = new PostgresInstance(ticker)
scene.add(instance.group)

// extra labels
const bufferLabel = label('SHARED BUFFERS · RAM')
bufferLabel.position.set(ANCHOR.bufferCenter.x - 4.6, 4.95, ANCHOR.bufferCenter.z + 3.2)
instance.group.add(bufferLabel)

const paths = makePaths()
const flows = makeFlows(scene, paths)

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
;(window as unknown as Record<string, unknown>).__psqlDebug = telemetry.api
if (new URLSearchParams(location.search).has('debug')) telemetry.api.on(2)
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

/* ------------------------------- hover picking ----------------------------- */

const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2(-2, -2)
let pointerPx = { x: 0, y: 0 }
let hovered: THREE.Object3D | null = null

const hoverBox = new THREE.Box3Helper(new THREE.Box3(), 0x35e0ff)
hoverBox.visible = false
const hbMat = hoverBox.material as THREE.LineBasicMaterial
hbMat.transparent = true
hbMat.opacity = 0.5
hbMat.depthWrite = false
scene.add(hoverBox)

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

window.addEventListener('keydown', (e) => {
  if (!flyMode || isTyping(e.target)) return
  flyKeys.add(e.code)
  if (e.code.startsWith('Key') || e.code === 'ShiftLeft') e.preventDefault()
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
  if (target) {
    const box = new THREE.Box3().setFromObject(target)
    box.expandByScalar(0.08)
    hoverBox.box.copy(box)
    hoverBox.visible = true
    hbMat.color.setHex(target === pinned ? 0xffffff : 0x35e0ff)
  } else {
    hoverBox.visible = false
  }

  // resume the slow orbit after the user stops interacting
  if (autoOrbit && !world.controls.autoRotate && performance.now() - lastInteraction > 6000) {
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

window.addEventListener('resize', () => world.resize())
requestAnimationFrame(frame)
