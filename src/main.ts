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
import { makeFlows, makePaths } from './postgresql/flow'
import { EngineSim } from './postgresql/sim'
import { PostgresqlRegime } from './postgresql/sim'
import { installTelemetry } from './debug'
import { createCameraRig, defaultView, slugOf, viewBySlug, viewForBox, viewsFor } from './views'
import type { ViewDef } from './views'
import { createStory, PLANNED_STORIES, STORIES } from './stories'
import type { StoryScene } from './stories'
import { installTestSurface } from './test-surface'
import { addressFromPath, decodePose, encodePose, pathFor } from './share'
import { Db, DB_LABEL, DB_NAME, DbScope, inScope } from './core/db'
import { initHud } from './ui'
import { Ticker, label, rand, OutlineBox, updateLabelLOD, fmtBytes } from './core/util'

const canvas = document.querySelector<HTMLCanvasElement>('#c')!
const labelHost = document.querySelector<HTMLElement>('#labels')!

const world = createWorld(canvas, labelHost)
const { scene, camera } = world

const ticker = new Ticker()
const instance = new PostgresInstance(ticker)
scene.add(instance.group)

const bufferLabel = label('SHARED BUFFERS')

bufferLabel.position.copy(instance.bufferCorners.farLeft).add(new THREE.Vector3(-0.02, 0.34, -0.06))
instance.group.add(bufferLabel)

const paths = makePaths(instance)

const flows = makeFlows(instance.group, paths)

const sim = new EngineSim(instance, ticker, scene, paths, flows)

const redis = new RedisInstance(ticker)
scene.add(redis.group)
const redisSim = new RedisSim(redis, ticker)

function shown(o: THREE.Object3D): boolean {
    for (let n: THREE.Object3D | null = o; n; n = n.parent) if (!n.visible) return false
    return true
}

const allPicks = () => [...instance.pickables, ...redis.pickables]

function cast(rc: THREE.Raycaster): THREE.Intersection[] {
    return rc.intersectObjects(allPicks(), true).filter((h) => shown(h.object))
}

const axes = createAxes(scene)
const markPostgres = axes.mark(DB_NAME[Db.Postgres], new THREE.Vector3(0, 0, 0))
const markRedis = axes.mark(DB_NAME[Db.Redis], new THREE.Vector3(-36, 0, 0))

;(window as unknown as Record<string, unknown>).__psql = {
    scene,
    world,
    instance,
    sim,
    paths,
    flows,
}
;(window as unknown as Record<string, unknown>).__redis = {
    redis,
    redisSim,

    check: () => redis.verify(),
}
;(window as unknown as Record<string, unknown>).__axes = axes
if (new URLSearchParams(location.search).has('axes')) axes.on()
console.info(
    '%caxes%c __axes.on() · .off() · .toggle() — or open the page with ?axes',
    'color:#ff6b6b',
    'color:inherit',
)

const LAYOUT_KEY = 'db-inside.layout.v1'

const MOVE_STEP = 2
const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

const CAGE = { halfX: 13, halfZ: 8 }
type CageName = Db

const CAGE_HOME = {
    postgres: [0, 0] as [number, number],
    redis: [0, -26] as [number, number],
}

const cageGroup = (c: CageName) => (c === Db.Postgres ? instance.group : redis.group)
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

    axis: 'x' | 'z' | null
}
let drag: DragState | null = null

type AnchorOut = { x: number; y: number; z: number }
type AnchorIn = { x: number; z: number } | [number, number]
const pairOf = (a: AnchorIn): [number, number] => (Array.isArray(a) ? [a[0], a[1]] : [a.x, a.z])
const anchorOut = (c: CageName): AnchorOut => {
    const [x, z] = anchorOf(c)
    return { x, y: 0, z }
}

const layoutNow = () => ({ postgres: anchorOut(Db.Postgres), redis: anchorOut(Db.Redis) })

function updateMoveHint() {
    const p = anchorOf(Db.Postgres)
    const r = anchorOf(Db.Redis)
    console.info(
        `%clayout%c postgres anchor (${p[0]}, ${p[1]}) · redis anchor (${r[0]}, ${r[1]})`,
        'color:#ff6b6b',
        'color:inherit',
    )
}

