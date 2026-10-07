import ChromaCurrent from '@/components/ui/chroma-current'

/* The "aurora" configuration, as supplied. Background follows the page theme
   (transparent → the component reads the page color behind it). */
export default function CurrentBandImpl() {
  return (
    <ChromaCurrent
      className="band__current"
      colors={['#e3fff3', '#eeeded']}
      streams={6}
      spread={0.45}
      speed={0.45}
      direction={90}
      turbulence={1}
      trail={1.2}
      plume={1.72}
      dpr={1.5}
    />
  )
}
