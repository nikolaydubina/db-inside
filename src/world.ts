import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import { neonEdges, rand } from './util'

export interface World {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  composer: EffectComposer
  controls: OrbitControls
  labelRenderer: CSS2DRenderer
  sun: THREE.DirectionalLight
  render(dt: number): void
  resize(): void
}

export function createWorld(canvas: HTMLCanvasElement, labelHost: HTMLElement): World {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.12
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setClearColor(0x04070d, 1)

  const scene = new THREE.Scene()
  scene.fog = new THREE.FogExp2(0x061420, 0.0108)

  const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 400)
  camera.position.set(29.2, 19, 34.5)

  const controls = new OrbitControls(camera, canvas)
  controls.target.set(3.4, 6.6, 1.0)
  controls.enableDamping = true
  controls.dampingFactor = 0.055
  controls.minDistance = 12
  controls.maxDistance = 78
  controls.minPolarAngle = 0.32
  controls.maxPolarAngle = 1.46
  controls.autoRotate = true
  controls.autoRotateSpeed = 0.34
  controls.zoomSpeed = 0.75
  controls.enablePan = false
  controls.update()

  const labelRenderer = new CSS2DRenderer({ element: labelHost })
  labelRenderer.setSize(window.innerWidth, window.innerHeight)

  /* ------------------------------- atmosphere ------------------------------ */

  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x02050c) },
      mid: { value: new THREE.Color(0x04101a) },
      horizon: { value: new THREE.Color(0x082031) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 top;
      uniform vec3 mid;
      uniform vec3 horizon;
      varying vec3 vPos;
      void main() {
        float h = clamp(normalize(vPos).y * 0.5 + 0.5, 0.0, 1.0);
        vec3 c = mix(horizon, mid, smoothstep(0.42, 0.62, h));
        c = mix(c, top, smoothstep(0.58, 1.0, h));
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  })
  const sky = new THREE.Mesh(new THREE.SphereGeometry(190, 32, 24), skyMat)
  scene.add(sky)

  // faint star dust
  const starCount = 900
  const starPos = new Float32Array(starCount * 3)
  for (let i = 0; i < starCount; i++) {
    const r = rand(80, 170)
    const theta = rand(0, Math.PI * 2)
    const phi = Math.acos(rand(-0.15, 1))
    starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    starPos[i * 3 + 1] = r * Math.cos(phi) * 0.6 + 6
    starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
  }
  const starGeo = new THREE.BufferGeometry()
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
  const stars = new THREE.Points(
    starGeo,
    new THREE.PointsMaterial({
      color: 0x8fc9e6,
      size: 0.55,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    }),
  )
  scene.add(stars)

  /* ---------------------------------- lights -------------------------------- */

  scene.add(new THREE.HemisphereLight(0x2a4667, 0x03070c, 1.0))

  const sun = new THREE.DirectionalLight(0xcfeaff, 1.85)
  sun.position.set(16, 30, 14)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.left = -24
  sun.shadow.camera.right = 24
  sun.shadow.camera.top = 24
  sun.shadow.camera.bottom = -24
  sun.shadow.camera.near = 2
  sun.shadow.camera.far = 90
  sun.shadow.bias = -0.0007
  sun.shadow.normalBias = 0.02
  scene.add(sun)

  const rim = new THREE.DirectionalLight(0x5a7bff, 0.3)
  rim.position.set(-20, 12, -22)
  scene.add(rim)

  const coreLight = new THREE.PointLight(0x35e0ff, 26, 32, 2)
  coreLight.position.set(0, 9, 0)
  scene.add(coreLight)

  /* ----------------------------------- island -------------------------------- */

  const island = new THREE.Group()

  const rock = new THREE.Mesh(
    new THREE.CylinderGeometry(18.2, 14.2, 3.6, 96, 1),
    new THREE.MeshStandardMaterial({ color: 0x060b13, roughness: 0.92, metalness: 0.12 }),
  )
  rock.position.y = -1.8
  rock.receiveShadow = true
  island.add(rock)

  const deck = new THREE.Mesh(
    new THREE.CylinderGeometry(18.05, 18.05, 0.35, 96),
    new THREE.MeshStandardMaterial({
      color: 0x05090f,
      emissive: 0x030a12,
      emissiveIntensity: 1,
      roughness: 0.92,
      metalness: 0.1,
    }),
  )
  deck.position.y = -0.18
  deck.receiveShadow = true
  island.add(deck)

  const rimRing = new THREE.Mesh(
    new THREE.TorusGeometry(18.05, 0.055, 8, 200),
    new THREE.MeshBasicMaterial({ color: 0x35e0ff, transparent: true, opacity: 0.62 }),
  )
  rimRing.rotation.x = Math.PI / 2
  rimRing.position.y = 0.02
  island.add(rimRing)

  const lowerRing = new THREE.Mesh(
    new THREE.TorusGeometry(14.4, 0.03, 6, 160),
    new THREE.MeshBasicMaterial({ color: 0xffb03a, transparent: true, opacity: 0.35 }),
  )
  lowerRing.rotation.x = Math.PI / 2
  lowerRing.position.y = -3.5
  island.add(lowerRing)

  // technical polar grid etched into the deck
  const polar = new THREE.PolarGridHelper(17.8, 12, 5, 96, 0x123c52, 0x0b2634)
  polar.position.y = 0.012
    ; (polar.material as THREE.Material).transparent = true
    ; (polar.material as THREE.Material).opacity = 0.6
    ; (polar.material as THREE.Material).depthWrite = false
  island.add(polar)

  // soft bounce glow beneath the island
  const levitation = new THREE.Mesh(
    new THREE.TorusGeometry(16.6, 0.16, 8, 128),
    new THREE.MeshBasicMaterial({
      color: 0x2aa8c8,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  levitation.rotation.x = Math.PI / 2
  levitation.position.y = -3.75
  island.add(levitation)

  scene.add(island)

  /* --------------------------------- sea + grid ------------------------------ */

  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 900),
    new THREE.MeshStandardMaterial({
      color: 0x02060c,
      roughness: 0.5,
      metalness: 0.4,
      emissive: 0x01060b,
      emissiveIntensity: 1,
    }),
  )
  sea.rotation.x = -Math.PI / 2
  sea.position.y = -5.9
  scene.add(sea)

  const grid = new THREE.GridHelper(600, 300, 0x0f3b4c, 0x081c26)
  grid.position.y = -5.84
  const gm = grid.material as THREE.Material
  gm.transparent = true
  gm.opacity = 0.34
  gm.depthWrite = false
  scene.add(grid)

  const grid2 = new THREE.GridHelper(600, 60, 0x17617c, 0x0b2836)
  grid2.position.y = -5.83
  const gm2 = grid2.material as THREE.Material
  gm2.transparent = true
  gm2.opacity = 0.34
  gm2.depthWrite = false
  scene.add(grid2)

  // horizon band to hide the grid edge
  const horizon = new THREE.Mesh(
    new THREE.RingGeometry(58, 260, 128, 1),
    new THREE.MeshBasicMaterial({
      color: 0x081c28,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  )
  horizon.rotation.x = -Math.PI / 2
  horizon.position.y = -5.8
  horizon.visible = false
  scene.add(horizon)

  /* ------------------------------- composition ------------------------------- */

  const renderPass = new RenderPass(scene, camera)
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.68,
    0.55,
    0.62,
  )
  const output = new OutputPass()
  const composer = new EffectComposer(renderer)
  composer.addPass(renderPass)
  composer.addPass(bloom)
  composer.addPass(output)

  function resize() {
    const w = window.innerWidth
    const h = window.innerHeight
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(w, h)
    composer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    composer.setSize(w, h)
    bloom.setSize(w, h)
    labelRenderer.setSize(w, h)
  }

  function render(dt: number) {
    stars.rotation.y += dt * 0.004
    const k = performance.now() * 0.001
      ; (rimRing.material as THREE.MeshBasicMaterial).opacity = 0.72 + 0.22 * Math.sin(k * 0.9)
    controls.update(dt)
    composer.render(dt)
    labelRenderer.render(scene, camera)
  }

  // decorative edge accent on the island deck
  const deckEdges = neonEdges(new THREE.CylinderGeometry(18.05, 18.05, 0.35, 12, 1), 0x2b6d88, 0.22)
  deckEdges.position.y = -0.18
  island.add(deckEdges)

  return { renderer, scene, camera, composer, controls, labelRenderer, sun, render, resize }
}
