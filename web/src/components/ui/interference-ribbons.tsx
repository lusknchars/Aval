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

export type InterferenceRibbonsMode = "auto" | "glow" | "ink";

export interface InterferenceRibbonsHandle {
  pulse: (x?: number) => void;
}

export interface InterferenceRibbonsProps {
  colors?: [string, string];
  backgroundColor?: string;
  mode?: InterferenceRibbonsMode;
  wires?: number;
  lineWidth?: number;
  ribbonWidth?: number;
  amplitude?: number;
  waveLength?: number;
  angle?: number;
  twist?: number;
  curl?: number;
  depth?: number;
  stripes?: number;
  colorFlow?: number;
  glow?: number;
  intensity?: number;
  speed?: number;
  spin?: number;
  interactive?: boolean;
  hoverPulses?: boolean;
  clickPulse?: boolean;
  pulseSpeed?: number;
  pulseStrength?: number;
  hoverBoost?: number;
  paused?: boolean;
  quality?: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

interface Settings {
  colors: [string, string];
  backgroundColor: string;
  mode: InterferenceRibbonsMode;
  wires: number;
  lineWidth: number;
  ribbonWidth: number;
  amplitude: number;
  waveLength: number;
  angle: number;
  twist: number;
  curl: number;
  depth: number;
  stripes: number;
  colorFlow: number;
  glow: number;
  intensity: number;
  speed: number;
  spin: number;
  interactive: boolean;
  hoverPulses: boolean;
  clickPulse: boolean;
  pulseSpeed: number;
  pulseStrength: number;
  hoverBoost: number;
  paused: boolean;
  quality: number;
  reduced: boolean;
}

interface Controller {
  sync: () => void;
  destroy: () => void;
  pulse: (x: number) => void;
}

const PULSES = 16;
const SAMPLES = 360;

const subscribeToMotion = (notify: () => void) => {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};

const readMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

let colorContext: CanvasRenderingContext2D | null = null;

const parseColor = (value: string, fallback: [number, number, number]): [number, number, number] => {
  if (!colorContext) colorContext = document.createElement("canvas").getContext("2d");
  if (!colorContext) return fallback;
  colorContext.fillStyle = "#010203";
  colorContext.fillStyle = value;
  const read = String(colorContext.fillStyle);
  if (read === "#010203" && value.trim().toLowerCase() !== "#010203") return fallback;
  if (read.startsWith("#")) {
    const hex = read.slice(1);
    return [
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255,
    ];
  }
  const parts = read.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return fallback;
  return [Number(parts[0]) / 255, Number(parts[1]) / 255, Number(parts[2]) / 255];
};

const toLinear = (value: number) => (value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));

