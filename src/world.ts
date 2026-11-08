import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import { FLOOR_Y, rand, setLineResolution } from './core/util'

export interface World {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  composer: EffectComposer
  controls: OrbitControls
  labelRenderer: CSS2DRenderer
  sun: THREE.DirectionalLight
  /** `dt` drives camera damping; `animDt` is the speed-scaled simulation clock. */
  render(dt: number, animDt?: number): void
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
  // keep draw-call stats across post-processing passes instead of per pass
  renderer.info.autoReset = false

  const scene = new THREE.Scene()
  scene.fog = new THREE.FogExp2(0x061420, 0.0108)

  const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 2600)
  camera.position.set(29.2, 19, 34.5)

  const controls = new OrbitControls(camera, canvas)
  controls.target.set(3.4, 6.6, 1.0)
  controls.enableDamping = true
  controls.dampingFactor = 0.055
  // wide enough range that walkthrough views can get down to block level
  controls.minDistance = 1.2
  controls.maxDistance = 90
  controls.minPolarAngle = 0.06
  controls.maxPolarAngle = 1.52
  // The slow drift is not OrbitControls' autoRotate: it has to turn about the
  // SUBJECT (the middle of a cage), not about the aim point, which for a
  // cage-level shot is out in front of it. main.ts drives it — see drift() there.
  controls.autoRotate = false
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
      // exactly the fog colour: past a hundred units the sea is nothing but fog,
      // so if the sky right above the water is not that same colour the edge of
      // the sea shows up as a line across the view. Matching them, plus a round
      // sea below, is what makes the horizon read as haze rather than geometry.
      horizon: { value: new THREE.Color(0x061420) },
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
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1200, 32, 24), skyMat)
  scene.add(sky)

  // faint star dust
  const starCount = 1500
  const starPos = new Float32Array(starCount * 3)
  for (let i = 0; i < starCount; i++) {
    // On the dome, not floating inside it: a real sky is infinitely far away,
    // so the stars belong at the sky sphere's radius. The sea is 900 units wide,
    // which puts its corners 636 out: the dome has to be beyond that or the far
    // water ends up *behind* the stars and starlight is painted on top of it.
    const r = rand(1020, 1040)
    const theta = rand(0, Math.PI * 2)
    const phi = Math.acos(rand(-1, 1))
    starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    starPos[i * 3 + 1] = r * Math.cos(phi)
    starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
  }
  const starGeo = new THREE.BufferGeometry()
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
  // A custom shader for two reasons: `Points` renders square sprites by default,
  // and we want a hard horizon clip so no star is ever drawn below the sea —
  // culling by latitude instead leaves a tilted empty band as the field turns.
  const starMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0x8fc9e6) },
      uOpacity: { value: 0.5 },
      // the deck sits at y = 0 — clip there, not at the sea far below, so no
      // star can ever be drawn over the floor
      uHorizon: { value: 0 },
      // tracks the dome radius: points shrink as 1/distance, so moving the
      // field from 185 out to 1030 needs the sprite scaled up to match
      uSize: { value: 3.1 },
      uScale: { value: 500 },
    },
    vertexShader: /* glsl */ `
      uniform float uSize;
      uniform float uScale;
      varying float vWorldY;
      void main() {
        vWorldY = (modelMatrix * vec4(position, 1.0)).y;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uSize * (uScale / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uHorizon;
      varying float vWorldY;
      void main() {
        if (vWorldY < uHorizon) discard;
        float r = length(gl_PointCoord - 0.5);
        if (r > 0.5) discard;
        gl_FragColor = vec4(uColor, uOpacity * (1.0 - smoothstep(0.25, 0.5, r)));
      }
    `,
    transparent: true,
    depthWrite: false,
    fog: false,
    blending: THREE.AdditiveBlending,
  })
  const stars = new THREE.Points(starGeo, starMat)

  // The stars turn about a tilted pole, the way the real sky does: the parent
  // holds the tilt, the points themselves spin about their own Y, which is now
  // 23.4 degrees off vertical. They are centred on the origin so that spin has
  // no wobble in it.
  const celestial = new THREE.Group()
  celestial.position.y = 6
  celestial.rotation.z = THREE.MathUtils.degToRad(23.4)
  celestial.add(stars)
  scene.add(celestial)

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

  /* ----------------------------------- floor --------------------------------- */
  // There is no island. The instance is not parked on a round slab: the only
  // surface in the scene is the global grid below, the same one that runs out
  // to the horizon. Nothing is propped up on a pedestal, so nothing has to be
  // levitated either.

  /* --------------------------------- sea + grid ------------------------------ */

  const sea = new THREE.Mesh(
    // A disc, not a quad: a 900-unit square puts its corners on screen as little
    // angles in the horizon. Everything past ~120 units is pure fog anyway, so
    // all that matters is that the edge has no corners to catch the eye.
    new THREE.CircleGeometry(700, 128),
    new THREE.MeshStandardMaterial({
      color: 0x0b1a28,
      roughness: 0.5,
      metalness: 0.4,
      emissive: 0x04101c,
      emissiveIntensity: 1,
    }),
  )
  sea.rotation.x = -Math.PI / 2
  sea.position.y = -5.9
  scene.add(sea)

  const grid = new THREE.GridHelper(600, 300, 0x2a7f9e, 0x123a4a)
  // The grid IS the floor: y = 0, the same plane the cages stand on and the same
  // one the disk lattices are drawn in, so alignment is checkable, not implied.
  grid.position.y = FLOOR_Y
  const gm = grid.material as THREE.Material
  gm.transparent = true
  gm.opacity = 0.42
  gm.depthWrite = false
  scene.add(grid)

  const grid2 = new THREE.GridHelper(600, 60, 0x3aa2c4, 0x19546a)
  grid2.position.y = FLOOR_Y + 0.01
  const gm2 = grid2.material as THREE.Material
  gm2.transparent = true
  gm2.opacity = 0.40
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
  // `antialias: true` on the renderer only affects the default framebuffer, and
  // the composer never draws to it — every frame goes through a render target.
  // Without `samples` that target has no MSAA at all, which is why every edge
  // and every thin line stair-steps. Ask for it explicitly.
  const composerTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    // 2 samples is the sweet spot here: the device pixel ratio is already 2 on
    // a retina screen, and 4 samples costs ~45% of the frame rate for a
    // difference you cannot see.
    samples: 2,
  })
  const composer = new EffectComposer(renderer, composerTarget)
  composer.addPass(renderPass)
  composer.addPass(bloom)
  composer.addPass(output)

  // desktop looks slightly right of centre to clear the HUD; portrait centres the box
  const CAM_OFFSET = new THREE.Vector3(25.8, 12.4, 33.5)
  let lastPortrait: boolean | null = null
  function frameView(portrait: boolean) {
    const tx = portrait ? 0.2 : 3.4
    const ty = portrait ? 4.9 : 6.6
    controls.target.set(tx, ty, 1.0)
    camera.position.set(tx + CAM_OFFSET.x, ty + CAM_OFFSET.y, 1.0 + CAM_OFFSET.z)
    controls.update()
  }

  function resize() {
    const w = window.innerWidth
    const h = window.innerHeight
    const aspect = w / h

    // keep the horizontal framing on portrait screens: widen the vertical fov
    const baseFov = 40
    camera.aspect = aspect
    camera.fov =
      aspect < 1
        ? Math.min(86, (2 * Math.atan(Math.tan((baseFov * Math.PI) / 360) / aspect) * 180) / Math.PI)
        : baseFov
    camera.updateProjectionMatrix()

    // only re-frame when the layout flips between portrait and landscape,
    // so a browser chrome resize does not reset the user's orbit
    const portrait = aspect < 1
    if (lastPortrait !== portrait) {
      lastPortrait = portrait
      frameView(portrait)
    }

    const dpr = Math.min(window.devicePixelRatio, w < 760 ? 1.5 : 2)
    renderer.setPixelRatio(dpr)
    renderer.setSize(w, h)
    // fat lines measure their width against the drawing buffer, not the CSS size
    setLineResolution(w, h, dpr)
    composer.setPixelRatio(dpr)
    composer.setSize(w, h)
    bloom.setSize(w, h)
    labelRenderer.setSize(w, h)
    // matches three's own point-size attenuation: half the drawing buffer
    starMat.uniforms.uScale.value = (h * dpr) / 2
  }

  function render(dt: number, animDt = dt) {
    renderer.info.reset()
    // The sky turns on the simulation clock, but not linearly: at 1x it should
    // read as a still sky (0.002 rad/s is a 52-minute revolution), while at 4x
    // the extra exponent takes it to ~5.7 minutes, which is finally fast enough
    // to look like the sky is moving. `dt` is wall-clock, `animDt` is the
    // simulation clock, so their ratio is the speed slider.
    const speed = dt > 1e-4 ? animDt / dt : 1
    stars.rotation.y += animDt * 0.002 * Math.pow(speed, 0.6)
    controls.update(dt)
    composer.render(dt)
    labelRenderer.render(scene, camera)
  }

  resize()

  return { renderer, scene, camera, composer, controls, labelRenderer, sun, render, resize }
}
