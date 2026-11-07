import './style.css'
import * as THREE from 'three'
import { createWorld } from './world'
import { ANCHOR, PostgresInstance } from './instance'
import { makeFlows, makePaths } from './flow'
import { EngineSim } from './sim'
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
  setIndexScan: (on) => sim.setIndexScan(on),
  setOrbit: (on) => {
    autoOrbit = on
    world.controls.autoRotate = on
  },
})

let autoOrbit = true
let lastInteraction = performance.now()
world.controls.addEventListener('start', () => {
  lastInteraction = performance.now()
})

/* ------------------------------- hover picking ----------------------------- */

const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2(-2, -2)
let pointerPx = { x: 0, y: 0 }
let hovered: THREE.Object3D | null = null
let pinned: THREE.Object3D | null = null

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
    pinned = root
    hud.inspect(root.userData.info)
  } else {
    pinned = null
    hud.unpin()
  }
})

/* --------------------------------- ambient -------------------------------- */

instance.markDeadTuples(7)

let trafficTimer = 2.4
let booted = false
let lastTime = performance.now()

function frame() {
  const now = performance.now()
  const dt = Math.min((now - lastTime) / 1000, 0.05)
  lastTime = now

  ticker.update(dt)
  sim.update(dt)

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
    canvas.style.cursor = info ? 'pointer' : 'grab'
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

  world.render(dt)
  hud.setStats(sim.stats)

  if (!booted) {
    booted = true
    window.setTimeout(() => hud.bootDone(), 260)
  }

  requestAnimationFrame(frame)
}

window.addEventListener('resize', () => world.resize())
requestAnimationFrame(frame)
