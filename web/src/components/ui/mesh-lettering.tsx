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

export interface MeshLetteringHandle {
  gust: (x?: number, y?: number, strength?: number) => void;
  replay: () => void;
}

export interface MeshLetteringProps {
  text?: string;
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  letterSpacing?: number;
  lineHeight?: number;
  colors?: [string, string];
  sheen?: number;
  gloss?: number;
  iridescence?: number;
  wind?: number;
  windAngle?: number;
  turbulence?: number;
  flow?: number;
  softness?: number;
  drag?: number;
  hold?: number;
  lightAngle?: number;
  lightDrift?: number;
  interactive?: boolean;
  gustStrength?: number;
  gustRadius?: number;
  clickGust?: boolean;
  intro?: boolean;
  introDuration?: number;
  paused?: boolean;
  quality?: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

interface Settings {
  text: string;
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  letterSpacing: number;
  lineHeight: number;
  colors: [string, string];
  sheen: number;
  gloss: number;
  iridescence: number;
  wind: number;
  windAngle: number;
  turbulence: number;
  flow: number;
  softness: number;
  drag: number;
  hold: number;
  lightAngle: number;
  lightDrift: number;
  interactive: boolean;
  gustStrength: number;
  gustRadius: number;
  clickGust: boolean;
  intro: boolean;
  introDuration: number;
  paused: boolean;
  quality: number;
  reduced: boolean;
}

interface Controller {
  sync: () => void;
  destroy: () => void;
  gust: (x: number, y: number, strength: number) => void;
  replay: () => void;
}

type Rgb = [number, number, number];

const STEP = 1 / 60;

const subscribeToMotion = (notify: () => void) => {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};

const readMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

let colorContext: CanvasRenderingContext2D | null = null;

const parseColor = (value: string, fallback: Rgb): Rgb => {
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

const toLinear = (value: number) =>
  value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);

const linearRgb = (color: Rgb): Rgb => [toLinear(color[0]), toLinear(color[1]), toLinear(color[2])];

const silkVertex = `
in vec3 aTangent;
out vec3 vNormal;
out vec3 vTangent;
out vec3 vWorld;
out vec2 vUv;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vNormal = normalize(mat3(modelMatrix) * normal);
  vTangent = normalize(mat3(modelMatrix) * aTangent);
  vWorld = world.xyz;
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const silkFragment = `
uniform sampler2D uMask;
uniform vec3 uSilk;
uniform vec3 uSheenColor;
uniform vec3 uKey;
uniform vec3 uFill;
uniform vec3 uEye;
uniform float uSheen;
uniform float uGloss;
uniform float uIridescence;
uniform float uFront;
uniform float uFrontWidth;
uniform vec2 uWindDir;
uniform vec4 uRestRect;
uniform vec3 uFrontShape;
in vec3 vNormal;
in vec3 vTangent;
in vec3 vWorld;
in vec2 vUv;
out vec4 fragColor;

vec3 encode(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

vec3 tonemap(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec2 rest = vec2(uRestRect.x + vUv.x * uRestRect.z, uRestRect.y - vUv.y * uRestRect.w);
  float across = dot(rest, vec2(-uWindDir.y, uWindDir.x));
  float along = dot(rest, uWindDir) - across * uFrontShape.x + uFrontShape.y * sin(across * uFrontShape.z + 0.7);
  float reveal = clamp((uFront - along) / uFrontWidth, 0.0, 1.0);
  float alpha = smoothstep(0.25, 0.75, texture(uMask, vUv).a) * reveal * reveal * (3.0 - 2.0 * reveal);
  if (alpha < 0.003) discard;
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(uEye - vWorld);
  vec3 t = normalize(vTangent - n * dot(n, vTangent));
  vec3 b = cross(n, t);
  vec3 h = normalize(uKey + v);
  float lit = clamp((dot(n, uKey) + 0.25) / 1.25, 0.0, 1.0);
  float fill = clamp(dot(n, uFill), 0.0, 1.0);
  float facing = clamp(dot(n, v), 0.0, 1.0);
  float th = dot(t, h);
  float bh = dot(b, h);
  float warp = pow(sqrt(max(1.0 - th * th, 0.0)), mix(30.0, 260.0, uGloss));
  float weft = pow(sqrt(max(1.0 - bh * bh, 0.0)), mix(12.0, 80.0, uGloss));
  float broad = pow(sqrt(max(1.0 - th * th, 0.0)), 8.0);
  float exposure = smoothstep(-0.25, 0.35, dot(n, uKey));
  float grazing = pow(1.0 - facing, 2.5);
  vec3 body = mix(uSilk, uSheenColor, clamp(uIridescence * (grazing * 1.6 + weft * 0.5), 0.0, 1.0));
  vec3 color = body * (0.06 + 1.05 * lit * lit + 0.12 * fill);
  color += body * broad * exposure * uSheen * 0.2;
  color = mix(color, uSheenColor, clamp(grazing * 0.3 * uSheen, 0.0, 1.0));
  color = mix(color, uSheenColor, clamp(weft * exposure * uSheen * 0.3, 0.0, 1.0));
  color = mix(color, mix(uSheenColor, vec3(1.0), 0.2) * 1.15, clamp(warp * exposure * uSheen * 0.9, 0.0, 1.0));
  if (!gl_FrontFacing) color *= 0.72;
  fragColor = vec4(encode(tonemap(color)) * alpha, alpha);
}
`;

const createSilk = (root: HTMLDivElement, settingsRef: { current: Settings }): Controller | null => {
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
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: true });
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

  const camera = new THREE.PerspectiveCamera(30, 1, 1, 20000);
  const scene = new THREE.Scene();
  const maskCanvas = document.createElement("canvas");
  const maskTexture = new THREE.CanvasTexture(maskCanvas);
  maskTexture.flipY = false;
  maskTexture.minFilter = THREE.LinearMipmapLinearFilter;
  maskTexture.magFilter = THREE.LinearFilter;
  maskTexture.generateMipmaps = true;
  maskTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  maskTexture.colorSpace = THREE.NoColorSpace;

  const uniforms = {
    uMask: { value: maskTexture },
    uSilk: { value: new THREE.Vector3(0.5, 0.4, 1) },
    uSheenColor: { value: new THREE.Vector3(1, 0.4, 1) },
    uKey: { value: new THREE.Vector3(-0.4, 0.6, 0.7).normalize() },
    uFill: { value: new THREE.Vector3(0.6, -0.3, 0.7).normalize() },
    uEye: { value: new THREE.Vector3(0, 0, 1000) },
    uSheen: { value: 1 },
    uGloss: { value: 0.6 },
    uIridescence: { value: 0.5 },
    uFront: { value: 1e9 },
    uFrontWidth: { value: 100 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uRestRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uFrontShape: { value: new THREE.Vector3(0.3, 0, 1) },
  };
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: silkVertex,
    fragmentShader: silkFragment,
    uniforms,
    side: THREE.DoubleSide,
    transparent: true,
    depthTest: true,
    depthWrite: true,
    premultipliedAlpha: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  let geometry = new THREE.BufferGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);

  const box = { x0: 0, y0: 0, x1: 0, y1: 0, size: 100 };
  const cloth = {
    cols: 0,
    rows: 0,
    count: 0,
    position: new Float32Array(0),
    previous: new Float32Array(0),
    rest: new Float32Array(0),
    normal: new Float32Array(0),
    tangent: new Float32Array(0),
    first: new Uint32Array(0),
    second: new Uint32Array(0),
    length: new Float32Array(0),
    weight: new Float32Array(0),
    spacing: 8,
  };
  let positionAttribute: THREE.BufferAttribute | null = null;
  let normalAttribute: THREE.BufferAttribute | null = null;
  let tangentAttribute: THREE.BufferAttribute | null = null;
  const pointer = { x: 0, y: 0, t: 0, placed: false };
  const ndc = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const hit = new THREE.Vector3();
  let layoutKey = "";
  let width = 1;
  let height = 1;
  let pixelRatio = 1;
  let clock = 0;
  let accumulator = 0;
  let lightPhase = 0;
  let raf = 0;
  let last = 0;
  let visible = true;
  let destroyed = false;
  let sized = false;
  let frames = 0;
  let settledStill = false;
  let introKey = "";
  const intro = { active: false, time: 0, lo: 0, hi: 1 };
  const requested = new Set<string>();

  const fontFor = (size: number) => {
    const settings = settingsRef.current;
    const family = settings.fontFamily || getComputedStyle(root).fontFamily;
    return `${clamp(Math.round(settings.fontWeight), 100, 900)} ${size}px ${family}`;
  };

  const buildCloth = () => {
    const margin = box.size * 0.35;
    const x0 = box.x0 - margin;
    const x1 = box.x1 + margin;
    const y0 = box.y0 - margin;
    const y1 = box.y1 + margin;
    const w = x1 - x0;
    const h = y1 - y0;
    let spacing = clamp(box.size * 0.075, 6, 16);
    while ((w / spacing + 1) * (h / spacing + 1) > 4200) spacing *= 1.08;
    const cols = Math.max(4, Math.round(w / spacing) + 1);
    const rows = Math.max(4, Math.round(h / spacing) + 1);
    const count = cols * rows;
    const sx = w / (cols - 1);
    const sy = h / (rows - 1);
    const position = new Float32Array(count * 3);
    const rest = new Float32Array(count * 2);
    const uv = new Float32Array(count * 2);
    const bw = box.x1 - box.x0;
    const bh = box.y1 - box.y0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const x = x0 + c * sx;
        const y = y1 - r * sy;
        position[i * 3] = x;
        position[i * 3 + 1] = y;
        rest[i * 2] = x;
        rest[i * 2 + 1] = y;
        uv[i * 2] = (x - box.x0) / bw;
        uv[i * 2 + 1] = (box.y1 - y) / bh;
      }
    }
    const first: number[] = [];
    const second: number[] = [];
    const lengths: number[] = [];
    const weights: number[] = [];
    const link = (a: number, b: number, weight: number) => {
      first.push(a);
      second.push(b);
      lengths.push(Math.hypot(rest[a * 2] - rest[b * 2], rest[a * 2 + 1] - rest[b * 2 + 1]));
      weights.push(weight);
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (c + 1 < cols) link(i, i + 1, 1);
        if (r + 1 < rows) link(i, i + cols, 1);
        if (c + 1 < cols && r + 1 < rows) {
          link(i, i + cols + 1, 0.7);
          link(i + 1, i + cols, 0.7);
        }
        if (c + 2 < cols) link(i, i + 2, -1);
        if (r + 2 < rows) link(i, i + cols * 2, -1);
      }
    }
    const indices: number[] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const i = r * cols + c;
        indices.push(i, i + cols, i + 1, i + 1, i + cols, i + cols + 1);
      }
    }
    cloth.cols = cols;
    cloth.rows = rows;
    cloth.count = count;
    cloth.position = position;
    cloth.previous = position.slice();
    cloth.rest = rest;
    cloth.normal = new Float32Array(count * 3);
    cloth.tangent = new Float32Array(count * 3);
    cloth.first = Uint32Array.from(first);
    cloth.second = Uint32Array.from(second);
    cloth.length = Float32Array.from(lengths);
    cloth.weight = Float32Array.from(weights);
    cloth.spacing = Math.min(sx, sy);
    const next = new THREE.BufferGeometry();
    positionAttribute = new THREE.BufferAttribute(position, 3);
    positionAttribute.setUsage(THREE.DynamicDrawUsage);
    normalAttribute = new THREE.BufferAttribute(cloth.normal, 3);
    normalAttribute.setUsage(THREE.DynamicDrawUsage);
    tangentAttribute = new THREE.BufferAttribute(cloth.tangent, 3);
    tangentAttribute.setUsage(THREE.DynamicDrawUsage);
    next.setAttribute("position", positionAttribute);
    next.setAttribute("normal", normalAttribute);
    next.setAttribute("aTangent", tangentAttribute);
    next.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    next.setIndex(count > 65535 ? new THREE.Uint32BufferAttribute(indices, 1) : new THREE.Uint16BufferAttribute(indices, 1));
    geometry.dispose();
    geometry = next;
    mesh.geometry = next;
    clock = 0;
    accumulator = 0;
    settledStill = false;
    const settings = settingsRef.current;
    const key = [settings.text, settings.fontFamily, settings.fontWeight, settings.fontSize, settings.letterSpacing, settings.lineHeight].join("|");
    if (key !== introKey) {
      introKey = key;
      if (settings.intro && !settings.reduced && !settings.paused) startIntro();
    }
    updateFrames();
  };

  const layout = () => {
    const settings = settingsRef.current;
    const context = maskCanvas.getContext("2d");
    if (!context) return;
    const face = fontFor(16);
    if (document.fonts?.load && !requested.has(face)) {
      requested.add(face);
      document.fonts
        .load(face)
        .then((faces) => {
          if (destroyed || !faces.length) return;
          layoutKey = "";
          if (sized) render();
        })
        .catch(() => {});
    }
    const words = settings.text.split(/\s+/).filter(Boolean);
    const leading = clamp(settings.lineHeight, 0.7, 2);
    const spacing = clamp(settings.letterSpacing, -0.2, 1);
    let size = clamp(settings.fontSize, 12, 600);
    let rows: string[] = [];
    const measure = (value: string) => {
      context.font = fontFor(size);
      context.letterSpacing = `${spacing * size}px`;
      return context.measureText(value).width;
    };
    for (let attempt = 0; attempt < 40; attempt++) {
      rows = [];
      let row = "";
      let fits = true;
      for (const word of words) {
        if (measure(word) > width * 0.8) {
          fits = false;
          break;
        }
        const next = row ? `${row} ${word}` : word;
        if (row && measure(next) > width * 0.8) {
          rows.push(row);
          row = word;
        } else row = next;
      }
      if (row) rows.push(row);
      if (fits && rows.length * size * leading <= height * 0.66) break;
      size *= 0.94;
    }
    let widest = 0;
    rows.forEach((row) => {
      widest = Math.max(widest, measure(row));
    });
    const blockH = Math.max(1, rows.length) * size * leading;
    const pad = size * 0.25;
    box.size = size;
    box.x0 = -widest / 2 - pad;
    box.x1 = widest / 2 + pad;
    box.y0 = -blockH / 2 - pad;
    box.y1 = blockH / 2 + pad;
    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    const scale = Math.min(pixelRatio * 1.5, 3);
    maskCanvas.width = Math.max(1, Math.ceil(w * scale));
    maskCanvas.height = Math.max(1, Math.ceil(h * scale));
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.font = fontFor(size);
    context.letterSpacing = `${spacing * size}px`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "#fff";
    rows.forEach((row, index) => {
      const y = ((rows.length - 1) / 2 - index) * size * leading;
      context.fillText(row, -box.x0 + (spacing * size) / 2, box.y1 - y);
    });
    maskTexture.dispose();
    maskTexture.needsUpdate = true;
    buildCloth();
  };

  const ensure = () => {
    const settings = settingsRef.current;
    const key = [
      settings.text,
      settings.fontFamily,
      settings.fontWeight,
      settings.fontSize,
      settings.letterSpacing,
      settings.lineHeight,
      Math.round(width),
      Math.round(height),
      pixelRatio.toFixed(2),
      settings.fontFamily ? "" : getComputedStyle(root).fontFamily,
    ].join("|");
    if (key !== layoutKey) {
      layoutKey = key;
      layout();
    }
  };

  const windVector = () => {
    const angle = (clamp(settingsRef.current.windAngle, -180, 180) * Math.PI) / 180;
    return [Math.cos(angle), Math.sin(angle)] as const;
  };

  const FRONT_TILT = 0.3;

  const frontOffset = (x: number, y: number, wx: number, wy: number) => {
    const across = -x * wy + y * wx;
    return x * wx + y * wy - across * FRONT_TILT + box.size * 0.22 * Math.sin((across * Math.PI * 2) / (box.size * 2.4) + 0.7);
  };

  const startIntro = () => {
    const [wx, wy] = windVector();
    const corners = [
      frontOffset(box.x0, box.y0, wx, wy),
      frontOffset(box.x1, box.y0, wx, wy),
      frontOffset(box.x0, box.y1, wx, wy),
      frontOffset(box.x1, box.y1, wx, wy),
    ];
    intro.lo = Math.min(...corners) - box.size * 0.22;
    intro.hi = Math.max(...corners) + box.size * 0.22;
    intro.time = 0;
    intro.active = true;
  };

  const introFront = () => {
    if (!intro.active) return Infinity;
    const duration = clamp(settingsRef.current.introDuration, 0.2, 8);
    const progress = clamp(intro.time / duration, 0, 1);
    const eased = (1 - Math.cos(Math.PI * progress)) / 2;
    const reach = box.size * 0.8;
    return intro.lo - reach * 0.4 + eased * (intro.hi - intro.lo + reach * 1.4);
  };

  const simulate = () => {
    const settings = settingsRef.current;
    const { cols, rows, count, position, previous, rest, first, second, length, weight } = cloth;
    if (!count) return;
    clock += STEP;
    const size = box.size;
    const windAngle = (clamp(settings.windAngle, -180, 180) * Math.PI) / 180;
    const wx = Math.cos(windAngle);
    const wy = Math.sin(windAngle);
    const strength = clamp(settings.wind, 0, 3) * size * 0.0034;
    const turbulence = clamp(settings.turbulence, 0, 1);
    const flow = clamp(settings.flow, 0, 4);
    const t = clock * flow;
    const k1 = (Math.PI * 2) / (size * 4.2);
    const k2 = (Math.PI * 2) / (size * 2.3);
    const k3 = (Math.PI * 2) / (size * 6.5);
    const damping = 1 - (0.012 + 0.05 * clamp(settings.drag, 0, 1));
    const hold = 0.001 + 0.006 * clamp(settings.hold, 0, 1);
    const holdZ = 0.0018 + 0.009 * clamp(settings.hold, 0, 1);
    const front = introFront();
    const reach = size * 0.8;
    const lift = size * 0.32;
    for (let i = 0; i < count; i++) {
      const p = i * 3;
      const x = position[p];
      const y = position[p + 1];
      const z = position[p + 2];
      const along = rest[i * 2] * wx + rest[i * 2 + 1] * wy;
      const across = -rest[i * 2] * wy + rest[i * 2 + 1] * wx;
      const swell =
        Math.sin(along * k1 - t * 1.1) * 0.62 +
        Math.sin(along * k2 + across * k2 * 0.45 - t * 1.7 + 1.3) * 0.38 * (0.4 + turbulence) +
        Math.sin(across * k3 - t * 0.6 + 2.1) * 0.3 * turbulence;
      const fz = swell * strength;
      const fx = wx * strength * 0.08;
      const fy = wy * strength * 0.08;
      const vx = (x - previous[p]) * damping;
      const vy = (y - previous[p + 1]) * damping;
      const vz = (z - previous[p + 2]) * damping;
      previous[p] = x;
      previous[p + 1] = y;
      previous[p + 2] = z;
      position[p] = x + vx + fx + (rest[i * 2] - x) * hold;
      position[p + 1] = y + vy + fy + (rest[i * 2 + 1] - y) * hold;
      position[p + 2] = z + vz + fz - z * holdZ;
      if (front !== Infinity) {
        const behind = (front - frontOffset(rest[i * 2], rest[i * 2 + 1], wx, wy) - reach * 0.55) / (reach * 0.5);
        const bump = Math.exp(-behind * behind);
        if (bump > 0.01) position[p + 2] += (lift * bump - position[p + 2]) * 0.1 * bump;
      }
    }
    const bend = 0.32 + 0.6 * (1 - clamp(settings.softness, 0, 1));
    for (let iteration = 0; iteration < 4; iteration++) {
      for (let k = 0; k < first.length; k++) {
        const a = first[k] * 3;
        const b = second[k] * 3;
        const dx = position[b] - position[a];
        const dy = position[b + 1] - position[a + 1];
        const dz = position[b + 2] - position[a + 2];
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const stiffness = weight[k] < 0 ? bend : weight[k];
        const correction = ((distance - length[k]) / distance) * 0.5 * stiffness;
        position[a] += dx * correction;
        position[a + 1] += dy * correction;
        position[a + 2] += dz * correction;
        position[b] -= dx * correction;
        position[b + 1] -= dy * correction;
        position[b + 2] -= dz * correction;
      }
    }
    if (cols < 2 || rows < 2) return;
  };

  const updateFrames = () => {
    const { cols, rows, position, normal, tangent } = cloth;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const left = (r * cols + Math.max(0, c - 1)) * 3;
        const right = (r * cols + Math.min(cols - 1, c + 1)) * 3;
        const up = (Math.max(0, r - 1) * cols + c) * 3;
        const down = (Math.min(rows - 1, r + 1) * cols + c) * 3;
        const ax = position[right] - position[left];
        const ay = position[right + 1] - position[left + 1];
        const az = position[right + 2] - position[left + 2];
        const bx = position[up] - position[down];
        const by = position[up + 1] - position[down + 1];
        const bz = position[up + 2] - position[down + 2];
        let nx = ay * bz - az * by;
        let ny = az * bx - ax * bz;
        let nz = ax * by - ay * bx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl;
        ny /= nl;
        nz /= nl;
        const tl = Math.hypot(ax, ay, az) || 1;
        normal[i * 3] = nx;
        normal[i * 3 + 1] = ny;
        normal[i * 3 + 2] = nz;
        tangent[i * 3] = ax / tl;
        tangent[i * 3 + 1] = ay / tl;
        tangent[i * 3 + 2] = az / tl;
      }
    }
    if (positionAttribute) positionAttribute.needsUpdate = true;
    if (normalAttribute) normalAttribute.needsUpdate = true;
    if (tangentAttribute) tangentAttribute.needsUpdate = true;
  };

  const push = (x: number, y: number, vx: number, vy: number, power: number) => {
    const settings = settingsRef.current;
    const { cols, rows, position, previous, rest } = cloth;
    if (!cloth.count) return;
    const radius = clamp(settings.gustRadius, 0.1, 3) * box.size;
    const speed = Math.hypot(vx, vy);
    const ux = speed > 0 ? vx / speed : 0;
    const uy = speed > 0 ? vy / speed : 0;
    const c0 = Math.max(0, Math.floor((x - radius - rest[0]) / cloth.spacing));
    const c1 = Math.min(cols - 1, Math.ceil((x + radius - rest[0]) / cloth.spacing));
    const r0 = Math.max(0, Math.floor((rest[1] - (y + radius)) / cloth.spacing));
    const r1 = Math.min(rows - 1, Math.ceil((rest[1] - (y - radius)) / cloth.spacing));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c;
        const dx = position[i * 3] - x;
        const dy = position[i * 3 + 1] - y;
        const distance = Math.hypot(dx, dy);
        if (distance > radius) continue;
        const falloff = 1 - distance / radius;
        const amount = falloff * falloff * (3 - 2 * falloff) * power;
        previous[i * 3 + 2] += amount * box.size * 0.022;
        previous[i * 3] -= ux * amount * box.size * 0.004;
        previous[i * 3 + 1] -= uy * amount * box.size * 0.004;
      }
    }
  };

  const apply = () => {
    const settings = settingsRef.current;
    const silk = linearRgb(parseColor(settings.colors[0], [0.72, 0.65, 1]));
    const sheen = linearRgb(parseColor(settings.colors[1], [1, 0.62, 0.99]));
    const u = uniforms;
    u.uSilk.value.set(silk[0], silk[1], silk[2]);
    u.uSheenColor.value.set(sheen[0], sheen[1], sheen[2]);
    u.uSheen.value = clamp(settings.sheen, 0, 2);
    u.uGloss.value = clamp(settings.gloss, 0, 1);
    u.uIridescence.value = clamp(settings.iridescence, 0, 1);
    const base = (clamp(settings.lightAngle, -180, 180) * Math.PI) / 180;
    const sway = base + Math.sin(lightPhase * 0.27) * 0.4 + Math.sin(lightPhase * 0.13 + 0.7) * 0.2;
    u.uKey.value.set(Math.sin(sway) * 0.62, Math.cos(sway) * 0.62, 0.72).normalize();
    u.uFill.value.set(-Math.sin(sway) * 0.5, -Math.cos(sway) * 0.4, 0.76).normalize();
    const [wx, wy] = windVector();
    u.uWindDir.value.set(wx, wy);
    u.uFront.value = Math.min(introFront(), 1e9);
    u.uFrontWidth.value = box.size * 0.8;
    u.uFrontShape.value.set(FRONT_TILT, box.size * 0.22, (Math.PI * 2) / (box.size * 2.4));
    u.uRestRect.value.set(box.x0, box.y1, box.x1 - box.x0, box.y1 - box.y0);
    u.uEye.value.copy(camera.position);
  };

  const render = () => {
    if (!sized) return;
    ensure();
    apply();
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(scene, camera);
  };

  const animating = () => {
    const settings = settingsRef.current;
    return !settings.reduced && !settings.paused;
  };

  const settleStill = () => {
    if (settledStill || !cloth.count) return;
    settledStill = true;
    for (let k = 0; k < 150; k++) simulate();
    updateFrames();
  };

  const tick = (now: number) => {
    raf = 0;
    if (destroyed) return;
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    frames++;
    if (frames % 30 === 0 && (Math.abs(root.clientWidth - width) > 1 || Math.abs(root.clientHeight - height) > 1)) resize();
    if (sized) ensure();
    if (animating()) {
      lightPhase += dt * clamp(settingsRef.current.lightDrift, 0, 4);
      if (intro.active) {
        intro.time += dt;
        if (intro.time > clamp(settingsRef.current.introDuration, 0.2, 8) + 0.3) intro.active = false;
      }
      accumulator += dt;
      let steps = 0;
      while (accumulator >= STEP && steps < 4) {
        simulate();
        accumulator -= STEP;
        steps++;
      }
      if (steps === 4) accumulator = 0;
      if (steps > 0) updateFrames();
    } else settleStill();
    render();
    if (visible && !document.hidden && animating()) raf = requestAnimationFrame(tick);
  };

  function wake() {
    if (destroyed || raf || !visible) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function resize() {
    const rect = root.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      sized = false;
      return;
    }
    sized = true;
    width = rect.width;
    height = rect.height;
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2) * clamp(settingsRef.current.quality, 0.25, 1);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    camera.fov = 30;
    camera.aspect = width / height;
    camera.position.set(0, 0, height / 2 / Math.tan((camera.fov * Math.PI) / 360));
    camera.near = camera.position.z * 0.05;
    camera.far = camera.position.z * 4;
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    render();
    wake();
  }

  const toPlane = (clientX: number, clientY: number) => {
    const rect = root.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -(((clientY - rect.top) / rect.height) * 2 - 1));
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    return [hit.x, hit.y] as const;
  };

  const onMove = (event: PointerEvent) => {
    const settings = settingsRef.current;
    const point = toPlane(event.clientX, event.clientY);
    if (!point) return;
    const now = performance.now();
    if (settings.interactive && animating() && pointer.placed && now - pointer.t < 120) {
      const dt = Math.max((now - pointer.t) / 1000, 1 / 240);
      const vx = (point[0] - pointer.x) / dt;
      const vy = (point[1] - pointer.y) / dt;
      const speed = Math.hypot(vx, vy);
      const power = clamp(settings.gustStrength, 0, 3) * Math.min(1, speed / 2200) * Math.min(1, dt * 60) * 0.7;
      if (power > 0.002) push(point[0], point[1], vx, vy, power);
      wake();
    }
    pointer.x = point[0];
    pointer.y = point[1];
    pointer.t = now;
    pointer.placed = true;
  };

  const onDown = (event: PointerEvent) => {
    const settings = settingsRef.current;
    if (!settings.interactive || !settings.clickGust || !animating()) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = toPlane(event.clientX, event.clientY);
    if (!point) return;
    push(point[0], point[1], 0, 0, 0.8 * clamp(settings.gustStrength, 0, 3));
    wake();
  };

  const onLeave = () => {
    pointer.placed = false;
  };

  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerdown", onDown);
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
  if (document.fonts?.ready)
    document.fonts.ready
      .then(() => {
        if (destroyed) return;
        layoutKey = "";
        if (sized) render();
      })
      .catch(() => {});
  const onLost = (event: Event) => event.preventDefault();
  canvas.addEventListener("webglcontextlost", onLost);
  resize();

  return {
    sync: () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2) * clamp(settingsRef.current.quality, 0.25, 1);
      if (!sized || Math.abs(ratio - pixelRatio) > 1e-3) resize();
      else {
        if (!animating()) {
          intro.active = false;
          ensure();
          settleStill();
        }
        render();
      }
      wake();
    },
    destroy: () => {
      destroyed = true;
      cancelAnimationFrame(raf);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onLost);
      resizeObserver.disconnect();
      intersection.disconnect();
      maskTexture.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
    replay: () => {
      if (!animating() || !sized) return;
      ensure();
      startIntro();
      wake();
    },
    gust: (x, y, strength) => {
      if (!animating() || !sized) return;
      ensure();
      const px = box.x0 + clamp(x, 0, 1) * (box.x1 - box.x0);
      const py = box.y1 - clamp(y, 0, 1) * (box.y1 - box.y0);
      push(px, py, 0, 0, 1.6 * clamp(strength, 0, 3));
      wake();
    },
  };
};

const MeshLettering = forwardRef<MeshLetteringHandle, MeshLetteringProps>(function MeshLettering(
  {
    text = "Feels like air",
    fontFamily = "",
    fontWeight = 800,
    fontSize = 124,
    letterSpacing = -0.01,
    lineHeight = 1,
    colors = ["#7B61FF", "#FFC4F5"],
    sheen = 1,
    gloss = 0.6,
    iridescence = 0.5,
    wind = 1,
    windAngle = 0,
    turbulence = 0.5,
    flow = 1,
    softness = 0.6,
    drag = 0.5,
    hold = 0.5,
    lightAngle = -35,
    lightDrift = 1,
    interactive = true,
    gustStrength = 1,
    gustRadius = 1.2,
    clickGust = true,
    intro = true,
    introDuration = 1.8,
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
    text,
    fontFamily,
    fontWeight,
    fontSize,
    letterSpacing,
    lineHeight,
    colors,
    sheen,
    gloss,
    iridescence,
    wind,
    windAngle,
    turbulence,
    flow,
    softness,
    drag,
    hold,
    lightAngle,
    lightDrift,
    interactive,
    gustStrength,
    gustRadius,
    clickGust,
    intro,
    introDuration,
    paused,
    quality,
    reduced,
  });

  useEffect(() => {
    settingsRef.current = {
      text,
      fontFamily,
      fontWeight,
      fontSize,
      letterSpacing,
      lineHeight,
      colors,
      sheen,
      gloss,
      iridescence,
      wind,
      windAngle,
      turbulence,
      flow,
      softness,
      drag,
      hold,
      lightAngle,
      lightDrift,
      interactive,
      gustStrength,
      gustRadius,
      clickGust,
      intro,
      introDuration,
      paused,
      quality,
      reduced,
    };
    controllerRef.current?.sync();
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const controller = createSilk(root, settingsRef);
    controllerRef.current = controller;
    return () => {
      controller?.destroy();
      controllerRef.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      gust: (x = 0.5, y = 0.5, strength = 1) => controllerRef.current?.gust(x, y, strength),
      replay: () => controllerRef.current?.replay(),
    }),
    [],
  );

  return (
    <div
      ref={rootRef}
      role="img"
      aria-label={text}
      className={cn("relative isolate h-full min-h-[240px] w-full overflow-hidden", className)}
      style={{ touchAction: "pan-y", ...style }}
    >
      {children && <div className="relative z-10 h-full w-full">{children}</div>}
    </div>
  );
});

MeshLettering.displayName = "MeshLettering";

export { MeshLettering };
export default MeshLettering;
