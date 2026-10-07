import PhotonKnot from '@/components/ui/photon-knot'

/* Photon Knot with the configuration as supplied. The page colour is read by
   the component itself (it switches to ink mode on the light theme). */
export default function KnotBandImpl() {
  return (
    <PhotonKnot
      className="knotband__knot"
      size={1.51}
      offsetX={0.29000000000000004}
      offsetY={0.010000000000000009}
      ribbonWidth={0.45}
      loop={0.35000000000000003}
      twists={1}
      tilt={44}
      glow={1.57}
      sheen={1.94}
      depth={0.21}
      colors={['#ffeaf0', '#ff436e']}
      flowSpeed={1.11}
      rotationSpeed={0.2200000000000002}
      parallax={0.6}
    />
  )
}
