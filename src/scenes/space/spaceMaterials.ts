import * as THREE from 'three';

/** Cheap 3D value noise shared by the planet and ring shaders. */
const NOISE_GLSL = /* glsl */ `
float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
`;

/** Radial ring opacity: fine ringlets from hashed noise, a dense B ring and the Cassini gap. Needs uRingInner/uRingOuter. */
const RING_GLSL = /* glsl */ `
float ringHash(float x) { return fract(sin(x * 127.1) * 43758.5453); }
float ringNoise(float x) { float i = floor(x); float f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(ringHash(i), ringHash(i + 1.0), f); }
float ringDensity(float r) {
  float d = smoothstep(uRingInner, uRingInner + 0.1, r) * (1.0 - smoothstep(uRingOuter - 0.06, uRingOuter, r));
  float fine = ringNoise(r * 60.0) * 0.5 + ringNoise(r * 160.0) * 0.3 + ringNoise(r * 9.0) * 0.4;
  float bRing = smoothstep(1.55, 1.62, r) * (1.0 - smoothstep(1.86, 1.9, r));
  d *= 0.25 + 0.45 * fine + 0.4 * bRing;
  d *= 1.0 - 0.9 * (1.0 - smoothstep(0.02, 0.05, abs(r - 1.93))); // Cassini gap
  d *= 1.0 - 0.6 * (1.0 - smoothstep(0.0, 0.015, abs(r - 2.22))); // Encke gap
  return clamp(d, 0.0, 1.0);
}
`;

export interface StarUniforms {
  [k: string]: THREE.IUniform;
  uSpan: THREE.IUniform<THREE.Vector2>;
  uRefZ: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  uDrift: THREE.IUniform<number>;
  uPxPerCm: THREE.IUniform<number>;
  uPixelRatio: THREE.IUniform<number>;
  uNear: THREE.IUniform<number>;
  uFar: THREE.IUniform<number>;
}

/**
 * Star field. Each star is stored as (u, v, depth) in "screen fractions" and expanded
 * in the vertex shader so the field always fills the window frustum at any viewport size.
 * Point size is physical (cm) and perspective-correct for the off-axis camera, plus a
 * small pixel floor so far stars never vanish.
 */
