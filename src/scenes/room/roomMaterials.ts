import * as THREE from 'three';

/**
 * Palette shared by everything in the room: one cool-grey family plus a single
 * desaturated terracotta accent.
 */
export const PALETTE = {
  wall: 0xb9bcbe,
  porcelain: 0xe2e3e1,
  stone: 0x9a9d9f,
  steel: 0xa7abae,
  graphite: 0x3d4144,
  accent: 0xb1664f,
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
  /** Half-extents of the box opening (x, y) in cm. */
  uHalf: THREE.IUniform<THREE.Vector2>;
  /** 0..1 — how much a grout line darkens the wall albedo. */
  uGridStrength: THREE.IUniform<number>;
  /** Grout line width in cm. */
  uGridWidth: THREE.IUniform<number>;
  /** 0..1 — darkening right in an inside corner. */
  uAOStrength: THREE.IUniform<number>;
  /** Falloff distance of the corner darkening, in cm. */
  uAORadius: THREE.IUniform<number>;
  /** Albedo multiplier for the floor (slightly darker than walls, like a real room). */
  uFloorTint: THREE.IUniform<number>;
}

export function createRoomUniforms(depthCm: number): RoomUniforms {
  return {
    uDepth: { value: depthCm },
    uFadeFar: { value: 0.8 },
    uCell: { value: new THREE.Vector3(5, 5, 5) },
    uOrigin: { value: new THREE.Vector3() },
    uHalf: { value: new THREE.Vector2(15, 9) },
    uGridStrength: { value: 0.16 },
    uGridWidth: { value: 0.06 },
    uAOStrength: { value: 0.5 },
    uAORadius: { value: 4 },
    uFloorTint: { value: 0.86 },
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
uniform vec2 uHalf;
uniform float uGridStrength;
uniform float uGridWidth;
uniform float uAOStrength;
uniform float uAORadius;
uniform float uFloorTint;
`;

/**
 * Wall surface: thin, anti-aliased grout lines that darken the albedo (not emissive),
 * plus a soft ambient-occlusion-like darkening into the inside corners of the box.
 */
const WALL_FRAG = /* glsl */ `
{
  vec3 n = abs(normalize(vRoomN));
  // Only the two axes lying in this surface's plane draw lines / receive corner AO.
  vec3 mask = step(n, vec3(0.5));

  vec3 gp = (vRoomPos - uOrigin) / uCell;
  vec3 fw = max(fwidth(gp), vec3(1e-4));
  vec3 d = abs(fract(gp + 0.5) - 0.5);
  // Line half-width in cell units, never thinner than ~1px so it doesn't shimmer.
  vec3 hwid = max(vec3(uGridWidth * 0.5) / uCell, fw * 0.5);
  vec3 cov = 1.0 - smoothstep(hwid - fw * 0.5, hwid + fw * 0.5, d);
  // A line thinner than a pixel keeps its average darkness instead of popping.
  cov *= min(vec3(1.0), (uGridWidth / uCell) / max(fw, vec3(1e-4)));
  // Fade where lines would alias (very grazing / far away).
  cov *= 1.0 - smoothstep(0.3, 0.7, fw);
  vec3 l = cov * mask;
  float line = max(max(l.x, l.y), l.z);
  diffuseColor.rgb *= 1.0 - uGridStrength * line;

  // Distance to the neighbouring planes of the box (the front is open, so no z=0 term).
  vec3 dist = vec3(uHalf.x - abs(vRoomPos.x), uHalf.y - abs(vRoomPos.y), uDepth + vRoomPos.z);
  vec3 occ = exp(-max(dist, vec3(0.0)) / uAORadius) * mask;
  float ao = (1.0 - uAOStrength * occ.x) * (1.0 - uAOStrength * occ.y) * (1.0 - uAOStrength * occ.z);
  diffuseColor.rgb *= ao;

  if (vRoomN.y > 0.5) diffuseColor.rgb *= uFloorTint;
}
`;

const FADE_FRAG = /* glsl */ `
gl_FragColor.rgb *= mix(1.0, uFadeFar, smoothstep(0.0, uDepth, -vRoomPos.z));
#include <tonemapping_fragment>`;

/**
 * Patch a built-in lit material so it (a) dims slightly toward the back of the box
 * (gentle aerial perspective), and optionally (b) draws the wall grout grid + corner AO.
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
      frag = frag.replace('#include <color_fragment>', `#include <color_fragment>\n${WALL_FRAG}`);
    }
    shader.fragmentShader = frag;
  };
  material.customProgramCacheKey = () => (grid ? 'holo-room-wall' : 'holo-room-fade');
  return material;
}

/** Target face: porcelain disc with fine graphite rings and a terracotta centre. */
export function createTargetTexture(): THREE.CanvasTexture {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const cx = size / 2;
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
  g.fillStyle = hex(PALETTE.porcelain);
  g.fillRect(0, 0, size, size);
  // Wide terracotta band, then fine rings, then a solid centre.
  g.strokeStyle = hex(PALETTE.accent);
  g.lineWidth = size * 0.045;
  g.beginPath();
  g.arc(cx, cx, cx * 0.7, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = hex(PALETTE.graphite);
  g.lineWidth = size * 0.006;
  for (const r of [0.92, 0.5, 0.34]) {
    g.beginPath();
    g.arc(cx, cx, cx * r, 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = hex(PALETTE.accent);
  g.beginPath();
  g.arc(cx, cx, cx * 0.17, 0, Math.PI * 2);
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Tiny procedural photo-studio environment (neutral grey room, one large softbox
 * up-front-left and a faint fill strip) baked once through PMREM so satin and
 * brushed-metal objects get soft, believable reflections.
 */
export function createStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
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
    new THREE.MeshBasicMaterial({ color: 0x6f7376, side: THREE.BackSide }),
    () => {},
  );
  // Darker floor half so reflections have a horizon.
  add(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial({ color: 0x45484b }), (m) => {
    m.position.y = -9.9;
    m.rotation.x = -Math.PI / 2;
  });
  // Key softbox: above and in front (toward the viewer), slightly left.
  add(new THREE.PlaneGeometry(9, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff6ec).multiplyScalar(2.4) }), (m) => {
    m.position.set(-3, 6, 9.9);
    m.rotation.y = Math.PI;
  });
  // Faint vertical fill strip on the right.
  add(new THREE.PlaneGeometry(2, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xe8ecef).multiplyScalar(0.9) }), (m) => {
    m.position.set(9.9, 1, 0);
    m.rotation.y = -Math.PI / 2;
  });
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.04);
  pmrem.dispose();
  for (const d of disposables) d.dispose();
  return rt;
}
