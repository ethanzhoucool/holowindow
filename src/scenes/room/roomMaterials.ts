import * as THREE from 'three';

/** Palette shared by everything in the room. */
export const PALETTE = {
  wall: 0x1e2852,
  grid: new THREE.Color(0x2ee6ff),
  accent: 0xff6a3d,
  accentHot: 0xffb347,
  magenta: 0xff3d8b,
  ivory: 0xf2efe8,
  ink: 0x0a0f24,
};

/**
 * Uniforms shared by every room material. They are passed by reference into each
 * compiled shader, so updating `.value` here updates all materials at once.
 */
export interface RoomUniforms {
  uDepth: THREE.IUniform<number>;
  uFadeFar: THREE.IUniform<number>;
  uCell: THREE.IUniform<THREE.Vector3>;
  uOrigin: THREE.IUniform<THREE.Vector3>;
  uGridColor: THREE.IUniform<THREE.Color>;
  uGridIntensity: THREE.IUniform<number>;
}

export function createRoomUniforms(depthCm: number): RoomUniforms {
  return {
    uDepth: { value: depthCm },
    uFadeFar: { value: 0.22 },
    uCell: { value: new THREE.Vector3(5, 5, 5) },
    uOrigin: { value: new THREE.Vector3() },
    uGridColor: { value: PALETTE.grid.clone() },
    uGridIntensity: { value: 1.35 },
  };
}

const VERT_DECL = /* glsl */ `
varying vec3 vRoomPos;
varying vec3 vRoomN;
`;

const FRAG_DECL = /* glsl */ `
varying vec3 vRoomPos;
varying vec3 vRoomN;
uniform float uDepth;
uniform float uFadeFar;
uniform vec3 uCell;
uniform vec3 uOrigin;
uniform vec3 uGridColor;
uniform float uGridIntensity;
`;

/** Anti-aliased, pixel-crisp grid lines in world space, with a faint world-space halo. */
const GRID_FRAG = /* glsl */ `
{
  vec3 gp = (vRoomPos - uOrigin) / uCell;
  vec3 fw = max(fwidth(gp), vec3(1e-4));
  vec3 d = abs(fract(gp + 0.5) - 0.5);
  vec3 core = 1.0 - smoothstep(0.35, 1.35, d / fw);
  vec3 halo = exp(-(d * uCell) / 0.22) * 0.22;
  // Only the two axes lying in this surface's plane draw lines.
  vec3 n = abs(normalize(vRoomN));
  vec3 mask = step(n, vec3(0.5));
  // Fade lines out where they would alias (very grazing / far away).
  vec3 aa = 1.0 - smoothstep(0.25, 0.6, fw);
  vec3 l = (core + halo) * mask * aa;
  // The ring of lines at z = 0 is the window frame: make it glow brighter.
  float frame = 1.0 - smoothstep(0.0, 0.6, -vRoomPos.z);
  l.z *= 1.0 + 1.6 * frame;
  float line = max(max(l.x, l.y), l.z);
  totalEmissiveRadiance += uGridColor * uGridIntensity * line;
}
`;

const FADE_FRAG = /* glsl */ `
gl_FragColor.rgb *= mix(1.0, uFadeFar, smoothstep(0.0, uDepth, -vRoomPos.z));
#include <tonemapping_fragment>`;

/**
 * Patch a built-in lit material so it (a) darkens toward the back of the box like
 * fog would, and optionally (b) draws the glowing room grid as emissive light.
 */
export function patchRoomMaterial<T extends THREE.Material>(
  material: T,
  uniforms: RoomUniforms,
  opts: { grid?: boolean } = {},
): T {
  const grid = !!opts.grid;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
      .replace(
        '#include <fog_vertex>',
        `#include <fog_vertex>
vRoomPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vRoomN = mat3(modelMatrix) * objectNormal;`,
      );
    let frag = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_DECL}`)
      .replace('#include <tonemapping_fragment>', FADE_FRAG);
    if (grid) {
      frag = frag.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${GRID_FRAG}`);
    }
    shader.fragmentShader = frag;
  };
  material.customProgramCacheKey = () => (grid ? 'holo-room-grid' : 'holo-room-fade');
  return material;
}

