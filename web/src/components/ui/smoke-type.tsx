"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
} from "react";
import * as THREE from "three";
import { cn } from "@/lib/utils";

export type SmokeTypeTag = "span" | "div" | "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
export type SmokeTypeDirection = "left" | "right" | "center" | "edges" | "random";
export type SmokeTypeTrigger = "view" | "mount" | "manual";

export interface SmokeTypeHandle {
  replay: () => void;
  condense: () => void;
  dissolve: () => void;
}

export interface SmokeTypeProps {
  text?: string;
  as?: SmokeTypeTag;
  fontSize?: number | string;
  fontWeight?: number;
  letterSpacing?: string;
  lineHeight?: number;
  align?: "left" | "center" | "right";
  color?: string;
  smokeColor?: string;
  trigger?: SmokeTypeTrigger;
  visible?: boolean;
  direction?: SmokeTypeDirection;
  delay?: number;
  duration?: number;
  stagger?: number;
  rise?: number;
  turbulence?: number;
  softness?: number;
  density?: number;
  speed?: number;
  replayOnHover?: boolean;
  quality?: number;
  onComplete?: () => void;
  className?: string;
  style?: CSSProperties;
}

interface Settings {
  smokeColor: string;
  trigger: SmokeTypeTrigger;
  visible: boolean;
  direction: SmokeTypeDirection;
  delay: number;
  duration: number;
  stagger: number;
  rise: number;
  turbulence: number;
  softness: number;
  density: number;
  speed: number;
  replayOnHover: boolean;
  quality: number;
  reduced: boolean;
  onComplete?: () => void;
}

interface Controller {
  measure: () => void;
  sync: () => void;
  destroy: () => void;
  replay: (from?: SmokeTypeDirection) => void;
  condense: () => void;
  dissolve: () => void;
}

type Phase = "hidden" | "condensing" | "shown" | "dissolving";

const LINES = 6;
const LEVELS = 5;

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

const segment = (value: string) =>
  typeof Intl === "undefined" || typeof Intl.Segmenter === "undefined"
    ? Array.from(value)
    : Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value), (part) => part.segment);

let colorContext: CanvasRenderingContext2D | null = null;

const parseColor = (value: string, fallback: [number, number, number]): [number, number, number] => {
  const direct = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (direct) return [Number(direct[1]) / 255, Number(direct[2]) / 255, Number(direct[3]) / 255];
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
  vec4 e = texture(uSource, vUv + uTexel * vec2(-2.0, 0.0));
  vec4 f = texture(uSource, vUv + uTexel * vec2(2.0, 0.0));
  vec4 g = texture(uSource, vUv + uTexel * vec2(0.0, -2.0));
  vec4 h = texture(uSource, vUv + uTexel * vec2(0.0, 2.0));
  fragColor = (a + b + c + d) * 0.15 + (e + f + g + h) * 0.05 + texture(uSource, vUv) * 0.2;
}
`;

const smokeFragment = `
precision highp float;
uniform sampler2D uL0;
uniform sampler2D uL1;
uniform sampler2D uL2;
uniform sampler2D uL3;
uniform sampler2D uL4;
uniform sampler2D uL5;
uniform sampler2D uNoise;
uniform vec2 uResolution;
uniform float uEm;
uniform float uTime;
uniform float uClock;
uniform float uDuration;
uniform float uSpan;
uniform float uMode;
uniform float uExit;
uniform vec4 uLines[${LINES}];
uniform float uLineCount;
uniform float uRise;
uniform float uTurbulence;
uniform float uSoftness;
uniform float uDensity;
uniform float uLetterLayer;
uniform vec3 uText;
uniform vec3 uSmoke;
out vec4 fragColor;

float hash1(float n) {
  return fract(sin(n * 127.1) * 43758.5453);
}

vec2 flow(vec2 q, float t) {
  vec4 a = texture(uNoise, q * 0.045 + vec2(t * 0.011, -t * 0.019));
  vec4 b = texture(uNoise, q * 0.11 + vec2(-t * 0.017, -t * 0.031) + a.ba * 0.5);
  return (a.rg - 0.5) * 1.6 + (b.rg - 0.5) * 0.8;
}

