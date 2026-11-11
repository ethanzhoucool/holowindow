import * as THREE from 'three';

/** Water palette shared by everything in the tank. */
export const WATER = {
  deep: new THREE.Color(0x03222e),
  shallow: new THREE.Color(0x0e5a68),
  caustic: new THREE.Color(0xbff6ff),
  surface: new THREE.Color(0x7fe3ee),
};

/**
 * Uniforms shared by every aquarium material (passed by reference, so one update
 * drives every compiled shader).
 */
export interface AquaUniforms {
  uTime: THREE.IUniform<number>;
  uDepth: THREE.IUniform<number>;
  uHalf: THREE.IUniform<THREE.Vector2>;
  uDeep: THREE.IUniform<THREE.Color>;
  uShallow: THREE.IUniform<THREE.Color>;
  uCausticColor: THREE.IUniform<THREE.Color>;
  uCausticStrength: THREE.IUniform<number>;
  uFog: THREE.IUniform<number>;
}

export function createAquaUniforms(depthCm: number): AquaUniforms {
  return {
    uTime: { value: 0 },
    uDepth: { value: depthCm },
    uHalf: { value: new THREE.Vector2(15, 10) },
    uDeep: { value: WATER.deep.clone() },
    uShallow: { value: WATER.shallow.clone() },
    uCausticColor: { value: WATER.caustic.clone() },
    uCausticStrength: { value: 1.6 },
    uFog: { value: 0.82 },
  };
}

/**
 * Animated caustic web (iterated trig warp; ~4 iterations, no textures).
 * Returns roughly 0..1 with bright thin filaments.
 */
export const CAUSTIC_GLSL = /* glsl */ `
float aquaCaustic(vec2 p, float t) {
  p -= 250.0;
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return clamp(pow(abs(c), 8.0), 0.0, 1.6);
}
`;

const COMMON_DECL = /* glsl */ `
uniform float uTime;
uniform float uDepth;
uniform vec2 uHalf;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uCausticColor;
uniform float uCausticStrength;
uniform float uFog;
varying vec3 vAquaPos;
`;

/** Depth fog toward the back wall and a darker gradient toward the floor. */
export const FOG_GLSL = /* glsl */ `
vec3 aquaFog(vec3 col, vec3 wp) {
  float depthT = clamp(-wp.z / uDepth, 0.0, 1.0);
  float h = clamp((wp.y + uHalf.y) / (2.0 * uHalf.y), 0.0, 1.0);
  vec3 water = mix(uDeep, uShallow, h * 0.85 + 0.1);
  float f = (1.0 - exp(-depthT * 2.2)) * uFog;
  // Water absorbs red first.
  col *= mix(vec3(1.0), vec3(0.72, 0.92, 1.0), depthT);
  return mix(col, water, f);
}
`;

const VERT_SWAY = /* glsl */ `
#include <begin_vertex>
{
  float hgt = max(transformed.y, 0.0);
  vec3 ip = vec3(0.0);
  #ifdef USE_INSTANCING
  ip = instanceMatrix[3].xyz;
  #endif
  float ph = ip.x * 0.37 + ip.z * 0.23;
  float k = hgt * hgt * 0.16;
  transformed.x += (sin(uTime * 0.8 + ph + hgt * 2.2) + 0.35 * sin(uTime * 1.9 + ph * 2.0 + hgt * 5.0)) * k;
  transformed.z += cos(uTime * 0.6 + ph * 1.3 + hgt * 1.7) * k * 0.6;
}
`;

const VERT_FISH = /* glsl */ `
#include <begin_vertex>
{
  vFishLocal = position.xy;
  vFishPat = aFish.z;
  float tailT = clamp(0.42 - position.x, 0.0, 1.2);
  float wig = sin(uTime * aFish.y + aFish.x - position.x * 6.0);
  transformed.z += wig * (0.015 + 0.17 * tailT * tailT);
}
`;

