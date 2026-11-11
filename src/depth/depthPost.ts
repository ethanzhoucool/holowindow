/**
 * Depth-map post-processing shared by the worker (model output) and the main thread
 * (procedural default image).
 *
 * Input: a per-pixel "nearness" / disparity map (bigger = closer to the viewer).
 * Output: Uint8 nearness map in 0..255 that has been
 *   1. robustly normalised (1st..99.5th percentile -> 0..1), optionally,
 *   2. dilated toward the near side so foreground silhouettes keep their own colour and
 *      the stretched "rubber sheet" at depth discontinuities lands in the background, and
 *   3. softly blurred to hide terracing / noise.
 */
export interface DepthPostOptions {
  normalize: boolean;
}

export function postProcessDepth(
  src: Float32Array,
  width: number,
  height: number,
  opts: DepthPostOptions,
): Uint8Array {
  const n = width * height;
  let d = opts.normalize ? robustNormalize(src) : Float32Array.from(src);

  // Small radii: just enough to pull the discontinuity off the silhouette and smooth noise.
  // Bigger radii leave visible background-coloured "halos" glued to foreground objects.
  const r = Math.max(1, Math.round(Math.max(width, height) / 640));
  d = maxFilter(d, width, height, r);
  d = boxBlur(d, width, height, r);
  d = boxBlur(d, width, height, r);

  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = d[i];
    out[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  }
  return out;
}

function robustNormalize(src: Float32Array): Float32Array {
  const n = src.length;
  const step = Math.max(1, Math.floor(n / 60000));
  const sample: number[] = [];
  for (let i = 0; i < n; i += step) {
    const v = src[i];
    if (Number.isFinite(v)) sample.push(v);
  }
  sample.sort((a, b) => a - b);
  const out = new Float32Array(n);
  if (sample.length === 0) return out;
  const lo = sample[Math.floor(sample.length * 0.01)];
  const hi = sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.995))];
  const span = hi - lo;
  if (!(span > 1e-6)) {
    out.fill(0.5);
    return out;
  }
  const inv = 1 / span;
  for (let i = 0; i < n; i++) {
    const v = (src[i] - lo) * inv;
    out[i] = Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
  }
  return out;
}

/** Separable square max filter (dilates high = near values). */
function maxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      for (let k = x0; k <= x1; k++) if (src[row + k] > m) m = src[row + k];
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = -Infinity;
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h - 1, y + r);
      for (let k = y0; k <= y1; k++) if (tmp[k * w + x] > m) m = tmp[k * w + x];
      out[y * w + x] = m;
    }
  }
  return out;
}

/** Separable box blur with clamped edges (running sums). */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const size = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / size;
      sum += src[row + clamp(x + r + 1, 0, w - 1)] - src[row + clamp(x - r, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / size;
      sum += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
    }
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