float strands(vec2 q, float t, float seed) {
  vec2 w = q * vec2(0.085, 0.034) + vec2(seed, -t * 0.05) + flow(q * 0.8 + seed * 9.0, t) * 0.05;
  float n = texture(uNoise, w).b * 0.62 + texture(uNoise, w * 2.3 + vec2(0.37, 0.11)).a * 0.38;
  float ridge = 1.0 - abs(n * 2.0 - 1.0);
  return ridge * ridge * ridge;
}

vec2 level(vec2 uv, int i) {
  if (i <= 0) return texture(uL0, uv).rg;
  if (i == 1) return texture(uL1, uv).rg;
  if (i == 2) return texture(uL2, uv).rg;
  if (i == 3) return texture(uL3, uv).rg;
  if (i == 4) return texture(uL4, uv).rg;
  return texture(uL5, uv).rg;
}

float blurred(vec2 p, float amount, float parity) {
  vec2 uv = p / uResolution;
  if (uv.x < -0.02 || uv.y < -0.02 || uv.x > 1.02 || uv.y > 1.02) return 0.0;
  float l = clamp(amount, 0.0, ${LEVELS}.0);
  int i = int(floor(l));
  vec2 a = level(uv, i);
  vec2 b = level(uv, min(i + 1, ${LEVELS}));
  vec2 m = mix(a, b, fract(l));
  float boost = 1.0 + l * 0.55;
  return min((parity < 0.5 ? m.x : m.y) * boost, 1.0);
}

float orderFor(int line, vec2 p) {
  vec4 band = uLines[line];
  float u = clamp((p.x - band.x) / max(band.y - band.x, 1.0), 0.0, 1.0);
  float o = u;
  if (uMode > 0.5 && uMode < 1.5) o = 1.0 - u;
  else if (uMode > 1.5 && uMode < 2.5) o = abs(u - 0.5) * 2.0;
  else if (uMode > 2.5 && uMode < 3.5) o = 1.0 - abs(u - 0.5) * 2.0;
  else if (uMode > 3.5) o = hash1(floor((p.x - band.x) / (uEm * 0.55)) + float(line) * 17.0);
  return (float(line) + o) / max(uLineCount, 1.0);
}

float progressFor(int line, vec2 p) {
  float local = clamp((uClock - orderFor(line, p) * uSpan) / max(uDuration, 0.05), 0.0, 1.0);
  return uExit > 0.5 ? 1.0 - local : local;
}

vec2 cloudFor(int line, vec2 p, vec2 q, vec2 stream, float body, out float prog) {
  prog = progressFor(line, p);
  float k = 1.0 - prog;
  float lift = uExit > 0.5 ? -1.0 : 1.0;
  vec2 source = p + vec2(0.0, lift * uRise * uEm * k * k * 1.2) + stream * uTurbulence * uEm * 0.45 * k;
  float shape = blurred(source, k * uSoftness * ${LEVELS}.0, mod(float(line), 2.0));
  float texture_ = mix(1.0, body, smoothstep(0.05, 0.5, k));
  float appear = smoothstep(0.0, 0.45, prog);
  float alpha = clamp(shape * texture_ * appear * mix(1.0, 0.5 * uDensity, smoothstep(0.0, 0.7, k)), 0.0, 1.0);
  alpha *= mix(1.0, uLetterLayer, step(0.999, prog));
  return vec2(alpha, smoothstep(0.62, 0.98, prog));
}

