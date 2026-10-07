import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import type { MotionValue } from 'motion/react'

/*
 * "Flow Wave": a sea of additive particle hills under two octaves of simplex
 * noise. Scrolling the hero dives the camera from a high view to skim the
 * field while the swell grows; the cursor parallaxes the view and parts the
 * surface. Ported from the scene spec with its values baked in.
 *
 * The spec's torus and bloom composers render layers 1 and 2, which nothing
 * in the scene sits on (both point clouds only add layer 3), so they always
 * produce black. They are left out and the final pass gets a black texture
 * in their slots: same image, two bloom chains cheaper per frame.
 */

const LAYERS = { NONE: 0, TORUS_SCENE: 1, BLOOM_SCENE: 2, ENTIRE_SCENE: 3 }

const bgColor = '#000000'
const flameColor = '#ffffff'
const flameColor2 = '#5e30eb'
const flameAmt = 0.2
const atmoColor = '#606060'
const atmoCount = 300
const atmoSize = 24
const atmoSpeed = 1.0
const colorLow = '#ffffff'
const colorHigh = '#ffffff'
const opacity = 0.26
const pointSize = 5.5
const brightness = 0.45
const waveHeight = 3
const flow = 1
const tilt = 0
const scale = 0.275
const scrollRise = 1.0
const camStartY = 7, camStartZ = 16
const camEndY = 0.8, camEndZ = -2
const lookStartZ = 2, lookEndZ = -16
const parallax = 1.2
const pointerRadius = 7.0
const pointerStrength = 0.9

const Lerp = (a: number, b: number, t: number) => a + (b - a) * t
function hexToVec3(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

const SNOISE = `
vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0); const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy)); vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz); vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy); vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + 1.0 * C.xxx; vec3 x2 = x0 - i2 + 2.0 * C.xxx; vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0/7.0; vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z *ns.z);
  vec4 x_ = floor(j * ns.z); vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ *ns.x + ns.yyyy; vec4 y = y_ *ns.x + ns.yyyy; vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy); vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0; vec4 s1 = floor(b1)*2.0 + 1.0; vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy; vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy,h.x); vec3 p1 = vec3(a0.zw,h.y); vec3 p2 = vec3(a1.xy,h.z); vec3 p3 = vec3(a1.zw,h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0); m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`

const pointsVertex = `
uniform float uTime; uniform float uStream; uniform float uSize; uniform float uWaveHeight; uniform float uFlow; uniform float uScale;
uniform vec3 uColLow; uniform vec3 uColHigh;
uniform vec3 uCursor; uniform float uRepelRadius; uniform float uRepelStrength; uniform float uActivity;
varying float vFade; varying vec3 vColor;
${SNOISE}
void main() {
  vec3 wp = vec3(position.x * 13.0, 0.0, position.z * 25.0);
  wp.x += position.y * 6.0;
  float zc = wp.z + uStream;
  float wn = snoise(vec3(wp.x * 0.08, zc * 0.08, uTime * 0.15 * uFlow)) * 2.0;
  wn += snoise(vec3(wp.x * 0.16, zc * 0.16, uTime * 0.3 * uFlow)) * 0.8;
  wp.y += wn * uWaveHeight;

  vec3 finalPos = wp * uScale;
  vec4 modelPosition = modelMatrix * vec4(finalPos, 1.0);
  vec3 toP = modelPosition.xyz - uCursor;
  float cd = length(toP);
  float fall = smoothstep(uRepelRadius, 0.0, cd);
  modelPosition.xyz += normalize(toP + vec3(0.0001)) * fall * uRepelStrength * uActivity;
  vec4 mvPosition = viewMatrix * modelPosition;

  float colMix = smoothstep(-3.0, 3.0, position.y + position.x * 0.5);
  vColor = mix(uColLow, uColHigh, clamp(colMix, 0.0, 1.0));
  vFade = 1.0;

  gl_PointSize = uSize * (10.0 / -mvPosition.z);
  gl_PointSize = max(gl_PointSize, 1.5);
  gl_Position = projectionMatrix * mvPosition;
}
`

const pointsFragment = `
uniform float uOpacity; uniform float uBrightness; uniform float uAppear;
varying float vFade; varying vec3 vColor;
void main() {
  vec2 xy = gl_PointCoord - 0.5;
  float ll = length(xy);
  if (ll > 0.5) discard;
  float a = smoothstep(0.5, 0.1, ll);
  gl_FragColor = vec4(vColor * uBrightness, vFade * a * uOpacity * uAppear);
}
`

const finalVertex = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position, 1.0); }`

const finalFragment = `
uniform float iTime; uniform sampler2D tDiffuse; uniform sampler2D bloomTexture; uniform sampler2D torusTexture; uniform sampler2D haloTexture;
uniform vec3 uBg; uniform vec3 uFlameA; uniform vec3 uFlameB; uniform float uFlameAmt;
varying vec2 vUv;
vec3 warp3d(vec3 pos, float t){ float curv=.8,a=1.9,b=0.7; pos*=2.;
  pos.x+=curv*sin(t+a*pos.y)+t*b; pos.y+=curv*cos(t+a*pos.x);
  pos.y+=curv*sin(t+a*pos.z)+t*b; pos.z+=curv*cos(t+a*pos.y);
  pos.z+=curv*sin(t+a*pos.x)+t*b; pos.x+=curv*cos(t+a*pos.z);
  return 0.5+0.5*cos(pos.xyz+vec3(1,2,4)); }
