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

    renderer.info.autoReset = false

    const scene = new THREE.Scene()

    scene.fog = new THREE.FogExp2(0x061420, 0.016)

    const camera = new THREE.PerspectiveCamera(
        40,
        window.innerWidth / window.innerHeight,
        0.1,
        2600,
    )
    camera.position.set(29.2, 19, 34.5)

    const controls = new OrbitControls(camera, canvas)
    controls.target.set(3.4, 6.6, 1.0)
    controls.enableDamping = true
    controls.dampingFactor = 0.055

    controls.minDistance = 0.05
    controls.maxDistance = 90
    controls.minPolarAngle = 0.06
    controls.maxPolarAngle = 1.52

    controls.autoRotate = false
    controls.zoomSpeed = 0.75
    controls.enablePan = false
    controls.update()

    const labelRenderer = new CSS2DRenderer({ element: labelHost })
    labelRenderer.setSize(window.innerWidth, window.innerHeight)

    const skyMat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
            top: { value: new THREE.Color(0x02050c) },
            mid: { value: new THREE.Color(0x04101a) },

            horizon: { value: new THREE.Color(0x061420) },
        },
        vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
        fragmentShader: `
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

    const starCount = 1500
    const starPos = new Float32Array(starCount * 3)
    for (let i = 0; i < starCount; i++) {
        const r = rand(1020, 1040)
        const theta = rand(0, Math.PI * 2)
        const phi = Math.acos(rand(-1, 1))
        starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
        starPos[i * 3 + 1] = r * Math.cos(phi)
        starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
    }
    const starGeo = new THREE.BufferGeometry()
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))

    const starMat = new THREE.ShaderMaterial({
        uniforms: {
            uColor: { value: new THREE.Color(0x8fc9e6) },
            uOpacity: { value: 0.5 },

            uHorizon: { value: 0 },

            uSize: { value: 3.1 },
            uScale: { value: 500 },
        },
        vertexShader: `
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
        fragmentShader: `
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

    const celestial = new THREE.Group()
    celestial.position.y = 6
    celestial.rotation.z = THREE.MathUtils.degToRad(23.4)
    celestial.add(stars)
    scene.add(celestial)

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

    const sea = new THREE.Mesh(
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
    gm2.opacity = 0.4
    gm2.depthWrite = false
    scene.add(grid2)

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

    const renderPass = new RenderPass(scene, camera)
    const bloom = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        0.68,
        0.55,
        0.62,
    )
    const output = new OutputPass()

    const composerTarget = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,

        samples: 2,
    })
    const composer = new EffectComposer(renderer, composerTarget)
    composer.addPass(renderPass)
    composer.addPass(bloom)
    composer.addPass(output)

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

        const baseFov = 40
        camera.aspect = aspect
        camera.fov =
            aspect < 1
                ? Math.min(
                      86,
                      (2 * Math.atan(Math.tan((baseFov * Math.PI) / 360) / aspect) * 180) / Math.PI,
                  )
                : baseFov
        camera.updateProjectionMatrix()

        const portrait = aspect < 1
        if (lastPortrait !== portrait) {
            lastPortrait = portrait
            frameView(portrait)
        }

        const dpr = Math.min(window.devicePixelRatio, w < 760 ? 1.5 : 2)
        renderer.setPixelRatio(dpr)
        renderer.setSize(w, h)

        setLineResolution(w, h, dpr)
        composer.setPixelRatio(dpr)
        composer.setSize(w, h)
        bloom.setSize(w, h)
        labelRenderer.setSize(w, h)

        starMat.uniforms.uScale.value = (h * dpr) / 2
    }

    function render(dt: number, animDt = dt) {
        renderer.info.reset()

        const speed = dt > 1e-4 ? animDt / dt : 1
        stars.rotation.y += animDt * 0.002 * Math.pow(speed, 0.6)
        controls.update(dt)
        composer.render(dt)
        labelRenderer.render(scene, camera)
    }

    resize()

    return { renderer, scene, camera, composer, controls, labelRenderer, sun, render, resize }
}