void main() {
  vec2 p = gl_FragCoord.xy;
  float t = uTime;
  vec2 q = p / uEm;
  vec2 stream = flow(q, t);
  float billow = texture(uNoise, q * 0.07 + stream * 0.035 - vec2(0.0, t * 0.035)).g;
  vec2 fibre = q * vec2(0.62, 0.16) + stream * 0.05 - vec2(0.0, t * 0.09);
  float fine = texture(uNoise, fibre).b * 0.6 + texture(uNoise, fibre * 2.2 + vec2(0.31, 0.17)).a * 0.4;
  float streak = pow(1.0 - abs(fine * 2.0 - 1.0), 2.0);
  float body = (0.45 + 0.9 * billow) * (0.25 + 1.3 * streak);

  int first = 0;
  int second = -1;
  float best = 1e9;
  float next = 1e9;
  for (int i = 0; i < ${LINES}; i++) {
    if (float(i) >= uLineCount) break;
    vec4 band = uLines[i];
    float d = abs(p.y - (band.z + band.w) * 0.5);
    if (d < best) {
      next = best;
      second = first;
      best = d;
      first = i;
    } else if (d < next) {
      next = d;
      second = i;
    }
  }
  if (uLineCount < 1.5) second = -1;
  float prog;
  vec2 a = cloudFor(first, p, q, stream, body, prog);
  float progB = 0.0;
  vec2 b = vec2(0.0);
  if (second >= 0) b = cloudFor(second, p, q, stream, body, progB);
  float letter = 1.0 - (1.0 - a.x) * (1.0 - b.x);
  float weight = a.x + b.x;
  float settle = weight > 1e-4 ? (a.y * a.x + b.y * b.x) / weight : a.y;

  vec3 tone = mix(uSmoke, uText, settle);
  fragColor = vec4(tone * letter, letter);
}
`;

const buildNoise = () => {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const lattice = (period: number, seed: number) => {
    const values = new Float32Array(period * period);
    let state = seed * 2654435761;
    for (let i = 0; i < values.length; i++) {
      state = (state ^ (state << 13)) >>> 0;
      state = (state ^ (state >>> 17)) >>> 0;
      state = (state ^ (state << 5)) >>> 0;
      values[i] = (state % 100000) / 100000;
    }
    return (x: number, y: number) => {
      const fx = x * period;
      const fy = y * period;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const tx = fx - ix;
      const ty = fy - iy;
      const sx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
      const sy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
      const at = (a: number, b: number) => values[(((b % period) + period) % period) * period + (((a % period) + period) % period)];
      const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
      const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
      return top + (bottom - top) * sy;
    };
  };
  const channels = [0, 1, 2, 3].map((channel) => [4, 8, 16, 32].map((period, octave) => lattice(period, channel * 13 + octave * 7 + 3)));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        let amplitude = 0.5;
        let total = 0;
        for (const octave of channels[c]) {
          sum += octave(u, v) * amplitude;
          total += amplitude;
          amplitude *= 0.5;
        }
        data[(y * size + x) * 4 + c] = Math.round((sum / total) * 255);
      }
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
};

const createSmoke = (
  root: HTMLElement,
  face: HTMLElement,
  settingsRef: { current: Settings },
): Controller | null => {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.position = "absolute";
  canvas.style.pointerEvents = "none";
  canvas.style.display = "block";
  canvas.style.zIndex = "0";
  root.prepend(canvas);

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: false });
  } catch {
    canvas.remove();
    return null;
  }
  if (!renderer.capabilities.isWebGL2) {
    renderer.dispose();
    canvas.remove();
    return null;
  }
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const plane = new THREE.PlaneGeometry(2, 2);
  const lines = Array.from({ length: LINES }, () => new THREE.Vector4());
  const pass = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>, blending: THREE.Blending) =>
    new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms,
      vertexShader: passVertex,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      premultipliedAlpha: true,
      blending,
    });
  const downMaterial = pass(downFragment, { uSource: { value: null }, uTexel: { value: new THREE.Vector2() } }, THREE.NoBlending);
  const smokeMaterial = pass(
    smokeFragment,
    {
      uL0: { value: null },
      uL1: { value: null },
      uL2: { value: null },
      uL3: { value: null },
      uL4: { value: null },
      uL5: { value: null },
      uNoise: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uEm: { value: 40 },
      uTime: { value: 0 },
      uClock: { value: 0 },
      uDuration: { value: 1 },
      uSpan: { value: 1 },
      uMode: { value: 0 },
      uExit: { value: 0 },
      uLines: { value: lines },
      uLineCount: { value: 1 },
      uRise: { value: 1 },
      uTurbulence: { value: 1 },
      uSoftness: { value: 1 },
      uDensity: { value: 1 },
      uLetterLayer: { value: 1 },
      uText: { value: new THREE.Vector3(1, 1, 1) },
      uSmoke: { value: new THREE.Vector3(1, 1, 1) },
    },
    THREE.NoBlending,
  );
  const noise = buildNoise();
  smokeMaterial.uniforms.uNoise.value = noise;
  const quad = new THREE.Mesh(plane, smokeMaterial);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);

  let sharp: THREE.CanvasTexture | null = null;
  let levels: THREE.WebGLRenderTarget[] = [];
  let pixelRatio = 1;
  let em = 40;
  let width = 1;
  let height = 1;
  let letterCount = 1;
  let lineCount = 1;
  let textColor: [number, number, number] = [1, 1, 1];
  let phase: Phase = "hidden";
  let clock = 0;
  let time = Math.random() * 40;
  let letterLayer = 1;
  let span = 1;
  let mode = 0;
  let raf = 0;
  let last = 0;
  let visible = true;
  let destroyed = false;
  let started = false;
  let reported = false;
  let lastVisible = settingsRef.current.visible;

  const directions: SmokeTypeDirection[] = ["left", "right", "center", "edges", "random"];

  const release = () => {
    levels.forEach((item) => item.dispose());
    levels = [];
    sharp?.dispose();
    sharp = null;
  };

  const raster = () => {
    const settings = settingsRef.current;
    const letters = Array.from(face.querySelectorAll<HTMLElement>("[data-smoke-index]"));
    const rootRect = root.getBoundingClientRect();
    const style = getComputedStyle(face);
    em = parseFloat(style.fontSize) || 16;
    letterCount = Math.max(1, letters.length);
    const padX = em * (0.9 + clamp(settings.turbulence, 0, 3) * 0.3);
    const padTop = em * (0.6 + 0.4 * clamp(settings.rise, 0, 4));
    const padBottom = em * (0.5 + 0.9 * clamp(settings.rise, 0, 4));
    const boxW = rootRect.width + padX * 2;
    const boxH = rootRect.height + padTop + padBottom;
    canvas.style.left = `${-padX}px`;
    canvas.style.top = `${-padTop}px`;
    canvas.style.width = `${boxW}px`;
    canvas.style.height = `${boxH}px`;
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2) * clamp(settings.quality, 0.25, 1);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(boxW, boxH, false);
    width = Math.max(1, Math.round(boxW * pixelRatio));
    height = Math.max(1, Math.round(boxH * pixelRatio));
    const ink = document.createElement("canvas");
    ink.width = width;
    ink.height = height;
    const context = ink.getContext("2d");
    const bands: { x0: number; x1: number; top: number; bottom: number }[] = [];
    const findBand = (center: number, tall: number) => bands.findIndex((item) => Math.abs((item.top + item.bottom) / 2 - center) < tall * 0.5);
    if (context) {
      context.clearRect(0, 0, width, height);
      context.fillStyle = "#ffffff";
      context.textBaseline = "alphabetic";
      context.font = `${style.fontStyle} ${style.fontWeight} ${em * pixelRatio}px ${style.fontFamily}`;
      const metrics = context.measureText("Hg");
      const ascent = metrics.fontBoundingBoxAscent || em * pixelRatio * 0.8;
      const descent = metrics.fontBoundingBoxDescent || em * pixelRatio * 0.2;
      for (const el of letters) {
        const glyph = el.textContent ?? "";
        if (!glyph.trim()) continue;
        const rect = el.getBoundingClientRect();
        const left = (rect.left - rootRect.left + padX) * pixelRatio;
        const top = (rect.top - rootRect.top + padTop) * pixelRatio;
        const tall = rect.height * pixelRatio;
        const baseline = top + (tall * ascent) / (ascent + descent);
        const found = findBand(height - top - tall / 2, tall);
        const line = found >= 0 ? found : bands.length;
        context.fillStyle = line % 2 === 0 ? "#ff0000" : "#00ff00";
        context.fillText(glyph, left, baseline);
        const yTop = height - top;
        const yBottom = height - (top + tall);
        const band = found >= 0 ? bands[found] : undefined;
        const right = left + rect.width * pixelRatio;
        if (band) {
          band.x0 = Math.min(band.x0, left);
          band.x1 = Math.max(band.x1, right);
        } else bands.push({ x0: left, x1: right, top: yTop, bottom: yBottom });
      }
    }
    lineCount = Math.max(1, Math.min(LINES, bands.length));
    for (let i = 0; i < LINES; i++) {
      const band = bands[Math.min(i, bands.length - 1)] ?? { x0: 0, x1: width, top: height, bottom: 0 };
      lines[i].set(band.x0, band.x1, band.top, band.bottom);
    }
    release();
    sharp = new THREE.CanvasTexture(ink);
    sharp.minFilter = THREE.LinearFilter;
    sharp.magFilter = THREE.LinearFilter;
    sharp.generateMipmaps = false;
    sharp.colorSpace = THREE.NoColorSpace;
    sharp.premultiplyAlpha = true;
    sharp.needsUpdate = true;
    const scale = Math.max(1, (em * pixelRatio) / 60);
    let source: THREE.Texture = sharp;
    let sourceW = width;
    let sourceH = height;
    for (let i = 1; i <= LEVELS; i++) {
      const factor = i === 1 ? Math.max(1, Math.round(scale)) : 2;
      const w = Math.max(2, Math.round(sourceW / factor));
      const h = Math.max(2, Math.round(sourceH / factor));
      const target = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      downMaterial.uniforms.uSource.value = source;
      downMaterial.uniforms.uTexel.value.set((1 / sourceW) * Math.max(1, factor * 0.75), (1 / sourceH) * Math.max(1, factor * 0.75));
      quad.material = downMaterial;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      levels.push(target);
      source = target.texture;
      sourceW = w;
      sourceH = h;
    }
    renderer.setRenderTarget(null);
    quad.material = smokeMaterial;
    textColor = parseColor(getComputedStyle(face).color, [1, 1, 1]);
  };

  const timing = () => {
    const settings = settingsRef.current;
    const duration = clamp(settings.duration, 0.1, 10);
    span = clamp(settings.stagger, 0, 2) * Math.max(0, letterCount - 1);
    return { duration, total: span + duration };
  };

  const setFace = (opacity: number) => {
    face.style.opacity = String(opacity);
  };

  const apply = () => {
    const settings = settingsRef.current;
    const u = smokeMaterial.uniforms;
    const smoke = parseColor(settings.smokeColor, textColor);
    const { duration } = timing();
    u.uL0.value = sharp;
    for (let i = 1; i <= LEVELS; i++) u[`uL${i}`].value = levels[i - 1]?.texture ?? null;
    u.uResolution.value.set(width, height);
    u.uEm.value = em * pixelRatio;
    u.uTime.value = time;
    u.uClock.value = phase === "hidden" ? -1e4 : phase === "shown" ? 1e4 : clock;
    u.uDuration.value = duration;
    u.uSpan.value = span;
    u.uMode.value = mode;
    u.uExit.value = phase === "dissolving" ? 1 : 0;
    u.uLineCount.value = lineCount;
    u.uRise.value = clamp(settings.rise, 0, 4);
    u.uTurbulence.value = clamp(settings.turbulence, 0, 3);
    u.uSoftness.value = clamp(settings.softness, 0.1, 1.5);
    u.uDensity.value = clamp(settings.density, 0, 3);
    u.uLetterLayer.value = letterLayer;
    u.uText.value.set(textColor[0], textColor[1], textColor[2]);
    u.uSmoke.value.set(smoke[0], smoke[1], smoke[2]);
  };

  const render = () => {
    if (!sharp || levels.length < LEVELS) return;
    apply();
    quad.material = smokeMaterial;
    renderer.setRenderTarget(null);
    renderer.clear();
    if (phase === "hidden") return;
    renderer.render(scene, camera);
  };

  const finish = () => {
    phase = "shown";
    setFace(1);
    if (!reported) {
      reported = true;
      settingsRef.current.onComplete?.();
    }
  };

  const step = (dt: number) => {
    const settings = settingsRef.current;
    const pace = clamp(settings.speed, 0.05, 4);
    time += dt * pace;
    if (phase === "condensing") {
      clock += dt * pace;
      const { total } = timing();
      if (clock >= total) {
        finish();
        letterLayer = 1;
      }
    } else if (phase === "dissolving") {
      clock += dt * pace;
      const { total } = timing();
      if (clock >= total) phase = "hidden";
    }
    if (phase === "shown" && letterLayer > 0) letterLayer = Math.max(0, letterLayer - dt / 0.35);
  };

  const animating = () => {
    const settings = settingsRef.current;
    if (settings.reduced) return false;
    if (phase === "condensing" || phase === "dissolving") return true;
    if (phase === "shown") return letterLayer > 0;
    return false;
  };

  const tick = (now: number) => {
    raf = 0;
    if (destroyed) return;
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    step(dt);
    render();
    if (visible && !document.hidden && animating()) raf = requestAnimationFrame(tick);
  };

  function wake() {
    if (destroyed || raf || !visible) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  const condense = (from?: SmokeTypeDirection) => {
    const settings = settingsRef.current;
    started = true;
    reported = false;
    mode = directions.indexOf(from ?? settings.direction);
    if (mode < 0) mode = 0;
    if (settings.reduced) {
      phase = "shown";
      letterLayer = 0;
      setFace(1);
      render();
      return;
    }
    phase = "condensing";
    clock = -clamp(settings.delay, 0, 10);
    letterLayer = 1;
    setFace(0);
    wake();
  };

  const dissolve = () => {
    const settings = settingsRef.current;
    started = true;
    if (settings.reduced) {
      phase = "hidden";
      setFace(0);
      render();
      return;
    }
    mode = directions.indexOf(settings.direction);
    if (mode < 0) mode = 0;
    phase = "dissolving";
    clock = 0;
    letterLayer = 1;
    setFace(0);
    wake();
  };

  const measure = () => {
    raster();
    render();
    wake();
  };

  const onEnter = (event: PointerEvent) => {
    const settings = settingsRef.current;
    if (!settings.replayOnHover || settings.reduced || event.pointerType === "touch") return;
    if (phase === "condensing" || phase === "dissolving") return;
    const rect = root.getBoundingClientRect();
    const side = event.clientX < rect.left + rect.width / 2 ? "left" : "right";
    condense(side);
  };

  root.addEventListener("pointerenter", onEnter);
  const resizeObserver = new ResizeObserver(() => measure());
  resizeObserver.observe(root);
  const intersection = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      visible = entries.some((item) => item.isIntersecting);
      const settings = settingsRef.current;
      if (!started && settings.trigger === "view" && settings.visible && entry && entry.intersectionRatio >= 0.35) condense();
      if (visible) wake();
    },
    { threshold: [0, 0.35, 1], rootMargin: "120px 0px" },
  );
  intersection.observe(root);
  const onVisibility = () => {
    if (!document.hidden) wake();
  };
  document.addEventListener("visibilitychange", onVisibility);
  if (document.fonts?.ready) document.fonts.ready.then(() => !destroyed && measure()).catch(() => {});

  raster();
  const initial = settingsRef.current;
  if (!initial.visible) {
    setFace(0);
  } else if (initial.reduced || initial.trigger === "manual") {
    phase = "shown";
    letterLayer = 0;
    started = true;
    setFace(1);
  } else if (initial.trigger === "mount") condense();
  else setFace(0);
  render();

  return {
    measure,
    sync: () => {
      const settings = settingsRef.current;
      if (settings.visible !== lastVisible) {
        lastVisible = settings.visible;
        const shown = phase === "shown" || phase === "condensing";
        if (settings.visible && !shown) condense();
        else if (!settings.visible && shown) dissolve();
      }
      if (settings.reduced && phase !== "hidden") {
        phase = "shown";
        letterLayer = 0;
        setFace(1);
      }
      const ratio = Math.min(window.devicePixelRatio || 1, 2) * clamp(settings.quality, 0.25, 1);
      if (Math.abs(ratio - pixelRatio) > 1e-3) raster();
      render();
      wake();
    },
    destroy: () => {
      destroyed = true;
      cancelAnimationFrame(raf);
      root.removeEventListener("pointerenter", onEnter);
      document.removeEventListener("visibilitychange", onVisibility);
      resizeObserver.disconnect();
      intersection.disconnect();
      release();
      plane.dispose();
      downMaterial.dispose();
      smokeMaterial.dispose();
      noise.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      face.style.opacity = "";
    },
    replay: (from?: SmokeTypeDirection) => condense(from),
    condense: () => condense(),
    dissolve,
  };
};

const SmokeType = forwardRef<SmokeTypeHandle, SmokeTypeProps>(function SmokeType(
  {
    text = "Out of thin air",
    as = "span",
    fontSize = "clamp(2.75rem, 8vw, 6.5rem)",
    fontWeight = 600,
    letterSpacing = "-0.035em",
    lineHeight = 1.1,
    align = "center",
    color,
    smokeColor = "#B19EEF",
    trigger = "view",
    visible = true,
    direction = "left",
    delay = 0.15,
    duration = 0.9,
    stagger = 0.11,
    rise = 1,
    turbulence = 1,
    softness = 1,
    density = 1,
    speed = 1,
    replayOnHover = false,
    quality = 1,
    onComplete,
    className,
    style,
  },
  ref,
) {
  const Tag = as as "span";
  const rootRef = useRef<HTMLElement>(null);
  const faceRef = useRef<HTMLSpanElement>(null);
  const controllerRef = useRef<Controller | null>(null);
  const reduced = useSyncExternalStore(subscribeToMotion, readMotion, () => false);
  const glyphs = useMemo(() => segment(text), [text]);
  const settingsRef = useRef<Settings>({
    smokeColor,
    trigger,
    visible,
    direction,
    delay,
    duration,
    stagger,
    rise,
    turbulence,
    softness,
    density,
    speed,
    replayOnHover,
    quality,
    reduced,
    onComplete,
  });

  useEffect(() => {
    settingsRef.current = {
      smokeColor,
      trigger,
      visible,
      direction,
      delay,
      duration,
      stagger,
      rise,
      turbulence,
      softness,
      density,
        speed,
      replayOnHover,
      quality,
      reduced,
      onComplete,
    };
    controllerRef.current?.sync();
  });

  useEffect(() => {
    const root = rootRef.current;
    const face = faceRef.current;
    if (!root || !face) return;
    const controller = createSmoke(root, face, settingsRef);
    controllerRef.current = controller;
    return () => {
      controller?.destroy();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.measure();
  }, [glyphs, fontSize, fontWeight, letterSpacing, lineHeight, align, color]);

  useImperativeHandle(
    ref,
    () => ({
      replay: () => controllerRef.current?.replay(),
      condense: () => controllerRef.current?.condense(),
      dissolve: () => controllerRef.current?.dissolve(),
    }),
    [],
  );

  return (
    <Tag
      ref={rootRef as RefObject<HTMLSpanElement>}
      className={cn("relative inline-block max-w-full", className)}
      style={{
        fontSize: typeof fontSize === "number" ? `${fontSize}px` : fontSize,
        fontWeight,
        letterSpacing,
        lineHeight,
        textAlign: align,
        color,
        ...style,
      }}
    >
      <span ref={faceRef} style={{ position: "relative", zIndex: 1, opacity: reduced ? 1 : 0, whiteSpace: "pre-wrap" }}>
        {glyphs.map((glyph, index) => (
          <span key={index} data-smoke-index={index}>
            {glyph}
          </span>
        ))}
      </span>
    </Tag>
  );
});

SmokeType.displayName = "SmokeType";

export { SmokeType };
export default SmokeType;
