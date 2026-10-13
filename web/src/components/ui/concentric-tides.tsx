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

export type ConcentricTidesMode = "auto" | "glow" | "ink";

export interface ConcentricTidesHandle {
  surge: (strength?: number) => void;
}

export interface ConcentricTidesProps {
  colors?: [string, string];
  backgroundColor?: string;
  mode?: ConcentricTidesMode;
  lineCount?: number;
  thickness?: number;
  spread?: number;
  ghost?: number;
  glow?: number;
  intensity?: number;
  speed?: number;
  breathe?: number;
  angle?: number;
  centerY?: number;
  hueShift?: number;
  colorCycle?: number;
  surge?: number;
  clickSurge?: boolean;
  hoverBoost?: number;
  interactive?: boolean;
  paused?: boolean;
  quality?: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

interface Settings {
  colors: [string, string];
  backgroundColor: string;
  mode: ConcentricTidesMode;
  lineCount: number;
  thickness: number;
  spread: number;
  ghost: number;
  glow: number;
  intensity: number;
  speed: number;
  breathe: number;
  angle: number;
  centerY: number;
  hueShift: number;
  colorCycle: number;
  surge: number;
  clickSurge: boolean;
  hoverBoost: number;
  interactive: boolean;
  paused: boolean;
  quality: number;
  reduced: boolean;
}

interface Controller {
  sync: () => void;
  destroy: () => void;
  surge: (strength: number) => void;
}

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

const rotateHue = (rgb: [number, number, number], angle: number): [number, number, number] => {
  const [r, g, b] = rgb.map(toLinear);
  if (!angle) return [r, g, b];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const chroma = Math.hypot(a, bb);
  const hue = Math.atan2(bb, a) + angle;
  const na = chroma * Math.cos(hue);
  const nb = chroma * Math.sin(hue);
  const l2 = Math.pow(lightness + 0.3963377774 * na + 0.2158037573 * nb, 3);
  const m2 = Math.pow(lightness - 0.1055613458 * na - 0.0638541728 * nb, 3);
  const s2 = Math.pow(lightness - 0.0894841775 * na - 1.291485548 * nb, 3);
  return [
    Math.max(0, 4.0767416621 * l2 - 3.3077115913 * m2 + 0.2309699292 * s2),
    Math.max(0, -1.2684380046 * l2 + 2.6097574011 * m2 - 0.3413193965 * s2),
    Math.max(0, -0.0041960863 * l2 - 0.7034186147 * m2 + 1.707614701 * s2),
  ];
};

const passVertex = `
out vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const lineFragment = `
precision highp float;
uniform vec2 uResolution;
uniform vec2 uCenter;
uniform vec2 uAxis;
uniform float uEdge;
uniform float uPixelRatio;
uniform float uLineCount;
uniform float uThickness;
uniform float uSpread;
uniform float uGhost;
uniform float uSweep;
uniform float uBreath;
uniform float uTime;
uniform float uEnergy;
uniform vec3 uLine;
uniform vec3 uCore;
uniform float uFlare;
in vec2 vUv;
out vec4 fragColor;

void main() {
  float unit = 0.5 * uResolution.y;
  vec2 offset = (gl_FragCoord.xy - uCenter) / unit;
  vec2 p = vec2(dot(offset, uAxis), dot(offset, vec2(-uAxis.y, uAxis.x)));
  float spread = uSpread * uBreath;
  float kmax = 2.0 * spread / (uEdge * uEdge + spread * spread);
  float r2 = dot(p, p) + 1e-7;
  float k = 2.0 * p.y / r2 / kmax;
  float phase = k * uLineCount * 0.5 - uSweep;
  float fw = max(fwidth(phase), 1e-5);
  float d = abs(fract(phase + 0.5) - 0.5);
  float widthPx = uThickness * uPixelRatio;
  float line = 1.0 - smoothstep(0.5 * widthPx - 0.5, 0.5 * widthPx + 0.6, d / fw);
  line = mix(line, min(widthPx * fw, 8.0), smoothstep(0.2, 0.5, fw));
  float ak = abs(k);
  float kappaEdge = kmax * 0.92;
  float cx = min(abs(p.x) * kappaEdge, 1.0);
  float edgePx = (1.0 - sqrt(1.0 - cx * cx)) / kappaEdge * unit;
  float yPx = abs(p.y) * unit;
  float cover = clamp(max(edgePx, 0.5 * widthPx) + 0.5 - yPx, 0.0, 1.0);
  float window = cover * (1.0 - smoothstep(0.82, 1.12, yPx / max(edgePx, 4.0)));
  float reach = abs(p.x) / uEdge;
  float ghost = (1.0 - smoothstep(1.0, 2.6, ak)) * smoothstep(0.75, 1.1, ak) * 0.045 * uGhost * smoothstep(0.15, 0.5, reach);
  float heat = exp(-reach * 3.2);
  vec3 tint = mix(uLine, uCore, clamp(heat * (1.3 + uFlare * 0.6), 0.0, 1.0));
  float gain = 1.4 * (1.0 + uEnergy * 0.35 * heat) * (1.0 + uFlare * 0.45);
  float body = line * (window + ghost);
  fragColor = vec4(tint * body * gain, body * gain);
}
`;

const brightFragment = `
precision highp float;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uThreshold;
in vec2 vUv;
out vec4 fragColor;

void main() {
  vec4 c = texture(uSource, vUv + uTexel * vec2(-0.5, -0.5));
  c += texture(uSource, vUv + uTexel * vec2(0.5, -0.5));
  c += texture(uSource, vUv + uTexel * vec2(-0.5, 0.5));
  c += texture(uSource, vUv + uTexel * vec2(0.5, 0.5));
  c *= 0.25;
  float knee = 0.45;
  float soft = clamp(c.a - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  c *= max(soft, c.a - uThreshold) / max(c.a, 1e-4);
  fragColor = c;
}
`;

const blurFragment = `
precision highp float;
uniform sampler2D uSource;
uniform vec2 uStep;
in vec2 vUv;
out vec4 fragColor;

void main() {
  vec4 sum = texture(uSource, vUv) * 0.1964825502;
  sum += (texture(uSource, vUv + uStep * 1.4117647059) + texture(uSource, vUv - uStep * 1.4117647059)) * 0.2969069647;
  sum += (texture(uSource, vUv + uStep * 3.2941176471) + texture(uSource, vUv - uStep * 3.2941176471)) * 0.0944703979;
  sum += (texture(uSource, vUv + uStep * 5.1764705882) + texture(uSource, vUv - uStep * 5.1764705882)) * 0.0103813624;
  fragColor = sum;
}
`;

const compositeFragment = `
precision highp float;
uniform sampler2D uLines;
uniform sampler2D uGlow;
uniform sampler2D uWide;
uniform vec3 uBackground;
uniform vec3 uInk;
uniform float uGlowAmount;
uniform float uExposure;
uniform float uMode;
in vec2 vUv;
out vec4 fragColor;

vec3 encode(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

void main() {
  vec4 lineSample = texture(uLines, vUv);
  vec4 bloomSample = texture(uGlow, vUv) * 0.8 + texture(uWide, vUv) * 0.18;
  vec3 lines = lineSample.rgb;
  vec3 bloom = bloomSample.rgb;
  vec3 light = lines + bloom * uGlowAmount;
  float grain = (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5) / 255.0;
  vec3 color;
  if (uMode < 0.5) {
    vec3 exposed = 1.0 - exp(-light * uExposure);
    color = uBackground + (1.0 - uBackground) * exposed;
  } else {
    float energy = lineSample.a + bloomSample.a * uGlowAmount * 0.4;
    vec3 hue = (lines + bloom * uGlowAmount * 0.4) / max(energy, 1e-4);
    float cover = clamp(1.0 - exp(-energy * uExposure * 1.6), 0.0, 0.94);
    color = mix(uBackground, hue * uInk, cover);
  }
  fragColor = vec4(encode(color) + grain, 1.0);
}
`;

const createTides = (root: HTMLDivElement, settingsRef: { current: Settings }): Controller | null => {
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

  const material = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
    new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms,
      vertexShader: passVertex,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });

  const lineMaterial = material(lineFragment, {
    uResolution: { value: new THREE.Vector2(1, 1) },
    uCenter: { value: new THREE.Vector2(0, 0) },
    uAxis: { value: new THREE.Vector2(1, 0) },
    uEdge: { value: 1.6 },
    uPixelRatio: { value: 1 },
    uLineCount: { value: 22 },
    uThickness: { value: 1 },
    uSpread: { value: 0.36 },
    uGhost: { value: 1 },
    uSweep: { value: 0 },
    uBreath: { value: 1 },
    uTime: { value: 0 },
    uEnergy: { value: 0 },
    uLine: { value: new THREE.Vector3(1, 1, 1) },
    uCore: { value: new THREE.Vector3(1, 1, 1) },
    uFlare: { value: 0 },
  });
  const brightMaterial = material(brightFragment, {
    uSource: { value: null },
    uTexel: { value: new THREE.Vector2(1, 1) },
    uThreshold: { value: 0.6 },
  });
  const blurMaterial = material(blurFragment, {
    uSource: { value: null },
    uStep: { value: new THREE.Vector2() },
  });
  const compositeMaterial = material(compositeFragment, {
    uLines: { value: null },
    uGlow: { value: null },
    uWide: { value: null },
    uBackground: { value: new THREE.Vector3(0, 0, 0) },
    uInk: { value: new THREE.Vector3(1, 1, 1) },
    uGlowAmount: { value: 1 },
    uExposure: { value: 1.2 },
    uMode: { value: 0 },
  });

  const mesh = new THREE.Mesh(plane, lineMaterial);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);

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
  let glowTarget: THREE.WebGLRenderTarget | null = null;
  let glowSpare: THREE.WebGLRenderTarget | null = null;
  let wideTarget: THREE.WebGLRenderTarget | null = null;
  let wideSpare: THREE.WebGLRenderTarget | null = null;

  let destroyed = false;
  let raf = 0;
  let last = 0;
  let visible = true;
  let clock = 0;
  let sweep = 0;
  let energy = 0;
  let inside = false;
  let swell = 0;
  let swellVelocity = 0;
  let width = 1;
  let height = 1;
  let pixelRatio = 1;

  const release = () => {
    [lineTarget, glowTarget, glowSpare, wideTarget, wideSpare].forEach((item) => item?.dispose());
    lineTarget = glowTarget = glowSpare = wideTarget = wideSpare = null;
  };

  const pass = (shader: THREE.ShaderMaterial, output: THREE.WebGLRenderTarget | null) => {
    mesh.material = shader;
    renderer.setRenderTarget(output);
    renderer.render(scene, camera);
  };

  const blur = (from: THREE.WebGLRenderTarget, spare: THREE.WebGLRenderTarget, scale: number) => {
    const uniforms = blurMaterial.uniforms;
    uniforms.uSource.value = from.texture;
    uniforms.uStep.value.set(scale / from.width, 0);
    pass(blurMaterial, spare);
    uniforms.uSource.value = spare.texture;
    uniforms.uStep.value.set(0, scale / from.height);
    pass(blurMaterial, from);
  };

  const kick = (strength: number) => {
    swellVelocity += 9 * clamp(strength, 0, 3);
  };

  const apply = () => {
    const settings = settingsRef.current;
    const uniforms = lineMaterial.uniforms;
    const moving = !settings.paused && !settings.reduced;
    const phase = clock * settings.colorCycle * 0.45;
    const swing = moving && settings.colorCycle > 0 ? 0.35 + 0.95 * Math.sin(phase) - 0.35 * Math.cos(phase) : 0;
    const hue = (settings.hueShift * Math.PI) / 180 + swing;
    const lineColor = rotateHue(parseColor(settings.colors[0], [0.69, 0.62, 0.94]), hue);
    const coreColor = rotateHue(parseColor(settings.colors[1], [1, 0.62, 0.99]), hue);
    const background = parseColor(settings.backgroundColor, [0.04, 0.04, 0.04]);
    const luminance = 0.2126 * background[0] + 0.7152 * background[1] + 0.0722 * background[2];
    const ink = settings.mode === "ink" || (settings.mode === "auto" && luminance > 0.5);
    uniforms.uLine.value.set(...lineColor);
    uniforms.uCore.value.set(...coreColor);
    const w = width * pixelRatio;
    const h = height * pixelRatio;
    const angle = (settings.angle * Math.PI) / 180;
    const ax = Math.cos(angle);
    const ay = Math.sin(angle);
    const cy = h * (1 - clamp(settings.centerY, 0, 1));
    const reachX = Math.abs(ax) > 1e-4 ? w / 2 / Math.abs(ax) : Infinity;
    const reachY = Math.abs(ay) > 1e-4 ? Math.max(cy, h - cy) / Math.abs(ay) : Infinity;
    uniforms.uResolution.value.set(w, h);
    uniforms.uCenter.value.set(w / 2, cy);
    uniforms.uAxis.value.set(ax, ay);
    uniforms.uEdge.value = Math.max(1.35, Math.min(reachX, reachY) / (0.5 * h));
    uniforms.uPixelRatio.value = pixelRatio;
    uniforms.uLineCount.value = clamp(Math.round(settings.lineCount), 2, 160);
    uniforms.uThickness.value = clamp(settings.thickness, 0.25, 6);
    uniforms.uSpread.value = clamp(settings.spread, 0.02, 3);
    uniforms.uGhost.value = clamp(settings.ghost, 0, 3);
    uniforms.uSweep.value = sweep;
    const breath = moving ? 1 + clamp(settings.breathe, 0, 2) * 0.12 * Math.sin(clock * 0.23) : 1;
    uniforms.uBreath.value = breath * (1 + 0.22 * swell);
    uniforms.uTime.value = clock;
    uniforms.uEnergy.value = energy;
    uniforms.uFlare.value = clamp(swell, 0, 2);
    const composite = compositeMaterial.uniforms;
    composite.uBackground.value.set(...background.map(toLinear));
    composite.uInk.value.set(0.62, 0.62, 0.62);
    composite.uGlowAmount.value = clamp(settings.glow, 0, 3) * (1 + energy * 0.25);
    composite.uExposure.value = 1.2 * clamp(settings.intensity, 0, 4);
    composite.uMode.value = ink ? 1 : 0;
  };

  const render = () => {
    if (!lineTarget || !glowTarget || !glowSpare || !wideTarget || !wideSpare) return;
    apply();
    pass(lineMaterial, lineTarget);
    const bright = brightMaterial.uniforms;
    bright.uSource.value = lineTarget.texture;
    bright.uTexel.value.set(1 / lineTarget.width, 1 / lineTarget.height);
    bright.uThreshold.value = 0.6;
    pass(brightMaterial, glowTarget);
    blur(glowTarget, glowSpare, 1);
    if (pixelRatio > 1.4) blur(glowTarget, glowSpare, 1);
    bright.uSource.value = glowTarget.texture;
    bright.uTexel.value.set(4 / lineTarget.width, 4 / lineTarget.height);
    bright.uThreshold.value = 0;
    pass(brightMaterial, wideTarget);
    blur(wideTarget, wideSpare, 1);
    blur(wideTarget, wideSpare, 1);
    const composite = compositeMaterial.uniforms;
    composite.uLines.value = lineTarget.texture;
    composite.uGlow.value = glowTarget.texture;
    composite.uWide.value = wideTarget.texture;
    pass(compositeMaterial, null);
  };

  const step = (dt: number) => {
    const settings = settingsRef.current;
    const moving = !settings.paused && !settings.reduced;
    const goal = inside && settings.interactive && !settings.reduced ? clamp(settings.hoverBoost, 0, 2) : 0;
    energy += (goal - energy) * (1 - Math.exp(-dt / (goal > energy ? 0.35 : 0.9)));
    const count = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / count;
    for (let i = 0; i < count; i++) {
      swellVelocity += (-36 * swell - 6 * swellVelocity) * h;
      swell += swellVelocity * h;
    }
    if (!moving) return;
    clock += dt;
    sweep += dt * clamp(settings.speed, -5, 5) * (1 + energy * 1.4 + Math.max(swell, 0) * 2.5);
  };

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
    const settling = Math.abs(energy - goal) > 0.002 || Math.abs(swell) > 0.001 || Math.abs(swellVelocity) > 0.001;
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
    glowTarget = target(w >> 1, h >> 1);
    glowSpare = target(w >> 1, h >> 1);
    wideTarget = target(w >> 3, h >> 3);
    wideSpare = target(w >> 3, h >> 3);
    render();
    wake();
  };

  const onEnter = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    inside = true;
    wake();
  };

  const onLeave = () => {
    inside = false;
    wake();
  };

  const onDown = (event: PointerEvent) => {
    const settings = settingsRef.current;
    if (event.button !== 0 || !settings.interactive || !settings.clickSurge || settings.reduced) return;
    kick(settings.surge);
    wake();
  };

  root.addEventListener("pointerenter", onEnter);
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
      root.removeEventListener("pointerenter", onEnter);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("pointercancel", onLeave);
      root.removeEventListener("pointerdown", onDown);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onLost);
      resizeObserver.disconnect();
      intersection.disconnect();
      release();
      plane.dispose();
      [lineMaterial, brightMaterial, blurMaterial, compositeMaterial].forEach((item) => item.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
    surge: (strength: number) => {
      if (settingsRef.current.reduced) return;
      kick(strength);
      wake();
    },
  };
};

const ConcentricTides = forwardRef<ConcentricTidesHandle, ConcentricTidesProps>(function ConcentricTides(
  {
    colors = ["#B19EEF", "#FF9FFC"],
    backgroundColor = "#0A0A0A",
    mode = "auto",
    lineCount = 18,
    thickness = 1,
    spread = 0.36,
    ghost = 0.6,
    glow = 1,
    intensity = 1,
    speed = 1,
    breathe = 0.4,
    angle = 0,
    centerY = 0.5,
    hueShift = 0,
    colorCycle = 0,
    surge = 1,
    clickSurge = true,
    hoverBoost = 0.5,
    interactive = true,
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
    lineCount,
    thickness,
    spread,
    ghost,
    glow,
    intensity,
    speed,
    breathe,
    angle,
    centerY,
    hueShift,
    colorCycle,
    surge,
    clickSurge,
    hoverBoost,
    interactive,
    paused,
    quality,
    reduced,
  });

  useEffect(() => {
    settingsRef.current = {
      colors,
      backgroundColor,
      mode,
      lineCount,
      thickness,
      spread,
      ghost,
      glow,
      intensity,
      speed,
      breathe,
      angle,
      centerY,
      hueShift,
      colorCycle,
      surge,
      clickSurge,
      hoverBoost,
      interactive,
      paused,
      quality,
      reduced,
    };
    controllerRef.current?.sync();
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const controller = createTides(root, settingsRef);
    controllerRef.current = controller;
    return () => {
      controller?.destroy();
      controllerRef.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      surge: (strength = 1) => controllerRef.current?.surge(strength),
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

ConcentricTides.displayName = "ConcentricTides";

export { ConcentricTides };
export default ConcentricTides;
