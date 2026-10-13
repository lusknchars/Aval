import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

/*
 * The Solana mark as a floating 3D piece: the model's own shape, recoloured
 * to glossy black, bobbing and turning slowly; the pointer tilts it a little.
 * Studio reflections (RoomEnvironment) are what make black read as a solid.
 */
export default function SolanaFloatImpl() {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = host.current
    if (!el) return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    let renderer: THREE.WebGLRenderer
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }) } catch { return }
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2))
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.domElement.style.cssText = 'width:100%;height:100%;display:block'
    el.append(renderer.domElement)

    const scene = new THREE.Scene()
    const pmrem = new THREE.PMREMGenerator(renderer)
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environment = env
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50)
    camera.position.set(0, 0, 6.2)
    const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(3, 4, 5); scene.add(key)

    const pivot = new THREE.Group(); scene.add(pivot)
    const material = new THREE.MeshPhysicalMaterial({ color: 0x0b0b0d, metalness: 0.85, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08 })
    let disposed = false
    new GLTFLoader().load('/models/solana-logo.glb', (gltf) => {
      if (disposed) return
      const model = gltf.scene
      model.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = material })
      // Centre it and fit it to ~2.6 units wide.
      const box = new THREE.Box3().setFromObject(model)
      const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3())
      model.position.sub(centre)
      const wrap = new THREE.Group(); wrap.add(model)
      wrap.scale.setScalar(2.6 / Math.max(size.x, size.y))
      pivot.add(wrap)
      wake()
    })

    const target = { x: 0, y: 0 }, tilt = { x: 0, y: 0 }
    const onMove = (e: PointerEvent) => {
      target.x = (e.clientX / innerWidth) * 2 - 1
      target.y = (e.clientY / innerHeight) * 2 - 1
    }
    addEventListener('pointermove', onMove, { passive: true })

    const resize = () => {
      const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight)
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(() => { resize(); renderer.render(scene, camera) })
    ro.observe(el)
    resize()

    let raf = 0, visible = false
    const t0 = performance.now()
    const loop = (now: number) => {
      raf = 0
      const t = (now - t0) / 1000
      tilt.x += (target.x - tilt.x) * 0.05
      tilt.y += (target.y - tilt.y) * 0.05
      pivot.position.y = reduced ? 0 : Math.sin(t * 1.1) * 0.12
      pivot.rotation.y = (reduced ? 0 : Math.sin(t * 0.45) * 0.55) + tilt.x * 0.35
      pivot.rotation.x = -0.12 + tilt.y * 0.2 + (reduced ? 0 : Math.sin(t * 0.8) * 0.05)
      pivot.rotation.z = reduced ? 0 : Math.sin(t * 0.6) * 0.04
      renderer.render(scene, camera)
      if (visible && !document.hidden && !reduced) raf = requestAnimationFrame(loop)
    }
    const wake = () => { if (!raf) raf = requestAnimationFrame(loop) }
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) wake() })
    io.observe(el)
    const onVis = () => { if (!document.hidden && visible) wake() }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      io.disconnect(); ro.disconnect()
      removeEventListener('pointermove', onMove)
      document.removeEventListener('visibilitychange', onVis)
      scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose() })
      material.dispose(); env.dispose(); pmrem.dispose()
      renderer.dispose(); renderer.forceContextLoss()
      renderer.domElement.remove()
    }
  }, [])
  return <div ref={host} className="solfloat__gl" />
}
