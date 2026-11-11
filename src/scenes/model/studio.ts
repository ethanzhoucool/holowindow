import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/** z of the backdrop wall, cm. */
export const BACKDROP_Z = -50;

/** Bake three's RoomEnvironment through PMREM: neutral softbox reflections for PBR materials. */
export function createStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const rt = pmrem.fromScene(room, 0.04);
  room.dispose();
  pmrem.dispose();
  return rt;
}

function radialTexture(stops: [number, string][], size = 512): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [t, col] of stops) grad.addColorStop(t, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export interface Studio {
  readonly group: THREE.Group;
  readonly key: THREE.DirectionalLight;
  /**
   * Lay the studio out around a model.
   * @param center  world-space centre of the model's turntable
   * @param radius  world-space radius enclosing the model at any turntable angle
   * @param floorY  world-space y of the floor (just under the model)
   */
  layout(viewport: { widthCm: number; heightCm: number }, center: THREE.Vector3, radius: number, floorY: number): void;
  dispose(): void;
}

export function createStudio(): Studio {
  const group = new THREE.Group();
  group.name = 'studio';

  // ---------- backdrop: soft radial gradient wall ----------
  const backTex = radialTexture([
    [0, '#2b3446'],
    [0.22, '#1a202c'],
    [0.5, '#0b0e15'],
    [1, '#05060a'],
  ]);
  const backMat = new THREE.MeshBasicMaterial({ map: backTex, toneMapped: false, depthWrite: false });
  const plane = new THREE.PlaneGeometry(1, 1);
  const backdrop = new THREE.Mesh(plane, backMat);
  backdrop.name = 'backdrop';
  backdrop.renderOrder = -1;
  group.add(backdrop);

  // ---------- floor: a pool of light + a shadow catcher ----------
  const poolTex = radialTexture([
    [0, 'rgba(120,140,175,0.55)'],
    [0.35, 'rgba(70,85,115,0.3)'],
    [0.7, 'rgba(40,50,70,0.08)'],
    [1, 'rgba(0,0,0,0)'],
  ]);
  const poolMat = new THREE.MeshBasicMaterial({
    map: poolTex,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const pool = new THREE.Mesh(plane, poolMat);
  pool.name = 'floor-pool';
  pool.rotation.x = -Math.PI / 2;
  group.add(pool);

  const shadowMat = new THREE.ShadowMaterial({ opacity: 0.55, depthWrite: false });
  const catcher = new THREE.Mesh(plane, shadowMat);
  catcher.name = 'shadow-catcher';
  catcher.rotation.x = -Math.PI / 2;
  catcher.receiveShadow = true;
  catcher.renderOrder = 1;
  group.add(catcher);

  // ---------- lights ----------
  // Key: the only shadow caster. Above, front-left of the model.
  const key = new THREE.DirectionalLight(0xfff4e6, 2.2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.radius = 6;
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  group.add(key, key.target);

  // Cool rim from behind-right so silhouettes separate from the dark backdrop. No shadows.
  const rim = new THREE.DirectionalLight(0x9fc4ff, 1.4);
  group.add(rim, rim.target);

  // Gentle fill so the shadow side never goes fully black (env does most of the work).
  const fill = new THREE.HemisphereLight(0xc8d6ff, 0x1a1410, 0.35);
  group.add(fill);

  const KEY_DIR = new THREE.Vector3(-0.55, 1, 0.75).normalize();
  const RIM_DIR = new THREE.Vector3(0.8, 0.55, -1).normalize();

  return {
    group,
    key,

    layout(viewport, center, radius, floorY) {
      const w = viewport.widthCm;
      const h = viewport.heightCm;

      // Big enough to fill the window at z=-50 for any plausible head position.
      backdrop.scale.set(w * 3 + 80, h * 3 + 80, 1);
      backdrop.position.set(0, 0, BACKDROP_Z);

      const poolSize = Math.max(radius * 5, w * 0.6);
      pool.scale.set(poolSize, poolSize * 0.75, 1);
      pool.position.set(center.x, floorY - 0.02, center.z - radius * 0.2);

      catcher.scale.set(Math.max(radius * 8, w * 2), Math.max(radius * 8, 60), 1);
      catcher.position.set(center.x, floorY, center.z);

      // Shadow frustum hugs the model's bounding sphere (+ margin for animation).
      const r = radius * 1.35;
      const dist = r * 4;
      key.position.copy(center).addScaledVector(KEY_DIR, dist);
      key.target.position.copy(center);
      key.target.updateMatrixWorld();
      const cam = key.shadow.camera;
      cam.left = -r;
      cam.right = r;
      cam.top = r;
      cam.bottom = -r;
      cam.near = Math.max(0.1, dist - r * 2.5);
      cam.far = dist + r * 4;
      cam.updateProjectionMatrix();

      rim.position.copy(center).addScaledVector(RIM_DIR, dist);
      rim.target.position.copy(center);
      rim.target.updateMatrixWorld();
    },

    dispose() {
      plane.dispose();
      backMat.dispose();
      backTex.dispose();
      poolMat.dispose();
      poolTex.dispose();
      shadowMat.dispose();
      key.dispose();
      rim.dispose();
      fill.dispose();
    },
  };
}
