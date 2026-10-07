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

export type GlyphOrbMode = "auto" | "glow" | "ink";

export interface GlyphOrbHandle {
  storm: (x?: number, y?: number) => void;
}

export interface GlyphOrbProps {
  colors?: [string, string];
  backgroundColor?: string;
  mode?: GlyphOrbMode;
  charset?: string;
  fontFamily?: string;
  glyphSize?: number;
  spacing?: number;
  size?: number;
  centerX?: number;
  centerY?: number;
  tilt?: number;
  spin?: number;
  bands?: number;
  turbulence?: number;
  lightAngle?: number;
  lightHeight?: number;
  hoverLight?: boolean;
  rim?: number;
  atmosphere?: number;
  contrast?: number;
  glow?: number;
  intensity?: number;
  interactive?: boolean;
  draggable?: boolean;
  momentum?: number;
  clickStorm?: boolean;
  stormStrength?: number;
  paused?: boolean;
  quality?: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

interface Settings {
  colors: [string, string];
  backgroundColor: string;
  mode: GlyphOrbMode;
  charset: string;
  fontFamily: string;
  glyphSize: number;
  spacing: number;
  size: number;
  centerX: number;
  centerY: number;
  tilt: number;
  spin: number;
  bands: number;
  turbulence: number;
  lightAngle: number;
  lightHeight: number;
  hoverLight: boolean;
  rim: number;
  atmosphere: number;
  contrast: number;
  glow: number;
  intensity: number;
  interactive: boolean;
  draggable: boolean;
  momentum: number;
  clickStorm: boolean;
  stormStrength: number;
  paused: boolean;
  quality: number;
  reduced: boolean;
}

interface Controller {
  sync: () => void;
  destroy: () => void;
  storm: (x: number, y: number) => void;
}

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

const STORMS = 6;
const STORM_LIFE = 12;
const PITCH = -0.22;
const ATLAS_COLUMNS = 16;
const DEFAULT_CHARSET = " .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";
const DEFAULT_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

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

const quatMultiply = (a: Quat, b: Quat): Quat => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];

const quatNormalize = (q: Quat): Quat => {
  const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
};

const quatFromAxisAngle = (axis: Vec3, angle: number): Quat => {
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  if (length < 1e-9 || Math.abs(angle) < 1e-9) return [1, 0, 0, 0];
  const s = Math.sin(angle / 2) / length;
  return [Math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s];
};

const quatToMatrix = (q: Quat) => {
  const [w, x, y, z] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
};

const multiply3 = (a: number[][], b: number[][]) =>
  a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const passVertex = `
out vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fieldFragment = `
precision highp float;
uniform vec2 uCell;
uniform vec2 uCenter;
uniform float uRadius;
uniform mat3 uOrient;
uniform vec3 uLight;
uniform float uTime;
uniform float uBands;
uniform float uTurbulence;
uniform float uRim;
uniform float uAmbient;
uniform float uAtmosphere;
uniform vec4 uStorms[${STORMS}];
uniform vec4 uStormShape[${STORMS}];
out vec4 fragColor;

float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(
    mix(mix(hash3(i), hash3(i + vec3(1.0, 0.0, 0.0)), f.x), mix(hash3(i + vec3(0.0, 1.0, 0.0)), hash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0.0, 0.0, 1.0)), hash3(i + vec3(1.0, 0.0, 1.0)), f.x), mix(hash3(i + vec3(0.0, 1.0, 1.0)), hash3(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z
  );
}

