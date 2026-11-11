import { describe, expect, it } from 'vitest';
import { OneEuroFilter, smoothingToParams, type OneEuroParams } from './oneEuroFilter';

const DT = 1 / 30;

/** Deterministic PRNG (mulberry32) so jitter tests are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function variance(xs: number[]): number {
  const m = xs.reduce((s, v) => s + v, 0) / xs.length;
  return xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length;
}

function run(params: OneEuroParams, signal: (i: number) => number, n: number): number[] {
  const f = new OneEuroFilter({ ...params });
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(f.filter(signal(i), i * DT));
  return out;
}

describe('OneEuroFilter', () => {
  it('returns the first sample unchanged', () => {
    const f = new OneEuroFilter(smoothingToParams(0.5));
    expect(f.filter(42, 0)).toBe(42);
  });

  it('converges to a constant input after a step', () => {
    const f = new OneEuroFilter(smoothingToParams(0.5));
    f.filter(0, 0);
    let y = 0;
    for (let i = 1; i <= 300; i++) y = f.filter(10, i * DT);
    expect(y).toBeCloseTo(10, 3);
  });

  it('holds a constant input exactly', () => {
    const out = run(smoothingToParams(0.8), () => 3.5, 50);
    for (const y of out) expect(y).toBe(3.5);
  });

  it('reduces jitter variance on a noisy constant signal', () => {
    const r = rng(1234);
    const noise = Array.from({ length: 600 }, () => (r() - 0.5) * 2);
    const out = run(smoothingToParams(0.5), (i) => 60 + noise[i], noise.length);
    const settled = out.slice(100);
    const rawVar = variance(noise.slice(100));
    expect(variance(settled)).toBeLessThan(rawVar * 0.2);
  });

  it('higher smoothing => more lag on a ramp', () => {
    const speed = 30; // cm/s
    const ramp = (i: number) => speed * i * DT;
    const n = 90;
    const lagAt = (s: number) => {
      const out = run(smoothingToParams(s), ramp, n);
      return ramp(n - 1) - out[n - 1];
    };
    const lags = [0, 0.25, 0.5, 0.75, 1].map(lagAt);
    for (let i = 1; i < lags.length; i++) expect(lags[i]).toBeGreaterThan(lags[i - 1]);
    expect(lags[0]).toBeGreaterThanOrEqual(0);
  });

  it('higher smoothing => less residual jitter', () => {
    const r = rng(99);
    const noise = Array.from({ length: 600 }, () => (r() - 0.5) * 2);
    const jitter = (s: number) => variance(run(smoothingToParams(s), (i) => noise[i], noise.length).slice(100));
    expect(jitter(1)).toBeLessThan(jitter(0.5));
    expect(jitter(0.5)).toBeLessThan(jitter(0));
  });

  it('reset() makes the next sample pass through unchanged', () => {
    const f = new OneEuroFilter(smoothingToParams(0.5));
    f.filter(0, 0);
    f.filter(0, DT);
    f.reset();
    expect(f.filter(25, 2 * DT)).toBe(25);
  });

  it('stays finite with duplicate or out-of-order timestamps', () => {
    const f = new OneEuroFilter(smoothingToParams(0.5));
    f.filter(0, 1);
    for (const [v, t] of [
      [1, 1],
      [2, 0.5],
      [3, 1],
      [4, 100],
    ]) {
      const y = f.filter(v, t);
      expect(Number.isFinite(y)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(4);
    }
  });
});

describe('smoothingToParams', () => {
  const steps = Array.from({ length: 11 }, (_, i) => i / 10);

  it('minCutoff and beta decrease strictly as smoothing increases', () => {
    const ps = steps.map(smoothingToParams);
    for (let i = 1; i < ps.length; i++) {
      expect(ps[i].minCutoff).toBeLessThan(ps[i - 1].minCutoff);
      expect(ps[i].beta).toBeLessThan(ps[i - 1].beta);
      expect(ps[i].dCutoff).toBe(ps[0].dCutoff);
    }
  });

  it('matches the documented endpoints', () => {
    expect(smoothingToParams(0)).toEqual({ minCutoff: 2.5, beta: 1, dCutoff: 1 });
    const mid = smoothingToParams(0.5);
    expect(mid.minCutoff).toBeCloseTo(0.5, 9);
    expect(mid.beta).toBeCloseTo(0.1, 9);
    const hi = smoothingToParams(1);
    expect(hi.minCutoff).toBeCloseTo(0.1, 9);
    expect(hi.beta).toBeCloseTo(0.01, 9);
  });

  it('clamps out-of-range input', () => {
    expect(smoothingToParams(-1)).toEqual(smoothingToParams(0));
    expect(smoothingToParams(2)).toEqual(smoothingToParams(1));
  });

  it('never yields non-finite params (e.g. NaN from a corrupted setting)', () => {
    expect(smoothingToParams(NaN)).toEqual(smoothingToParams(0.5));
    for (const s of [NaN, Infinity, -Infinity]) {
      const p = smoothingToParams(s);
      expect(Number.isFinite(p.minCutoff) && Number.isFinite(p.beta) && Number.isFinite(p.dCutoff)).toBe(true);
    }
  });
});