function moveCageTo(c: CageName, anchor: [number, number]) {
    const pos = new THREE.Vector3(anchor[0] - CAGE.halfX, 0, anchor[1] - CAGE.halfZ)
    const at = new THREE.Vector3(anchor[0], 0, anchor[1])
    if (c === Db.Postgres) {
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
    } catch {}
}

function applyLayout(l: { postgres?: AnchorIn; redis?: AnchorIn }) {
    if (l.postgres) moveCageTo(Db.Postgres, pairOf(l.postgres))
    if (l.redis) moveCageTo(Db.Redis, pairOf(l.redis))
}

applyLayout(CAGE_HOME)
try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (raw) applyLayout(JSON.parse(raw) as { postgres?: AnchorIn; redis?: AnchorIn })
} catch {}
;(window as unknown as Record<string, unknown>).__layout = {
    get: layoutNow,
    set: (l: { postgres?: AnchorIn; redis?: AnchorIn }) => {
        applyLayout(l)
        saveLayout()
    },
    reset: () => {
        applyLayout(CAGE_HOME)
        try {
            localStorage.removeItem(LAYOUT_KEY)
        } catch {}
    },
    export: () => JSON.stringify(layoutNow()),
    step: MOVE_STEP,
}
;(window as unknown as Record<string, unknown>).__move = {
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

function leaveMove() {
    if (moveMode) setMove(false)
}

let zenMode = false

function setZen(on: boolean) {
    zenMode = on
    document.body.classList.toggle('zen', on)
    hud.setZen(on)
}

function wake() {
    if (zenMode) setZen(false)
}

window.addEventListener('pointerdown', wake, { capture: true })
window.addEventListener('keydown', wake, { capture: true })
window.addEventListener('wheel', wake, { passive: true })

const dragPlanePoint = new THREE.Vector3()
let lastCage: CageName | null = null
let hoverCage: CageName | null = null

function ownerCage(o: THREE.Object3D): CageName | null {
    let cur: THREE.Object3D | null = o
    while (cur) {
        if (cur === instance.group) return Db.Postgres
        if (cur === redis.group) return Db.Redis
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

function cageUnder(p: THREE.Vector3): CageName | null {
    const covers = (c: CageName) => {
        const box = new THREE.Box3().setFromObject(cageGroup(c))
        return (
            p.x >= box.min.x - 1 &&
            p.x <= box.max.x + 1 &&
            p.z >= box.min.z - 1 &&
            p.z <= box.max.z + 1
        )
    }
    if (covers(Db.Redis)) return Db.Redis
    if (covers(Db.Postgres)) return Db.Postgres
    return null
}

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

const NUDGE: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
}
window.addEventListener('keydown', (e) => {
    if (!moveMode || !NUDGE[e.key]) return
    if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))
        return
    const hit = pick(pointer)
    const ground = groundAt(pointer)
    const cage =
        (hit ? ownerCage(hit.root) : null) ??
        hoverCage ??
        lastCage ??
        (ground ? cageUnder(ground) : null)
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
interface PickInfo {
    root: THREE.Object3D
    key: string
    info: { title: string; body: string; meta?: string }
    box?: THREE.Box3
}
let pinned: PickInfo | null = null

const telemetry = installTelemetry({
    sim,
    inst: instance,
    renderer: world.renderer,
    speed: () => speed,
})
;(window as unknown as Record<string, unknown>).__psqlDebug = telemetry.api
if (new URLSearchParams(location.search).has('debug')) telemetry.api.on(2)
const startView = new URLSearchParams(location.search).get('view')
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

let userTookCamera = false

const ORBIT_COOLDOWN = 5000

const ORBIT_RATE = ((2 * Math.PI) / 60) * 0.34
let driftOn = true
let storyActive = false

let cameraMoves = 0
function noteCameraMove() {
    cameraMoves++
    lastInteraction = performance.now()
    driftOn = false
}

function drift(dt: number) {
    rig.turn(-ORBIT_RATE * dt)
}

;(window as unknown as Record<string, unknown>).__orbit = {
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

;(window as unknown as Record<string, unknown>).__clock = {
    stop: () => applySpeed(0),
    resume: () => applySpeed(1),
    set: (v: number) => applySpeed(v),
    get speed() {
        return speed
    },
}
;(window as unknown as Record<string, unknown>).__ride = () => {
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
    rig.release()
})

canvas.addEventListener(
    'pointerdown',
    () => {
        userTookCamera = true
    },
    { capture: true },
)
canvas.addEventListener('wheel', () => (userTookCamera = true), { passive: true })

const rig = createCameraRig({
    camera,
    controls: world.controls,
    ticker,
    beforeNavigate: () => {
        driftOn = false
    },
})
;(window as unknown as Record<string, unknown>).__psqlViews = rig

function dbInFrame(): Db {
    if (hud.db) return hud.db
    const aim = world.controls.target
    const centreOf = (g: THREE.Object3D) =>
        new THREE.Box3().setFromObject(g).getCenter(new THREE.Vector3())
    return aim.distanceTo(centreOf(instance.group)) <= aim.distanceTo(centreOf(redis.group))
        ? Db.Postgres
        : Db.Redis
}

function cageOrigin(db: Db): THREE.Vector3 {
    return (db === Db.Postgres ? instance.group : redis.group).position.clone()
}

function setAddress(db: Db, view: ViewDef | null) {
    const q = new URLSearchParams(location.search)
    q.delete('cam')
    q.delete('view')
    const path = pathFor(db, view ? slugOf(view) : '')
    const rest = q.toString()
    history.replaceState(null, '', rest ? `${path}?${rest}` : path)
}

function panelFromQuery(): Db | null {
    const v = new URLSearchParams(location.search).get('db-panel')
    if (v === 'redis') return Db.Redis
    if (v === 'postgresql' || v === 'postgres') return Db.Postgres
    return null
}

function setPanelParam(open: Db | null) {
    const q = new URLSearchParams(location.search)
    if (open) q.set('db-panel', open === Db.Postgres ? 'postgresql' : 'redis')
    else q.delete('db-panel')
    const rest = q.toString()
    history.replaceState(null, '', rest ? `${location.pathname}?${rest}` : location.pathname)
}

;(window as unknown as Record<string, unknown>).__psqlCam = () => {
    const db = dbInFrame()
    const origin = cageOrigin(db)
    return encodePose(
        camera.position.clone().sub(origin),
        world.controls.target.clone().sub(origin),
        camera.fov,
    )
}

function pinShotSubject(db: Db, view: ViewDef) {
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

let speedBeforeStory = 1
let regimeBeforeStory: PostgresqlRegime = PostgresqlRegime.Default

const speedInput = document.querySelector<HTMLInputElement>('#speed')

function applySpeed(v: number) {
    speed = v
    if (speedInput) speedInput.value = String(v)
    hud.showSpeed(v)
}

const storyScene: StoryScene = {
    overview: () => new THREE.Box3().setFromObject(instance.group),
    ports: () => {
        const box = new THREE.Box3()
        for (const b of instance.backends) if (b.active) box.expandByObject(b.group)
        return box
    },
    executing: () => {
        const open = instance.backends.filter((b) => b.active && b.busy)
        if (open.length === 0) return null
        let best = open[0]
        for (const b of open) if (b.inbuf > best.inbuf) best = b
        const box = new THREE.Box3(
            best.group.position.clone().add(new THREE.Vector3(-0.8, -2.35, -0.8)),
            best.group.position.clone().add(new THREE.Vector3(0.8, 0.75, 0.8)),
        ).translate(POSTGRES_ORIGIN)
        return { id: `backend ${best.id + 1}`, box }
    },
    valid: (id: string) => {
        if (id.startsWith('ride ')) return redisSim.packetSubject()?.id === id
        const m = /^backend (\d+)$/.exec(id)
        if (!m) return true
        const pod = instance.backends[Number(m[1]) - 1]
        return !!pod && pod.active && pod.busy
    },
    walRun: () => instance.walRunBox(),
    walBuffers: () => instance.walBuffersBox(),
    walHead: () => ({ id: `wal head`, box: instance.walHeadBox() }),
    redisRide: () => {
        const p = redisSim.packetSubject()
        if (!p) return null
        const at = p.object.getWorldPosition(new THREE.Vector3())
        const box = new THREE.Box3(at.clone().addScalar(-0.5), at.clone().addScalar(0.5))
        return { id: p.id, box, object: p.object }
    },
    indexRide: () => sim.indexSubject(),
}

const story = createStory({
    rig,
    sim,
    scene: storyScene,
    redis: redisSim,
    index: {
        run: (kind, opts) => void sim.runIndexQuery(kind, opts),
        state: () => sim.indexState,
    },
    stories: STORIES,
    setSpeed: applySpeed,
    onEnter: () => {
        speedBeforeStory = speed
        regimeBeforeStory = sim.regime
        world.controls.autoRotate = false
        sim.ambient = false
        redisSim.ambient = false
        hud.setRegime(PostgresqlRegime.Default)
        instance.closeIdleBackendsTo(1)
        redisSim.suspendPubSub()
        hud.closePanels()
        storyActive = true
        driftOn = false
    },
    onExit: () => {
        sim.cancelIndexRide()
        sim.ambient = true
        redisSim.ambient = true
        redisSim.resumePubSub()
        storyActive = false
        applySpeed(speedBeforeStory)
        hud.setRegime(regimeBeforeStory)
        noteCameraMove()
    },
})
;(window as unknown as Record<string, unknown>).__psqlStory = story
installTestSurface({ story, redisSim, indexRide: { state: () => sim.indexState } })

const storiesEl = document.getElementById('stories')
if (storiesEl) {
    const groups: { db: Db; label: string }[] = [
        { db: Db.Postgres, label: DB_LABEL[Db.Postgres] },
        { db: Db.Redis, label: DB_LABEL[Db.Redis] },
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
        for (const s of STORIES.filter((x) => inScope(x.db ?? DbScope.Postgres, g.db))) addStory(s)
        for (const p of PLANNED_STORIES.filter((x) => inScope(x.db ?? DbScope.Postgres, g.db))) {
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

const viewHosts = [
    { el: document.getElementById('views'), db: Db.Postgres },
    { el: document.getElementById('views-redis'), db: Db.Redis },
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
            setAddress(host.db, v)
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
        const db = hud.db ?? Db.Postgres
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

const raycaster = new THREE.Raycaster()
raycaster.params.Line = { threshold: 0.1 }
const pointer = new THREE.Vector2(-2, -2)
let pointerPx = { x: 0, y: 0 }
let hovered: PickInfo | null = null

const hoverBox = new OutlineBox(1, 1, 1, 0x35e0ff, 0.6)
hoverBox.visible = false
scene.add(hoverBox)

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

function infoForRoot(o: THREE.Object3D | null) {
    let cur: THREE.Object3D | null = o
    while (cur) {
        const f = cur.userData.infoFor as
            ((hit: THREE.Intersection) => BlockPick | null) | undefined
        if (f) return f
        cur = cur.parent
    }
    return null
}

function pick(ndc: THREE.Vector2): PickInfo | null {
    raycaster.setFromCamera(ndc, camera)
    const hits = cast(raycaster)
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

;(window as unknown as Record<string, unknown>).__pickAt = (x: number, y: number) => {
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

const crosshair = document.querySelector<HTMLElement>('#crosshair')!
let looking = false

const isTyping = (t: EventTarget | null) =>
    t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')

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
    lookSph.theta -= e.movementX * sens
    lookSph.phi = THREE.MathUtils.clamp(lookSph.phi + e.movementY * sens, 0.12, Math.PI - 0.12)
    lookOffset.setFromSpherical(lookSph)
    world.controls.target.copy(camera.position).add(lookOffset)
    lastInteraction = performance.now()
})

const FLY_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'])
const flyHint = document.getElementById('fly-hint')

function setFly(on: boolean) {
    flyMode = on
    flyKeys.clear()
    flyVel.set(0, 0, 0)
    if (!on) looking = false
    if (on) {
        userTookCamera = true
        rig.release()
        leaveMove()
    }
    world.controls.enableRotate = !on
    crosshair.hidden = true
    canvas.style.cursor = on ? 'crosshair' : 'grab'
    if (flyHint) flyHint.hidden = !on
    driftOn = !on && performance.now() - lastInteraction > ORBIT_COOLDOWN
}

canvas.addEventListener('dblclick', (e) => {
    if (moveMode) return
    const ndc = new THREE.Vector2(
        (e.clientX / window.innerWidth) * 2 - 1,
        -(e.clientY / window.innerHeight) * 2 + 1,
    )
    const root = pick(ndc)
    if (root) {
        pinned = root
        hud.inspect(root.info)
    } else {
        pinned = null
        hud.unpin()
    }
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
        rig.go('overview')
        markView('overview')
    }
    noteCameraMove()
})

window.addEventListener('keydown', (e) => {
    if (isTyping(e.target)) return
    if (e.code === 'Escape') {
        if (flyMode) setFly(false)
        if (moveMode) setMove(false)
        return
    }
    if (!flyMode && FLY_CODES.has(e.code)) {
        userTookCamera = true
        setFly(true)
    }
    if (!flyMode || !FLY_CODES.has(e.code)) return
    flyKeys.add(e.code)
    e.preventDefault()
})

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

instance.markDeadTuples(7)

let trafficTimer = 2.4
let booted = false
let lastTime = performance.now()

function frame() {
    const now = performance.now()
    const raw = Math.min((now - lastTime) / 1000, 0.05)
    lastTime = now
    const dt = raw * speed

    ticker.update(dt)
    sim.update(dt)
    redisSim.ambient = sim.ambient
    redisSim.update(dt)
    redis.update(dt, now * 0.001)
    updateFly(raw)
    rig.follow(raw)
    if (storyActive && !redisSim.rideState().hasPacket && !sim.indexSubject()) rig.hold(null)

    if (sim.ambient) {
        trafficTimer -= dt
        if (trafficTimer <= 0) {
            trafficTimer = rand(3.6, 7.2) * sim.arrivalGap
            void sim.runQuery()
        }
    }

    const root = pick(pointer)
    hoverCage = root ? ownerCage(root.root) : null
    if (hoverCage) lastCage = hoverCage
    if ((root?.key ?? null) !== (hovered?.key ?? null)) {
        hovered = root
        hud.hover(root?.info ?? null, pointerPx.x, pointerPx.y)
        if (!flyMode) canvas.style.cursor = root ? 'pointer' : 'grab'
    } else if (hovered) {
        hud.hover(hovered.info, pointerPx.x, pointerPx.y)
    }
    const target = hovered ?? pinned
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
        hoverBox.visible = false
    } else if (target) {
        const box = target.box ? target.box.clone() : new THREE.Box3().setFromObject(target.root)
        box.expandByScalar(0.08)
        const size = box.getSize(_boxSize)
        const centre = box.getCenter(_boxCentre)
        hoverBox.position.copy(centre)
        hoverBox.scale.set(Math.max(size.x, 0.05), Math.max(size.y, 0.05), Math.max(size.z, 0.05))
        hoverBox.setColor(target === pinned ? 0xffffff : 0x35e0ff)
        hoverBox.visible = true
    } else {
        hoverBox.visible = false
    }

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
    updateLabelLOD(camera)
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

const bootPanel = panelFromQuery()
if (bootPanel) hud.setDb(bootPanel)

if (bootAddress) {
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
        const view = viewBySlug(bootAddress.db, bootAddress.slug) ?? defaultView(bootAddress.db)
        rig.snap(view.id)
        markView(view.id)
        setAddress(bootAddress.db, view)
        if (bootAddress.slug) pinShotSubject(bootAddress.db, view)
    }
}

window.setTimeout(() => {
    void redisSim.boot()
}, 300)

requestAnimationFrame(frame)
