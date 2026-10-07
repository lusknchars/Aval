"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import * as THREE from "three";
import { cn } from "@/lib/utils";

export interface ElasticReelItem {
  src: string;
  alt: string;
  title?: string;
  subtitle?: string;
  focus?: number;
}

export type ElasticReelAutoplay = "sweep" | "cycle" | "off";
export type ElasticReelAlign = "center" | "bottom";

export interface ElasticReelProps {
  items?: ElasticReelItem[];
  defaultOpen?: number;
  barWidth?: number;
  barHeight?: number;
  gap?: number;
  radius?: number;
  magnify?: number;
  lift?: number;
  influence?: number;
  align?: ElasticReelAlign;
  openSize?: number;
  openAspect?: number;
  elasticity?: number;
  blur?: number;
  dim?: number;
  shadow?: number;
  rim?: number;
  autoplay?: ElasticReelAutoplay;
  speed?: number;
  interval?: number;
  pauseOnHover?: boolean;
  draggable?: boolean;
  wheel?: boolean;
  captions?: boolean;
  labels?: boolean;
  backgroundColor?: string;
  paused?: boolean;
  dpr?: number;
  ariaLabel?: string;
  onOpen?: (item: ElasticReelItem, index: number) => void;
  onClose?: () => void;
  className?: string;
  style?: CSSProperties;
}

export interface ElasticReelHandle {
  open: (index: number) => void;
  close: () => void;
  next: () => void;
  previous: () => void;
}

type Settings = Required<
  Omit<ElasticReelProps, "className" | "style" | "onOpen" | "onClose" | "ariaLabel" | "items" | "defaultOpen">
> & {
  reduced: boolean;
};

interface Controller {
  sync: () => void;
  open: (index: number) => void;
  close: () => void;
  step: (direction: number) => void;
  destroy: () => void;
}

interface Callbacks {
  onOpen: (index: number) => void;
  onClose: () => void;
}

interface Overlay {
  caption: HTMLElement;
  title: HTMLElement;
  subtitle: HTMLElement;
  label: HTMLElement;
}

interface Picture {
  image: HTMLImageElement;
  texture: THREE.Texture;
  aspect: number;
  ready: boolean;
  uploaded: boolean;
  fade: number;
}

interface Bar {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  m: number;
  mv: number;
  o: number;
  ov: number;
  a: number;
  av: number;
  q: number;
  qv: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

const MAX_BARS = 40;
const LABEL_SPACE = 34;
const CAPTION_SPACE = 66;
const SIDE_WIDTH = 0.72;
const SIDE_HEIGHT = 0.86;
const TAU = Math.PI * 2;

const defaultItems: ElasticReelItem[] = [
  {
    src: "https://pro.reactbits.dev/demo-media/abstract-orchid-orbit.webp",
    alt: "Fuchsia ring and peach crescent on a grainy orchid-purple field",
    title: "Orchid orbit",
    subtitle: "Color in orbit",
    focus: 0.5,
  },
  {
    src: "https://pro.reactbits.dev/demo-media/abstract-fuchsia-wave.webp",
    alt: "Broad fuchsia S-shaped band with a coral gradient across deep plum",
    title: "Fuchsia wave",
    subtitle: "One continuous curve",
    focus: 0.5,
  },
  {
    src: "https://pro.reactbits.dev/demo-media/abstract-coral-fold.webp",
    alt: "Broad vermilion and orange folded plane over deep plum with fine grain",
    title: "Coral fold",
    subtitle: "A bold change of direction",
    focus: 0.5,
  },
  {
    src: "https://pro.reactbits.dev/demo-media/abstract-rose-balance.webp",
    alt: "Tilted raspberry rounded rectangle and tangerine disc on a rose-pink field",
    title: "Rose balance",
    subtitle: "A bright point of balance",
    focus: 0.5,
  },
  {
    src: "https://pro.reactbits.dev/demo-media/abstract-violet-steps.webp",
    alt: "Three interlocking violet and pink stepped planes with an amber edge",
    title: "Violet steps",
    subtitle: "Three planes in rhythm",
    focus: 0.5,
  },
  {
    src: "https://pro.reactbits.dev/demo-media/abstract-amber-loop.webp",
    alt: "Tilted golden-amber loop on a grainy raspberry-purple field",
    title: "Amber loop",
    subtitle: "Warmth around an open center",
    focus: 0.5,
  },
  {
    src: "https://pro.reactbits.dev/demo-media/abstract-pink-eclipse.webp",
    alt: "Coral-pink disc crossing a violet diagonal plane on a grainy purple field",
    title: "Pink eclipse",
    subtitle: "A disc across the diagonal",
    focus: 0.5,
  },
  {
    src: "https://pro.reactbits.dev/demo-media/abstract-plum-ribbon.webp",
    alt: "Intersecting pink and plum diagonal ribbons on a coral-magenta field",
    title: "Plum ribbon",
    subtitle: "Two ribbons, one crossing",
    focus: 0.5,
  },
];

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const smooth = (edge0: number, edge1: number, value: number) => {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

const subscribeToMotion = (notify: () => void) => {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};

const readMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const parseColor = (value: string) => {
  const hex = value.trim().replace("#", "");
  if (!/^[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(hex)) return null;
  const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
  return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16) / 255);
};

const isLight = (value: string) => {
  const rgb = parseColor(value);
  if (!rgb) return false;
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] > 0.6;
};

const springTo = (
  value: number,
  velocity: number,
  target: number,
  dt: number,
  response: number,
  ratio: number,
) => {
  const omega = TAU / Math.max(response, 0.02);
  const substeps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / substeps;
  let v = velocity;
  let x = value;
  for (let i = 0; i < substeps; i++) {
    v += (omega * omega * (target - x) - 2 * ratio * omega * v) * h;
    x += v * h;
  }
  return [x, v] as const;
};

const bell = (t: number) => {
  const x = clamp(Math.abs(t), 0, 1);
  return 0.5 + 0.5 * Math.cos(Math.PI * x);
};

const hiddenStyle: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

const stageStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  touchAction: "pan-y",
  userSelect: "none",
  WebkitUserSelect: "none",
  WebkitTouchCallout: "none",
};

const captionStyle: CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 4,
  textAlign: "center",
  whiteSpace: "nowrap",
  pointerEvents: "none",
  opacity: 0,
  willChange: "transform, opacity",
};

const titleStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  lineHeight: 1.25,
  letterSpacing: "-0.012em",
};

const subtitleStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.4,
  opacity: 0.55,
};

const labelStyle: CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.3,
  letterSpacing: "-0.005em",
  whiteSpace: "nowrap",
  pointerEvents: "none",
  opacity: 0,
  willChange: "transform, opacity",
};

const vertexShader = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = `
precision highp float;

uniform sampler2D uImage;
uniform float uImageAspect;
uniform vec2 uSize;
uniform float uMargin;
uniform float uRadius;
uniform float uFocus;
uniform float uBlur;
uniform float uAlpha;
uniform float uLoaded;
uniform float uShadow;
uniform float uRim;
uniform vec3 uRimColor;
uniform vec3 uPlaceholder;
varying vec2 vUv;

float roundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

vec3 sampleImage(vec2 uv, float level, vec2 spread) {
  if (level < 0.05) return texture2D(uImage, uv).rgb;
  vec3 total = texture2D(uImage, uv, level).rgb * 0.36;
  total += texture2D(uImage, uv + vec2(spread.x, spread.y * 0.4), level).rgb * 0.16;
  total += texture2D(uImage, uv - vec2(spread.x, spread.y * 0.4), level).rgb * 0.16;
  total += texture2D(uImage, uv + vec2(-spread.x * 0.4, spread.y), level).rgb * 0.16;
  total += texture2D(uImage, uv - vec2(-spread.x * 0.4, spread.y), level).rgb * 0.16;
  return total;
}

void main() {
  vec2 full = uSize + 2.0 * uMargin;
  vec2 p = (vUv - 0.5) * full;
  float radius = min(uRadius, 0.5 * min(uSize.x, uSize.y));
  float d = roundBox(p, 0.5 * uSize, radius);
  float px = max(fwidth(d), 1e-4);
  float card = 1.0 - smoothstep(-0.7 * px, 0.7 * px, d);

  float shadowBlur = max(uSize.y * 0.07, 6.0);
  float sd = roundBox(p - vec2(0.0, -uSize.y * 0.035), 0.5 * uSize * vec2(0.96, 0.97), radius);
  float shade = (1.0 - smoothstep(-shadowBlur * 0.5, shadowBlur, sd)) * uShadow * 0.42;

  float scale = max(uSize.y, uSize.x / uImageAspect);
  vec2 extent = 0.5 * uSize / (scale * vec2(uImageAspect, 1.0));
  float cx = clamp(uFocus, extent.x, 1.0 - extent.x);
  vec2 uv = vec2(cx, 0.5) + vec2(p.x / (scale * uImageAspect), p.y / scale);
  vec2 spread = vec2(1.0 / uImageAspect, 1.0) * (uBlur * 2.4 / scale);
  vec3 image = sampleImage(uv, uBlur, spread);

  float loaded = clamp(uLoaded, 0.0, 1.0);
  vec3 color = mix(uPlaceholder, image, loaded);
  float rimMask = card * (1.0 - smoothstep(0.0, 1.5 * px, -d));
  color = mix(color, uRimColor, rimMask * uRim);

  float alpha = card * uAlpha * mix(0.18, 1.0, loaded);
  float shadowAlpha = (1.0 - card) * shade * uAlpha;
  float total = alpha + shadowAlpha * (1.0 - alpha);
  if (total < 0.002) discard;
  gl_FragColor = vec4(color * alpha, total);
}
`;

