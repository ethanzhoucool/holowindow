/**
 * Shader for the depth-displaced photo relief.
 *
 * Geometry is a unit PlaneGeometry (uv 0..1). The vertex shader:
 *  - extends the plane by `uMargin` (in uv units) on every side; the extra rim clamps its
 *    texture lookups, so edge pixels smear outward instead of revealing the void when the
 *    viewer looks around the frame edge,
 *  - maps the plane onto `uSize` cm (cover-fit to the viewport at z = 0),
 *  - pushes each vertex to z = -(uNearGap + (1 - nearness) * (uDepthScale - uNearGap)),
 *  - scales x/y by (E - z) / E (E = nominal eye distance) so that from the nominal head
 *    position the relief projects exactly onto the original flat photo.
 *
 * The fragment shader darkens triangles that appear stretched on screen (rubber-sheet walls
 * across depth discontinuities). Stretch is measured view-dependently: the screen-space area
 * of a pixel is compared with the area it covers on the flat reference photo, so from the
 * nominal eye position nothing is darkened, and walls darken only as they're revealed.
 * The out-of-frame rim is also slightly darkened.
 */
import * as THREE from 'three';

const vertexShader = /* glsl */ `
uniform sampler2D uDepth;
uniform vec2 uSize;
uniform float uMargin;
uniform float uDepthScale;
uniform float uNearGap;
uniform float uEyeDist;
uniform float uDepthMix;

varying vec2 vUv;
varying vec4 vClip;
varying vec4 vRefClip;
varying float vOutside;

void main() {
  vec2 ext = uv * (1.0 + 2.0 * uMargin) - uMargin;
  vec2 uvc = clamp(ext, 0.0, 1.0);
  vOutside = max(max(-ext.x, ext.x - 1.0), max(-ext.y, ext.y - 1.0));
  vUv = uvc;

  // Depth texture rows are stored top-first, so flip v.
  float nearness = texture2D(uDepth, vec2(uvc.x, 1.0 - uvc.y)).r;
  nearness = mix(1.0, nearness, uDepthMix);
  float z = -(uNearGap + (1.0 - nearness) * max(uDepthScale - uNearGap, 0.0));
  float s = (uEyeDist - z) / uEyeDist;
  vec3 p = vec3((ext - 0.5) * uSize * s, z);

  mat4 vp = projectionMatrix * viewMatrix * modelMatrix;
  vRefClip = vp * vec4((ext - 0.5) * uSize, 0.0, 1.0);
  vClip = vp * vec4(p, 1.0);
  gl_Position = vClip;
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uColor;
uniform float uMargin;
uniform float uEdgeFade;

varying vec2 vUv;
varying vec4 vClip;
varying vec4 vRefClip;
varying float vOutside;

float area(vec2 a) {
  return abs(dFdx(a).x * dFdy(a).y - dFdx(a).y * dFdy(a).x);
}

void main() {
  vec4 c = texture2D(uColor, vUv);

  // Linear magnification of the reference photo at this pixel (1 = undistorted).
  float actual = area(vClip.xy / vClip.w);
  float ref = area(vRefClip.xy / vRefClip.w);
  float shrink = sqrt(ref / max(actual, 1e-20));
  float stretch = (1.0 - smoothstep(0.08, 0.45, shrink)) * uEdgeFade;
  c.rgb *= 1.0 - 0.55 * stretch;

  c.rgb *= 1.0 - 0.35 * smoothstep(0.0, max(uMargin, 1e-4), vOutside);

  gl_FragColor = vec4(c.rgb, 1.0);
  #include <colorspace_fragment>
}
`;

export interface ReliefUniforms {
  [name: string]: THREE.IUniform;
  uColor: THREE.IUniform<THREE.Texture | null>;
  uDepth: THREE.IUniform<THREE.Texture | null>;
  uSize: THREE.IUniform<THREE.Vector2>;
  uMargin: THREE.IUniform<number>;
  uDepthScale: THREE.IUniform<number>;
  uNearGap: THREE.IUniform<number>;
  uEyeDist: THREE.IUniform<number>;
  uDepthMix: THREE.IUniform<number>;
  uEdgeFade: THREE.IUniform<number>;
}

export function createReliefMaterial(margin: number, eyeDist: number): THREE.ShaderMaterial & { uniforms: ReliefUniforms } {
  const uniforms: ReliefUniforms = {
    uColor: { value: null },
    uDepth: { value: null },
    uSize: { value: new THREE.Vector2(1, 1) },
    uMargin: { value: margin },
    uDepthScale: { value: 12 },
    uNearGap: { value: 0.4 },
    uEyeDist: { value: eyeDist },
    uDepthMix: { value: 1 },
    uEdgeFade: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, side: THREE.DoubleSide });
  return mat as THREE.ShaderMaterial & { uniforms: ReliefUniforms };
}