const toOklab = ([r, g, b]: [number, number, number]): [number, number, number] => {
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

const spineAt = (x: number, t: number, amplitude: number, frequency: number) =>
  amplitude *
  (0.62 * Math.sin(x * frequency + t * 0.33 + 0.4) +
    0.26 * Math.sin(x * frequency * 1.93 - t * 0.21 + 2.1) +
    0.12 * Math.sin(x * frequency * 3.07 + t * 0.47 + 4.2));

const wireVertex = `
in vec2 aWire;
in vec2 aSample;
uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform float uPulseTime;
uniform float uAngle;
uniform float uExtent;
uniform float uAmplitude;
uniform float uFrequency;
uniform float uHalf;
uniform float uCurl;
uniform float uTwist;
uniform float uSpin;
uniform float uLineWidth;
uniform float uBack;
uniform float uStripes;
uniform float uFlow;
uniform float uEnergy;
uniform float uPulseSpeed;
uniform float uPulseStrength;
uniform float uInk;
uniform vec3 uLabDeep;
uniform vec3 uLabA;
uniform vec3 uLabB;
uniform vec4 uPulses[${PULSES}];
out float vDist;
out float vHalfPx;
out vec3 vColor;
out float vGain;

vec3 labToLinear(vec3 lab) {
  float l = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  l = l * l * l;
  m = m * m * m;
  s = s * s * s;
  return max(vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  ), 0.0);
}

vec3 palette(float s) {
  s = fract(s) * 3.0;
  vec3 lab = s < 1.0 ? mix(uLabDeep, uLabA, smoothstep(0.0, 1.0, s))
    : s < 2.0 ? mix(uLabA, uLabB, smoothstep(0.0, 1.0, s - 1.0))
    : mix(uLabB, uLabDeep, smoothstep(0.0, 1.0, s - 2.0));
  return labToLinear(lab);
}

float spine(float x) {
  float t = uTime;
  return uAmplitude * (0.62 * sin(x * uFrequency + t * 0.33 + 0.4)
    + 0.26 * sin(x * uFrequency * 1.93 - t * 0.21 + 2.1)
    + 0.12 * sin(x * uFrequency * 3.07 + t * 0.47 + 4.2));
}

vec3 wire(float x, float u, float seed, out float facing) {
  float t = uTime;
  float halfWidth = uHalf * (1.0 + 0.22 * sin(x * 0.61 - t * 0.19 + 1.3));
  float theta = uTwist * x + uSpin;
  float wobble = 0.4 * (sin(x * 2.3 + seed * 6.2831853 + t * 0.7) * 0.6 + sin(x * 3.9 - seed * 11.3 - t * 0.5) * 0.4);
  float xi = u + wobble * 0.05;
  float zeta = uCurl * (u * u - 1.0 / 3.0) + wobble * 0.07;
  float c = cos(theta);
  float s = sin(theta);
  float y = spine(x) + halfWidth * (xi * c - zeta * s);
  float z = xi * s + zeta * c;
  facing = clamp(0.5 + 0.5 * z, 0.0, 1.0);
  return vec3(x, y, z);
}

vec2 toScreen(vec2 p) {
  float unit = 0.5 * uResolution.y;
  float ca = cos(uAngle);
  float sa = sin(uAngle);
  return vec2(ca * p.x - sa * p.y, sa * p.x + ca * p.y) * unit + 0.5 * uResolution;
}

void main() {
  float u = aWire.x;
  float seed = aWire.y;
  float x = mix(-uExtent, uExtent, aSample.x);
  float delta = 2.0 * uExtent / ${SAMPLES}.0;
  float f0;
  float f1;
  float f2;
  vec3 p0 = wire(x - delta, u, seed, f0);
  vec3 p1 = wire(x, u, seed, f1);
  vec3 p2 = wire(x + delta, u, seed, f2);
  vec2 s0 = toScreen(p0.xy);
  vec2 s1 = toScreen(p1.xy);
  vec2 s2 = toScreen(p2.xy);
  vec2 tangent = normalize(s2 - s0 + vec2(1e-6, 0.0));
  vec2 normal = vec2(-tangent.y, tangent.x);
  float halfPx = uLineWidth * uPixelRatio * mix(0.3, 1.0, f1 * f1 * f1) * 0.5;
  float reach = halfPx * 2.2 + 1.5;
  vec2 position2 = s1 + normal * aSample.y * reach;
  vDist = aSample.y * reach;
  vHalfPx = halfPx;
  float light = 0.0;
  for (int k = 0; k < ${PULSES}; k++) {
    vec4 pulse = uPulses[k];
    if (pulse.w <= 0.0) continue;
    float age = uPulseTime - pulse.y;
    if (age < 0.0 || age > 4.0) continue;
    float travel = age * uPulseSpeed;
    float front = abs(x - pulse.x) - travel + 0.05 * sin(u * 7.0 + pulse.y * 3.7) + (seed - 0.5) * 0.025;
    bool wave = pulse.w > 1.5;
    float along = front > 0.0 ? exp(-front * front / 0.0025) : exp(front / (wave ? 0.32 : 0.13));
    along += wave ? 0.0 : 0.45 * exp(-front * front / 0.0012);
    along *= smoothstep(0.0, 0.12, travel);
    float gap = (u - pulse.z) * 13.0;
    float across = wave ? 1.0 : 1.25 * exp(-gap * gap);
    light += along * across * exp(-age * 1.1);
  }
  light = min(light * uPulseStrength, 1.4);
  float tone = u * uStripes * 0.5 + x * 0.09 - uFlow;
  vec3 base = palette(tone);
  float lit = clamp(light, 0.0, 1.0);
  vec3 glowTint = mix(base, vec3(1.0, 0.95, 1.0), lit * 0.45);
  vec3 inkTint = mix(base, labToLinear(uLabDeep), lit * 0.7);
  vColor = mix(glowTint, inkTint, uInk);
  vGain = mix(uBack, 1.0, pow(f1, 1.5)) * (1.0 + light * mix(0.9, 2.2, uInk)) * (1.0 + uEnergy * 0.18);
  gl_Position = vec4(position2 / uResolution * 2.0 - 1.0, 0.0, 1.0);
}
`;

const wireFragment = `
precision highp float;
uniform float uCore;
in float vDist;
in float vHalfPx;
in vec3 vColor;
in float vGain;
out vec4 fragColor;

void main() {
  float sigma = max(vHalfPx, 0.55);
  float d = vDist / sigma;
  float energy = exp(-d * d) * min(vHalfPx / 0.55, 1.0) * vGain * uCore;
  fragColor = vec4(vColor * energy, energy);
}
`;

const passVertex = `
out vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const downFragment = `
precision highp float;
uniform sampler2D uSource;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 fragColor;

void main() {
  vec4 a = texture(uSource, vUv + uTexel * vec2(-1.0, -1.0));
  vec4 b = texture(uSource, vUv + uTexel * vec2(1.0, -1.0));
  vec4 c = texture(uSource, vUv + uTexel * vec2(-1.0, 1.0));
  vec4 d = texture(uSource, vUv + uTexel * vec2(1.0, 1.0));
  fragColor = (a + b + c + d) * 0.125 + texture(uSource, vUv) * 0.5;
}
`;

const upFragment = `
precision highp float;
uniform sampler2D uSource;
uniform sampler2D uBase;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 fragColor;

void main() {
  vec4 sum = texture(uSource, vUv) * 4.0;
  sum += texture(uSource, vUv + uTexel * vec2(-1.0, 0.0)) * 2.0;
  sum += texture(uSource, vUv + uTexel * vec2(1.0, 0.0)) * 2.0;
  sum += texture(uSource, vUv + uTexel * vec2(0.0, -1.0)) * 2.0;
  sum += texture(uSource, vUv + uTexel * vec2(0.0, 1.0)) * 2.0;
  sum += texture(uSource, vUv + uTexel * vec2(-1.0, -1.0));
  sum += texture(uSource, vUv + uTexel * vec2(1.0, -1.0));
  sum += texture(uSource, vUv + uTexel * vec2(-1.0, 1.0));
  sum += texture(uSource, vUv + uTexel * vec2(1.0, 1.0));
  fragColor = texture(uBase, vUv) + sum / 16.0;
}
`;

const compositeFragment = `
precision highp float;
uniform sampler2D uLines;
uniform sampler2D uBloom;
uniform vec3 uBackground;
uniform vec2 uResolution;
uniform float uGlow;
uniform float uExposure;
uniform float uMode;
uniform float uGrain;
in vec2 vUv;
out vec4 fragColor;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 encode(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

void main() {
  vec4 lines = texture(uLines, vUv);
  vec4 bloom = texture(uBloom, vUv);
  vec3 color;
  if (uMode < 0.5) {
    vec3 light = (lines.rgb + bloom.rgb * uGlow) * uExposure;
    vec3 exposed = 1.0 - exp(-light);
    float peak = max(exposed.r, max(exposed.g, exposed.b));
    exposed = mix(exposed, vec3(peak), smoothstep(0.75, 1.0, peak) * 0.35);
    vec2 q = vUv - 0.5;
    q.x *= uResolution.x / uResolution.y;
    exposed *= 1.0 - 0.18 * smoothstep(0.35, 1.1, length(q));
    color = uBackground + (1.0 - uBackground) * exposed;
  } else {
    float energy = lines.a + bloom.a * uGlow * 0.2;
    vec3 hue = (lines.rgb + bloom.rgb * uGlow * 0.2) / max(energy, 1e-4);
    float cover = clamp(1.0 - exp(-energy * uExposure * 1.4), 0.0, 0.94);
    color = mix(uBackground, clamp(hue * 0.8, 0.0, 1.0), cover);
  }
  float grain = hash(gl_FragCoord.xy + uGrain * 311.0) - 0.5;
  fragColor = vec4(encode(color) + grain * (1.2 / 255.0), 1.0);
}
`;

const buildGeometry = (count: number) => {
  const verts = new Float32Array(count * (SAMPLES + 1) * 2 * 4);
  const indices = new Uint32Array(count * SAMPLES * 6);
  let v = 0;
  let n = 0;
  let seedState = 1;
  const random = () => {
    seedState = (seedState * 16807) % 2147483647;
    return seedState / 2147483647;
  };
  for (let i = 0; i < count; i++) {
    const u = ((i + 0.5) / count) * 2 - 1;
    const seed = random();
    const base = v / 4;
    for (let j = 0; j <= SAMPLES; j++) {
      const t = j / SAMPLES;
      verts.set([u, seed, t, -1, u, seed, t, 1], v);
      v += 8;
    }
    for (let j = 0; j < SAMPLES; j++) {
      const a = base + j * 2;
      indices.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], n);
      n += 6;
    }
  }
  const geometry = new THREE.BufferGeometry();
  const buffer = new THREE.InterleavedBuffer(verts, 4);
  geometry.setAttribute("aWire", new THREE.InterleavedBufferAttribute(buffer, 2, 0));
  geometry.setAttribute("aSample", new THREE.InterleavedBufferAttribute(buffer, 2, 2));
  geometry.setAttribute("position", new THREE.InterleavedBufferAttribute(buffer, 3, 0));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
};

const createRibbons = (root: HTMLDivElement, settingsRef: { current: Settings }): Controller | null => {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  canvas.style.pointerEvents = "none";
  root.prepend(canvas);

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: false, antialias: false, powerPreference: "high-performance" });
  } catch {
    canvas.remove();
    return null;
  }
  if (!renderer.capabilities.isWebGL2) {
    renderer.dispose();
    canvas.remove();
    return null;
  }
  renderer.autoClear = false;
  const texelType =
    renderer.extensions.has("EXT_color_buffer_float") || renderer.extensions.has("EXT_color_buffer_half_float")
      ? THREE.HalfFloatType
      : THREE.UnsignedByteType;

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const plane = new THREE.PlaneGeometry(2, 2);
  const pulses = Array.from({ length: PULSES }, () => new THREE.Vector4(0, -100, 0, 0));

  const wireMaterial = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uResolution: { value: new THREE.Vector2(1, 1) },
      uPixelRatio: { value: 1 },
      uTime: { value: 0 },
      uPulseTime: { value: 0 },
      uAngle: { value: 0 },
      uExtent: { value: 2 },
      uAmplitude: { value: 0.6 },
      uFrequency: { value: 1.55 },
      uHalf: { value: 0.24 },
      uCurl: { value: 0.25 },
      uTwist: { value: 1.6 },
      uSpin: { value: 0 },
      uLineWidth: { value: 1.6 },
      uBack: { value: 0.35 },
      uStripes: { value: 2.2 },
      uFlow: { value: 0 },
      uEnergy: { value: 0 },
      uPulseSpeed: { value: 1.1 },
      uPulseStrength: { value: 1 },
      uInk: { value: 0 },
      uLabDeep: { value: new THREE.Vector3() },
      uLabA: { value: new THREE.Vector3() },
      uLabB: { value: new THREE.Vector3() },
      uPulses: { value: pulses },
      uCore: { value: 0.85 },
    },
    vertexShader: wireVertex,
    fragmentShader: wireFragment,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
  });

  const pass = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
    new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms,
      vertexShader: passVertex,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });

  const downMaterial = pass(downFragment, { uSource: { value: null }, uTexel: { value: new THREE.Vector2() } });
  const upMaterial = pass(upFragment, {
    uSource: { value: null },
    uBase: { value: null },
    uTexel: { value: new THREE.Vector2() },
  });
  const compositeMaterial = pass(compositeFragment, {
    uLines: { value: null },
    uBloom: { value: null },
    uBackground: { value: new THREE.Vector3() },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uGlow: { value: 0.45 },
    uExposure: { value: 1.6 },
    uMode: { value: 0 },
    uGrain: { value: 0 },
  });

  let wireCount = 0;
  const wireMesh = new THREE.Mesh(new THREE.BufferGeometry(), wireMaterial);
  wireMesh.frustumCulled = false;
  const wireScene = new THREE.Scene();
  wireScene.add(wireMesh);
  const quad = new THREE.Mesh(plane, compositeMaterial);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);

  const target = (w: number, h: number) =>
    new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      type: texelType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });

  let lineTarget: THREE.WebGLRenderTarget | null = null;
  let downTargets: THREE.WebGLRenderTarget[] = [];
  let upTargets: THREE.WebGLRenderTarget[] = [];

  let destroyed = false;
  let raf = 0;
  let last = 0;
  let visible = true;
  let clock = 6;
  let pulseClock = 0;
  let spinPhase = 0;
  let flow = 0;
  let energy = 0;
  let inside = false;
  let slot = 0;
  let width = 1;
  let height = 1;
  let pixelRatio = 1;
  let grain = 0;
  const lastLaunch = { x: -1e9, y: -1e9 };

  const release = () => {
    lineTarget?.dispose();
    downTargets.forEach((item) => item.dispose());
    upTargets.forEach((item) => item.dispose());
    lineTarget = null;
    downTargets = [];
    upTargets = [];
  };

  const draw = (material: THREE.ShaderMaterial, output: THREE.WebGLRenderTarget | null) => {
    quad.material = material;
    renderer.setRenderTarget(output);
    renderer.render(quadScene, camera);
  };

  const ensureWires = () => {
    const count = Math.round(clamp(settingsRef.current.wires, 4, 160));
    if (count === wireCount) return;
    wireCount = count;
    wireMesh.geometry.dispose();
    wireMesh.geometry = buildGeometry(count);
  };

  const geometryState = () => {
    const settings = settingsRef.current;
    const angle = (clamp(settings.angle, -180, 180) * Math.PI) / 180;
    const aspect = width / Math.max(height, 1);
    const extent = (Math.abs(Math.cos(angle)) * aspect + Math.abs(Math.sin(angle))) * 1.08;
    const frequency = 1.55 / clamp(settings.waveLength, 0.2, 5);
    return { angle, extent, frequency };
  };

  const apply = () => {
    const settings = settingsRef.current;
    const uniforms = wireMaterial.uniforms;
    const w = width * pixelRatio;
    const h = height * pixelRatio;
    const { angle, extent, frequency } = geometryState();
    const labA = toOklab(parseColor(settings.colors[0], [0.42, 0.24, 1]));
    const labB = toOklab(parseColor(settings.colors[1], [0.83, 0.42, 1]));
    uniforms.uResolution.value.set(w, h);
    uniforms.uPixelRatio.value = pixelRatio;
    uniforms.uTime.value = clock;
    uniforms.uPulseTime.value = pulseClock;
    uniforms.uAngle.value = angle;
    uniforms.uExtent.value = extent;
    uniforms.uAmplitude.value = clamp(settings.amplitude, 0, 1.5);
    uniforms.uFrequency.value = frequency;
    uniforms.uHalf.value = clamp(settings.ribbonWidth, 0.02, 0.8);
    uniforms.uCurl.value = clamp(settings.curl, 0, 1.2);
    uniforms.uTwist.value = clamp(settings.twist, 0, 8);
    uniforms.uSpin.value = spinPhase;
    uniforms.uLineWidth.value = clamp(settings.lineWidth, 0.4, 6);
    uniforms.uBack.value = 1 - clamp(settings.depth, 0, 1);
    uniforms.uStripes.value = clamp(settings.stripes, 0, 12);
    uniforms.uFlow.value = flow;
    uniforms.uEnergy.value = energy;
    uniforms.uPulseSpeed.value = clamp(settings.pulseSpeed, 0.1, 5);
    uniforms.uPulseStrength.value = clamp(settings.pulseStrength, 0, 3);
    const background = parseColor(settings.backgroundColor, [0.04, 0.04, 0.04]);
    const luminance = 0.2126 * background[0] + 0.7152 * background[1] + 0.0722 * background[2];
    const ink = settings.mode === "ink" || (settings.mode === "auto" && luminance > 0.5);
    const deepLightness = ink ? 0.6 : 0.42;
    const deepChroma = ink ? 1.15 : 0.85;
    uniforms.uInk.value = ink ? 1 : 0;
    uniforms.uLabDeep.value.set(labA[0] * deepLightness, labA[1] * deepChroma, labA[2] * deepChroma);
    uniforms.uLabA.value.set(labA[0], labA[1], labA[2]);
    uniforms.uLabB.value.set(labB[0], labB[1], labB[2]);
    const composite = compositeMaterial.uniforms;
    composite.uBackground.value.set(toLinear(background[0]), toLinear(background[1]), toLinear(background[2]));
    composite.uResolution.value.set(w, h);
    composite.uGlow.value = clamp(settings.glow, 0, 3);
    composite.uExposure.value = 1.6 * clamp(settings.intensity, 0, 4);
    composite.uMode.value = ink ? 1 : 0;
    composite.uGrain.value = grain;
  };

  const render = () => {
    if (!lineTarget || !downTargets.length) return;
    ensureWires();
    apply();
    renderer.setRenderTarget(lineTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(wireScene, camera);
    let source = lineTarget;
    for (const item of downTargets) {
      downMaterial.uniforms.uSource.value = source.texture;
      downMaterial.uniforms.uTexel.value.set(1 / source.width, 1 / source.height);
      draw(downMaterial, item);
      source = item;
    }
    let accumulated = downTargets[downTargets.length - 1];
    for (let k = downTargets.length - 2; k >= 0; k--) {
      upMaterial.uniforms.uSource.value = accumulated.texture;
      upMaterial.uniforms.uBase.value = downTargets[k].texture;
      upMaterial.uniforms.uTexel.value.set(1 / accumulated.width, 1 / accumulated.height);
      draw(upMaterial, upTargets[k]);
      accumulated = upTargets[k];
    }
    compositeMaterial.uniforms.uLines.value = lineTarget.texture;
    compositeMaterial.uniforms.uBloom.value = accumulated.texture;
    draw(compositeMaterial, null);
  };

  const step = (dt: number) => {
    const settings = settingsRef.current;
    const goal = inside && settings.interactive && !settings.reduced ? clamp(settings.hoverBoost, 0, 2) : 0;
    energy += (goal - energy) * (1 - Math.exp(-dt / 0.4));
    pulseClock += dt;
    if (settings.paused || settings.reduced) return;
    const pace = clamp(settings.speed, -4, 4) * (1 + energy * 0.35);
    clock += dt * pace;
    spinPhase += dt * pace * clamp(settings.spin, -4, 4);
    flow += dt * pace * clamp(settings.colorFlow, -2, 2);
    grain = (grain + 0.618034) % 1;
  };

  const pulsesAlive = () => pulses.some((item) => item.w > 0 && pulseClock - item.y < 4);

  const frame = (now: number) => {
    raf = 0;
    if (destroyed) return;
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    step(dt);
    render();
    const settings = settingsRef.current;
    const animating = !settings.paused && !settings.reduced;
    const goal = inside && settings.interactive && !settings.reduced ? settings.hoverBoost : 0;
    const settling = Math.abs(energy - goal) > 0.002 || pulsesAlive();
    if (visible && !document.hidden && (animating || settling)) raf = requestAnimationFrame(frame);
  };

  const wake = () => {
    if (destroyed || raf || !visible) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };

  const resize = () => {
    const rect = root.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2) * clamp(settingsRef.current.quality, 0.25, 1);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    const w = Math.round(width * pixelRatio);
    const h = Math.round(height * pixelRatio);
    release();
    lineTarget = target(w, h);
    const levels = clamp(Math.floor(Math.log2(Math.min(w, h) / 8)), 3, 7);
    for (let k = 1; k <= levels; k++) {
      downTargets.push(target(Math.max(1, w >> k), Math.max(1, h >> k)));
      upTargets.push(target(Math.max(1, w >> k), Math.max(1, h >> k)));
    }
    render();
    wake();
  };

  const launch = (x: number, u: number, strength: number) => {
    pulses[slot].set(x, pulseClock, u, strength);
    slot = (slot + 1) % PULSES;
    wake();
  };

  const toRibbon = (clientX: number, clientY: number) => {
    const rect = root.getBoundingClientRect();
    const { angle } = geometryState();
    const unit = 0.5 * rect.height;
    const px = (clientX - rect.left - rect.width / 2) / unit;
    const py = -(clientY - rect.top - rect.height / 2) / unit;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    return { x: ca * px + sa * py, y: -sa * px + ca * py };
  };

  const onMove = (event: PointerEvent) => {
    const settings = settingsRef.current;
    if (event.pointerType === "touch" || !settings.interactive) return;
    if (!inside) {
      inside = true;
      wake();
    }
    if (!settings.hoverPulses || settings.reduced) return;
    const moved = Math.hypot(event.clientX - lastLaunch.x, event.clientY - lastLaunch.y);
    if (moved < 50) return;
    const { frequency } = geometryState();
    const point = toRibbon(event.clientX, event.clientY);
    const halfWidth = clamp(settings.ribbonWidth, 0.02, 0.8) * (1 + 0.22 * Math.sin(point.x * 0.61 - clock * 0.19 + 1.3));
    const theta = clamp(settings.twist, 0, 8) * point.x + spinPhase;
    const offset = point.y - spineAt(point.x, clock, clamp(settings.amplitude, 0, 1.5), frequency);
    const span = halfWidth * Math.max(Math.abs(Math.cos(theta)), 0.12);
    if (Math.abs(offset) > span + 0.03) return;
    lastLaunch.x = event.clientX;
    lastLaunch.y = event.clientY;
    const across = clamp(offset / (halfWidth * Math.cos(theta) || 1e-3), -1, 1);
    launch(point.x, across, 1);
  };

  const onLeave = () => {
    inside = false;
    lastLaunch.x = -1e9;
    wake();
  };

  const onDown = (event: PointerEvent) => {
    const settings = settingsRef.current;
    if (event.button !== 0 || !settings.interactive || !settings.clickPulse || settings.reduced) return;
    const point = toRibbon(event.clientX, event.clientY);
    launch(point.x, 0, 2);
  };

  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerleave", onLeave);
  root.addEventListener("pointercancel", onLeave);
  root.addEventListener("pointerdown", onDown);
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(root);
  const intersection = new IntersectionObserver(
    (entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (visible) wake();
    },
    { rootMargin: "80px" },
  );
  intersection.observe(root);
  const onVisibility = () => {
    if (!document.hidden) wake();
  };
  document.addEventListener("visibilitychange", onVisibility);
  const onLost = (event: Event) => event.preventDefault();
  canvas.addEventListener("webglcontextlost", onLost);
  resize();

  return {
    sync: () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2) * clamp(settingsRef.current.quality, 0.25, 1);
      if (Math.abs(ratio - pixelRatio) > 1e-3) resize();
      else render();
      wake();
    },
    destroy: () => {
      destroyed = true;
      cancelAnimationFrame(raf);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("pointercancel", onLeave);
      root.removeEventListener("pointerdown", onDown);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onLost);
      resizeObserver.disconnect();
      intersection.disconnect();
      release();
      wireMesh.geometry.dispose();
      plane.dispose();
      [wireMaterial, downMaterial, upMaterial, compositeMaterial].forEach((item) => item.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
    pulse: (x: number) => {
      if (settingsRef.current.reduced) return;
      const rect = root.getBoundingClientRect();
      const point = toRibbon(rect.left + clamp(x, 0, 1) * rect.width, rect.top + rect.height / 2);
      launch(point.x, 0, 2);
    },
  };
};

const InterferenceRibbons = forwardRef<InterferenceRibbonsHandle, InterferenceRibbonsProps>(function InterferenceRibbons(
  {
    colors = ["#6B3CFF", "#D46BFF"],
    backgroundColor = "#0A0A0A",
    mode = "auto",
    wires = 64,
    lineWidth = 1.6,
    ribbonWidth = 0.24,
    amplitude = 0.6,
    waveLength = 1,
    angle = 42,
    twist = 1.6,
    curl = 0.25,
    depth = 0.65,
    stripes = 2.2,
    colorFlow = 0.04,
    glow = 0.45,
    intensity = 1,
    speed = 0.7,
    spin = 0.35,
    interactive = true,
    hoverPulses = true,
    clickPulse = true,
    pulseSpeed = 1.1,
    pulseStrength = 1,
    hoverBoost = 1,
    paused = false,
    quality = 1,
    className,
    style,
    children,
  },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<Controller | null>(null);
  const reduced = useSyncExternalStore(subscribeToMotion, readMotion, () => false);
  const settingsRef = useRef<Settings>({
    colors,
    backgroundColor,
    mode,
    wires,
    lineWidth,
    ribbonWidth,
    amplitude,
    waveLength,
    angle,
    twist,
    curl,
    depth,
    stripes,
    colorFlow,
    glow,
    intensity,
    speed,
    spin,
    interactive,
    hoverPulses,
    clickPulse,
    pulseSpeed,
    pulseStrength,
    hoverBoost,
    paused,
    quality,
    reduced,
  });

  useEffect(() => {
    settingsRef.current = {
      colors,
      backgroundColor,
      mode,
      wires,
      lineWidth,
      ribbonWidth,
      amplitude,
      waveLength,
      angle,
      twist,
      curl,
      depth,
      stripes,
      colorFlow,
      glow,
      intensity,
      speed,
      spin,
      interactive,
      hoverPulses,
      clickPulse,
      pulseSpeed,
      pulseStrength,
      hoverBoost,
      paused,
      quality,
      reduced,
    };
    controllerRef.current?.sync();
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const controller = createRibbons(root, settingsRef);
    controllerRef.current = controller;
    return () => {
      controller?.destroy();
      controllerRef.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      pulse: (x = 0.5) => controllerRef.current?.pulse(x),
    }),
    [],
  );

  return (
    <div
      ref={rootRef}
      className={cn("relative isolate h-full min-h-[240px] w-full overflow-hidden", className)}
      style={{ backgroundColor, ...style }}
    >
      {children && <div className="relative z-10 h-full w-full">{children}</div>}
    </div>
  );
});

InterferenceRibbons.displayName = "InterferenceRibbons";

export { InterferenceRibbons };
export default InterferenceRibbons;