/** Species patterns, applied in the fragment shader in fish-local space (x: tail -0.55 .. nose +0.5). */
const FRAG_FISH = /* glsl */ `
#include <emissivemap_fragment>
{
  vec2 fl = vFishLocal;
  float notEye = step(0.03, max(max(vColor.r, vColor.g), vColor.b));
  if (vFishPat > 0.5 && vFishPat < 1.5) {
    // Clownfish: three white bands with dark edges.
    float s = 0.0;
    s += 1.0 - smoothstep(0.03, 0.04, abs(fl.x - 0.27));
    s += 1.0 - smoothstep(0.035, 0.045, abs(fl.x - 0.01));
    s += 1.0 - smoothstep(0.025, 0.035, abs(fl.x + 0.3));
    float e = 0.0;
    e += smoothstep(0.03, 0.04, abs(fl.x - 0.27)) * (1.0 - smoothstep(0.045, 0.055, abs(fl.x - 0.27)));
    e += smoothstep(0.035, 0.045, abs(fl.x - 0.01)) * (1.0 - smoothstep(0.05, 0.06, abs(fl.x - 0.01)));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03), clamp(e, 0.0, 1.0) * notEye);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), clamp(s, 0.0, 1.0) * notEye);
  } else if (vFishPat > 1.5 && vFishPat < 2.5) {
    // Neon tetra: glowing cyan lateral line, red rear belly.
    float line = 1.0 - smoothstep(0.012, 0.024, abs(fl.y - 0.025 + fl.x * 0.03));
    line *= smoothstep(-0.36, -0.25, fl.x) * (1.0 - smoothstep(0.33, 0.4, fl.x));
    float red = (1.0 - smoothstep(-0.02, 0.01, fl.y - 0.0)) * (1.0 - smoothstep(-0.02, 0.06, fl.x)) * step(-0.36, fl.x);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.08, 0.1), red * notEye);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.95, 1.0), line * notEye);
    totalEmissiveRadiance += vec3(0.05, 0.6, 0.75) * line * notEye;
  } else if (vFishPat > 2.5) {
    // Blue tang: yellow tail, dark palette mark.
    float tail = 1.0 - smoothstep(-0.37, -0.33, fl.x);
    float mark = (1.0 - smoothstep(0.02, 0.05, abs(fl.y - 0.06 - 0.25 * (fl.x - 0.1) * (fl.x - 0.1) * -3.0))) * step(-0.28, fl.x) * step(fl.x, 0.3);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02, 0.03, 0.12), mark * notEye * 0.85);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.82, 0.1), tail * notEye);
  }
}
`;

const FRAG_LIGHT = /* glsl */ `
#include <lights_fragment_end>
{
  vec2 cp = vec2(vAquaPos.x, vAquaPos.z - vAquaPos.y * 0.55) * 0.32;
  float cz = aquaCaustic(cp, uTime * 0.55 + 23.0);
  float facing = clamp(normal.y * 0.75 + 0.3, 0.0, 1.0);
  float nearSurface = mix(0.45, 1.0, clamp((vAquaPos.y + uHalf.y) / (2.0 * uHalf.y), 0.0, 1.0));
  reflectedLight.directDiffuse += diffuseColor.rgb * uCausticColor * (cz * uCausticStrength * facing * nearSurface);
}
`;

const FRAG_FOG = /* glsl */ `
gl_FragColor.rgb = aquaFog(gl_FragColor.rgb, vAquaPos);
#include <tonemapping_fragment>`;

const VERT_WORLD = /* glsl */ `
#include <project_vertex>
{
  vec4 aquaWP = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  aquaWP = instanceMatrix * aquaWP;
  #endif
  vAquaPos = (modelMatrix * aquaWP).xyz;
}
`;

export interface PatchOpts {
  /** Kelp-style sway (local +y is up, amplitude grows with height). */
  sway?: boolean;
  /** Fish tail wiggle + species patterns (needs the `aFish` instanced attribute). */
  fish?: boolean;
  /** Receive caustics. Default true. */
  caustics?: boolean;
}

/**
 * Patch a built-in lit material (Lambert/Phong/Standard) with aquarium caustics,
 * underwater fog and optional vertex animation.
 */
export function patchAquaMaterial<T extends THREE.Material>(material: T, uniforms: AquaUniforms, opts: PatchOpts = {}): T {
  const caustics = opts.caustics !== false;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let vs = shader.vertexShader.replace('#include <common>', `#include <common>\n${COMMON_DECL}`);
    if (opts.fish) {
      vs = vs
        .replace('#include <common>', `#include <common>\nattribute vec4 aFish;\nvarying vec2 vFishLocal;\nvarying float vFishPat;`)
        .replace('#include <begin_vertex>', VERT_FISH);
    }
    if (opts.sway) vs = vs.replace('#include <begin_vertex>', VERT_SWAY);
    vs = vs.replace('#include <project_vertex>', VERT_WORLD);
    shader.vertexShader = vs;

    let fs = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${COMMON_DECL}\n${CAUSTIC_GLSL}\n${FOG_GLSL}`)
      .replace('#include <tonemapping_fragment>', FRAG_FOG);
    if (caustics) fs = fs.replace('#include <lights_fragment_end>', FRAG_LIGHT);
    if (opts.fish) {
      fs = fs
        .replace('#include <common>', `#include <common>\nvarying vec2 vFishLocal;\nvarying float vFishPat;`)
        .replace('#include <emissivemap_fragment>', FRAG_FISH);
    }
    shader.fragmentShader = fs;
  };
  const key = `holo-aqua-${opts.sway ? 's' : ''}${opts.fish ? 'f' : ''}${caustics ? 'c' : ''}`;
  material.customProgramCacheKey = () => key;
  return material;
}