void main(){
  vec2 uv = 2.*vUv - 1.;
  vec3 w = pow(warp3d(vec3(uv.x, sin(uv.y), uv.y), iTime*1.5), vec3(1.5));
  vec3 flame = 1.5*uFlameA*w.x; flame*=w.y; flame += uFlameB*w.z;
  flame *= smoothstep(0.25, 1., abs(uv.y));
  float md = smoothstep(-0.7, 1., -uv.y*uv.x); flame *= md*md;
  vec3 bg = uBg * (1.0 - 0.4 * length(uv));
  vec3 halo = texture2D(haloTexture, vUv).xyz;
  gl_FragColor = vec4(bg + flame*uFlameAmt + texture2D(bloomTexture, vUv).xyz + texture2D(torusTexture, vUv).xyz + texture2D(tDiffuse, vUv).xyz + halo, 1.);
}
`

const atmoVertex = `
attribute float size; attribute float seed; uniform float uTime; uniform vec2 uRes;
varying float vA;
vec3 warp(vec3 p, float t){ float c=0.9,a=1.9,b=0.02,s=0.05; p*=2.;
  p.x+=c*sin(s*t+a*p.y)+t*b; p.y+=c*cos(s*t+a*p.x); p.y+=c*sin(s*t+a*p.z)+t*b;
  p.z+=c*cos(s*t+a*p.y); p.z+=c*sin(s*t+a*p.x)+t*b; p.x+=c*cos(s*t+a*p.z);
  return cos(p+vec3(1,2,4)); }
void main(){
  vec3 v = position*4.0 + warp(position, uTime)*1.2;
  vec4 mv = modelViewMatrix * vec4(v, 1.0);
  float r = length(v); float farF = 1.0 - smoothstep(5.0, 6.5, r); float nearF = smoothstep(0.0, 0.5, -mv.z);
  vA = farF * nearF;
  gl_PointSize = size * uRes.y / 900.0 / -mv.z; gl_PointSize = max(gl_PointSize, 1.0);
  gl_Position = projectionMatrix * mv;
}
`

const atmoFragment = `
uniform vec3 uColor; varying float vA;
void main(){ vec2 p = gl_PointCoord - 0.5; float l = length(p); if (l > 0.5) discard;
  float tex = smoothstep(0.5, 0.0, l); gl_FragColor = vec4(uColor * tex, tex * vA * 0.6); }