/** Synthwave sun painted on the back wall: warm gradient disc with scrolling horizon cuts. */
export function createSunMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uTop: { value: new THREE.Color(PALETTE.accentHot) },
      uBottom: { value: new THREE.Color(PALETTE.magenta) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uTop;
      uniform vec3 uBottom;
      varying vec2 vUv;
      void main() {
        // The quad is 2x the disc so the glow has room.
        vec2 p = (vUv - 0.5) * 2.0;
        float r = length(p);
        float fw = fwidth(r);
        float R = 0.5;
        float disc = 1.0 - smoothstep(R - fw, R + fw, r);
        float t = clamp(p.y / R * 0.5 + 0.5, 0.0, 1.0);
        vec3 col = mix(uBottom, uTop, smoothstep(0.0, 1.0, t));
        // Horizontal cuts in the lower half, widening toward the bottom.
        float y = p.y / R;
        float cut = 0.0;
        if (y < 0.15) {
          float period = 0.16;
          float ph = fract((y - uTime * 0.03) / period);
          float gap = clamp((0.15 - y) * 0.45, 0.0, 0.85);
          float fy = fwidth(y / period);
          cut = smoothstep(gap + fy, gap - fy, ph);
        }
        float body = disc * (1.0 - cut);
        float glow = exp(-max(r - R, 0.0) * 9.0) * 0.28 * (1.0 - disc);
        vec3 c = col * (body * 1.6 + glow);
        // Premultiplied: the disc occludes the wall grid, the glow and cuts let it through.
        gl_FragColor = vec4(c, body);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    depthWrite: false,
  });
}

/** Archery-style target face: concentric warm/ivory rings. */
export function createTargetTexture(): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const rings = ['#e6e1d8', '#ff4f1f', '#e6e1d8', '#ff4f1f', '#e6e1d8', '#ff4f1f'];
  const cx = size / 2;
  for (let i = 0; i < rings.length; i++) {
    g.fillStyle = rings[i];
    g.beginPath();
    g.arc(cx, cx, (cx * (rings.length - i)) / rings.length, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Tiny procedural environment (dark navy room with cyan strips and a warm panel)
 * baked once through PMREM so glossy objects get believable neon reflections.
 */
export function createNeonEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const env = new THREE.Scene();
  const disposables: { dispose(): void }[] = [];
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, setup: (m: THREE.Mesh) => void) => {
    const m = new THREE.Mesh(geo, mat);
    setup(m);
    env.add(m);
    disposables.push(geo, mat);
  };
  add(
    new THREE.BoxGeometry(20, 20, 20),
    new THREE.MeshBasicMaterial({ color: 0x060a1c, side: THREE.BackSide }),
    () => {},
  );
  const stripMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x2ee6ff).multiplyScalar(3) });
  for (let i = 0; i < 4; i++) {
    add(new THREE.PlaneGeometry(18, 0.25), i === 0 ? stripMat : stripMat.clone(), (m) => {
      m.position.set(0, 9.9, -6 + i * 4);
      m.rotation.x = Math.PI / 2;
    });
  }
  add(new THREE.PlaneGeometry(6, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff6a3d).multiplyScalar(2.5) }), (m) => {
    m.position.set(0, 1, -9.9);
  });
  add(new THREE.PlaneGeometry(5, 5), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffffff).multiplyScalar(4) }), (m) => {
    m.position.set(-4, 6, 9.9);
    m.rotation.y = Math.PI;
  });
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.02);
  pmrem.dispose();
  for (const d of disposables) d.dispose();
  return rt;
}
