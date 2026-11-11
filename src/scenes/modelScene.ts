import * as THREE from 'three';
import type { HeadPose, HoloScene, SceneContext, ViewportSpec } from '../types';
import { createGltfLoader, type GltfLoaderHandle } from './model/loadGltf';
import { createStudio, createStudioEnvironment } from './model/studio';
import { animateDefaultModel, createDefaultModel } from './model/defaultModel';

export interface ModelScene extends HoloScene {
  /** Load a .glb/.gltf (File or URL), fit it into the window box, and show it. */
  loadModel(src: File | string, onStatus?: (msg: string) => void): Promise<void>;
}

/** Turntable speed in rad/s (≈25 s per revolution). Set to 0 to stop the spin. */
export const TURNTABLE_SPEED = 0.25;
/** Fraction of the viewport height the model's bounding box should fill. */
const FILL_HEIGHT = 0.55;
/** Max fraction of the viewport width the model's turntable footprint may fill. */
const FILL_WIDTH = 0.8;
/** Cap on the turntable radius relative to viewport height, so deep models don't hit the viewer's nose. */
const MAX_RADIUS_H = 0.6;
/** z of the model's centre, cm. Slightly behind the glass so the front pokes out. */
const MODEL_Z = -4;
/** Gap between the model's lowest point and the shadow-catcher floor, cm. */
const FLOOR_GAP = 0.15;

interface Content {
  object: THREE.Object3D;
  /** Bounding box in the object's own (unscaled) space. */
  box: THREE.Box3;
  mixer: THREE.AnimationMixer | null;
  isDefault: boolean;
}

