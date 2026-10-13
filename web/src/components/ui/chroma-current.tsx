"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import * as THREE from "three";
import { cn } from "@/lib/utils";

export type ChromaCurrentShape = "circle" | "square";
export type ChromaCurrentPattern = "streams" | "waves" | "vortex" | "radial" | "contours";

export interface ChromaCurrentHandle {
  plume: (x?: number, y?: number, strength?: number) => void;
  replay: () => void;
}

export interface ChromaCurrentProps {
  colors?: [string, string];
  backgroundColor?: string;
  pattern?: ChromaCurrentPattern;
  centerX?: number;
  centerY?: number;
  scale?: number;
  pitch?: number;
  dotSize?: number;
  variance?: number;
  shape?: ChromaCurrentShape;
  baseDots?: number;
  stretch?: number;
  streams?: number;
  spread?: number;
  speed?: number;
  direction?: number;
  turbulence?: number;
  trail?: number;
  intensity?: number;
  bloom?: number;
  grain?: number;
  interactive?: boolean;
  stir?: number;
  plume?: number;
  intro?: boolean;
  paused?: boolean;
  dpr?: number;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

interface Settings {
  colors: [string, string];
  backgroundColor: string;
  pattern: ChromaCurrentPattern;
  centerX: number;
  centerY: number;
  scale: number;
  pitch: number;
  dotSize: number;
  variance: number;
  shape: ChromaCurrentShape;
  baseDots: number;
  stretch: number;
  streams: number;
  spread: number;
  speed: number;
  direction: number;
  turbulence: number;
  trail: number;
  intensity: number;
  bloom: number;
  grain: number;
  interactive: boolean;
  stir: number;
  plume: number;
  intro: boolean;
  paused: boolean;
  dpr: number;
  reduced: boolean;
}

interface Controller {
  sync: () => void;
  plume: (x?: number, y?: number, strength?: number) => void;
  replay: () => void;
  destroy: () => void;
}

interface Impulse {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
}

const MAX_PARTICLES = 16000;
const PATTERNS: ChromaCurrentPattern[] = ["streams", "waves", "vortex", "radial", "contours"];
const FLOW_COLUMNS = 64;
const MAX_IMPULSES = 40;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const finite = (value: number, fallback: number) =>
  Number.isFinite(value) ? value : fallback;

const scratchColor = new THREE.Color();

const parseColor = (value: string): [number, number, number] | null => {
  const text = value.trim().toLowerCase();
  if (!text || text === "transparent" || text === "none" || text === "auto") return null;
  try {
    scratchColor.setStyle(text, THREE.NoColorSpace);
  } catch {
    return null;
  }
  return [scratchColor.r, scratchColor.g, scratchColor.b];
};

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toGamma = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

const toOklab = ([r, g, b]: [number, number, number]) => {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};

const fromOklab = ([L, A, B]: number[]): [number, number, number] => {
  const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
  const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
  const s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
  return [
    clamp(toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), 0, 1),
    clamp(toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), 0, 1),
    clamp(toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s), 0, 1),
  ];
};

const PERM = (() => {
  const base = Array.from({ length: 256 }, (_, i) => i);
  let state = 1337;
  for (let i = 255; i > 0; i--) {
    state = (state * 16807) % 2147483647;
    const j = state % (i + 1);
    const swap = base[i];
    base[i] = base[j];
    base[j] = swap;
  }
  const table = new Uint8Array(512);
  for (let i = 0; i < 512; i++) table[i] = base[i & 255];
  return table;
})();

const fadeCurve = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

const gradient = (hash: number, x: number, y: number, z: number) => {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
};

const noise3 = (x: number, y: number, z: number) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const X = xi & 255;
  const Y = yi & 255;
  const Z = zi & 255;
  const fx = x - xi;
  const fy = y - yi;
  const fz = z - zi;
  const u = fadeCurve(fx);
  const v = fadeCurve(fy);
  const w = fadeCurve(fz);
  const A = PERM[X] + Y;
  const AA = PERM[A] + Z;
  const AB = PERM[A + 1] + Z;
  const B = PERM[X + 1] + Y;
  const BA = PERM[B] + Z;
  const BB = PERM[B + 1] + Z;
  const lerp = (t: number, a: number, b: number) => a + t * (b - a);
  return lerp(
    w,
    lerp(
      v,
      lerp(u, gradient(PERM[AA], fx, fy, fz), gradient(PERM[BA], fx - 1, fy, fz)),
      lerp(u, gradient(PERM[AB], fx, fy - 1, fz), gradient(PERM[BB], fx - 1, fy - 1, fz)),
    ),
    lerp(
      v,
      lerp(u, gradient(PERM[AA + 1], fx, fy, fz - 1), gradient(PERM[BA + 1], fx - 1, fy, fz - 1)),
      lerp(u, gradient(PERM[AB + 1], fx, fy - 1, fz - 1), gradient(PERM[BB + 1], fx - 1, fy - 1, fz - 1)),
    ),
  );
};

const subscribeToMotion = (notify: () => void) => {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};

const readMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const passVertex = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const dotsFragment = `
uniform sampler2D uEnergy;
uniform sampler2D uFlow;
uniform vec2 uGrid;
uniform vec2 uOrigin;
uniform float uPitch;
uniform float uMaxRadius;
uniform float uBaseRadius;
uniform float uBase;
uniform float uGain;
uniform float uStretch;
uniform float uVariance;
uniform float uSquare;
uniform float uInk;
uniform float uFade;
uniform vec3 uBaseColor;
varying vec2 vUv;

float shape(vec2 q, float radius) {
  if (uSquare > 0.5) {
    vec2 d = abs(q) - vec2(radius * 0.86);
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  }
  return length(q) - radius;
}

void main() {
  vec2 frag = gl_FragCoord.xy - uOrigin;
  vec2 cell = floor(frag / uPitch);
  if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= uGrid.x || cell.y >= uGrid.y) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec2 local = frag - (cell + 0.5) * uPitch;
  vec2 uv = (cell + 0.5) / uGrid;
  vec4 energy = texture2D(uEnergy, uv);
  vec2 flow = texture2D(uFlow, uv).rg;
  float amount = max(energy.a, 0.0);
  float lit = (1.0 - exp(-amount * uGain)) * uFade;
  vec3 tint = energy.rgb / max(amount, 0.0001);
  float speed = length(flow) / max(amount, 0.0001);
  vec2 along = speed > 0.00001 ? flow / (speed * max(amount, 0.0001)) : vec2(1.0, 0.0);
  vec2 across = vec2(-along.y, along.x);
  float stretch = 1.0 + uStretch * clamp(speed * 6.0, 0.0, 1.6) * smoothstep(0.02, 0.3, lit);
  float halftone = mix(uBaseRadius, uMaxRadius, sqrt(lit));
  float panel = uMaxRadius * (0.72 + 0.28 * smoothstep(0.0, 0.45, lit));
  float radius = mix(panel, halftone, uVariance);
  vec2 q = vec2(dot(local, along) / stretch, dot(local, across));
  float d = shape(q, radius);
  float cover = 1.0 - smoothstep(-0.65, 0.65, d);
  float baseCover = (1.0 - smoothstep(-0.6, 0.6, shape(local, uBaseRadius))) * uBase * (1.0 - lit);
  if (uInk > 0.5) {
    float a = clamp(cover * lit * 2.3, 0.0, 1.0);
    vec3 color = tint * a;
    gl_FragColor = vec4(color + uBaseColor * baseCover * 0.5, a + baseCover * 0.5);
    return;
  }
  vec3 emission = tint * lit * cover * 1.6 + vec3(1.0) * max(lit - 0.82, 0.0) * cover * 0.8;
  gl_FragColor = vec4(emission + uBaseColor * baseCover, 1.0);
}
`;

const downFragment = `
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
vec3 tap(vec2 d) {
  vec3 c = texture2D(uSource, vUv + d * uTexel).rgb;
  float peak = max(c.r, max(c.g, c.b));
  return c * (max(peak - uThreshold, 0.0) / max(peak, 0.0001));
}
void main() {
  vec3 a = tap(vec2(-2.0, 2.0));
  vec3 b = tap(vec2(0.0, 2.0));
  vec3 c = tap(vec2(2.0, 2.0));
  vec3 d = tap(vec2(-2.0, 0.0));
  vec3 e = tap(vec2(0.0, 0.0));
  vec3 f = tap(vec2(2.0, 0.0));
  vec3 g = tap(vec2(-2.0, -2.0));
  vec3 h = tap(vec2(0.0, -2.0));
  vec3 i = tap(vec2(2.0, -2.0));
  vec3 j = tap(vec2(-1.0, 1.0));
  vec3 k = tap(vec2(1.0, 1.0));
  vec3 l = tap(vec2(-1.0, -1.0));
  vec3 m = tap(vec2(1.0, -1.0));
  vec3 color = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  gl_FragColor = vec4(color, 1.0);
}
`;

const upFragment = `
uniform sampler2D uSource;
uniform vec2 uTexel;
varying vec2 vUv;
vec3 tap(vec2 d) { return texture2D(uSource, vUv + d * uTexel).rgb; }
void main() {
  vec3 color = tap(vec2(0.0)) * 4.0
    + (tap(vec2(-1.0, 0.0)) + tap(vec2(1.0, 0.0)) + tap(vec2(0.0, -1.0)) + tap(vec2(0.0, 1.0))) * 2.0
    + tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0));
  gl_FragColor = vec4(color / 16.0, 1.0);
}
`;

