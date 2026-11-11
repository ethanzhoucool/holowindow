/**
 * Procedurally painted default photo: a stylised, layered misty forest at dawn, plus a
 * matching synthetic depth map. No network, no external assets — photo mode works offline.
 */
import { postProcessDepth } from '../../depth/depthPost';

export interface DefaultImage {
  color: HTMLCanvasElement;
  depth: Uint8Array;
  depthWidth: number;
  depthHeight: number;
}

const W = 1920;
const H = 1080;
const SEED = 0x5eed_f0e5;

type Mode = 'color' | 'depth';

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hex(h: string): Rgb {
  const v = parseInt(h.slice(1), 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}
function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}
function css(c: Rgb, a = 1): string {
  return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${a})`;
}
function gray(nearness: number): string {
  const v = Math.round(Math.max(0, Math.min(1, nearness)) * 255);
  return `rgb(${v},${v},${v})`;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SKY_TOP = hex('#24364f');
const SKY_MID = hex('#7d7f9e');
const SKY_HORIZON = hex('#f2c09a');
const HAZE = hex('#d9b2a6');
const MID = hex('#46706b');
const NEAR = hex('#0b1a1c');
const SUN = hex('#fff1d0');

interface Layer {
  kind: 'mountain' | 'trees';
  /** 0 = far, 1 = near. */
  nearness: number;
  /** Colour blend from HAZE (0) to NEAR (1). */
  tone: number;
  /** Ground/ridge baseline as a fraction of H. */
  base: number;
  /** Feature height as a fraction of H. */
  size: number;
  count: number;
}

const LAYERS: Layer[] = [
  { kind: 'mountain', nearness: 0.06, tone: 0.12, base: 0.5, size: 0.2, count: 0 },
  { kind: 'mountain', nearness: 0.14, tone: 0.24, base: 0.58, size: 0.16, count: 0 },
  { kind: 'trees', nearness: 0.26, tone: 0.36, base: 0.64, size: 0.1, count: 70 },
  { kind: 'trees', nearness: 0.4, tone: 0.5, base: 0.7, size: 0.16, count: 46 },
  { kind: 'trees', nearness: 0.56, tone: 0.66, base: 0.78, size: 0.26, count: 26 },
  { kind: 'trees', nearness: 0.74, tone: 0.82, base: 0.88, size: 0.42, count: 12 },
  { kind: 'trees', nearness: 0.97, tone: 1.0, base: 1.04, size: 1.05, count: 5 },
];

function paint(g: CanvasRenderingContext2D, mode: Mode): void {
  const rand = mulberry32(SEED);
  const isColor = mode === 'color';

  // Sky.
  if (isColor) {
    const sky = g.createLinearGradient(0, 0, 0, H * 0.7);
    sky.addColorStop(0, css(SKY_TOP));
    sky.addColorStop(0.55, css(SKY_MID));
    sky.addColorStop(1, css(SKY_HORIZON));
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);
    const sx = W * 0.6;
    const sy = H * 0.42;
    const glow = g.createRadialGradient(sx, sy, 0, sx, sy, H * 0.75);
    glow.addColorStop(0, css(SUN, 0.95));
    glow.addColorStop(0.06, css(SUN, 0.8));
    glow.addColorStop(0.25, css(SKY_HORIZON, 0.35));
    glow.addColorStop(1, css(SKY_HORIZON, 0));
    g.fillStyle = glow;
    g.fillRect(0, 0, W, H);
  } else {
    g.fillStyle = gray(0);
    g.fillRect(0, 0, W, H);
  }

  for (let li = 0; li < LAYERS.length; li++) {
    const L = LAYERS[li];
    const col = L.tone < 0.5 ? mix(HAZE, MID, L.tone * 2) : mix(MID, NEAR, (L.tone - 0.5) * 2);
    const baseY = L.base * H;
    const ph1 = rand() * Math.PI * 2;
    const ph2 = rand() * Math.PI * 2;
    const amp = H * (0.015 + 0.02 * L.nearness);
    const ground = (x: number) =>
      baseY + Math.sin(x / W * Math.PI * 2.2 + ph1) * amp + Math.sin(x / W * Math.PI * 5.3 + ph2) * amp * 0.4;

    if (L.kind === 'mountain') {
      // Midpoint-displacement ridge.
      const n = 129;
      const pts = new Float32Array(n);
      pts[0] = rand();
      pts[n - 1] = rand();
      for (let step = n - 1, rough = 1; step > 1; step >>= 1, rough *= 0.55) {
        for (let i = step >> 1; i < n; i += step) {
          pts[i] = (pts[i - (step >> 1)] + pts[i + (step >> 1)]) / 2 + (rand() - 0.5) * rough;
        }
      }
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of pts) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      g.beginPath();
      g.moveTo(0, H);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * W;
        const k = (pts[i] - lo) / Math.max(hi - lo, 1e-6);
        g.lineTo(x, ground(x) - (0.2 + k * 0.8) * L.size * H);
      }
      g.lineTo(W, H);
      g.closePath();
      g.fillStyle = isColor ? css(col) : gray(L.nearness);
      g.fill();
    } else {
      // Rolling ground for this row.
      g.beginPath();
      g.moveTo(0, H);
      for (let x = 0; x <= W; x += 16) g.lineTo(x, ground(x));
      g.lineTo(W, H);
      g.closePath();
      g.fillStyle = isColor ? css(col) : gray(L.nearness);
      g.fill();

      const near = li === LAYERS.length - 1;
      for (let t = 0; t < L.count; t++) {
        let x: number;
        if (near) {
          // Frame the view: big trees hugging the left and right edges.
          const side = t % 2 === 0 ? 0 : 1;
          x = side === 0 ? W * (-0.02 + rand() * 0.16) : W * (0.86 + rand() * 0.16);
        } else {
          x = (t + rand()) * (W / L.count);
        }
        const h = L.size * H * (0.6 + rand() * 0.6);
        const jitter = (rand() - 0.5) * 0.03;
        const shade = rand() * 0.08;
        g.fillStyle = isColor ? css(mix(col, NEAR, shade)) : gray(L.nearness + jitter);
        pine(g, x, ground(x) + h * 0.03, h, rand);
      }
    }

    // Mist pooled at the foot of this layer (colour only; next layer covers its base).
    if (isColor && li < LAYERS.length - 1) {
      const top = baseY - L.size * H * 0.6;
      const mist = g.createLinearGradient(0, top, 0, baseY + amp * 2);
      mist.addColorStop(0, css(HAZE, 0));
      mist.addColorStop(1, css(mix(HAZE, SKY_HORIZON, 0.4), 0.45 - li * 0.04));
      g.fillStyle = mist;
      g.fillRect(0, top, W, H - top);
    }
  }

  if (isColor) {
    // Soft vignette.
    const v = g.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, H * 1.1);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.35)');
    g.fillStyle = v;
    g.fillRect(0, 0, W, H);
  }
}

/** A jagged, tiered pine silhouette with its base at (x, baseY). */
function pine(g: CanvasRenderingContext2D, x: number, baseY: number, h: number, rand: () => number): void {
  const tiers = 7 + Math.floor(rand() * 4);
  const halfW = h * (0.16 + rand() * 0.05);
  const top = baseY - h;
  const trunkH = h * 0.08;
  const crownH = h - trunkH;
  const right: [number, number][] = [];
  const left: [number, number][] = [];
  for (let i = 1; i <= tiers; i++) {
    const f = i / tiers;
    const y = top + crownH * f;
    const w = halfW * Math.pow(f, 0.9) * (0.85 + rand() * 0.3);
    const notchY = y - crownH / tiers * 0.35;
    right.push([x + w * 0.45, notchY], [x + w, y]);
    const wl = halfW * Math.pow(f, 0.9) * (0.85 + rand() * 0.3);
    left.push([x - wl * 0.45, notchY], [x - wl, y]);
  }
  const trunkW = Math.max(1.5, halfW * 0.12);
  g.beginPath();
  g.moveTo(x, top);
  for (const [px, py] of right) g.lineTo(px, py);
  g.lineTo(x + trunkW, top + crownH);
  g.lineTo(x + trunkW, baseY);
  g.lineTo(x - trunkW, baseY);
  g.lineTo(x - trunkW, top + crownH);
  for (let i = left.length - 1; i >= 0; i--) g.lineTo(left[i][0], left[i][1]);
  g.closePath();
  g.fill();
}

export function createDefaultImage(): DefaultImage {
  const color = document.createElement('canvas');
  color.width = W;
  color.height = H;
  const cg = color.getContext('2d');
  if (!cg) throw new Error('2D canvas unavailable');
  paint(cg, 'color');

  const dw = 640;
  const dh = Math.round((dw * H) / W);
  const dc = document.createElement('canvas');
  dc.width = dw;
  dc.height = dh;
  const dg = dc.getContext('2d', { willReadFrequently: true });
  if (!dg) throw new Error('2D canvas unavailable');
  dg.scale(dw / W, dh / H);
  paint(dg, 'depth');
  const px = dg.getImageData(0, 0, dw, dh).data;
  const f = new Float32Array(dw * dh);
  for (let i = 0; i < f.length; i++) f[i] = px[i * 4] / 255;

  return { color, depth: postProcessDepth(f, dw, dh, { normalize: false }), depthWidth: dw, depthHeight: dh };
}