`

/** `progress` is the hero's own scroll progress (0 → 1); it drives the dive. */
export default function FlowWaveImpl({ progress }: { progress: MotionValue<number> }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-hidden', 'true')
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'
    el.append(canvas)

    let renderer: THREE.WebGLRenderer
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true }) } catch { canvas.remove(); return }
    const dpr = () => Math.min(devicePixelRatio || 1, 2)
    renderer.setPixelRatio(dpr())

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x000000)
    scene.fog = new THREE.Fog(0x000000, 0, 15)
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400)
    camera.position.set(0, 7, 16)
    camera.layers.enable(LAYERS.TORUS_SCENE)
    camera.layers.enable(LAYERS.BLOOM_SCENE)
    camera.layers.enable(LAYERS.ENTIRE_SCENE)
    scene.add(camera)

    // ── the sheet ──
    const uniforms = {
      uTime: { value: 0 }, uStream: { value: 0 }, uAppear: { value: 0 },
      uColLow: { value: hexToVec3(colorLow) }, uColHigh: { value: hexToVec3(colorHigh) },
      uOpacity: { value: opacity }, uSize: { value: pointSize }, uBrightness: { value: brightness },
      uWaveHeight: { value: waveHeight }, uFlow: { value: flow }, uScale: { value: scale },
      uCursor: { value: new THREE.Vector3() }, uRepelRadius: { value: pointerRadius },
      uRepelStrength: { value: pointerStrength }, uActivity: { value: 0 },
    }
    const geometry = new THREE.SphereGeometry(4.2, 200, 600)
    const material = new THREE.ShaderMaterial({
      uniforms, vertexShader: pointsVertex, fragmentShader: pointsFragment,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    })
    const points = new THREE.Points(geometry, material)
    points.frustumCulled = false
    points.layers.enable(LAYERS.ENTIRE_SCENE)
    const group = new THREE.Group()
    group.add(points)
    scene.add(group)

    // ── composite ──
    const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
    black.needsUpdate = true
    const finalPass = new ShaderPass(new THREE.ShaderMaterial({
      uniforms: {
        iTime: { value: 0 }, tDiffuse: { value: null }, torusTexture: { value: black },
        bloomTexture: { value: black }, haloTexture: { value: black },
        uBg: { value: hexToVec3(bgColor) }, uFlameA: { value: hexToVec3(flameColor) },
        uFlameB: { value: hexToVec3(flameColor2) }, uFlameAmt: { value: flameAmt },
      },
      vertexShader: finalVertex, fragmentShader: finalFragment,
    }))
    const composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(scene, camera))
    composer.addPass(finalPass)

    // ── ambient motes ──
    const N = Math.round(atmoCount)
    const positions = new Float32Array(N * 3), sizes = new Float32Array(N), seeds = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      positions[i * 3] = 2 * Math.random() - 1
      positions[i * 3 + 1] = 2 * Math.random() - 1
      positions[i * 3 + 2] = 2 * Math.random() - 1
      sizes[i] = atmoSize * (0.4 + Math.random())
      seeds[i] = Math.random()
    }
    const atmoGeo = new THREE.BufferGeometry()
    atmoGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    atmoGeo.setAttribute('size', new THREE.BufferAttribute(sizes, 1))
    atmoGeo.setAttribute('seed', new THREE.BufferAttribute(seeds, 1))
    const atmoMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: hexToVec3(atmoColor) }, uRes: { value: new THREE.Vector2(1, 1) } },
      vertexShader: atmoVertex, fragmentShader: atmoFragment,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    })
    const motes = new THREE.Points(atmoGeo, atmoMat)
    motes.frustumCulled = false
    motes.layers.enable(LAYERS.ENTIRE_SCENE)
    motes.onBeforeRender = () => {
      const t = performance.now() / 1000
      atmoMat.uniforms.uTime.value = t * atmoSpeed * 8.0
      motes.position.copy(camera.position)
      finalPass.uniforms.iTime.value = t
    }
    scene.add(motes)

    // ── input ──
    let scrollSmooth = 0, scrollCurrent = 0
    const mouseTarget = { x: 0, y: 0 }, mouse = { x: 0, y: 0 }
    const POINTER = { world: new THREE.Vector3(), activity: 0, active: false, lastMove: performance.now() }
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      const r = el.getBoundingClientRect()
      mouseTarget.x = ((e.clientX - r.left) / r.width) * 2 - 1
      mouseTarget.y = -(((e.clientY - r.top) / r.height) * 2 - 1)
      POINTER.active = true
      POINTER.lastMove = performance.now()
    }
    const onOut = () => { POINTER.active = false }
    const stage = el.parentElement ?? el
    stage.addEventListener('pointermove', onMove, { passive: true })
    stage.addEventListener('pointerleave', onOut)

    const _ndc = new THREE.Vector3(), _dir = new THREE.Vector3(), _tgt = new THREE.Vector3()
    function updatePointerWorld() {
      _tgt.set(0, 0, 0)
      if (POINTER.active) {
        _ndc.set(mouse.x, mouse.y, 0.5).unproject(camera)
        _dir.copy(_ndc).sub(camera.position).normalize()
        const dn = _dir.z
        if (Math.abs(dn) > 1e-4) { const tt = -camera.position.z / dn; if (tt > 0 && Number.isFinite(tt)) _tgt.copy(camera.position).addScaledVector(_dir, tt) }
      }
      POINTER.world.lerp(_tgt, 0.12)
      const idle = (performance.now() - POINTER.lastMove) / 1000
      POINTER.activity += (((POINTER.active && idle < 3) ? 1 : 0) - POINTER.activity) * 0.06
    }

    // ── per frame ──
    let stream = 0
    const appearStart = performance.now()
    let t0 = performance.now() / 1000
    const update = (scroll: number, m: { x: number; y: number }) => {
      const t = performance.now() / 1000
      const dt = Math.min(0.05, t - t0); t0 = t
      uniforms.uTime.value = t
      stream += dt * (flow * 2.0) * 4.0
      uniforms.uStream.value = stream
      uniforms.uWaveHeight.value = waveHeight * (1 + scroll * scrollRise)
      const ea = Math.min(scroll / 0.35, 1.0)
      const e = ea * ea * (3 - 2 * ea)
      camera.position.set(m.x * parallax, Lerp(camStartY, camEndY, e) + m.y * parallax * 0.3, Lerp(camStartZ, camEndZ, e))
      camera.lookAt(m.x * parallax * 0.5, Lerp(0.0, 0.6, e), Lerp(lookStartZ, lookEndZ, e))
      group.rotation.x = -tilt
      group.rotation.y = 0
      updatePointerWorld()
      uniforms.uCursor.value.copy(POINTER.world)
      uniforms.uActivity.value = POINTER.activity
      const elapsed = (performance.now() - appearStart) / 1000
      uniforms.uAppear.value = Math.max(0, Math.min(1, (elapsed - 0.2) / 1.4))
    }

    let raf = 0, visible = true
    const loop = () => {
      raf = 0
      const scrollTarget = Math.max(0, Math.min(1, progress.get()))
      scrollSmooth = Lerp(scrollSmooth, scrollTarget, 0.10)
      scrollCurrent = Lerp(scrollCurrent, scrollSmooth, 0.06)
      mouse.x = Lerp(mouse.x, mouseTarget.x, 0.06)
      mouse.y = Lerp(mouse.y, mouseTarget.y, 0.06)
      update(scrollCurrent, mouse)
      camera.layers.set(LAYERS.ENTIRE_SCENE)
      composer.render()
      if (visible && !document.hidden) raf = requestAnimationFrame(loop)
    }
    const wake = () => { if (!raf && visible && !document.hidden) { t0 = performance.now() / 1000; raf = requestAnimationFrame(loop) } }

    const resize = () => {
      const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight)
      renderer.setPixelRatio(dpr())
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      composer.setPixelRatio(dpr())
      composer.setSize(w, h)
      atmoMat.uniforms.uRes.value.set(w * dpr(), h * dpr())
    }
    const ro = new ResizeObserver(() => { resize(); if (!raf) loop() })
    ro.observe(el)
    resize()
    const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible) wake() })
    io.observe(el)
    const onVis = () => wake()
    document.addEventListener('visibilitychange', onVis)
    wake()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect(); io.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      stage.removeEventListener('pointermove', onMove)
      stage.removeEventListener('pointerleave', onOut)
      geometry.dispose(); material.dispose(); atmoGeo.dispose(); atmoMat.dispose()
      finalPass.material.dispose(); black.dispose(); composer.dispose()
      renderer.dispose(); renderer.forceContextLoss()
      canvas.remove()
    }
  }, [progress])

  return <div ref={host} className="wave__gl" />
}