const createReel = (
  root: HTMLElement,
  stage: HTMLElement,
  overlay: Overlay,
  settingsRef: { current: Settings },
  itemsRef: { current: ElasticReelItem[] },
  initialOpen: number,
  callbacks: Callbacks,
): Controller | null => {
  const doc = root.ownerDocument;
  const view = doc.defaultView ?? window;
  const canvas = doc.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      powerPreference: "high-performance",
    });
  } catch {
    return null;
  }
  stage.appendChild(canvas);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
  const plane = new THREE.PlaneGeometry(1, 1);
  const blank = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  blank.needsUpdate = true;
  const background = new THREE.Color(0x0a0a0a);
  const rimColor = new THREE.Color(1, 1, 1);
  const placeholder = new THREE.Color(0.12, 0.12, 0.12);

  const bars: Bar[] = Array.from({ length: MAX_BARS }, () => {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uImage: { value: blank as THREE.Texture },
        uImageAspect: { value: 1.5 },
        uSize: { value: new THREE.Vector2(40, 200) },
        uMargin: { value: 16 },
        uRadius: { value: 12 },
        uFocus: { value: 0.5 },
        uBlur: { value: 0 },
        uAlpha: { value: 0 },
        uLoaded: { value: 0 },
        uShadow: { value: 0.35 },
        uRim: { value: 0.12 },
        uRimColor: { value: rimColor },
        uPlaceholder: { value: placeholder },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      premultipliedAlpha: true,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(plane, material);
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, m: 0, mv: 0, o: 0, ov: 0, a: 0, av: 0, q: 0, qv: 0, x: 0, y: 0, w: 0, h: 0 };
  });

  let pictures: Picture[] = [];
  let itemsKey = "";
  let width = 0;
  let height = 0;
  let dpr = 1;
  let sized = false;
  let openIndex = -1;
  let pressIndex = -1;
  let px = 0;
  let pv = 0;
  let pointerX = 0;
  let pointerY = 0;
  let pointerInside = false;
  let presence = 0;
  let presenceV = 0;
  let virtualIndex = 0;
  let virtualUntil = 0;
  let sweepPhase = 0;
  let sweepActive = false;
  let sweepResumeAt = 0;
  let nextStepAt = 0;
  let wheelAccumulator = 0;
  let wheelLockUntil = 0;
  let pull = 0;
  let pullV = 0;
  let started = false;
  let waitedSince = 0;
  let introClock = 0;
  let raf = 0;
  let timer = 0;
  let last = 0;
  let visible = false;
  let destroyed = false;
  let lost = false;
  let backgroundAt = -10;
  let captionIndex = -1;
  let captionOpacity = -1;
  let captionX = Number.NaN;
  let captionY = Number.NaN;
  let labelIndex = -1;
  let labelOpacity = -1;
  let labelX = Number.NaN;
  let labelY = Number.NaN;
  let press: {
    id: number;
    x: number;
    y: number;
    t: number;
    moved: boolean;
    mode: "scrub" | "pull" | "none";
    samples: { t: number; x: number }[];
  } | null = null;

  const geo = {
    restW: 40,
    restH: 200,
    pitch: 50,
    gap: 10,
    avail: 800,
    usable: 400,
    labelSpace: 0,
    captionSpace: 0,
    yC: 0,
    open: 0,
  };

  const count = () => Math.min(itemsRef.current.length, MAX_BARS);
  const clock = () => performance.now() / 1000;
  const restCentre = (i: number) => (i - (count() - 1) / 2) * geo.pitch;

  const loadPictures = () => {
    const items = itemsRef.current.slice(0, MAX_BARS);
    const key = items.map((item) => item.src).join("\u0000");
    if (key === itemsKey) return;
    itemsKey = key;
    pictures.forEach((picture) => {
      picture.image.onload = null;
      picture.texture.dispose();
    });
    const n = Math.max(items.length, 1);
    pictures = items.map((item, index) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.decoding = "async";
      image.fetchPriority = Math.abs(index - (n - 1) / 2) < 3 ? "high" : "low";
      const texture = new THREE.Texture(image);
      texture.colorSpace = THREE.NoColorSpace;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      const picture: Picture = { image, texture, aspect: 1.5, ready: false, uploaded: false, fade: 0 };
      image.onload = () => {
        if (destroyed) return;
        const finish = () => {
          if (destroyed || picture.ready) return;
          picture.aspect = image.naturalWidth / Math.max(image.naturalHeight, 1);
          picture.ready = true;
          texture.needsUpdate = true;
          schedule();
        };
        image.decode().then(finish, finish);
      };
      image.src = item.src;
      return picture;
    });
    if (openIndex >= items.length) openIndex = -1;
    captionIndex = -1;
    labelIndex = -1;
  };

  const readSize = () => {
    const settings = settingsRef.current;
    const nextWidth = Math.round(root.clientWidth);
    const nextHeight = Math.round(root.clientHeight);
    if (nextWidth < 2 || nextHeight < 2) {
      sized = false;
      return false;
    }
    const nextDpr = Math.min(view.devicePixelRatio || 1, Math.max(settings.dpr, 0.5));
    if (sized && nextWidth === width && nextHeight === height && nextDpr === dpr) return false;
    sized = true;
    width = nextWidth;
    height = nextHeight;
    dpr = nextDpr;
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    camera.left = -width / 2;
    camera.right = width / 2;
    camera.top = height / 2;
    camera.bottom = -height / 2;
    camera.updateProjectionMatrix();
    return true;
  };

  const syncColors = () => {
    const value = settingsRef.current.backgroundColor;
    if (parseColor(value)) {
      background.setStyle(value, THREE.NoColorSpace);
    } else {
      let node: HTMLElement | null = root;
      let found = false;
      while (node && !found) {
        const fill = view.getComputedStyle(node).backgroundColor;
        if (fill && fill !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(fill)) {
          background.setStyle(fill, THREE.NoColorSpace);
          found = true;
        }
        node = node.parentElement;
      }
      if (!found) {
        const ink = new THREE.Color();
        ink.setStyle(view.getComputedStyle(root).color || "#fff", THREE.NoColorSpace);
        background.setHex(ink.r + ink.g + ink.b > 1.5 ? 0x0a0a0a : 0xffffff, THREE.NoColorSpace);
      }
    }
    const light = background.r * 0.2126 + background.g * 0.7152 + background.b * 0.0722 > 0.6;
    rimColor.setRGB(light ? 0 : 1, light ? 0 : 1, light ? 0 : 1);
    placeholder.copy(background).lerp(new THREE.Color(light ? 0x000000 : 0xffffff), 0.08);
  };

  const measure = () => {
    const settings = settingsRef.current;
    const n = Math.max(count(), 1);
    const margin = Math.max(16, width * 0.04);
    const avail = Math.max(width - 2 * margin, 40);
    const gap = clamp(settings.gap, 0, 64);
    const fit = (avail - (n - 1) * gap) / n;
    const restW = clamp(Math.min(settings.barWidth, fit), 2, 480);
    const labelSpace = settings.labels ? LABEL_SPACE : 0;
    const captionSpace = settings.captions ? CAPTION_SPACE : 0;
    const usable = Math.max(height - 32, 160);
    geo.restW = restW;
    geo.gap = gap;
    geo.pitch = restW + gap;
    geo.avail = avail;
    geo.usable = usable;
    geo.labelSpace = labelSpace;
    geo.captionSpace = captionSpace;
    geo.restH = clamp(settings.barHeight, 0.08, 0.95) * (usable - labelSpace);
    geo.open = clamp(settings.openSize, 0.15, 0.95) * (usable - captionSpace);
  };

  const openSize = (index: number) => {
    const settings = settingsRef.current;
    const n = count();
    const picture = pictures[index];
    const aspect =
      settings.openAspect > 0
        ? clamp(settings.openAspect, 0.4, 3)
        : clamp(picture?.ready ? picture.aspect : 1.5, 0.55, 2.2);
    let h = geo.open;
    let w = h * aspect;
    const room = geo.avail - (n - 1) * (geo.gap + geo.restW * SIDE_WIDTH * 1.15);
    const maxW = Math.max(room, geo.avail * 0.42);
    if (w > maxW) {
      w = maxW;
      h = w / aspect;
    }
    return { w, h };
  };

  const schedule = () => {
    if (destroyed || lost || !visible || raf) return;
    if (timer) {
      view.clearTimeout(timer);
      timer = 0;
    }
    raf = requestAnimationFrame(frame);
  };

  const holdAutoplay = (seconds = 3) => {
    const at = clock();
    sweepActive = false;
    sweepResumeAt = Math.max(sweepResumeAt, at + seconds);
    nextStepAt = Math.max(nextStepAt, at + Math.max(settingsRef.current.interval, seconds));
  };

  const setOpen = (index: number) => {
    const n = count();
    const next = index >= 0 && index < n ? index : -1;
    if (next === openIndex) return;
    openIndex = next;
    if (next >= 0) {
      virtualIndex = next;
      callbacks.onOpen(next);
    } else {
      callbacks.onClose();
    }
    schedule();
  };

  const step = (direction: number) => {
    const n = count();
    if (!n) return;
    if (openIndex >= 0) {
      setOpen((openIndex + direction + n) % n);
    } else {
      const base = clock() < virtualUntil ? virtualIndex : nearestToFocus();
      virtualIndex = clamp(base + direction, 0, n - 1);
      virtualUntil = clock() + 1.8;
    }
    holdAutoplay();
    schedule();
  };

  const nearestToFocus = () => {
    const n = count();
    return clamp(Math.round(px / Math.max(geo.pitch, 1) + (n - 1) / 2), 0, n - 1);
  };

  const uploadOne = () => {
    const n = pictures.length;
    let best: Picture | null = null;
    let bestDistance = Infinity;
    for (let i = 0; i < n; i++) {
      const picture = pictures[i];
      if (!picture.ready || picture.uploaded) continue;
      const distance = Math.abs(i - (n - 1) / 2);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = picture;
      }
    }
    if (!best) return false;
    renderer.initTexture(best.texture);
    best.uploaded = true;
    return true;
  };

  const hitTest = (localX: number, localY: number) => {
    const n = count();
    const sx = localX - width / 2;
    const sy = height / 2 - localY;
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < n; i++) {
      const bar = bars[i];
      const dx = Math.abs(sx - bar.x) - bar.w / 2;
      const dy = Math.abs(sy - bar.y) - bar.h / 2;
      if (dy > 6) continue;
      const distance = Math.max(dx, 0);
      if (distance < Math.min(bestDistance, geo.gap / 2 + 1)) {
        bestDistance = distance;
        best = i;
      }
    }
    return best;
  };

  const inBand = (localY: number) => {
    const sy = height / 2 - localY;
    const reach = (geo.restH * Math.max(settingsRef.current.lift, 1)) / 2 + 48;
    return Math.abs(sy - geo.yC) <= Math.max(reach, geo.open / 2 * clamp(openness(), 0, 1));
  };

  const openness = () => {
    let total = 0;
    for (let i = 0; i < count(); i++) total += bars[i].o;
    return clamp(total, 0, 1);
  };

  const openW = new Float64Array(MAX_BARS);
  const openH = new Float64Array(MAX_BARS);
  const solveW = new Float64Array(MAX_BARS);
  const solveC = new Float64Array(MAX_BARS);
  const drawW = new Float64Array(MAX_BARS);
  const drawC = new Float64Array(MAX_BARS);

  const layout = (weightOf: (i: number) => number, O: number, outW: Float64Array, outC: Float64Array) => {
    const n = count();
    const magnify = Math.max(settingsRef.current.magnify, 1);
    let fixed = 0;
    let scalable = 0;
    for (let i = 0; i < n; i++) {
      const bar = bars[i];
      const keep = clamp(bar.o, 0, 1);
      const own = clamp(bar.o, 0, 1.2);
      const hw = geo.restW * (1 + (magnify - 1) * weightOf(i));
      const sw = hw * (1 - (1 - SIDE_WIDTH) * O * (1 - keep));
      const w = sw + (openW[i] - sw) * own;
      outW[i] = w;
      fixed += w * keep;
      scalable += w * (1 - keep);
    }
    const gaps = Math.max(n - 1, 0) * geo.gap;
    if (fixed + scalable + gaps > geo.avail && scalable > 1) {
      const k = clamp((geo.avail - fixed - gaps) / scalable, 0.05, 1);
      for (let i = 0; i < n; i++) {
        const keep = clamp(bars[i].o, 0, 1);
        outW[i] *= keep + (1 - keep) * k;
      }
    }
    let total = gaps;
    for (let i = 0; i < n; i++) total += outW[i];
    let cursor = -total / 2;
    for (let i = 0; i < n; i++) {
      outC[i] = cursor + outW[i] / 2;
      cursor += outW[i] + geo.gap;
    }
    return total;
  };

  const solveFocus = (target: number, O: number) => {
    const n = count();
    if (n < 2) return 0;
    const influence = Math.max(settingsRef.current.influence, 20);
    const displayed = (p: number) => {
      layout(
        (i) => bell((p - restCentre(i)) / influence) * (1 - 0.6 * O * (1 - clamp(bars[i].o, 0, 1))),
        O,
        solveW,
        solveC,
      );
      const u = p / Math.max(geo.pitch, 1) + (n - 1) / 2;
      if (u <= 0) return solveC[0] + u * (solveW[0] + geo.gap);
      if (u >= n - 1) return solveC[n - 1] + (u - (n - 1)) * (solveW[n - 1] + geo.gap);
      const k = Math.floor(u);
      return solveC[k] + (solveC[k + 1] - solveC[k]) * (u - k);
    };
    let lo = restCentre(0) - geo.pitch;
    let hi = restCentre(n - 1) + geo.pitch;
    if (target <= displayed(lo)) return lo;
    if (target >= displayed(hi)) return hi;
    for (let k = 0; k < 22; k++) {
      const mid = (lo + hi) / 2;
      if (displayed(mid) < target) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };

  function frame(time: number) {
    raf = 0;
    if (destroyed || lost) return;
    if (!sized) {
      readSize();
      if (!sized) return;
    }
    const settings = settingsRef.current;
    const dt = last && time - last < 100 ? Math.min(Math.max((time - last) / 1000, 0), 0.05) : 1 / 60;
    last = time;
    const now = clock();
    const reduced = settings.reduced;
    const n = count();
    let busy = false;

    if (now - backgroundAt > 1.2) {
      backgroundAt = now;
      syncColors();
    }
    readSize();
    measure();

    if (uploadOne()) busy = true;
    for (const picture of pictures) {
      if (picture.uploaded && picture.fade < 1) {
        picture.fade = reduced || !started ? 1 : Math.min(1, picture.fade + dt / 0.45);
        busy = true;
      }
    }

    if (!started) {
      if (!waitedSince) waitedSince = now;
      let ready = true;
      for (let i = 0; i < n; i++) if (pictures[i] && !pictures[i].uploaded) ready = false;
      if (ready || reduced || now - waitedSince > 1.6) {
        started = true;
        introClock = 0;
        if (initialOpen >= 0 && initialOpen < n) setOpen(initialOpen);
        sweepResumeAt = now + 1.4;
        nextStepAt = now + Math.max(settings.interval, 1);
      } else {
        busy = true;
      }
    } else {
      introClock += dt;
      if (introClock < 1.4) busy = true;
    }

    const elastic = clamp(settings.elasticity, 0, 1);
    const stopped = settings.paused || reduced || settings.autoplay === "off";
    const touching = !!press || (settings.pauseOnHover && pointerInside);

    let openNow = 0;
    for (let i = 0; i < n; i++) {
      openNow += clamp(bars[i].o, 0, 1);
      const size = openSize(i);
      openW[i] = size.w;
      openH[i] = size.h;
    }
    openNow = clamp(openNow, 0, 1);
    const reelLeft = n ? bars[0].x - bars[0].w / 2 : 0;
    const reelRight = n ? bars[n - 1].x + bars[n - 1].w / 2 : 0;
    const pointerAside = Math.max(reelLeft - (pointerX - width / 2), pointerX - width / 2 - reelRight, 0);
    const pointerNear = 1 - smooth(0, geo.pitch * 1.5, pointerAside);

    let focus: number | null = null;
    let presenceTarget = 0;
    let follow = 0.06;
    let sweeping = false;
    if (press && press.mode === "scrub") {
      focus = solveFocus(pointerX - width / 2, openNow);
      presenceTarget = pointerNear;
    } else if (pointerInside && !(press && press.mode === "pull") && inBand(pointerY) && pointerNear > 0) {
      focus = solveFocus(pointerX - width / 2, openNow);
      presenceTarget = pointerNear;
    } else if (now < virtualUntil) {
      focus = restCentre(virtualIndex);
      presenceTarget = 1;
      follow = 0.22;
    } else if (
      settings.autoplay === "sweep" &&
      !stopped &&
      !touching &&
      openIndex < 0 &&
      started &&
      now >= sweepResumeAt &&
      n > 1
    ) {
      const amplitude = ((n - 1) / 2) * geo.pitch * 0.86;
      const sharp = 0.88;
      const norm = Math.asin(sharp);
      if (!sweepActive) {
        const ratio = clamp(px / Math.max(amplitude, 1), -1, 1);
        sweepPhase = Math.asin(clamp(Math.sin(ratio * norm) / sharp, -1, 1));
        if (pv < 0) sweepPhase = Math.PI - sweepPhase;
      }
      sweeping = true;
      const travel = (Math.PI / 2) * ((n - 1) / 2) * 0.86;
      sweepPhase += (dt * clamp(settings.speed, 0, 6)) / Math.max(travel, 0.5) * (Math.PI / 2);
      focus = (amplitude * Math.asin(sharp * Math.sin(sweepPhase))) / norm;
      presenceTarget = 1;
      follow = 0.2;
    }
    sweepActive = sweeping;
    if (settings.autoplay === "cycle" && !stopped && !touching && started && n > 1) {
      if (now >= nextStepAt) {
        nextStepAt = now + Math.max(settings.interval, 1);
        setOpen(openIndex < 0 ? 0 : (openIndex + 1) % n);
      }
    }

    if (focus !== null) {
      if (presence < 0.02) {
        px = focus;
        pv = 0;
      }
      [px, pv] = springTo(px, pv, focus, dt, reduced ? 0.04 : follow, 1);
      if (Math.abs(px - focus) > 0.05 || Math.abs(pv) > 0.5) busy = true;
    }
    [presence, presenceV] = springTo(presence, presenceV, presenceTarget, dt, reduced ? 0.05 : presenceTarget > presence ? 0.3 : 0.45, 1);
    if (Math.abs(presence - presenceTarget) > 1e-3 || Math.abs(presenceV) > 1e-3) busy = true;
    else {
      presence = presenceTarget;
      presenceV = 0;
    }

    const hoverResponse = reduced ? 0.05 : 0.09 + 0.2 * elastic;
    const hoverRatio = 1 - 0.55 * elastic;
    const openResponse = reduced ? 0.06 : 0.5 + 0.12 * elastic;
    const openRatio = 1 - 0.45 * elastic;
    const influence = Math.max(settings.influence, 20);
    let O = 0;
    for (let i = 0; i < n; i++) {
      const bar = bars[i];
      const mTarget = presence * bell((px - restCentre(i)) / influence);
      [bar.m, bar.mv] = springTo(bar.m, bar.mv, mTarget, dt, hoverResponse, hoverRatio);
      if (Math.abs(bar.m - mTarget) > 1e-4 || Math.abs(bar.mv) > 1e-3) busy = true;
      const oTarget = i === openIndex ? 1 : 0;
      [bar.o, bar.ov] = springTo(bar.o, bar.ov, oTarget, dt, openResponse, openRatio);
      if (Math.abs(bar.o - oTarget) > 1e-4 || Math.abs(bar.ov) > 1e-3) busy = true;
      else {
        bar.o = oTarget;
        bar.ov = 0;
      }
      const delay = Math.abs(i - (n - 1) / 2) * 0.045;
      const aTarget = started && (reduced || introClock >= delay) ? 1 : 0;
      if (reduced && started) {
        bar.a = 1;
        bar.av = 0;
      } else {
        [bar.a, bar.av] = springTo(bar.a, bar.av, aTarget, dt, 0.7, 0.86);
        if (Math.abs(bar.a - aTarget) > 1e-4 || Math.abs(bar.av) > 1e-3) busy = true;
        else {
          bar.a = aTarget;
          bar.av = 0;
        }
      }
      const qTarget = press && pressIndex === i && !press.moved ? 1 : 0;
      [bar.q, bar.qv] = springTo(bar.q, bar.qv, qTarget, dt, 0.22, 0.7);
      if (Math.abs(bar.q - qTarget) > 1e-4 || Math.abs(bar.qv) > 1e-3) busy = true;
      else {
        bar.q = qTarget;
        bar.qv = 0;
      }
      O += clamp(bar.o, 0, 1);
    }
    O = clamp(O, 0, 1);

    if (!press || press.mode !== "pull") {
      [pull, pullV] = springTo(pull, pullV, 0, dt, reduced ? 0.05 : 0.42, 0.9);
      if (Math.abs(pull) > 0.05 || Math.abs(pullV) > 0.5) busy = true;
      else {
        pull = 0;
        pullV = 0;
      }
    }

    const lift = Math.max(settings.lift, 0.5);
    const weightOf = (i: number) => bars[i].m * (1 - 0.6 * O * (1 - clamp(bars[i].o, 0, 1)));
    layout(weightOf, O, drawW, drawC);
    for (let i = 0; i < n; i++) {
      const bar = bars[i];
      const own = clamp(bar.o, 0, 1.2);
      const hh = geo.restH * (1 + (lift - 1) * weightOf(i));
      const sh = hh * (1 - (1 - SIDE_HEIGHT) * O * (1 - clamp(bar.o, 0, 1)));
      bar.w = drawW[i];
      bar.h = sh + (openH[i] - sh) * own;
    }

    geo.yC = geo.labelSpace / 2 + (geo.captionSpace / 2 - geo.labelSpace / 2) * O;
    const bottomAligned = settings.align === "bottom";
    const baseline = geo.yC - geo.restH / 2;

    const radiusSetting = Math.max(settings.radius, 0);
    const blurSetting = clamp(settings.blur, 0, 1);
    const dimSetting = clamp(settings.dim, 0, 1);
    const shadowSetting = clamp(settings.shadow, 0, 1);
    const rimSetting = clamp(settings.rim, 0, 1);
    let leader = -1;
    let leaderOpen = 0;
    const fractional = px / Math.max(geo.pitch, 1) + (n - 1) / 2;
    const hoverLead = n ? clamp(Math.round(fractional), 0, n - 1) : -1;
    const centred = 1 - smooth(0.26, 0.46, Math.abs(fractional - hoverLead));

    for (let i = 0; i < n; i++) {
      const bar = bars[i];
      bar.x = drawC[i] + pull;
      const centred = geo.yC;
      const grounded = baseline + bar.h / 2;
      bar.y = bottomAligned ? grounded + (centred - grounded) * O : centred;
      if (bar.o > leaderOpen) {
        leaderOpen = bar.o;
        leader = i;
      }
      const mesh = bar.mesh;
      const appear = bar.a;
      const visibleBar = appear > 0.002 && bar.w > 0.5;
      mesh.visible = visibleBar;
      if (!visibleBar) continue;
      const pressScale = 1 - 0.035 * bar.q;
      const introScale = 0.94 + 0.06 * appear;
      const w = bar.w * pressScale * introScale;
      const h = bar.h * pressScale * introScale;
      const margin = Math.max(12, h * 0.14);
      const rise = (1 - appear) * geo.restH * 0.22;
      mesh.position.set(bar.x, bar.y - rise, 0);
      mesh.scale.set(w + 2 * margin, h + 2 * margin, 1);
      mesh.renderOrder = i === leader ? 1000 : i;
      const u = mesh.material.uniforms;
      const picture = pictures[i];
      const side = O * (1 - clamp(bar.o, 0, 1));
      const preview = 1 - 0.65 * bar.m;
      u.uImage.value = picture?.uploaded ? picture.texture : blank;
      u.uImageAspect.value = picture?.ready ? picture.aspect : 1.5;
      u.uLoaded.value = picture?.uploaded ? picture.fade : 0;
      u.uSize.value.set(w, h);
      u.uMargin.value = margin;
      u.uRadius.value = Math.min(radiusSetting, w / 2);
      u.uFocus.value = clamp(itemsRef.current[i]?.focus ?? 0.5, 0, 1);
      u.uBlur.value = reduced ? 0 : side * blurSetting * 2.6 * preview;
      u.uAlpha.value = appear * (1 - side * dimSetting * 0.8 * preview);
      u.uShadow.value = shadowSetting;
      u.uRim.value = rimSetting;
    }
    for (let i = n; i < MAX_BARS; i++) bars[i].mesh.visible = false;

    paintOverlay(leader, leaderOpen, hoverLead, centred, O);
    renderer.render(scene, camera);

    if (busy || press || sweepActive || pointerInside) schedule();
    else if (!stopped && started && n > 1 && !timer) {
      const wake = settings.autoplay === "cycle" ? nextStepAt : settings.autoplay === "sweep" ? sweepResumeAt : 0;
      if (wake > now) {
        timer = view.setTimeout(() => {
          timer = 0;
          last = 0;
          schedule();
        }, (wake - now) * 1000 + 16);
      }
    }
  }

  function paintOverlay(leader: number, leaderOpen: number, hoverLead: number, centred: number, O: number) {
    const settings = settingsRef.current;
    const items = itemsRef.current;
    if (settings.captions && leader >= 0) {
      if (leader !== captionIndex) {
        captionIndex = leader;
        const item = items[leader];
        overlay.title.textContent = item ? item.title ?? item.alt : "";
        overlay.subtitle.textContent = item?.subtitle ?? "";
        overlay.subtitle.style.display = item?.subtitle ? "" : "none";
      }
      const bar = bars[leader];
      const opacity = smooth(0.62, 1, leaderOpen) * bar.a;
      const x = width / 2 + bar.x;
      const y = height / 2 - (bar.y - bar.h / 2) + 18;
      if (Number.isNaN(captionX) || Math.abs(x - captionX) > 0.05 || Math.abs(y - captionY) > 0.05) {
        captionX = x;
        captionY = y;
        overlay.caption.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) translateX(-50%)`;
      }
      if (Math.abs(opacity - captionOpacity) > 0.002) {
        captionOpacity = opacity;
        overlay.caption.style.opacity = opacity.toFixed(3);
      }
    } else if (captionOpacity !== 0) {
      captionOpacity = 0;
      overlay.caption.style.opacity = "0";
    }

    if (settings.labels && hoverLead >= 0) {
      if (hoverLead !== labelIndex) {
        labelIndex = hoverLead;
        const item = items[hoverLead];
        overlay.label.textContent = item ? item.title ?? item.alt : "";
      }
      const bar = bars[hoverLead];
      const opacity = presence * centred * smooth(0.45, 0.8, bar.m) * (1 - smooth(0.05, 0.4, O)) * bar.a;
      const x = width / 2 + bar.x;
      const y = height / 2 - (bar.y - bar.h / 2) + 14;
      if (Number.isNaN(labelX) || Math.abs(x - labelX) > 0.05 || Math.abs(y - labelY) > 0.05) {
        labelX = x;
        labelY = y;
        overlay.label.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) translateX(-50%)`;
      }
      if (Math.abs(opacity - labelOpacity) > 0.002) {
        labelOpacity = opacity;
        overlay.label.style.opacity = opacity.toFixed(3);
      }
    } else if (labelOpacity !== 0) {
      labelOpacity = 0;
      overlay.label.style.opacity = "0";
    }
  }

  const local = (event: PointerEvent | WheelEvent) => {
    const rect = root.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onMove = (event: PointerEvent) => {
    const point = local(event);
    if (event.pointerType !== "touch") {
      pointerInside = true;
      pointerX = point.x;
      pointerY = point.y;
      const hit = hitTest(point.x, point.y);
      const cursor = hit >= 0 ? "pointer" : "";
      if (root.style.cursor !== cursor) root.style.cursor = cursor;
    }
    if (press && press.id === event.pointerId) {
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      if (!press.moved && Math.hypot(dx, dy) > 6) {
        press.moved = true;
        if (!settingsRef.current.draggable) press.mode = "none";
        else if (openIndex >= 0) press.mode = "pull";
        else press.mode = "scrub";
        try {
          stage.setPointerCapture(event.pointerId);
        } catch {}
      }
      if (press.moved) {
        if (press.mode === "scrub") {
          pointerX = point.x;
          pointerY = point.y;
        } else if (press.mode === "pull") {
          const reach = Math.max(width * 0.18, 80);
          pull = (reach * Math.tanh(dx / reach / 1.6)) * 0.9;
          pullV = 0;
        }
        const t = performance.now();
        press.samples.push({ t, x: event.clientX });
        while (press.samples.length > 2 && t - press.samples[0].t > 110) press.samples.shift();
      }
    }
    schedule();
  };

  const onDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button > 0) return;
    const point = local(event);
    pressIndex = hitTest(point.x, point.y);
    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      t: performance.now(),
      moved: false,
      mode: "none",
      samples: [{ t: performance.now(), x: event.clientX }],
    };
    if (event.pointerType === "touch") {
      pointerX = point.x;
      pointerY = point.y;
    }
    holdAutoplay();
    schedule();
  };

  const finish = (event: PointerEvent, cancelled: boolean) => {
    if (!press || press.id !== event.pointerId) return;
    const ended = press;
    press = null;
    try {
      if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    } catch {}
    const n = count();
    if (!cancelled && !ended.moved) {
      const point = local(event);
      const hit = hitTest(point.x, point.y);
      if (hit >= 0 && hit === pressIndex) setOpen(hit === openIndex ? -1 : hit);
      else if (hit < 0 && openIndex >= 0) setOpen(-1);
    } else if (!cancelled && ended.mode === "pull" && openIndex >= 0 && n > 1) {
      const t = performance.now();
      const recent = ended.samples.filter((sample) => t - sample.t < 110);
      let velocity = 0;
      if (recent.length > 1) {
        const span = Math.max((recent[recent.length - 1].t - recent[0].t) / 1000, 1 / 120);
        velocity = (recent[recent.length - 1].x - recent[0].x) / span;
      }
      const dx = event.clientX - ended.x;
      if (dx < -56 || velocity < -520) setOpen((openIndex + 1) % n);
      else if (dx > 56 || velocity > 520) setOpen((openIndex - 1 + n) % n);
    }
    pressIndex = -1;
    if (event.pointerType === "touch") pointerInside = false;
    holdAutoplay();
    schedule();
  };

  const onUp = (event: PointerEvent) => finish(event, false);
  const onCancel = (event: PointerEvent) => finish(event, true);

  const onLeave = (event: PointerEvent) => {
    if (press && press.id === event.pointerId) return;
    pointerInside = false;
    root.style.cursor = "";
    holdAutoplay(1.6);
    schedule();
  };

  const onWheel = (event: WheelEvent) => {
    if (!settingsRef.current.wheel) return;
    const n = count();
    if (!n) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
    const delta = clamp((Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * unit, -240, 240);
    const now = clock();
    if (openIndex >= 0) {
      if (now < wheelLockUntil) return;
      wheelAccumulator += delta;
      if (Math.abs(wheelAccumulator) >= 90) {
        setOpen((openIndex + (wheelAccumulator > 0 ? 1 : -1) + n) % n);
        wheelAccumulator = 0;
        wheelLockUntil = now + 0.32;
      }
    } else {
      if (now >= virtualUntil) {
        virtualIndex = pointerInside ? hitTestNearest() : nearestToFocus();
        wheelAccumulator = 0;
      }
      wheelAccumulator += delta;
      while (Math.abs(wheelAccumulator) >= 60) {
        const direction = wheelAccumulator > 0 ? 1 : -1;
        virtualIndex = clamp(virtualIndex + direction, 0, n - 1);
        wheelAccumulator -= direction * 60;
      }
      virtualUntil = now + 1.6;
    }
    holdAutoplay();
    schedule();
  };

  const hitTestNearest = () => {
    const n = count();
    const sx = pointerX - width / 2;
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < n; i++) {
      const distance = Math.abs(sx - bars[i].x);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return best;
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.target !== root) return;
    const n = count();
    if (!n) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const target = event.key === "Home" ? 0 : n - 1;
      if (openIndex >= 0) setOpen(target);
      else {
        virtualIndex = target;
        virtualUntil = clock() + 1.8;
      }
      holdAutoplay();
      schedule();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (openIndex >= 0) setOpen(-1);
      else setOpen(clock() < virtualUntil ? virtualIndex : nearestToFocus());
      holdAutoplay();
    } else if (event.key === "Escape" && openIndex >= 0) {
      event.preventDefault();
      setOpen(-1);
    }
  };

  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerup", onUp);
  stage.addEventListener("pointercancel", onCancel);
  stage.addEventListener("pointerleave", onLeave);
  stage.addEventListener("wheel", onWheel, { passive: false });
  root.addEventListener("keydown", onKey);

  const resizer = new ResizeObserver(() => {
    if (readSize()) schedule();
  });
  resizer.observe(root);

  const observer =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          ([entry]) => {
            visible = entry.isIntersecting;
            if (visible) {
              last = 0;
              schedule();
            } else {
              if (raf) cancelAnimationFrame(raf);
              raf = 0;
            }
          },
          { rootMargin: "80px" },
        );
  if (observer) observer.observe(root);
  else visible = true;

  const onLost = (event: Event) => {
    event.preventDefault();
    lost = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
  const onRestored = () => {
    lost = false;
    itemsKey = "";
    loadPictures();
    schedule();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  readSize();
  syncColors();
  bars[0].mesh.visible = true;
  renderer.compile(scene, camera);
  bars[0].mesh.visible = false;
  loadPictures();
  schedule();

  return {
    sync: () => {
      readSize();
      syncColors();
      loadPictures();
      captionIndex = -1;
      labelIndex = -1;
      schedule();
    },
    open: (index: number) => {
      setOpen(index);
      holdAutoplay();
    },
    close: () => setOpen(-1),
    step,
    destroy: () => {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      if (timer) view.clearTimeout(timer);
      observer?.disconnect();
      resizer.disconnect();
      stage.removeEventListener("pointerdown", onDown);
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerup", onUp);
      stage.removeEventListener("pointercancel", onCancel);
      stage.removeEventListener("pointerleave", onLeave);
      stage.removeEventListener("wheel", onWheel);
      root.removeEventListener("keydown", onKey);
      root.style.cursor = "";
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      pictures.forEach((picture) => {
        picture.image.onload = null;
        picture.texture.dispose();
      });
      bars.forEach((bar) => bar.mesh.material.dispose());
      blank.dispose();
      plane.dispose();
      renderer.dispose();
      if (!renderer.getContext().isContextLost()) renderer.forceContextLoss();
      canvas.remove();
    },
  };
};

export const ElasticReel = forwardRef<ElasticReelHandle, ElasticReelProps>(function ElasticReel(
  {
    items = defaultItems,
    defaultOpen = -1,
    barWidth = 44,
    barHeight = 0.5,
    gap = 10,
    radius = 12,
    magnify = 2.4,
    lift = 1.15,
    influence = 200,
    align = "center",
    openSize = 0.72,
    openAspect = 1,
    elasticity = 0.35,
    blur = 0.5,
    dim = 0.45,
    shadow = 0.35,
    rim = 0.12,
    autoplay = "sweep",
    speed = 1.4,
    interval = 4,
    pauseOnHover = true,
    draggable = true,
    wheel = true,
    captions = true,
    labels = true,
    backgroundColor = "transparent",
    paused = false,
    dpr = 2,
    ariaLabel = "Elastic reel. Hover, scroll or use the arrow keys to browse, and click a photo to open it.",
    onOpen,
    onClose,
    className,
    style,
  },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const subtitleRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const controllerRef = useRef<Controller | null>(null);
  const reduced = useSyncExternalStore(subscribeToMotion, readMotion, () => false);
  const list = items.length ? items : defaultItems;
  const itemsRef = useRef(list);
  const [initialOpen] = useState(() => Math.round(defaultOpen));
  const [openIndex, setOpenIndex] = useState(-1);
  const [failed, setFailed] = useState(false);

  const settings: Settings = {
    barWidth,
    barHeight,
    gap,
    radius,
    magnify,
    lift,
    influence,
    align,
    openSize,
    openAspect,
    elasticity,
    blur,
    dim,
    shadow,
    rim,
    autoplay,
    speed,
    interval,
    pauseOnHover,
    draggable,
    wheel,
    captions,
    labels,
    backgroundColor,
    paused,
    dpr,
    reduced,
  };
  const settingsRef = useRef(settings);
  const callbacksRef = useRef({ onOpen, onClose });

  useEffect(() => {
    settingsRef.current = settings;
    itemsRef.current = list;
    callbacksRef.current = { onOpen, onClose };
    controllerRef.current?.sync();
  });

  useEffect(() => {
    const root = rootRef.current;
    const stage = stageRef.current;
    const caption = captionRef.current;
    const title = titleRef.current;
    const subtitle = subtitleRef.current;
    const label = labelRef.current;
    if (!root || !stage || !caption || !title || !subtitle || !label) return;
    const controller = createReel(
      root,
      stage,
      { caption, title, subtitle, label },
      settingsRef,
      itemsRef,
      initialOpen,
      {
        onOpen: (index) => {
          setOpenIndex(index);
          const item = itemsRef.current[index];
          if (item) callbacksRef.current.onOpen?.(item, index);
        },
        onClose: () => {
          setOpenIndex(-1);
          callbacksRef.current.onClose?.();
        },
      },
    );
    if (!controller) {
      const frame = requestAnimationFrame(() => setFailed(true));
      return () => cancelAnimationFrame(frame);
    }
    controllerRef.current = controller;
    return () => {
      controller.destroy();
      controllerRef.current = null;
    };
  }, [initialOpen]);

  useImperativeHandle(
    ref,
    () => ({
      open: (index: number) => controllerRef.current?.open(index),
      close: () => controllerRef.current?.close(),
      next: () => controllerRef.current?.step(1),
      previous: () => controllerRef.current?.step(-1),
    }),
    [],
  );

  const backgroundValue = backgroundColor.trim().toLowerCase();
  const transparent = backgroundValue === "transparent" || backgroundValue === "";
  const light = !transparent && isLight(backgroundValue);
  const ink = transparent ? "currentColor" : light ? "#0a0a0a" : "#fafafa";
  const opened = openIndex >= 0 ? list[openIndex] : null;

  return (
    <div
      ref={rootRef}
      className={cn(
        "relative h-full min-h-[420px] w-full overflow-hidden outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color-mix(in_oklch,currentColor_35%,transparent)]",
        className,
      )}
      style={{ backgroundColor: transparent ? undefined : backgroundColor, color: ink, ...style }}
      role="region"
      aria-roledescription="carousel"
      aria-label={ariaLabel}
      tabIndex={0}
    >
      <div ref={stageRef} style={stageStyle} />
      {failed ? (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap }}>
          {list.slice(0, 12).map((item, index) => (
            <img
              key={`${item.src}-${index}`}
              src={item.src}
              alt={item.alt}
              style={{ width: barWidth, height: "50%", objectFit: "cover", borderRadius: radius }}
            />
          ))}
        </div>
      ) : null}
      <ul style={hiddenStyle}>
        {list.map((item, index) => (
          <li key={`${item.src}-${index}`}>
            {item.title ? `${item.title}${item.subtitle ? `, ${item.subtitle}` : ""}` : item.alt}
          </li>
        ))}
      </ul>
      <div aria-live="polite" style={hiddenStyle}>
        {opened ? `Opened ${opened.title ?? opened.alt}` : ""}
      </div>
      <span ref={labelRef} aria-hidden="true" style={labelStyle} />
      <div ref={captionRef} aria-hidden="true" style={captionStyle}>
        <span ref={titleRef} style={titleStyle} />
        <span ref={subtitleRef} style={subtitleStyle} />
      </div>
    </div>
  );
});

ElasticReel.displayName = "ElasticReel";

export default ElasticReel;