export function createStarMaterial(near: number, far: number, refZ: number): THREE.ShaderMaterial {
  const uniforms: StarUniforms = {
    uSpan: { value: new THREE.Vector2(20, 15) },
    uRefZ: { value: refZ },
    uTime: { value: 0 },
    uDrift: { value: 0 },
    uPxPerCm: { value: 40 },
    uPixelRatio: { value: 1 },
    uNear: { value: near },
    uFar: { value: far },
  };
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      attribute vec3 aStar;   // u, v, depth (cm behind the screen)
      attribute vec4 aParams; // radius cm, twinkle phase, twinkle speed, min px
      attribute vec3 aColor;
      uniform vec2 uSpan;
      uniform float uRefZ;
      uniform float uTime;
      uniform float uDrift;
      uniform float uPxPerCm;
      uniform float uPixelRatio;
      uniform float uNear;
      uniform float uFar;
      varying vec3 vColor;
      varying float vBright;
      void main() {
        float range = uFar - uNear;
        float d = uNear + mod(aStar.z - uNear - uDrift, range);
        float s = (uRefZ + d) / uRefZ;
        vec3 pos = vec3(aStar.x * uSpan.x * s, aStar.y * uSpan.y * s, -d);
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mv;
        float dist = max(-mv.z, 1.0);
        float ez = max(cameraPosition.z, 5.0);
        float px = 2.0 * aParams.x * ez / dist * uPxPerCm + aParams.w * uPixelRatio;
        float tw = 0.72 + 0.28 * sin(uTime * aParams.z + aParams.y) * sin(uTime * aParams.z * 0.37 + aParams.y * 1.7);
        float fade = smoothstep(uNear, uNear + 45.0, d) * (1.0 - smoothstep(uFar - 250.0, uFar, d));
        float bright = tw * fade;
        float minPx = 2.0 * uPixelRatio;
        if (px < minPx) { bright *= (px * px) / (minPx * minPx); px = minPx; }
        gl_PointSize = px;
        vColor = aColor;
        vBright = bright;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vBright;
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(c, c);
        if (r2 > 1.0) discard;
        float core = exp(-r2 * 9.0);
        float glow = exp(-r2 * 3.0) * 0.3 * (1.0 - r2);
        gl_FragColor = vec4(vColor * (core + glow) * vBright, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Banded gas giant with zonal winds, soft terminator, atmosphere rim and the ring's shadow. */
export function createPlanetMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uLightLocal: { value: new THREE.Vector3(0, 0, 1) },
      uRingInner: { value: 1.32 },
      uRingOuter: { value: 2.35 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      varying vec3 vWorldN;
      varying vec3 vWorldPos;
      void main() {
        vLocal = position;
        vWorldN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uLightLocal;
      uniform float uRingInner;
      uniform float uRingOuter;
      varying vec3 vLocal;
      varying vec3 vWorldN;
      varying vec3 vWorldPos;
      ${NOISE_GLSL}
      ${RING_GLSL}
      void main() {
        vec3 n = normalize(vLocal);
        float lat = n.y;
        // Zonal winds: each latitude band flows at its own rate.
        float flow = uTime * 0.02 * (1.0 + sin(lat * 9.0));
        float ca = cos(flow), sa = sin(flow);
        vec3 q = vec3(ca * n.x - sa * n.z, n.y, sa * n.x + ca * n.z);
        float turb = vnoise(q * vec3(3.0, 9.0, 3.0)) * 0.6 + vnoise(q * vec3(7.0, 22.0, 7.0)) * 0.3;
        float b = lat * 6.5 + turb * 0.55;
        float t1 = 0.5 + 0.5 * sin(b * 3.1);
        float t2 = 0.5 + 0.5 * sin(b * 7.3 + 1.0);
        vec3 cream = vec3(0.95, 0.86, 0.68);
        vec3 tan = vec3(0.78, 0.56, 0.36);
        vec3 rust = vec3(0.58, 0.32, 0.20);
        vec3 col = mix(tan, cream, t1);
        col = mix(col, rust, t2 * t2 * 0.55);
        col = mix(col, vec3(0.70, 0.74, 0.80), smoothstep(0.72, 0.95, abs(lat)) * 0.6); // pale poles

        vec3 L = normalize(uLightLocal);
        float ndl = dot(n, L);
        float diff = smoothstep(-0.12, 0.9, ndl);
        // Shadow cast by the ring onto the globe.
        if (abs(L.y) > 1e-3) {
          float t = -n.y / L.y;
          if (t > 0.0) {
            vec3 hit = n + t * L;
            diff *= 1.0 - 0.75 * ringDensity(length(hit.xz));
          }
        }
        vec3 V = normalize(cameraPosition - vWorldPos);
        float fres = pow(1.0 - max(dot(normalize(vWorldN), V), 0.0), 3.0);
        vec3 atm = vec3(1.0, 0.82, 0.6) * fres * smoothstep(-0.35, 0.4, ndl) * 0.8;
        vec3 c = col * (diff * 1.35 + 0.025) + atm;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

/** Planetary ring (geometry lies in the planet's local xz plane), shadowed by the globe. */
export function createRingMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uLightLocal: { value: new THREE.Vector3(0, 0, 1) },
      uRingInner: { value: 1.32 },
      uRingOuter: { value: 2.35 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      void main() {
        vLocal = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uLightLocal;
      uniform float uRingInner;
      uniform float uRingOuter;
      varying vec3 vLocal;
      ${RING_GLSL}
      void main() {
        float r = length(vLocal.xz);
        float d = ringDensity(r);
        if (d < 0.04) discard;
        vec3 L = normalize(uLightLocal);
        // Globe shadow: does the ray toward the sun hit the unit sphere?
        float bq = dot(vLocal, L);
        float cq = dot(vLocal, vLocal) - 1.0;
        float disc = bq * bq - cq;
        float lit = 1.0;
        if (disc > 0.0 && -bq - sqrt(disc) > 0.0) lit = 0.08;
        vec3 col = mix(vec3(0.55, 0.47, 0.40), vec3(0.96, 0.89, 0.78), ringNoise(r * 14.0 + 3.0));
        float face = 0.55 + 0.45 * abs(L.y);
        gl_FragColor = vec4(col * lit * face * 1.25, d * 0.92);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: true,
  });
}

/** Soft darkening at the window edges, drawn on the z = 0 plane. */
export function createVignetteMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uHalf: { value: new THREE.Vector2(15, 10) },
      uWidth: { value: 3.0 },
      uStrength: { value: 0.6 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() {
        vP = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec2 uHalf;
      uniform float uWidth;
      uniform float uStrength;
      varying vec2 vP;
      void main() {
        vec2 e = uHalf - abs(vP * uHalf);
        float d = min(e.x, e.y);
        float a = 1.0 - smoothstep(0.0, uWidth, d);
        gl_FragColor = vec4(0.0, 0.0, 0.0, a * a * uStrength);
      }`,
    transparent: true,
    depthWrite: false,
  });
}

// ---------- CPU-side procedural textures ----------

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

/** 2D value noise over a periodic lattice (cheap, good enough for baked nebulae). */
function createNoise2(seed: number) {
  const rnd = makeRng(seed);
  const N = 256;
  const table = new Float32Array(N * N);
  for (let i = 0; i < table.length; i++) table[i] = rnd();
  const at = (x: number, y: number) => table[(((y % N) + N) % N) * N + (((x % N) + N) % N)];
  const noise = (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let fx = x - xi;
    let fy = y - yi;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  return (x: number, y: number, oct = 5) => {
    let sum = 0;
    let amp = 0.5;
    let f = 1;
    for (let i = 0; i < oct; i++) {
      sum += amp * noise(x * f, y * f);
      f *= 2.03;
      amp *= 0.5;
    }
    return sum;
  };
}

export interface NebulaPalette {
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
}

/**
 * Domain-warped fbm cloud baked once into a small texture. Concentrated in a diagonal
 * band (like a galactic plane) and faded to black at the borders so the quad edge never shows.
 * Colour is pre-multiplied for additive blending.
 */
export function createNebulaTexture(seed: number, pal: NebulaPalette, size = 256, angle = 0.5): THREE.DataTexture {
  const fbm = createNoise2(seed);
  const data = new Uint8Array(size * size * 4);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size - 0.5;
      const v = j / size - 0.5;
      const px = u * 5;
      const py = v * 5;
      const qx = fbm(px + 1.7, py + 9.2, 4);
      const qy = fbm(px + 8.3, py + 2.8, 4);
      const dens = fbm(px + 3.5 * qx, py + 3.5 * qy, 5);
      const across = -sa * u + ca * v;
      const band = Math.exp(-(across * across) / 0.025);
      const r = Math.sqrt(u * u + v * v) * 2;
      const edge = 1 - Math.min(1, Math.max(0, (r - 0.55) / 0.42));
      const fade = edge * edge * (3 - 2 * edge);
      let k = Math.max(0, dens - 0.32) * 2.2;
      k = k * k * (0.25 + 0.75 * band) * fade;
      const m = Math.min(1, qx * 1.4);
      const m2 = Math.min(1, Math.max(0, (dens - 0.45) * 3));
      const o = (j * size + i) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const col = pal.a[ch] * (1 - m) + pal.b[ch] * m;
        const col2 = col * (1 - m2) + pal.c[ch] * m2;
        data[o + ch] = Math.min(255, Math.round(col2 * k * 255));
      }
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Small solar-panel cell texture. */
export function createPanelTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0b1a3a';
  g.fillRect(0, 0, 128, 64);
  g.strokeStyle = '#6f8fc8';
  g.lineWidth = 1.5;
  for (let x = 0; x <= 128; x += 16) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, 64);
    g.stroke();
  }
  for (let y = 0; y <= 64; y += 16) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(128, y);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Tiny procedural environment for metallic bits: black space, a warm "sun" panel in the
 * key-light direction and a faint blue nebula glow opposite.
 */
export function createSpaceEnvironment(renderer: THREE.WebGLRenderer, sunDir: THREE.Vector3): THREE.WebGLRenderTarget {
  const env = new THREE.Scene();
  const disposables: { dispose(): void }[] = [];
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, setup: (m: THREE.Mesh) => void) => {
    const m = new THREE.Mesh(geo, mat);
    setup(m);
    env.add(m);
    disposables.push(geo, mat);
  };
  add(new THREE.SphereGeometry(20, 16, 8), new THREE.MeshBasicMaterial({ color: 0x03040a, side: THREE.BackSide }), () => {});
  add(new THREE.PlaneGeometry(7, 7), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff0d8).multiplyScalar(6), side: THREE.DoubleSide }), (m) => {
    m.position.copy(sunDir).multiplyScalar(15);
    m.lookAt(0, 0, 0);
  });
  add(new THREE.PlaneGeometry(26, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x3a2a80).multiplyScalar(1.2), side: THREE.DoubleSide }), (m) => {
    m.position.set(0, -2, -15);
    m.rotation.z = 0.5;
  });
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.03);
  pmrem.dispose();
  for (const d of disposables) d.dispose();
  return rt;
}