const compositeFragment = `
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec3 uBackground;
uniform float uBloomStrength;
uniform float uGrain;
uniform float uTime;
uniform float uInk;
varying vec2 vUv;

vec3 neutral(vec3 color) {
  const float start = 0.76;
  const float desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < start) return color;
  const float d = 1.0 - start;
  float next = 1.0 - d * d / (peak + d - start);
  color *= next / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - next) + 1.0);
  return mix(color, vec3(next), g);
}

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec4 scene = texture2D(uScene, vUv);
  float n = hash(gl_FragCoord.xy + fract(uTime * 13.0) * 911.0) - 0.5;
  if (uInk > 0.5) {
    float cover = clamp(scene.a, 0.0, 1.0);
    vec3 ink = scene.rgb / max(scene.a, 0.0001);
    vec3 color = mix(uBackground, ink, cover);
    color += n * uGrain * 0.05 * smoothstep(0.0, 0.05, cover);
    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    return;
  }
  vec3 emission = scene.rgb + texture2D(uBloom, vUv).rgb * uBloomStrength;
  vec3 light = neutral(max(emission, 0.0));
  light = pow(light, vec3(1.0 / 2.2));
  vec3 color = 1.0 - (1.0 - uBackground) * (1.0 - light);
  float l = max(light.r, max(light.g, light.b));
  float mask = smoothstep(0.0, 0.04, l);
  color += n * uGrain * 0.1 * mask;
  color += (hash(gl_FragCoord.xy * 1.7) - 0.5) / 255.0 * mask;
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

function createCurrent(
  root: HTMLDivElement,
  stage: HTMLDivElement,
  settingsRef: { current: Settings },
): Controller | null {
  const doc = root.ownerDocument;
  const view = doc.defaultView ?? window;
  const canvas = doc.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: false,
      antialias: false,
      powerPreference: "high-performance",
    });
  } catch {
    return null;
  }
  stage.appendChild(canvas);
  renderer.autoClear = false;

  const settings = () => settingsRef.current;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  const quadGeometry = new THREE.PlaneGeometry(2, 2);
  const quadScene = new THREE.Scene();
  const quad = new THREE.Mesh(quadGeometry);
  quad.frustumCulled = false;
  quadScene.add(quad);

  let columns = 1;
  let rows = 1;
  let energy = new Float32Array(4);
  let flow = new Float32Array(2);
  let energyTexture = new THREE.DataTexture(energy, 1, 1, THREE.RGBAFormat, THREE.FloatType);
  let flowTexture = new THREE.DataTexture(flow, 1, 1, THREE.RGFormat, THREE.FloatType);

  const background = new THREE.Vector3(0.04, 0.04, 0.04);
  const baseColor = new THREE.Vector3(0.1, 0.06, 0.3);

  const dotsMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uEnergy: { value: energyTexture },
      uFlow: { value: flowTexture },
      uGrid: { value: new THREE.Vector2(1, 1) },
      uOrigin: { value: new THREE.Vector2(0, 0) },
      uPitch: { value: 20 },
      uMaxRadius: { value: 7 },
      uBaseRadius: { value: 1.2 },
      uBase: { value: 0.12 },
      uGain: { value: 0.7 },
      uStretch: { value: 0.35 },
      uVariance: { value: 0.35 },
      uSquare: { value: 0 },
      uInk: { value: 0 },
      uFade: { value: 1 },
      uBaseColor: { value: baseColor },
    },
    vertexShader: passVertex,
    fragmentShader: dotsFragment,
    depthTest: false,
    depthWrite: false,
  });

  const target = () =>
    new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
  const sceneTarget = target();
  const bloomTargets = Array.from({ length: 5 }, target);
  const downMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uSource: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 0 },
    },
    vertexShader: passVertex,
    fragmentShader: downFragment,
    depthTest: false,
    depthWrite: false,
  });
  const upMaterial = new THREE.ShaderMaterial({
    uniforms: { uSource: { value: null }, uTexel: { value: new THREE.Vector2() } },
    vertexShader: passVertex,
    fragmentShader: upFragment,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const compositeMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uScene: { value: sceneTarget.texture },
      uBloom: { value: bloomTargets[0].texture },
      uBackground: { value: background },
      uBloomStrength: { value: 0.6 },
      uGrain: { value: 0.2 },
      uTime: { value: 0 },
      uInk: { value: 0 },
    },
    vertexShader: passVertex,
    fragmentShader: compositeFragment,
    depthTest: false,
    depthWrite: false,
  });

  const px = new Float32Array(MAX_PARTICLES);
  const py = new Float32Array(MAX_PARTICLES);
  const age = new Float32Array(MAX_PARTICLES);
  const life = new Float32Array(MAX_PARTICLES);
  const weight = new Float32Array(MAX_PARTICLES);
  const tone = new Float32Array(MAX_PARTICLES);
  const dye = new Uint8Array(MAX_PARTICLES);
  let count = 0;
  let flowW = FLOW_COLUMNS;
  let flowH = 32;
  let psi = new Float32Array((flowW + 1) * (flowH + 1));
  let psiFull = new Float32Array((flowW + 1) * (flowH + 1));
  let bandNode = new Float32Array((flowW + 1) * (flowH + 1));
  let cyclic = false;
  let wrapped = false;
  let velX = new Float32Array(flowW * flowH);
  let velY = new Float32Array(flowW * flowH);
  const palette: [number, number, number][] = Array.from({ length: 33 }, () => [1, 1, 1]);
  const impulses: Impulse[] = [];

  let width = 0;
  let height = 0;
  let aspect = 1;
  let dpr = 1;
  let sized = false;
  let gridKey = "";
  let colorKey = "";
  let ink = false;
  let page: [number, number, number] = [0.04, 0.04, 0.04];
  let backgroundAt = -10;
  let travel = 0;
  let evolve = 0;
  let hue = 0;
  let clock = 0;
  let fade = 0;
  let introStart = -1;
  let raf = 0;
  let last = 0;
  let visible = false;
  let destroyed = false;
  let lost = false;
  let seed = 7;
  let pointer: { x: number; y: number; t: number } | null = null;
  let press: { id: number; x: number; y: number; time: number } | null = null;

  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  const readPage = (): [number, number, number] => {
    let node: HTMLElement | null = root.parentElement;
    while (node) {
      const fill = view.getComputedStyle(node).backgroundColor;
      const match = fill.match(/rgba?\(([^)]+)\)/);
      if (match) {
        const parts = match[1].split(",").map((part) => Number.parseFloat(part));
        if (parts.length < 4 || parts[3] > 0.05)
          return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
      }
      node = node.parentElement;
    }
    const text = view.getComputedStyle(root).color.match(/rgba?\(([^)]+)\)/);
    if (text) {
      const parts = text[1].split(",").map((part) => Number.parseFloat(part));
      return parts[0] + parts[1] + parts[2] > 382 ? [0.04, 0.04, 0.04] : [1, 1, 1];
    }
    return [0.04, 0.04, 0.04];
  };

  const syncColors = () => {
    const s = settings();
    page = parseColor(s.backgroundColor) ?? readPage();
    const key = [page.join(","), s.colors[0], s.colors[1]].join("|");
    if (key === colorKey) return;
    colorKey = key;
    ink = 0.2126 * page[0] + 0.7152 * page[1] + 0.0722 * page[2] > 0.55;
    background.set(page[0], page[1], page[2]);
    const first = toOklab(parseColor(s.colors[0]) ?? [0.32, 0.15, 1]);
    const second = toOklab(parseColor(s.colors[1]) ?? [1, 0.62, 0.99]);
    const chromaOf = (lab: number[]) => Math.hypot(lab[1], lab[2]);
    const adapt = (lab: number[], other: number[]) => {
      if (!ink) return lab;
      let source = lab;
      if (chromaOf(lab) < 0.03 && chromaOf(other) >= 0.03) source = other;
      const chroma = chromaOf(source);
      if (chroma < 0.03) return [0.3, 0, 0];
      const scale = Math.max(1, 0.15 / chroma);
      return [clamp(source[0], 0.34, 0.52), source[1] * scale, source[2] * scale];
    };
    const a = adapt(first, second);
    const b = adapt(second, first);
    for (let i = 0; i < palette.length; i++) {
      const t = i / (palette.length - 1);
      const rgb = fromOklab([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
      palette[i] = ink ? rgb : [toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])];
    }
    const dim = fromOklab([ink ? 0.82 : 0.32, a[1] * 0.5, a[2] * 0.5]);
    if (ink) baseColor.set(dim[0], dim[1], dim[2]);
    else baseColor.set(toLinear(dim[0]) * 0.55, toLinear(dim[1]) * 0.55, toLinear(dim[2]) * 0.55);
    dotsMaterial.uniforms.uInk.value = ink ? 1 : 0;
    compositeMaterial.uniforms.uInk.value = ink ? 1 : 0;
  };

  const tint = (t: number): [number, number, number] =>
    palette[Math.round(clamp(t, 0, 1) * (palette.length - 1))];

  const readSize = () => {
    const s = settings();
    const nextWidth = Math.round(root.clientWidth);
    const nextHeight = Math.round(root.clientHeight);
    if (nextWidth < 2 || nextHeight < 2) {
      sized = false;
      return false;
    }
    const nextDpr = Math.min(view.devicePixelRatio || 1, clamp(finite(s.dpr, 2), 0.5, 3));
    if (sized && nextWidth === width && nextHeight === height && nextDpr === dpr) return false;
    sized = true;
    width = nextWidth;
    height = nextHeight;
    aspect = width / height;
    dpr = nextDpr;
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    sceneTarget.setSize(Math.round(width * dpr), Math.round(height * dpr));
    let w = Math.round(width * dpr);
    let h = Math.round(height * dpr);
    for (const bloomTarget of bloomTargets) {
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
      bloomTarget.setSize(w, h);
    }
    gridKey = "";
    return true;
  };

  const ensureGrid = () => {
    const s = settings();
    const pitch = Math.max(3, Math.round(clamp(finite(s.pitch, 8), 4, 48) * dpr));
    const key = [width, height, dpr, pitch].join("|");
    if (key === gridKey) return;
    gridKey = key;
    const deviceW = Math.round(width * dpr);
    const deviceH = Math.round(height * dpr);
    columns = Math.ceil(deviceW / pitch) + 1;
    rows = Math.ceil(deviceH / pitch) + 1;
    energy = new Float32Array(columns * rows * 4);
    flow = new Float32Array(columns * rows * 2);
    energyTexture.dispose();
    flowTexture.dispose();
    energyTexture = new THREE.DataTexture(energy, columns, rows, THREE.RGBAFormat, THREE.FloatType);
    flowTexture = new THREE.DataTexture(flow, columns, rows, THREE.RGFormat, THREE.FloatType);
    for (const texture of [energyTexture, flowTexture]) {
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      texture.needsUpdate = true;
    }
    const u = dotsMaterial.uniforms;
    u.uEnergy.value = energyTexture;
    u.uFlow.value = flowTexture;
    u.uGrid.value.set(columns, rows);
    u.uPitch.value = pitch;
    u.uOrigin.value.set((deviceW - columns * pitch) / 2, (deviceH - rows * pitch) / 2);
    flowW = FLOW_COLUMNS;
    flowH = Math.max(12, Math.round(FLOW_COLUMNS / Math.max(aspect, 0.3)));
    psi = new Float32Array((flowW + 1) * (flowH + 1));
    psiFull = new Float32Array((flowW + 1) * (flowH + 1));
    bandNode = new Float32Array((flowW + 1) * (flowH + 1));
    velX = new Float32Array(flowW * flowH);
    velY = new Float32Array(flowW * flowH);
  };

  const drift = () => clamp(finite(settings().speed, 0.6), 0, 3) * 0.25;

  const updateFlow = () => {
    const s = settings();
    const d = drift();
    const kind = s.pattern;
    const theta = (clamp(finite(s.direction, 0), -360, 360) * Math.PI) / 180;
    const c = Math.cos(theta);
    const sn = Math.sin(theta);
    const spin = finite(s.direction, 0) < 0 ? -1 : 1;
    const meander = clamp(finite(s.turbulence, 0.6), 0, 2) * 0.3;
    const size = clamp(finite(s.scale, 1), 0.25, 4);
    const extent = aspect * Math.abs(sn) + Math.abs(c);
    const centerX = clamp(finite(s.centerX, 0.5), -1, 2) * aspect;
    const centerY = 1 - clamp(finite(s.centerY, 0.5), -1, 2);
    const reach = Math.max(
      Math.hypot(centerX, centerY),
      Math.hypot(aspect - centerX, centerY),
      Math.hypot(centerX, 1 - centerY),
      Math.hypot(aspect - centerX, 1 - centerY),
      0.2,
    );
    const contourFrequency = 1.7 / size;
    const twist = kind === "vortex" ? 1.35 * size * spin : 0;
    const wavelength = 0.9 * size;
    cyclic = kind === "radial" || kind === "vortex";
    wrapped = cyclic;
    const frequency = 1.35;
    const shift = travel * frequency * 0.6;
    for (let j = 0; j <= flowH; j++) {
      const y = j / flowH;
      const oy = y - 0.5;
      for (let i = 0; i <= flowW; i++) {
        const x = (i / flowW) * aspect;
        const ox = x - aspect / 2;
        const along = ox * c + oy * sn;
        const across = -ox * sn + oy * c;
        const flowing = kind === "streams";
        const n =
          noise3(along * frequency - (flowing ? shift : 0), across * frequency * 1.2, evolve) +
          0.42 *
            noise3(
              along * frequency * 2.2 + 7.3 - (flowing ? shift * 1.3 : 0),
              across * frequency * 2.3 - 3.1,
              evolve * 1.6 + 11.7,
            ) +
          0.16 *
            noise3(
              along * frequency * 4.6 - 2.1 - (flowing ? shift * 1.7 : 0),
              across * frequency * 4.4 + 5.7,
              evolve * 2.3 + 3.3,
            );
        const node = j * (flowW + 1) + i;
        if (kind === "waves") {
          const phase = (along / wavelength) * Math.PI * 2 + across * 3.5 + Math.sin(evolve * 2.1) * 1.2;
          const swing = 0.075 * (Math.sin(phase) + 0.35 * Math.sin(phase * 2 + 1.3 + evolve));
          const value = (across + swing + meander * 0.3 * n) / extent;
          psi[node] = value;
          bandNode[node] = value + 0.5;
        } else if (kind === "vortex" || kind === "radial") {
          const rho = Math.hypot(x - centerX, y - centerY) / reach;
          const angle = Math.atan2(y - centerY, x - centerX);
          const value = angle / (Math.PI * 2) + 0.5 + twist * rho + meander * 0.035 * n;
          psi[node] = value;
          bandNode[node] = value - Math.floor(value);
        } else if (kind === "contours") {
          const field =
            0.62 * noise3(x * contourFrequency, y * contourFrequency, evolve * 0.9) +
            0.38 * noise3(x * contourFrequency * 2.1 + 5.2, y * contourFrequency * 2.1 - 3.4, evolve * 1.4 + 7.7) +
            meander * 0.12 * n;
          psi[node] = field;
          bandNode[node] = field / 1.1 + 0.5;
        } else {
          const value = (across + meander * n) / extent;
          psi[node] = value;
          bandNode[node] = value + 0.5;
        }
      }
    }
    const velocityScale =
      kind === "vortex"
        ? d / Math.hypot(1 / (Math.PI * 2 * 0.4 * reach), twist / reach)
        : kind === "radial"
          ? d * Math.PI * 2 * 0.4 * reach
          : kind === "contours"
            ? (d * spin * 1.2) / contourFrequency
            : d * extent;
    const hx = aspect / flowW;
    const hy = 1 / flowH;
    const now = clock;
    const strength = clamp(finite(s.stir, 1), 0, 3);
    const live = impulses.filter((impulse) => now - impulse.born < 1.6);
    for (let j = 0; j <= flowH; j++) {
      const y = j * hy;
      for (let i = 0; i <= flowW; i++) {
        const x = i * hx;
        let value = 0;
        for (const impulse of live) {
          const remaining = 1 - (now - impulse.born) / 1.6;
          const dx = x - impulse.x;
          const dy = y - impulse.y;
          const falloff = Math.exp(-(dx * dx + dy * dy) / 0.02) * remaining * remaining;
          value += (impulse.vx * dy - impulse.vy * dx) * falloff * strength;
        }
        psiFull[j * (flowW + 1) + i] = value;
      }
    }
    const limit = d * 3 + 0.0001;
    const wrap = (t: number) => (wrapped ? t - Math.round(t) : t);
    for (let j = 0; j < flowH; j++) {
      for (let i = 0; i < flowW; i++) {
        const node = j * (flowW + 1) + i;
        const a = psi[node];
        const b = psi[node + 1];
        const e = psi[node + flowW + 1];
        const f = psi[node + flowW + 2];
        const dy = (wrap(e - a) + wrap(f - b)) / (2 * hy);
        const dx = (wrap(b - a) + wrap(f - e)) / (2 * hx);
        const mean = a + (wrap(b - a) + wrap(e - a) + wrap(f - a)) / 4;
        const level =
          kind === "contours"
            ? mean / 1.1 + 0.5
            : cyclic
              ? mean - Math.floor(mean)
              : mean + 0.5;
        const pace = 0.62 + 0.76 * (0.5 + 0.5 * Math.sin(level * Math.PI * 6 + 0.9));
        let vx = dy * velocityScale * pace;
        let vy = -dx * velocityScale * pace;
        const speed = Math.hypot(vx, vy);
        if (speed > limit) {
          vx *= limit / speed;
          vy *= limit / speed;
        }
        const ia = psiFull[node];
        const ib = psiFull[node + 1];
        const ie = psiFull[node + flowW + 1];
        const iff = psiFull[node + flowW + 2];
        vx += (ie + iff - ia - ib) / (2 * hy);
        vy += -(ib + iff - ia - ie) / (2 * hx);
        velX[j * flowW + i] = vx;
        velY[j * flowW + i] = vy;
      }
    }
    for (let n = impulses.length - 1; n >= 0; n--)
      if (now - impulses[n].born > 1.6) impulses.splice(n, 1);
  };

  const sampleField = (field: Float32Array, x: number, y: number, w: number, h: number) => {
    const fx = clamp((x / aspect) * w - 0.5, 0, w - 1.001);
    const fy = clamp(y * h - 0.5, 0, h - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const a = field[j * w + i];
    const b = field[j * w + i + 1];
    const c = field[(j + 1) * w + i];
    const d = field[(j + 1) * w + i + 1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };

  const sampleBand = (x: number, y: number) => {
    const fx = clamp((x / aspect) * flowW, 0, flowW - 0.001);
    const fy = clamp(y * flowH, 0, flowH - 0.001);
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const stride = flowW + 1;
    const a = bandNode[j * stride + i];
    const wrap = (t: number) => (cyclic ? t - Math.round(t) : t);
    const b = a + wrap(bandNode[j * stride + i + 1] - a);
    const c = a + wrap(bandNode[(j + 1) * stride + i] - a);
    const d = a + wrap(bandNode[(j + 1) * stride + i + 1] - a);
    const value = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    return cyclic ? value - Math.floor(value) : value;
  };

  const streamHash = (n: number) => {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
    return x - Math.floor(x);
  };

  const bandOf = (x: number, y: number) => {
    const s = settings();
    const k = clamp(Math.round(finite(s.streams, 4)), 1, 16);
    const value = sampleBand(x, y);
    const base = (clamp(finite(s.spread, 0.5), 0.05, 1.5) * 0.3) / k;
    let best = 0;
    let index = 0;
    for (let i = 0; i < k; i++) {
      const center = (i + 0.5 + (streamHash(i * 3.7 + 1.3) - 0.5) * (cyclic ? 0.3 : 0.55)) / k;
      const width = base * (0.55 + 0.9 * streamHash(i * 5.1 + 2.9));
      let offset = value - center;
      if (cyclic) offset -= Math.round(offset);
      const profile =
        Math.exp(-(offset * offset) / (2 * width * width)) * (0.55 + 0.45 * streamHash(i * 2.3 + 0.7));
      if (profile > best) {
        best = profile;
        index = i;
      }
    }
    return { profile: best, index, count: k };
  };

  const spawn = (p: number, prewarm: boolean) => {
    let x = 0;
    let y = 0;
    let band = { profile: 0, index: 0, count: 1 };
    const margin = 0.18;
    for (let attempt = 0; attempt < 10; attempt++) {
      x = -margin + random() * (aspect + margin * 2);
      y = -margin + random() * (1 + margin * 2);
      band = bandOf(x, y);
      if (random() < band.profile) break;
    }
    px[p] = x;
    py[p] = y;
    life[p] = 2.8 + random() * 3.6;
    age[p] = prewarm ? random() * life[p] : 0;
    const sparkle = random();
    weight[p] = band.profile * (0.22 + 0.78 * sparkle * sparkle * sparkle) * 1.6;
    const base = cyclic
      ? 0.5 - 0.5 * Math.cos((band.index / band.count) * Math.PI * 2)
      : band.count > 1
        ? band.index / (band.count - 1)
        : 0.5;
    tone[p] = clamp(base + (random() - 0.5) * 0.1, 0, 1);
    dye[p] = 0;
  };

  const targetCount = () => {
    const s = settings();
    const k = clamp(Math.round(finite(s.streams, 4)), 1, 16);
    const area = (columns * rows) / 6000;
    const spread = clamp(finite(s.spread, 0.5), 0.05, 1.5);
    return Math.round(clamp(3400 * area * Math.sqrt(k / 4) * (0.6 + spread * 0.8), 600, MAX_PARTICLES - 1200));
  };

  const reseed = (prewarm: boolean) => {
    count = targetCount();
    for (let p = 0; p < count; p++) spawn(p, prewarm);
  };

  const emitPlume = (x: number, y: number, amount: number) => {
    const total = Math.round(clamp(amount, 0, 3) * 110);
    const hue = 0.55 + random() * 0.45;
    for (let n = 0; n < total && count < MAX_PARTICLES; n++) {
      const p = count++;
      const r = Math.sqrt(random()) * 0.055;
      const a = random() * Math.PI * 2;
      px[p] = x + Math.cos(a) * r;
      py[p] = y + Math.sin(a) * r;
      age[p] = random() * 0.25;
      life[p] = 3.2 + random() * 2.8;
      weight[p] = 0.32 + random() * 0.32;
      tone[p] = clamp(hue + (random() - 0.5) * 0.18, 0, 1);
      dye[p] = 1;
    }
  };

  const decayAndSplat = (dt: number) => {
    const s = settings();
    const tau = 0.08 + clamp(finite(s.trail, 0.6), 0, 1.5) * 0.9;
    const keep = Math.exp(-dt / tau);
    for (let i = 0; i < energy.length; i++) energy[i] *= keep;
    for (let i = 0; i < flow.length; i++) flow[i] *= keep;
    const fullW = Math.round(width * dpr);
    const fullH = Math.round(height * dpr);
    const pitch = dotsMaterial.uniforms.uPitch.value as number;
    const originX = (fullW - columns * pitch) / 2;
    const originY = (fullH - rows * pitch) / 2;
    const toCellX = (x: number) => ((x / aspect) * fullW - originX) / pitch - 0.5;
    const toCellY = (y: number) => (y * fullH - originY) / pitch - 0.5;
    const unit = dt * 60;
    for (let p = 0; p < count; p++) {
      const a = age[p];
      const l = life[p];
      const ramp = Math.min(1, a / 0.5) * Math.min(1, (l - a) / 0.7);
      if (ramp <= 0) continue;
      const w = weight[p] * ramp * unit;
      if (w <= 0.0001) continue;
      const cx = toCellX(px[p]);
      const cy = toCellY(py[p]);
      const i = Math.floor(cx);
      const j = Math.floor(cy);
      if (i < -1 || j < -1 || i >= columns || j >= rows) continue;
      const tx = cx - i;
      const ty = cy - j;
      const color = tint(tone[p] + 0.22 * Math.sin(px[p] * 1.7 + hue + tone[p] * 4.0));
      const vx = sampleField(velX, px[p], py[p], flowW, flowH);
      const vy = sampleField(velY, px[p], py[p], flowW, flowH);
      for (let k = 0; k < 4; k++) {
        const ci = i + (k & 1);
        const cj = j + (k >> 1);
        if (ci < 0 || cj < 0 || ci >= columns || cj >= rows) continue;
        const share = ((k & 1) ? tx : 1 - tx) * ((k >> 1) ? ty : 1 - ty) * w;
        const cell = cj * columns + ci;
        energy[cell * 4] += color[0] * share;
        energy[cell * 4 + 1] += color[1] * share;
        energy[cell * 4 + 2] += color[2] * share;
        energy[cell * 4 + 3] += share;
        flow[cell * 2] += vx * share;
        flow[cell * 2 + 1] += vy * share;
      }
    }
    energyTexture.needsUpdate = true;
    flowTexture.needsUpdate = true;
  };

  const advect = (dt: number, aging: number) => {
    let write = 0;
    const baseCount = targetCount();
    for (let p = 0; p < count; p++) {
      age[p] += dt * (dye[p] ? 1 : aging);
      const vx = sampleField(velX, px[p], py[p], flowW, flowH);
      const vy = sampleField(velY, px[p], py[p], flowW, flowH);
      px[p] += vx * dt;
      py[p] += vy * dt;
      const outside = px[p] < -0.25 || px[p] > aspect + 0.25 || py[p] < -0.25 || py[p] > 1.25;
      if (age[p] >= life[p] || outside) {
        if (dye[p] || write >= baseCount) continue;
        spawn(p, false);
      }
      if (write !== p) {
        px[write] = px[p];
        py[write] = py[p];
        age[write] = age[p];
        life[write] = life[p];
        weight[write] = weight[p];
        tone[write] = tone[p];
        dye[write] = dye[p];
      }
      write++;
    }
    count = write;
    while (count < baseCount) spawn(count++, false);
  };

  const applyUniforms = () => {
    const s = settings();
    const pitch = dotsMaterial.uniforms.uPitch.value as number;
    const size = clamp(finite(s.dotSize, 0.62), 0.1, 1);
    const u = dotsMaterial.uniforms;
    u.uMaxRadius.value = pitch * 0.5 * size;
    u.uBaseRadius.value = Math.max(0.6 * dpr, pitch * 0.5 * size * 0.22);
    u.uBase.value = clamp(finite(s.baseDots, 0.12), 0, 1);
    u.uStretch.value = clamp(finite(s.stretch, 0.2), 0, 2);
    u.uVariance.value = clamp(finite(s.variance, 0.35), 0, 1);
    u.uSquare.value = s.shape === "square" ? 1 : 0;
    const tau = 0.08 + clamp(finite(s.trail, 0.6), 0, 1.5) * 0.9;
    u.uGain.value = (clamp(finite(s.intensity, 1), 0, 4) * 1.05) / (60 * tau);
    u.uFade.value = fade;
    compositeMaterial.uniforms.uGrain.value = clamp(finite(s.grain, 0.2), 0, 1);
  };

  const render = () => {
    if (!sized) return;
    const s = settings();
    if (performance.now() - backgroundAt > 1000) {
      backgroundAt = performance.now();
      syncColors();
    }
    ensureGrid();
    applyUniforms();
    if (ink) {
      dotsMaterial.blending = THREE.NoBlending;
    }
    quad.material = dotsMaterial;
    renderer.setRenderTarget(sceneTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(quadScene, camera);
    const bloom = ink ? 0 : clamp(finite(s.bloom, 0.6), 0, 3);
    if (bloom > 0.001) {
      let source: THREE.WebGLRenderTarget = sceneTarget;
      quad.material = downMaterial;
      for (const bloomTarget of bloomTargets) {
        downMaterial.uniforms.uThreshold.value = source === sceneTarget ? 0.25 : 0;
        downMaterial.uniforms.uSource.value = source.texture;
        downMaterial.uniforms.uTexel.value.set(1 / source.width, 1 / source.height);
        renderer.setRenderTarget(bloomTarget);
        renderer.render(quadScene, camera);
        source = bloomTarget;
      }
      quad.material = upMaterial;
      for (let i = bloomTargets.length - 1; i > 0; i--) {
        upMaterial.uniforms.uSource.value = bloomTargets[i].texture;
        upMaterial.uniforms.uTexel.value.set(1 / bloomTargets[i].width, 1 / bloomTargets[i].height);
        renderer.setRenderTarget(bloomTargets[i - 1]);
        renderer.render(quadScene, camera);
      }
    }
    compositeMaterial.uniforms.uBloomStrength.value = bloom;
    compositeMaterial.uniforms.uTime.value = clock;
    quad.material = compositeMaterial;
    renderer.setRenderTarget(null);
    renderer.render(quadScene, camera);
  };

  const simulate = (dt: number) => {
    const speed = clamp(finite(settings().speed, 0.6), 0, 3);
    travel += dt * drift();
    evolve += dt * speed * 0.075;
    hue += dt * speed * 0.2;
    updateFlow();
    advect(dt, Math.min(1, speed / 0.3));
    decayAndSplat(dt);
  };

  const prewarm = (seconds: number) => {
    ensureGrid();
    updateFlow();
    reseed(true);
    const step = 1 / 30;
    for (let t = 0; t < seconds; t += step) simulate(step);
  };

  const schedule = () => {
    if (destroyed || lost || !visible || raf) return;
    raf = requestAnimationFrame(frame);
  };

  const frame = (now: number) => {
    raf = 0;
    if (destroyed || lost) return;
    const s = settings();
    const dt =
      last && now - last < 100 ? Math.min(Math.max((now - last) / 1000, 0), 0.05) : 1 / 60;
    last = now;
    const moving = !s.reduced && !s.paused;
    if (count === 0) {
      ensureGrid();
      prewarm(s.reduced || !s.intro ? 3 : 1.2);
      if (s.reduced || !s.intro) fade = 1;
    }
    if (moving) {
      clock += dt;
      simulate(dt);
    }
    if (s.intro && !s.reduced && fade < 1) {
      if (introStart < 0) introStart = now;
      const progress = clamp((now - introStart) / 2200, 0, 1);
      fade = progress * progress * (3 - 2 * progress);
    } else fade = 1;
    render();
    if (moving && !document.hidden) raf = requestAnimationFrame(frame);
    else last = 0;
  };

  const isControl = (target: EventTarget | null) => {
    const element = target as Element | null;
    return (
      !!element &&
      typeof element.closest === "function" &&
      !!element.closest("a,button,input,textarea,select,label,summary,[role=button],[contenteditable=true]")
    );
  };

  const local = (event: PointerEvent) => {
    const box = root.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    return {
      x: ((event.clientX - box.left) / box.width) * aspect,
      y: 1 - (event.clientY - box.top) / box.height,
    };
  };

  const onPointerMove = (event: PointerEvent) => {
    const s = settings();
    if (!s.interactive || s.reduced || s.paused) return;
    const at = local(event);
    if (!at) return;
    const now = clock;
    if (!pointer || now - pointer.t > 0.25) {
      pointer = { x: at.x, y: at.y, t: now };
      return;
    }
    const dx = at.x - pointer.x;
    const dy = at.y - pointer.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 0.035) return;
    const elapsed = Math.max(0.012, now - pointer.t);
    const speed = Math.min(distance / elapsed, 3);
    const scale = (speed / Math.max(distance, 0.0001)) * 0.12;
    impulses.push({ x: at.x, y: at.y, vx: dx * scale, vy: dy * scale, born: now });
    if (impulses.length > MAX_IMPULSES) impulses.shift();
    pointer = { x: at.x, y: at.y, t: now };
  };

  const onPointerLeave = () => {
    pointer = null;
    press = null;
  };

  const onPointerDown = (event: PointerEvent) => {
    const s = settings();
    press = null;
    if (!s.interactive || s.reduced || s.paused || !event.isPrimary) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (isControl(event.target)) return;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now() };
  };

  const onPointerUp = (event: PointerEvent) => {
    const tap = press;
    press = null;
    if (!tap || tap.id !== event.pointerId) return;
    const s = settings();
    if (!s.interactive || s.reduced || s.paused) return;
    if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 10) return;
    if (performance.now() - tap.time > 500) return;
    const at = local(event);
    if (!at) return;
    emitPlume(at.x, at.y, clamp(finite(s.plume, 1), 0, 3));
    schedule();
  };

  const onVisibility = () => {
    last = 0;
    schedule();
  };

  const onLost = (event: Event) => {
    event.preventDefault();
    lost = true;
    cancelAnimationFrame(raf);
    raf = 0;
  };

  const onRestored = () => {
    lost = false;
    gridKey = "";
    schedule();
  };

  const resizeObserver = new ResizeObserver(() => {
    if (readSize()) {
      ensureGrid();
      if (count > 0) reseed(true);
      render();
      schedule();
    }
  });

  const intersection = new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting;
      last = 0;
      schedule();
    },
    { rootMargin: "120px" },
  );

  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointerup", onPointerUp);
  root.addEventListener("pointerleave", onPointerLeave);
  root.addEventListener("pointercancel", onPointerLeave);
  document.addEventListener("visibilitychange", onVisibility);
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  resizeObserver.observe(root);
  intersection.observe(root);
  readSize();
  syncColors();

  return {
    sync: () => {
      backgroundAt = -10;
      if (readSize()) gridKey = "";
      last = 0;
      if (count > 0 && Math.abs(count - targetCount()) > targetCount() * 0.25) reseed(true);
      if (!raf && visible) {
        render();
        schedule();
      }
    },
    plume: (x, y, strength) => {
      const s = settings();
      if (s.reduced) return;
      emitPlume(
        clamp(x ?? 0.5, 0, 1) * aspect,
        1 - clamp(y ?? 0.5, 0, 1),
        clamp(finite(strength ?? s.plume, 1), 0, 3),
      );
      schedule();
    },
    replay: () => {
      introStart = -1;
      fade = 0;
      count = 0;
      energy.fill(0);
      flow.fill(0);
      last = 0;
      schedule();
    },
    destroy: () => {
      destroyed = true;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersection.disconnect();
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("pointerup", onPointerUp);
      root.removeEventListener("pointerleave", onPointerLeave);
      root.removeEventListener("pointercancel", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      quadGeometry.dispose();
      dotsMaterial.dispose();
      downMaterial.dispose();
      upMaterial.dispose();
      compositeMaterial.dispose();
      energyTexture.dispose();
      flowTexture.dispose();
      sceneTarget.dispose();
      for (const bloomTarget of bloomTargets) bloomTarget.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}

export const ChromaCurrent = forwardRef<ChromaCurrentHandle, ChromaCurrentProps>(
  function ChromaCurrent(
    {
      colors = ["#5227FF", "#FF9FFC"],
      backgroundColor = "transparent",
      pattern = "streams",
      centerX = 0.5,
      centerY = 0.5,
      scale = 1,
      pitch = 8,
      dotSize = 0.62,
      variance = 0.35,
      shape = "circle",
      baseDots = 0.12,
      stretch = 0.2,
      streams = 4,
      spread = 0.5,
      speed = 0.6,
      direction = 0,
      turbulence = 0.6,
      trail = 0.6,
      intensity = 1,
      bloom = 0.6,
      grain = 0.2,
      interactive = true,
      stir = 1,
      plume = 1,
      intro = true,
      paused = false,
      dpr = 2,
      children,
      className,
      style,
    },
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const controllerRef = useRef<Controller | null>(null);
    const reduced = useSyncExternalStore(subscribeToMotion, readMotion, () => false);

    const settings: Settings = {
      colors,
      backgroundColor,
      pattern: PATTERNS.includes(pattern) ? pattern : "streams",
      centerX,
      centerY,
      scale,
      pitch,
      dotSize,
      variance,
      shape: shape === "square" ? "square" : "circle",
      baseDots,
      stretch,
      streams,
      spread,
      speed,
      direction,
      turbulence,
      trail,
      intensity,
      bloom,
      grain,
      interactive,
      stir,
      plume,
      intro,
      paused,
      dpr,
      reduced,
    };
    const settingsRef = useRef(settings);

    useEffect(() => {
      settingsRef.current = settings;
      controllerRef.current?.sync();
    });

    useEffect(() => {
      const root = rootRef.current;
      const stage = stageRef.current;
      if (!root || !stage) return;
      const controller = createCurrent(root, stage, settingsRef);
      controllerRef.current = controller;
      return () => {
        controller?.destroy();
        controllerRef.current = null;
      };
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        plume: (x?: number, y?: number, strength?: number) =>
          controllerRef.current?.plume(x, y, strength),
        replay: () => controllerRef.current?.replay(),
      }),
      [],
    );

    const backgroundValue = backgroundColor.trim().toLowerCase();
    const transparent = backgroundValue === "transparent" || backgroundValue === "";

    return (
      <div
        ref={rootRef}
        className={cn("relative isolate h-full min-h-[320px] w-full overflow-hidden", className)}
        style={{
          backgroundColor: transparent ? undefined : backgroundColor,
          touchAction: "pan-y",
          ...style,
        }}
      >
        <div
          ref={stageRef}
          aria-hidden="true"
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        />
        {children ? (
          <div style={{ position: "relative", zIndex: 1, height: "100%" }}>{children}</div>
        ) : null}
      </div>
    );
  },
);

ChromaCurrent.displayName = "ChromaCurrent";

export default ChromaCurrent;
