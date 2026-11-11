import * as THREE from 'three';
import { DEFAULT_POSE, type HoloScene, type SceneContext, type ViewportSpec } from '../types';
import { DepthEstimator } from '../depth/depthEstimator';
import { createDefaultImage } from './photo/defaultImage';
import { decodeImage, drawScaled, readPixels } from './photo/imageUtils';
import { createReliefMaterial } from './photo/reliefMaterial';

export interface PhotoScene extends HoloScene {
  /** Load an image (File or URL), estimate depth, and show it as a 3D relief. */
  loadImage(src: File | string, onStatus?: (msg: string) => void): Promise<void>;
}

/** Longest side of the image fed to the depth model. */
const INFERENCE_MAX_SIDE = 640;
/** Longest side of the colour texture. */
const COLOR_MAX_SIDE = 2048;
/** Mesh segments along the image's longest side (within the photo itself). */
const MESH_SEGMENTS = 384;
/** Out-of-frame rim, as a fraction of the image size on each side. */
const MARGIN = 0.15;
/** Seconds for the relief to "grow" from flat after new depth arrives. */
const GROW_SECONDS = 0.8;

export function createPhotoScene(): PhotoScene {
  const root = new THREE.Group();
  root.name = 'photo';

  const material = createReliefMaterial(MARGIN, DEFAULT_POSE.z);
  const u = material.uniforms;
  let geometry: THREE.PlaneGeometry | null = null;
  let mesh: THREE.Mesh | null = null;
  let colorTex: THREE.Texture | null = null;
  let depthTex: THREE.DataTexture | null = null;
  let aspect = 16 / 9;
  let viewport: ViewportSpec = { widthCm: 30, heightCm: 19 };
  let renderer: THREE.WebGLRenderer | null = null;
  let estimator: DepthEstimator | null = null;
  let loadToken = 0;
  let growing = false;
  let disposed = false;

  function fit(): void {
    const va = viewport.widthCm / viewport.heightCm;
    if (aspect > va) u.uSize.value.set(viewport.heightCm * aspect, viewport.heightCm);
    else u.uSize.value.set(viewport.widthCm, viewport.widthCm / aspect);
  }

  function setGeometry(imgAspect: number): void {
    aspect = imgAspect;
    const ext = 1 + 2 * MARGIN;
    const sx = Math.round((imgAspect >= 1 ? MESH_SEGMENTS : Math.max(32, MESH_SEGMENTS * imgAspect)) * ext);
    const sy = Math.round((imgAspect >= 1 ? Math.max(32, MESH_SEGMENTS / imgAspect) : MESH_SEGMENTS) * ext);
    const prev = geometry;
    geometry = new THREE.PlaneGeometry(1, 1, sx, sy);
    if (mesh) mesh.geometry = geometry;
    else {
      mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      root.add(mesh);
    }
    prev?.dispose();
    fit();
  }

  function makeColorTexture(source: HTMLCanvasElement): THREE.Texture {
    const t = new THREE.CanvasTexture(source);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    if (renderer) t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return t;
  }

  function makeDepthTexture(data: Uint8Array, w: number, h: number): THREE.DataTexture {
    const t = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
    t.unpackAlignment = 1;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }

  function setColor(t: THREE.Texture): void {
    colorTex?.dispose();
    colorTex = t;
    u.uColor.value = t;
  }

  function setDepth(t: THREE.DataTexture, animate: boolean): void {
    depthTex?.dispose();
    depthTex = t;
    u.uDepth.value = t;
    growing = animate;
    u.uDepthMix.value = animate ? 0 : 1;
  }

  function flatDepth(): THREE.DataTexture {
    return makeDepthTexture(new Uint8Array([255]), 1, 1);
  }

  function showDefault(): void {
    const img = createDefaultImage();
    setGeometry(img.color.width / img.color.height);
    setColor(makeColorTexture(img.color));
    setDepth(makeDepthTexture(img.depth, img.depthWidth, img.depthHeight), false);
  }

  return {
    name: 'photo',
    root,

    init(ctx: SceneContext) {
      renderer = ctx.renderer;
      viewport = ctx.viewport;
      u.uDepthScale.value = ctx.settings.depthScale;
      if (!mesh) showDefault();
    },

    resize(ctx: SceneContext) {
      viewport = ctx.viewport;
      u.uDepthScale.value = ctx.settings.depthScale;
      fit();
    },

    update(dt: number, _pose, ctx: SceneContext) {
      u.uDepthScale.value = ctx.settings.depthScale;
      if (ctx.viewport !== viewport) {
        viewport = ctx.viewport;
        fit();
      }
      if (growing) {
        const v = Math.min(1, u.uDepthMix.value + dt / GROW_SECONDS);
        u.uDepthMix.value = v;
        if (v >= 1) growing = false;
      }
    },

    dispose() {
      disposed = true;
      loadToken++;
      estimator?.dispose();
      estimator = null;
      geometry?.dispose();
      geometry = null;
      colorTex?.dispose();
      colorTex = null;
      depthTex?.dispose();
      depthTex = null;
      material.dispose();
      if (mesh) root.remove(mesh);
      mesh = null;
    },

    async loadImage(src: File | string, onStatus?: (msg: string) => void): Promise<void> {
      if (disposed) throw new Error('Photo scene has been disposed');
      const token = ++loadToken;
      onStatus?.('Decoding image…');
      const bitmap = await decodeImage(src);
      let colorCanvas: HTMLCanvasElement;
      let inference: ImageData;
      try {
        const maxTex = renderer ? renderer.capabilities.maxTextureSize : COLOR_MAX_SIDE;
        colorCanvas = drawScaled(bitmap, Math.min(COLOR_MAX_SIDE, maxTex));
        inference = readPixels(drawScaled(bitmap, INFERENCE_MAX_SIDE));
      } finally {
        bitmap.close();
      }
      if (token !== loadToken) return;

      // Show the new photo flat right away while depth is computed.
      setGeometry(colorCanvas.width / colorCanvas.height);
      setColor(makeColorTexture(colorCanvas));
      setDepth(flatDepth(), false);

      estimator ??= new DepthEstimator();
      const depth = await estimator.estimate(inference, (msg) => {
        if (token === loadToken) onStatus?.(msg);
      });
      if (token !== loadToken || disposed) return;
      setDepth(makeDepthTexture(depth.data, depth.width, depth.height), true);
    },
  };
}