vec3 rotateAbout(vec3 v, vec3 axis, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

float bands(vec3 q) {
  float shear = 0.9 * sin(uTime * 0.021) * (1.0 - 1.4 * q.y * q.y);
  float c = cos(shear);
  float s = sin(shear);
  vec3 r = vec3(c * q.x + s * q.z, q.y, -s * q.x + c * q.z);
  vec3 w = r * 2.1 + vec3(0.0, 0.0, uTime * 0.03);
  float warp = (noise3(w) - 0.5) * 1.6 + (noise3(w * 2.3 + 7.1) - 0.5) * 0.8;
  float lat = asin(clamp(r.y + warp * 0.05 * uTurbulence, -1.0, 1.0));
  float broad = 0.5 + 0.5 * sin(lat * uBands + warp * uTurbulence * 2.4);
  float fine = 0.5 + 0.5 * sin(lat * uBands * 2.6 + 1.7 + warp * uTurbulence * 1.6);
  float grain = noise3(r * 9.0 + vec3(uTime * 0.05, 0.0, 0.0));
  return clamp(0.58 * broad + 0.27 * fine + 0.15 * grain, 0.0, 1.0);
}

float surface(vec3 q, out float mark) {
  mark = 0.0;
  vec3 twisted = q;
  float presence = 0.0;
  for (int k = 0; k < ${STORMS}; k++) {
    vec4 storm = uStorms[k];
    if (storm.w < 0.0) continue;
    float age = uTime - storm.w;
    if (age < 0.0 || age > ${STORM_LIFE}.0) continue;
    vec4 shape = uStormShape[k];
    float d = acos(clamp(dot(q, storm.xyz), -1.0, 1.0)) / shape.y;
    float falloff = exp(-d * d);
    twisted = rotateAbout(twisted, storm.xyz, shape.x * falloff * (1.2 + 0.45 * age));
    float vis = smoothstep(0.0, 1.2, age) * (1.0 - smoothstep(${STORM_LIFE}.0 * 0.5, ${STORM_LIFE}.0, age));
    presence = max(presence, vis * smoothstep(3.2, 1.6, d));
    mark += vis * min(abs(shape.x), 1.5) * exp(-d * d * 1.6);
  }
  float base = bands(q);
  if (presence <= 0.001) return base;
  return mix(base, bands(twisted), clamp(presence, 0.0, 1.0));
}

void main() {
  vec2 center = gl_FragCoord.xy * uCell;
  vec2 d = (center - uCenter) / uRadius;
  float r2 = dot(d, d);
  vec2 lightFlat = normalize(uLight.xy + vec2(1e-4));
  float behind = smoothstep(-0.2, 0.7, -uLight.z);
  float value = 0.0;
  float tone = 0.0;
  if (r2 < 1.0) {
    vec3 n = vec3(d, sqrt(1.0 - r2));
    vec3 q = transpose(uOrient) * n;
    float mark;
    float albedo = surface(q, mark);
    float lit = smoothstep(-0.1, 0.85, dot(n, uLight));
    float toward = dot(normalize(d + vec2(1e-5)), lightFlat);
    float scatter = pow(1.0 - n.z, 4.0) * smoothstep(-0.35, 1.0, toward) * (0.35 + 0.65 * behind);
    value = mix(0.3, 1.0, albedo) * (uAmbient + (1.0 - uAmbient) * lit) + uRim * scatter;
    tone = value + (albedo - 0.5) * 0.14 + mark * 0.16;
  } else {
    float edge = sqrt(r2) - 1.0;
    float toward = dot(normalize(d), lightFlat);
    float side = smoothstep(-0.4, 1.0, toward) * (0.45 + 0.55 * behind);
    value = uAtmosphere * 0.5 * exp(-edge * 18.0) * side;
    tone = value;
  }
  fragColor = vec4(value, tone, 0.0, 1.0);
}
`;

const glyphFragment = `
precision highp float;
uniform sampler2D uField;
uniform sampler2D uAtlas;
uniform vec2 uAtlasGrid;
uniform float uCount;
uniform vec2 uCell;
uniform float uGamma;
uniform float uDither;
uniform vec3 uLabNight;
uniform vec3 uLabLit;
out vec4 fragColor;

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

float glyphCoverage(float index, vec2 g) {
  vec2 f = fract(g) - 0.5;
  vec2 span = vec2(uCell.x / uCell.y, 1.0) * 0.86;
  vec2 texel = vec2(0.5 + f.x * span.x, 0.5 - f.y * span.y);
  float inside = step(0.01, texel.x) * step(texel.x, 0.99) * step(0.01, texel.y) * step(texel.y, 0.99);
  vec2 slot = vec2(mod(index, uAtlasGrid.x), floor(index / uAtlasGrid.x));
  vec2 uv = (slot + texel) / uAtlasGrid;
  vec2 scale = span / uAtlasGrid;
  return textureGrad(uAtlas, uv, dFdx(g) * scale, dFdy(g) * scale).r * inside;
}

vec3 palette(float t) {
  vec3 deep = vec3(uLabNight.x * 0.5, uLabNight.yz * 0.9);
  vec3 white = vec3(min(uLabLit.x * 1.06 + 0.04, 0.99), uLabLit.yz * 0.3);
  vec3 lab = t < 0.4 ? mix(deep, uLabNight, smoothstep(0.0, 0.4, t))
    : t < 0.82 ? mix(uLabNight, uLabLit, smoothstep(0.4, 0.82, t))
    : mix(uLabLit, white, smoothstep(0.82, 1.0, t));
  return labToLinear(lab);
}

void main() {
  vec2 g = gl_FragCoord.xy / uCell;
  vec2 cellId = floor(g);
  vec4 field = texelFetch(uField, ivec2(cellId), 0);
  float dither = fract(sin(dot(cellId, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  float value = clamp(field.r + dither * uDither * step(0.02, field.r), 0.0, 1.0);
  float level = pow(value, uGamma);
  float index = floor(level * (uCount - 1.0) + 0.5);
  float energy = 0.0;
  vec3 color = vec3(0.0);
  if (index >= 1.0) {
    float cover = glyphCoverage(index, g);
    color = palette(clamp(field.g, 0.0, 1.0));
    energy = cover * (0.2 + 0.95 * level) * mix(1.0, 0.75, smoothstep(0.7, 1.0, level));
  }
  fragColor = vec4(color * energy, energy);
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
    color = uBackground + (1.0 - uBackground) * exposed;
  } else {
    float energy = lines.a + bloom.a * uGlow * 0.2;
    vec3 hue = (lines.rgb + bloom.rgb * uGlow * 0.2) / max(energy, 1e-4);
    float cover = clamp(1.0 - exp(-energy * uExposure * 1.4), 0.0, 0.95);
    color = mix(uBackground, clamp(hue * 0.85, 0.0, 1.0), cover);
  }
  float grain = hash(gl_FragCoord.xy + uGrain * 311.0) - 0.5;
  fragColor = vec4(encode(color) + grain * (1.2 / 255.0), 1.0);
}
`;

const buildAtlas = (charset: string, fontFamily: string, cell: number) => {
  const ramp = Array.from(new Set(Array.from(charset))).slice(0, 180);
  if (ramp.length < 2) ramp.push(".", "#");
  const measure = document.createElement("canvas");
  measure.width = cell;
  measure.height = cell;
  const probe = measure.getContext("2d", { willReadFrequently: true });
  const font = `500 ${Math.round(cell * 0.8)}px ${fontFamily}`;
  const weight = (character: string) => {
    if (!probe) return 0;
    probe.fillStyle = "#000000";
    probe.fillRect(0, 0, cell, cell);
    probe.fillStyle = "#ffffff";
    probe.textAlign = "center";
    probe.textBaseline = "middle";
    probe.font = font;
    probe.fillText(character, cell / 2, cell / 2);
    const data = probe.getImageData(0, 0, cell, cell).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i];
    return sum;
  };
  const list = ramp
    .map((character) => ({ character, ink: weight(character) }))
    .sort((a, b) => a.ink - b.ink)
    .map((item) => item.character);
  const rows = Math.ceil(list.length / ATLAS_COLUMNS);
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_COLUMNS * cell;
  canvas.height = rows * cell;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = "#000000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ffffff";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = font;
    list.forEach((character, index) => {
      const x = (index % ATLAS_COLUMNS) * cell + cell / 2;
      const y = Math.floor(index / ATLAS_COLUMNS) * cell + cell / 2 + cell * 0.04;
      context.fillText(character, x, y);
    });
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return { texture, count: list.length, rows };
};

const createOrb = (root: HTMLDivElement, settingsRef: { current: Settings }): Controller | null => {
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
  const storms = Array.from({ length: STORMS }, () => new THREE.Vector4(0, 0, 1, -1));
  const stormShapes = Array.from({ length: STORMS }, () => new THREE.Vector4(1, 0.25, 0, 0));
  const orient = new THREE.Matrix3();

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

  const fieldMaterial = pass(fieldFragment, {
    uCell: { value: new THREE.Vector2(7, 11) },
    uCenter: { value: new THREE.Vector2() },
    uRadius: { value: 100 },
    uOrient: { value: orient },
    uLight: { value: new THREE.Vector3(-0.5, 0.5, 0.2) },
    uTime: { value: 0 },
    uBands: { value: 9 },
    uTurbulence: { value: 1 },
    uRim: { value: 0.7 },
    uAmbient: { value: 0.09 },
    uAtmosphere: { value: 0.6 },
    uStorms: { value: storms },
    uStormShape: { value: stormShapes },
  });
  const glyphMaterial = pass(glyphFragment, {
    uField: { value: null },
    uAtlas: { value: null },
    uAtlasGrid: { value: new THREE.Vector2(ATLAS_COLUMNS, 1) },
    uCount: { value: 2 },
    uCell: { value: new THREE.Vector2(7, 11) },
    uGamma: { value: 1 },
    uDither: { value: 0.05 },
    uLabNight: { value: new THREE.Vector3() },
    uLabLit: { value: new THREE.Vector3() },
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
    uGlow: { value: 0.3 },
    uExposure: { value: 1.2 },
    uMode: { value: 0 },
    uGrain: { value: 0 },
  });

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
  let fieldTarget: THREE.WebGLRenderTarget | null = null;
  let fieldKey = "";
  let atlas: ReturnType<typeof buildAtlas> | null = null;
  let atlasKey = "";
  const lamp = new THREE.Vector3(-0.5, 0.5, 0.2).normalize();
  const lampGoal = new THREE.Vector3();
  let lampPlaced = false;

  let destroyed = false;
  let raf = 0;
  let last = 0;
  let visible = true;
  let clock = 40;
  let spinAngle = 0.4;
  let userTurn: Quat = [1, 0, 0, 0];
  let angular: Vec3 = [0, 0, 0];
  let width = 1;
  let height = 1;
  let pixelRatio = 1;
  let grain = 0;
  let stormSlot = 0;
  let lastMatrix = quatToMatrix([1, 0, 0, 0]);
  const pointer = { x: 0, y: 0, time: 0, down: false, dragging: false, startX: 0, startY: 0, id: -1, inside: false };

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

  const geometry = () => {
    const settings = settingsRef.current;
    const w = width * pixelRatio;
    const h = height * pixelRatio;
    return {
      cx: clamp(settings.centerX, -1, 2) * w,
      cy: (1 - clamp(settings.centerY, -1, 2)) * h,
      radius: Math.max(8, clamp(settings.size, 0.1, 4) * 0.36 * Math.min(w, h)),
    };
  };

  function glyphPixels() {
    const settings = settingsRef.current;
    return clamp(settings.glyphSize, 5, 40) * clamp(Math.min(width, height) / 520, 0.72, 1) * pixelRatio;
  }

  const ensureAtlas = () => {
    const settings = settingsRef.current;
    const charset = String(settings.charset ?? "") || DEFAULT_CHARSET;
    const font = String(settings.fontFamily ?? "") || DEFAULT_FONT;
    const cell = Math.round(clamp(glyphPixels() * 1.3, 16, 96) / 4) * 4;
    const key = `${charset}|${font}|${cell}`;
    if (key === atlasKey && atlas) return;
    atlasKey = key;
    atlas?.texture.dispose();
    atlas = buildAtlas(charset, font, cell);
    glyphMaterial.uniforms.uAtlas.value = atlas.texture;
    glyphMaterial.uniforms.uAtlasGrid.value.set(ATLAS_COLUMNS, atlas.rows);
    glyphMaterial.uniforms.uCount.value = atlas.count;
  };

  const cellSize = () => {
    const settings = settingsRef.current;
    const size = glyphPixels();
    return [size * 0.62 * clamp(settings.spacing, 0.6, 2.5), size * 1.04] as const;
  };

  const ensureField = () => {
    const [cellW, cellH] = cellSize();
    const cols = Math.ceil((width * pixelRatio) / cellW);
    const rows = Math.ceil((height * pixelRatio) / cellH);
    const key = `${cols}|${rows}`;
    if (key === fieldKey && fieldTarget) return;
    fieldKey = key;
    fieldTarget?.dispose();
    fieldTarget = new THREE.WebGLRenderTarget(cols, rows, {
      type: texelType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
  };

  const lightFromSettings = (target: THREE.Vector3) => {
    const settings = settingsRef.current;
    const angle = (clamp(settings.lightAngle, -180, 180) * Math.PI) / 180;
    const lift = clamp(settings.lightHeight, 0, 1);
    return target.set(Math.sin(angle), Math.cos(angle), -0.55 + lift * 2.2).normalize();
  };

  const aimLamp = (dt: number) => {
    const settings = settingsRef.current;
    const shape = geometry();
    if (pointer.inside && !pointer.dragging && settings.interactive && settings.hoverLight && !settings.reduced) {
      const dx = (pointer.x - shape.cx) / shape.radius;
      const dy = (pointer.y - shape.cy) / shape.radius;
      const reach = Math.hypot(dx, dy);
      if (reach > 0.3) {
        const lift = -0.55 + clamp(settings.lightHeight, 0, 1) * 2.2;
        lampGoal.set(dx / reach, dy / reach, lift).normalize();
      }
    } else if (!pointer.dragging) {
      lightFromSettings(lampGoal);
    }
    if (!lampPlaced || settings.reduced || dt <= 0) {
      lamp.copy(lampGoal);
      lampPlaced = true;
      return;
    }
    lamp.lerp(lampGoal, 1 - Math.exp(-dt / 0.55)).normalize();
  };

  const orientation = () => {
    const settings = settingsRef.current;
    const lean = (clamp(settings.tilt, -90, 90) * Math.PI) / 180;
    const spinMatrix = [
      [Math.cos(spinAngle), 0, Math.sin(spinAngle)],
      [0, 1, 0],
      [-Math.sin(spinAngle), 0, Math.cos(spinAngle)],
    ];
    const pitchMatrix = [
      [1, 0, 0],
      [0, Math.cos(PITCH), -Math.sin(PITCH)],
      [0, Math.sin(PITCH), Math.cos(PITCH)],
    ];
    const leanMatrix = [
      [Math.cos(lean), -Math.sin(lean), 0],
      [Math.sin(lean), Math.cos(lean), 0],
      [0, 0, 1],
    ];
    return multiply3(quatToMatrix(userTurn), multiply3(leanMatrix, multiply3(pitchMatrix, spinMatrix)));
  };

  const toBody = (view: Vec3): Vec3 => {
    const m = lastMatrix;
    return [
      m[0][0] * view[0] + m[1][0] * view[1] + m[2][0] * view[2],
      m[0][1] * view[0] + m[1][1] * view[1] + m[2][1] * view[2],
      m[0][2] * view[0] + m[1][2] * view[1] + m[2][2] * view[2],
    ];
  };

  const apply = () => {
    const settings = settingsRef.current;
    const shape = geometry();
    const background = parseColor(settings.backgroundColor, [0.04, 0.04, 0.04]);
    const luminance = 0.2126 * background[0] + 0.7152 * background[1] + 0.0722 * background[2];
    const ink = settings.mode === "ink" || (settings.mode === "auto" && luminance > 0.5);
    const night = toOklab(parseColor(settings.colors[0], [0.45, 0.28, 1]));
    const lit = toOklab(parseColor(settings.colors[1], [1, 0.75, 0.93]));
    if (!lampPlaced) aimLamp(0);
    lastMatrix = orientation();
    const m = lastMatrix;
    orient.set(m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]);
    const [cellW, cellH] = cellSize();
    const field = fieldMaterial.uniforms;
    field.uCell.value.set(cellW, cellH);
    field.uCenter.value.set(shape.cx, shape.cy);
    field.uRadius.value = shape.radius;
    field.uLight.value.copy(lamp);
    field.uTime.value = clock;
    field.uBands.value = clamp(settings.bands, 1, 30);
    field.uTurbulence.value = clamp(settings.turbulence, 0, 3);
    field.uRim.value = clamp(settings.rim, 0, 2);
    field.uAtmosphere.value = clamp(settings.atmosphere, 0, 2);
    const glyph = glyphMaterial.uniforms;
    glyph.uField.value = fieldTarget ? fieldTarget.texture : null;
    glyph.uCell.value.set(cellW, cellH);
    glyph.uGamma.value = 0.6 + clamp(settings.contrast, 0, 1) * 1.2;
    glyph.uDither.value = 0.14 / Math.sqrt(Math.max((atlas?.count ?? 10) / 10, 1));
    glyph.uLabNight.value.set(night[0], night[1], night[2]);
    glyph.uLabLit.value.set(lit[0], lit[1], lit[2]);
    const composite = compositeMaterial.uniforms;
    composite.uBackground.value.set(toLinear(background[0]), toLinear(background[1]), toLinear(background[2]));
    composite.uGlow.value = clamp(settings.glow, 0, 3);
    composite.uExposure.value = (ink ? 4 : 1.2) * clamp(settings.intensity, 0, 4);
    composite.uMode.value = ink ? 1 : 0;
    composite.uGrain.value = grain;
  };

  const render = () => {
    if (!lineTarget || !downTargets.length) return;
    ensureAtlas();
    ensureField();
    apply();
    if (fieldTarget) draw(fieldMaterial, fieldTarget);
    draw(glyphMaterial, lineTarget);
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

  const surfacePoint = (x: number, y: number): Vec3 => {
    const shape = geometry();
    const px = (x - shape.cx) / shape.radius;
    const py = (y - shape.cy) / shape.radius;
    const r2 = px * px + py * py;
    if (r2 >= 1) {
      const r = Math.sqrt(r2);
      return [px / r, py / r, 0];
    }
    return [px, py, Math.sqrt(1 - r2)];
  };

  const turn = (rotation: Quat) => {
    userTurn = quatNormalize(quatMultiply(rotation, userTurn));
  };

  const step = (dt: number) => {
    const settings = settingsRef.current;
    aimLamp(dt);
    if (settings.paused || settings.reduced) return;
    clock += dt;
    if (!pointer.dragging) spinAngle += dt * clamp(settings.spin, -4, 4) * 0.12;
    if (!pointer.dragging) {
      const friction = 0.35 + clamp(settings.momentum, 0, 1) * 3.2;
      const fade = Math.exp(-dt / friction);
      angular = [angular[0] * fade, angular[1] * fade, angular[2] * fade];
      const magnitude = Math.hypot(angular[0], angular[1], angular[2]);
      if (magnitude > 1e-5) turn(quatFromAxisAngle(angular, magnitude * dt));
      if (magnitude < 0.35) {
        const settle = 1 - Math.exp(-dt / 3.2);
        const identity: Quat = userTurn[0] < 0 ? [-1, 0, 0, 0] : [1, 0, 0, 0];
        userTurn = quatNormalize([
          userTurn[0] + (identity[0] - userTurn[0]) * settle,
          userTurn[1] * (1 - settle),
          userTurn[2] * (1 - settle),
          userTurn[3] * (1 - settle),
        ]);
      }
    }
    grain = (grain + 0.618034) % 1;
  };

  const tick = (now: number) => {
    raf = 0;
    if (destroyed) return;
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    step(dt);
    render();
    const settings = settingsRef.current;
    const animating = !settings.paused && !settings.reduced;
    const settling = lamp.distanceToSquared(lampGoal) > 1e-6;
    if (visible && !document.hidden && (animating || settling)) raf = requestAnimationFrame(tick);
  };

  function wake() {
    if (destroyed || raf || !visible) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

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
      downTargets.push(target(w >> k, h >> k));
      upTargets.push(target(w >> k, h >> k));
    }
    render();
    wake();
  };

  const locate = (event: PointerEvent) => {
    const rect = root.getBoundingClientRect();
    return [(event.clientX - rect.left) * pixelRatio, (rect.height - (event.clientY - rect.top)) * pixelRatio] as const;
  };

  const overOrb = (x: number, y: number) => {
    const shape = geometry();
    return Math.hypot(x - shape.cx, y - shape.cy) < shape.radius;
  };

  const stormAt = (view: Vec3) => {
    const settings = settingsRef.current;
    if (settings.reduced || settings.paused) return;
    const body = toBody(view);
    stormSlot = (stormSlot + 1) % STORMS;
    storms[stormSlot].set(body[0], body[1], body[2], clock);
    stormShapes[stormSlot].set(clamp(settings.stormStrength, 0, 3) * (Math.random() < 0.5 ? -1 : 1), 0.22 + Math.random() * 0.08, 0, 0);
    wake();
  };

  const onMove = (event: PointerEvent) => {
    const settings = settingsRef.current;
    if (!settings.interactive) return;
    const [x, y] = locate(event);
    const now = performance.now();
    if (pointer.down && pointer.id === event.pointerId && settings.draggable && event.pointerType !== "touch") {
      if (!pointer.dragging && Math.hypot(x - pointer.startX, y - pointer.startY) > 6 * pixelRatio) {
        pointer.dragging = true;
        try {
          root.setPointerCapture(event.pointerId);
        } catch {}
      }
      if (pointer.dragging) {
        const from = surfacePoint(pointer.x, pointer.y);
        const to = surfacePoint(x, y);
        const axis = cross(from, to);
        const angle = Math.acos(clamp(from[0] * to[0] + from[1] * to[1] + from[2] * to[2], -1, 1));
        turn(quatFromAxisAngle(axis, angle));
        const elapsed = clamp((now - pointer.time) / 1000, 1 / 240, 0.1);
        const length = Math.hypot(axis[0], axis[1], axis[2]) || 1;
        const rate = angle / elapsed;
        angular = [
          angular[0] + ((axis[0] / length) * rate - angular[0]) * 0.5,
          angular[1] + ((axis[1] / length) * rate - angular[1]) * 0.5,
          angular[2] + ((axis[2] / length) * rate - angular[2]) * 0.5,
        ];
      }
    }
    root.style.cursor = settings.draggable && (pointer.dragging || overOrb(x, y)) ? (pointer.dragging ? "grabbing" : "grab") : "";
    pointer.x = x;
    pointer.y = y;
    pointer.time = now;
    if (event.pointerType !== "touch") pointer.inside = true;
    wake();
  };

  const onDown = (event: PointerEvent) => {
    const settings = settingsRef.current;
    if (event.button !== 0 || !settings.interactive) return;
    const [x, y] = locate(event);
    pointer.down = true;
    pointer.dragging = false;
    pointer.startX = x;
    pointer.startY = y;
    pointer.x = x;
    pointer.y = y;
    pointer.time = performance.now();
    pointer.id = event.pointerId;
    if (settings.draggable && event.pointerType !== "touch" && overOrb(x, y)) {
      angular = [angular[0] * 0.3, angular[1] * 0.3, angular[2] * 0.3];
    }
  };

  const onUp = (event: PointerEvent) => {
    if (!pointer.down || pointer.id !== event.pointerId) return;
    const settings = settingsRef.current;
    const wasDragging = pointer.dragging;
    pointer.down = false;
    pointer.dragging = false;
    try {
      root.releasePointerCapture(event.pointerId);
    } catch {}
    const [x, y] = locate(event);
    if (!wasDragging && settings.interactive && settings.clickStorm && overOrb(x, y)) stormAt(surfacePoint(x, y));
  };

  const onCancel = (event: PointerEvent) => {
    if (pointer.id === event.pointerId) {
      pointer.down = false;
      pointer.dragging = false;
    }
  };

  const onLeave = () => {
    pointer.inside = false;
    if (!pointer.dragging) root.style.cursor = "";
    wake();
  };

  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerdown", onDown);
  root.addEventListener("pointerup", onUp);
  root.addEventListener("pointercancel", onCancel);
  root.addEventListener("pointerleave", onLeave);
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
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", onCancel);
      root.removeEventListener("pointerleave", onLeave);
      root.style.cursor = "";
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onLost);
      resizeObserver.disconnect();
      intersection.disconnect();
      release();
      fieldTarget?.dispose();
      atlas?.texture.dispose();
      plane.dispose();
      [fieldMaterial, glyphMaterial, downMaterial, upMaterial, compositeMaterial].forEach((item) => item.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
    storm: (x: number, y: number) => {
      const shape = geometry();
      stormAt(surfacePoint(shape.cx + (clamp(x, 0, 1) - 0.5) * 2 * shape.radius, shape.cy - (clamp(y, 0, 1) - 0.5) * 2 * shape.radius));
    },
  };
};

const GlyphOrb = forwardRef<GlyphOrbHandle, GlyphOrbProps>(function GlyphOrb(
  {
    colors = ["#6D3DFF", "#FF9BE1"],
    backgroundColor = "#0A0A0A",
    mode = "auto",
    charset = DEFAULT_CHARSET,
    fontFamily = DEFAULT_FONT,
    glyphSize = 10,
    spacing = 1.1,
    size = 1,
    centerX = 0.5,
    centerY = 0.5,
    tilt = -24,
    spin = 1,
    bands = 9,
    turbulence = 1,
    lightAngle = -45,
    lightHeight = 0.4,
    hoverLight = true,
    rim = 0.7,
    atmosphere = 0.6,
    contrast = 0.4,
    glow = 0.12,
    intensity = 1,
    interactive = true,
    draggable = true,
    momentum = 0.5,
    clickStorm = true,
    stormStrength = 1,
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
    charset,
    fontFamily,
    glyphSize,
    spacing,
    size,
    centerX,
    centerY,
    tilt,
    spin,
    bands,
    turbulence,
    lightAngle,
    lightHeight,
    hoverLight,
    rim,
    atmosphere,
    contrast,
    glow,
    intensity,
    interactive,
    draggable,
    momentum,
    clickStorm,
    stormStrength,
    paused,
    quality,
    reduced,
  });

  useEffect(() => {
    settingsRef.current = {
      colors,
      backgroundColor,
      mode,
      charset,
      fontFamily,
      glyphSize,
      spacing,
      size,
      centerX,
      centerY,
      tilt,
      spin,
      bands,
      turbulence,
      lightAngle,
      lightHeight,
      hoverLight,
      rim,
      atmosphere,
      contrast,
      glow,
      intensity,
      interactive,
      draggable,
      momentum,
      clickStorm,
      stormStrength,
      paused,
      quality,
      reduced,
    };
    controllerRef.current?.sync();
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const controller = createOrb(root, settingsRef);
    controllerRef.current = controller;
    return () => {
      controller?.destroy();
      controllerRef.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      storm: (x = 0.5, y = 0.5) => controllerRef.current?.storm(x, y),
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

GlyphOrb.displayName = "GlyphOrb";

export { GlyphOrb };
export default GlyphOrb;