/** Underside of the water surface: bright, rippling, with total-internal-reflection falloff. */
export function createSurfaceMaterial(uniforms: AquaUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uSurface: { value: WATER.surface.clone() } },
    vertexShader: /* glsl */ `
      varying vec3 vAquaPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vAquaPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON_DECL}
      uniform vec3 uSurface;
      ${CAUSTIC_GLSL}
      ${FOG_GLSL}
      void main() {
        vec2 p = vAquaPos.xz * 0.22;
        float r = aquaCaustic(p, uTime * 0.4 + 7.0);
        vec3 V = normalize(cameraPosition - vAquaPos);
        float graze = pow(1.0 - abs(V.y), 2.0);
        vec3 col = uSurface * (0.35 + 0.65 * r) * mix(1.1, 0.45, graze);
        col = aquaFog(col, vAquaPos);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

/** Soft additive light shafts from the surface. */
export function createShaftMaterial(uniforms: AquaUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: uniforms.uTime, uColor: { value: new THREE.Color(0x9ff0ff) } },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      varying vec2 vUv;
      varying float vSeed;
      void main() {
        vUv = uv;
        vSeed = aSeed;
        vec4 p = vec4(position, 1.0);
        #ifdef USE_INSTANCING
        p = instanceMatrix * p;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * p;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      varying vec2 vUv;
      varying float vSeed;
      void main() {
        float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
        across = across * across * (3.0 - 2.0 * across);
        float down = pow(vUv.y, 1.6) * smoothstep(1.0, 0.88, vUv.y);
        float flick = 0.55 + 0.45 * sin(uTime * (0.4 + vSeed * 0.3) + vSeed * 17.0);
        float a = across * down * flick * 0.07;
        gl_FragColor = vec4(uColor * a, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/** Rising bubbles: positions are computed in the shader from per-bubble seeds. */
export function createBubbleMaterial(uniforms: AquaUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...uniforms,
      uPxPerCm: { value: 40 },
      uFloorY: { value: -10 },
    },
    vertexShader: /* glsl */ `
      ${COMMON_DECL}
      attribute vec4 aBubble; // fx, fz (fractions), rise speed cm/s, phase
      attribute float aSize;  // radius cm
      uniform float uPxPerCm;
      uniform float uFloorY;
      varying float vAlpha;
      void main() {
        float H = uHalf.y - uFloorY;
        float t = mod(aBubble.w * H + uTime * aBubble.z, H);
        float y = uFloorY + t;
        float wob = sin(uTime * 3.0 + aBubble.w * 40.0 + t * 0.6) * (0.15 + t * 0.02);
        vec3 pos = vec3(aBubble.x * uHalf.x + wob, y, -aBubble.y * uDepth + cos(uTime * 2.3 + aBubble.w * 13.0) * 0.12);
        vAquaPos = pos;
        vec4 mv = viewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mv;
        float ez = max(cameraPosition.z, 5.0);
        float grow = 1.0 + t / H * 0.6;
        gl_PointSize = max(2.0 * aSize * grow * ez / max(-mv.z, 1.0) * uPxPerCm, 1.5);
        vAlpha = smoothstep(0.0, 1.5, t) * (1.0 - smoothstep(H - 0.6, H, t));
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON_DECL}
      ${FOG_GLSL}
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        float r = length(c);
        if (r > 1.0) discard;
        float rim = smoothstep(0.6, 0.95, r) * (1.0 - smoothstep(0.95, 1.0, r));
        float spec = 1.0 - smoothstep(0.0, 0.28, length(c - vec2(-0.35, -0.35)));
        float a = (rim * 0.55 + spec * 0.9 + 0.06) * vAlpha;
        vec3 col = aquaFog(vec3(0.85, 0.97, 1.0) * 1.3, vAquaPos);
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
}

/** Faint glass sheen + edge vignette on the z = 0 plane. */
export function createGlassMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uHalf: { value: new THREE.Vector2(15, 10) },
      uWidth: { value: 2.0 },
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
      varying vec2 vP;
      void main() {
        vec2 q = vP * uHalf;
        vec2 e = uHalf - abs(q);
        float d = min(e.x, e.y);
        float vig = 1.0 - smoothstep(0.0, uWidth, d);
        // Two soft diagonal reflections across the glass.
        float diag = (q.x + q.y * 0.8) / max(uHalf.x, 1.0);
        float sheen = exp(-pow((diag + 0.35) * 5.0, 2.0)) * 0.05 + exp(-pow((diag + 0.62) * 14.0, 2.0)) * 0.035;
        sheen *= smoothstep(-1.0, 0.2, vP.y);
        // Premultiplied: darken edges, add sheen.
        float a = vig * vig * 0.55;
        gl_FragColor = vec4(vec3(0.75, 0.95, 1.0) * sheen, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
}