export function createModelScene(): ModelScene {
  const root = new THREE.Group();
  root.name = 'model';

  const studio = createStudio();
  root.add(studio.group);

  const turntable = new THREE.Group();
  turntable.name = 'turntable';
  turntable.position.z = MODEL_Z;
  turntable.rotation.y = -0.45;
  root.add(turntable);
  const fitter = new THREE.Group();
  fitter.name = 'fitter';
  turntable.add(fitter);

  let envRT: THREE.WebGLRenderTarget | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let loader: GltfLoaderHandle | null = null;
  let content: Content | null = null;
  let viewport: ViewportSpec = { widthCm: 30, heightCm: 19 };
  let loadToken = 0;
  let time = 0;
  let disposed = false;

  function prepare(object: THREE.Object3D): void {
    const maxAniso = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 1;
    const lights: THREE.Light[] = [];
    object.traverse((o) => {
      if ((o as THREE.Light).isLight) lights.push(o as THREE.Light);
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Skinned meshes' bind-pose bounds are unreliable once animated.
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false;
      for (const m of materialsOf(mesh)) {
        for (const tex of texturesOf(m)) if (tex.anisotropy < maxAniso) tex.anisotropy = maxAniso;
      }
    });
    // Lights baked into the file (KHR_lights_punctual) are authored in metres/candela and
    // fight the studio rig; drop them.
    for (const l of lights) {
      l.removeFromParent();
      l.dispose();
    }
    applyEnv(object);
  }

  function applyEnv(object: THREE.Object3D): void {
    if (!envRT) return;
    const env = envRT.texture;
    object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of materialsOf(mesh)) {
        const std = m as THREE.MeshStandardMaterial;
        if (std.isMeshStandardMaterial && !std.envMap) {
          std.envMap = env;
          std.needsUpdate = true;
        }
      }
    });
  }

  function setContent(object: THREE.Object3D, animations: THREE.AnimationClip[], isDefault: boolean): void {
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty() || !Number.isFinite(box.min.x + box.max.x + box.min.y + box.max.y)) {
      throw new Error('The model has no visible geometry.');
    }

    let mixer: THREE.AnimationMixer | null = null;
    if (animations.length) {
      mixer = new THREE.AnimationMixer(object);
      mixer.clipAction(animations[0]).play();
    }

    const prev = content;
    content = { object, box, mixer, isDefault };
    fitter.add(object);
    if (prev) {
      fitter.remove(prev.object);
      disposeContent(prev);
    }
    fit();
  }

  function disposeContent(c: Content): void {
    if (c.mixer) {
      c.mixer.stopAllAction();
      c.mixer.uncacheRoot(c.object);
    }
    const env = envRT?.texture;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    c.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) geometries.add(mesh.geometry);
      if (mesh.material) for (const m of materialsOf(mesh)) materials.add(m);
      const skinned = o as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh) skinned.skeleton?.dispose();
    });
    for (const m of materials) for (const t of texturesOf(m)) if (t !== env) textures.add(t);
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    for (const t of textures) {
      const img = t.image as { close?: () => void } | null;
      t.dispose();
      if (img && typeof img.close === 'function') img.close(); // ImageBitmap from GLTFLoader
    }
  }

  /** Scale and place the current content for the current viewport. */
  function fit(): void {
    if (!content) return;
    const w = viewport.widthCm;
    const h = viewport.heightCm;
    const size = content.box.getSize(new THREE.Vector3());
    const center = content.box.getCenter(new THREE.Vector3());
    // Radius swept by the turntable around the vertical axis through the box centre.
    const sweep = Math.max(Math.hypot(size.x, size.z) / 2, 1e-6);
    const sphere = Math.max(size.length() / 2, 1e-6);

    let s = (FILL_HEIGHT * h) / Math.max(size.y, 1e-6);
    s = Math.min(s, (FILL_WIDTH * w) / (2 * sweep), (MAX_RADIUS_H * h) / sweep);

    fitter.scale.setScalar(s);
    fitter.position.copy(center).multiplyScalar(-s);
    turntable.position.set(0, 0, MODEL_Z);

    const floorY = (-size.y / 2) * s - FLOOR_GAP;
    studio.layout(viewport, turntable.position, sphere * s, floorY);
  }

  return {
    name: 'model',
    root,

    init(ctx: SceneContext) {
      renderer = ctx.renderer;
      viewport = ctx.viewport;
      envRT = createStudioEnvironment(ctx.renderer);
      loader = createGltfLoader();
      if (content) applyEnv(content.object);
      else {
        const showpiece = createDefaultModel();
        prepare(showpiece);
        setContent(showpiece, [], true);
      }
    },

    resize(ctx: SceneContext) {
      if (ctx.viewport.widthCm === viewport.widthCm && ctx.viewport.heightCm === viewport.heightCm && content) return;
      viewport = ctx.viewport;
      fit();
    },

    update(dt: number, _pose: HeadPose) {
      time += dt;
      turntable.rotation.y += TURNTABLE_SPEED * dt;
      if (content?.mixer) content.mixer.update(dt);
      if (content?.isDefault) animateDefaultModel(content.object, time);
    },

    async loadModel(src: File | string, onStatus?: (msg: string) => void) {
      if (disposed) throw new Error('Scene has been disposed.');
      loader ??= createGltfLoader();
      const token = ++loadToken;
      const gltf = await loader.load(src, onStatus);
      const object = gltf.scene ?? gltf.scenes?.[0];
      if (!object) throw new Error('The file contains no scene.');
      if (token !== loadToken || disposed) {
        // A newer load (or dispose) superseded this one.
        disposeContent({ object, box: new THREE.Box3(), mixer: null, isDefault: false });
        return;
      }
      prepare(object);
      try {
        setContent(object, gltf.animations ?? [], false);
      } catch (err) {
        disposeContent({ object, box: new THREE.Box3(), mixer: null, isDefault: false });
        throw err;
      }
      turntable.rotation.y = -0.45;
    },

    dispose() {
      disposed = true;
      loadToken++;
      if (content) {
        fitter.remove(content.object);
        disposeContent(content);
        content = null;
      }
      studio.dispose();
      loader?.dispose();
      loader = null;
      envRT?.dispose();
      envRT = null;
      root.removeFromParent();
      root.clear();
    },
  };
}

function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
  const m = mesh.material;
  return Array.isArray(m) ? m : m ? [m] : [];
}

function texturesOf(material: THREE.Material): THREE.Texture[] {
  const out: THREE.Texture[] = [];
  for (const value of Object.values(material)) {
    if (value && (value as THREE.Texture).isTexture) out.push(value as THREE.Texture);
  }
  return out;
}
