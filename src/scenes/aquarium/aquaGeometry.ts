import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 2D value-noise-ish function built from a few incommensurate sines (cheap, deterministic). */
export function dunes(x: number, z: number): number {
  return (
    Math.sin(x * 0.21 + z * 0.07) * 0.5 +
    Math.sin(x * 0.05 - z * 0.17 + 1.3) * 0.6 +
    Math.sin(x * 0.53 + z * 0.41 + 2.1) * 0.12 +
    Math.sin(-x * 0.37 + z * 0.61 + 0.4) * 0.1
  );
}

/**
 * Low-poly fish, ~110 triangles, facing +x, length 1 (nose +0.5, tail tips -0.55).
 * Vertex colours: darker back, pale belly, black eyes. Flat shaded (non-indexed).
 */
export function createFishGeometry(): THREE.BufferGeometry {
  const xs = [0.5, 0.43, 0.3, 0.12, -0.08, -0.24, -0.36];
  const hy = [0, 0.085, 0.145, 0.17, 0.14, 0.075, 0.03];
  const hz = [0, 0.045, 0.07, 0.075, 0.06, 0.035, 0.014];
  const SEG = 8;
  const pos: number[] = [];
  const col: number[] = [];
  const ring = (i: number, k: number): [number, number, number] => {
    const a = (k / SEG) * Math.PI * 2;
    // Slightly flattened belly.
    const sy = Math.sin(a);
    return [xs[i], sy * hy[i] * (sy < 0 ? 0.85 : 1) + 0.01, Math.cos(a) * hz[i]];
  };
  const shade = (y: number) => {
    const t = THREE.MathUtils.clamp(0.5 - y * 4, 0, 1); // 0 top .. 1 belly
    return 0.55 + 0.45 * t;
  };
  const tri = (a: number[], b: number[], c: number[], cOverride?: number) => {
    for (const v of [a, b, c]) {
      pos.push(v[0], v[1], v[2]);
      const s = cOverride ?? shade(v[1]);
      col.push(s, s, s);
    }
  };
  for (let i = 0; i < xs.length - 1; i++) {
    for (let k = 0; k < SEG; k++) {
      const a = ring(i, k);
      const b = ring(i, k + 1);
      const c = ring(i + 1, k);
      const d = ring(i + 1, k + 1);
      if (i > 0) tri(a, c, b);
      tri(b, c, d);
    }
  }
  // Close the tail end of the body.
  const last = xs.length - 1;
  for (let k = 0; k < SEG; k++) tri(ring(last, k), [xs[last] - 0.02, 0.01, 0], ring(last, k + 1));

  // Tail fin (forked), dorsal, ventral and pectoral fins. Fins are thin: rendered double-sided.
  const fin = 0.92;
  tri([-0.33, 0.02, 0], [-0.56, 0.2, 0], [-0.47, 0.01, 0], fin);
  tri([-0.33, 0.0, 0], [-0.47, 0.01, 0], [-0.56, -0.17, 0], fin);
  tri([0.16, 0.16, 0], [-0.14, 0.14, 0], [-0.04, 0.29, 0], 0.7);
  tri([0.0, -0.11, 0], [-0.16, -0.09, 0], [-0.1, -0.2, 0], fin);
  for (const s of [-1, 1]) {
    tri([0.24, -0.04, s * 0.06], [0.12, -0.06, s * 0.065], [0.08, -0.1, s * 0.16], fin);
  }
  // Eyes: small black pyramids on each side.
  const ex = 0.36;
  const ey = 0.045;
  for (const s of [-1, 1]) {
    const z0 = s * 0.052;
    const z1 = s * 0.068;
    const r = 0.024;
    const p = [
      [ex + r, ey, z0],
      [ex, ey + r, z0],
      [ex - r, ey, z0],
      [ex, ey - r, z0],
    ];
    const tip = [ex, ey, z1];
    for (let k = 0; k < 4; k++) {
      if (s > 0) tri(p[k], p[(k + 1) % 4], tip, 0);
      else tri(p[(k + 1) % 4], p[k], tip, 0);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/** One kelp ribbon, height 1, base at the origin, with a gentle twist and curl. */
export function createKelpGeometry(segments = 14): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const col: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const width = 0.045 * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.08)) + 0.006;
    const twist = t * 2.2;
    const curl = Math.sin(t * 3.0) * 0.05;
    const cx = curl;
    for (const s of [-1, 1]) {
      pos.push(cx + Math.cos(twist) * width * s, t, Math.sin(twist) * width * s);
      const c = 0.55 + 0.45 * t;
      col.push(c, c, c);
    }
    if (i < segments) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Faceted rock, roughly unit radius, flattened so it sits on the sand. */
export function createRockGeometry(seed = 4): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 1);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const rnd = makeRng(seed);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const k = 0.78 + rnd() * 0.38;
    pos.setXYZ(i, pos.getX(i) * k * 1.15, pos.getY(i) * k * 0.72, pos.getZ(i) * k);
  }
  const flat = g.toNonIndexed();
  g.dispose();
  flat.computeVertexNormals();
  return flat;
}
