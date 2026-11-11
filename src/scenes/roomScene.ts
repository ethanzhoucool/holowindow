import * as THREE from 'three';
import type { HeadPose, HoloScene, SceneContext } from '../types';
import {
  PALETTE,
  createNeonEnvironment,
  createRoomUniforms,
  createSunMaterial,
  createTargetTexture,
  patchRoomMaterial,
} from './room/roomMaterials';

/** How far the box extends behind the screen, in cm. */
const DEPTH = 56;
/** Preferred grid cell size in cm (snapped so lines land exactly on the box edges). */
const CELL = 4.5;

/**
 * Layout is expressed in viewport-relative units so the room keeps its composition
 * at any window size: fx/fy are fractions of width/height from the centre,
 * sizes are fractions of min(width, height). z is absolute cm.
 */
interface Placed {
  obj: THREE.Object3D;
  fx: number;
  fy: number;
  z: number;
  size: number;
  /** Rest on the floor instead of using fy. */
  floor?: boolean;
  bobAmp?: number;
  bobSpeed?: number;
  phase?: number;
  spin?: THREE.Vector3;
  /** Computed in layout(): resting y. */
  baseY?: number;
}

interface Stalked {
  target: THREE.Group;
  stalk: THREE.Mesh;
  foot: THREE.Mesh;
  fx: number;
  fy: number;
  z: number;
  size: number;
}

export function createRoomScene(): HoloScene {
  const root = new THREE.Group();
  root.name = 'room';

  const uniforms = createRoomUniforms(DEPTH);
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];
  let envRT: THREE.WebGLRenderTarget | null = null;

  const geo = <G extends THREE.BufferGeometry>(g: G): G => (geometries.push(g), g);
  const mat = <M extends THREE.Material>(m: M): M => (materials.push(m), m);

  // ---------- walls ----------
  const wallMat = mat(
    patchRoomMaterial(
      new THREE.MeshStandardMaterial({ color: PALETTE.wall, roughness: 0.92, metalness: 0 }),
      uniforms,
      { grid: true },
    ),
  );
  const plane = geo(new THREE.PlaneGeometry(1, 1));
  const makeWall = (name: string): THREE.Mesh => {
    const m = new THREE.Mesh(plane, wallMat);
    m.name = name;
    m.receiveShadow = true;
    root.add(m);
    return m;
  };
  const floor = makeWall('floor');
  floor.rotation.x = -Math.PI / 2;
  const ceiling = makeWall('ceiling');
  ceiling.rotation.x = Math.PI / 2;
  const left = makeWall('left');
  left.rotation.y = Math.PI / 2;
  const right = makeWall('right');
  right.rotation.y = -Math.PI / 2;
  const back = makeWall('back');

  const sunMat = mat(createSunMaterial());
  const sun = new THREE.Mesh(plane, sunMat);
  sun.renderOrder = 1;
  root.add(sun);

  // ---------- shared prop resources ----------
  const targetTex = createTargetTexture();
  textures.push(targetTex);
  const faceMat = mat(
    patchRoomMaterial(new THREE.MeshStandardMaterial({ map: targetTex, color: 0xb8b8b8, roughness: 0.55 }), uniforms),
  );
  const edgeMat = mat(
    patchRoomMaterial(new THREE.MeshStandardMaterial({ color: PALETTE.ink, roughness: 0.4, metalness: 0.6 }), uniforms),
  );
  const stalkMat = mat(
    patchRoomMaterial(new THREE.MeshStandardMaterial({ color: 0xc9d3e6, roughness: 0.3, metalness: 0.85 }), uniforms),
  );
  const targetGeo = geo(new THREE.CylinderGeometry(1, 1, 0.12, 40, 1));
  targetGeo.rotateX(Math.PI / 2); // caps face ±z
  const stalkGeo = geo(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true));
  stalkGeo.translate(0, 0.5, 0);
  const footGeo = geo(new THREE.CylinderGeometry(1, 1.25, 0.25, 20));
  footGeo.translate(0, 0.125, 0);
  const sphereGeo = geo(new THREE.SphereGeometry(1, 40, 20));

  const glossy = (color: number, extra: THREE.MeshPhysicalMaterialParameters = {}) =>
    mat(
      patchRoomMaterial(
        new THREE.MeshPhysicalMaterial({
          color,
          roughness: 0.18,
          metalness: 0.1,
          clearcoat: 1,
          clearcoatRoughness: 0.05,
          envMapIntensity: 1.2,
          ...extra,
        }),
        uniforms,
      ),
    );
  const physMats: THREE.MeshPhysicalMaterial[] = [];
  const glossyTracked = (color: number, extra?: THREE.MeshPhysicalMaterialParameters) => {
    const m = glossy(color, extra);
    physMats.push(m);
    return m;
  };

  const placed: Placed[] = [];
  const stalked: Stalked[] = [];

  const shadowy = <O extends THREE.Object3D>(o: O): O => {
    o.traverse((c) => {
      if ((c as THREE.Mesh).isMesh) {
        c.castShadow = true;
        c.receiveShadow = true;
      }
    });
    return o;
  };

  // Johnny Lee targets on stalks, at three depths.
  const addTarget = (fx: number, fy: number, z: number, size: number) => {
    const target = new THREE.Group();
    target.add(new THREE.Mesh(targetGeo, [edgeMat, faceMat, edgeMat]));
    const stalk = new THREE.Mesh(stalkGeo, stalkMat);
    const foot = new THREE.Mesh(footGeo, edgeMat);
    root.add(shadowy(target), shadowy(stalk), shadowy(foot));
    stalked.push({ target, stalk, foot, fx, fy, z, size });
  };
  addTarget(-0.3, 0.06, -14, 0.085);
  addTarget(0.24, 0.2, -29, 0.085);
  addTarget(0.06, -0.12, -45, 0.085);

  // Glossy spheres inside the box.
  const bigBall = shadowy(new THREE.Mesh(sphereGeo, glossyTracked(PALETTE.ink, { metalness: 0.6, roughness: 0.12 })));
  root.add(bigBall);
  placed.push({ obj: bigBall, fx: 0.31, fy: 0, z: -40, size: 0.13, floor: true });

  const floatBall = shadowy(new THREE.Mesh(sphereGeo, glossyTracked(PALETTE.magenta, { roughness: 0.22 })));
  root.add(floatBall);
  placed.push({ obj: floatBall, fx: -0.24, fy: 0.24, z: -33, size: 0.06, bobAmp: 0.9, bobSpeed: 0.7, phase: 1.3 });

  // Neon ring mid-depth.
  const ringGeo = geo(new THREE.TorusGeometry(1, 0.09, 10, 56));
  const ringMat = mat(
    patchRoomMaterial(
      new THREE.MeshStandardMaterial({
        color: 0x0c1a2a,
        emissive: PALETTE.grid,
        emissiveIntensity: 2.4,
        roughness: 0.4,
      }),
      uniforms,
    ),
  );
  const ring = shadowy(new THREE.Mesh(ringGeo, ringMat));
  root.add(ring);
  placed.push({
    obj: ring, fx: -0.06, fy: 0.02, z: -22, size: 0.1,
    bobAmp: 0.5, bobSpeed: 0.5, phase: 0.2, spin: new THREE.Vector3(0.0, 0.35, 0.0),
  });

  // ---------- pop-out objects (z > 0), kept small and near the middle ----------
  const crystal = new THREE.Group();
  const crystalGeo = geo(
    new THREE.LatheGeometry(
      [new THREE.Vector2(0, -1.5), new THREE.Vector2(0.62, -0.25), new THREE.Vector2(0.62, 0.25), new THREE.Vector2(0, 1.5)],
      6,
    ),
  );
  crystalGeo.computeVertexNormals();
  const crystalMat = glossyTracked(0x1fa6d6, {
    flatShading: true,
    roughness: 0.08,
    metalness: 0.2,
    emissive: new THREE.Color(PALETTE.grid),
    emissiveIntensity: 0.3,
    envMapIntensity: 1.8,
  });
  crystal.add(shadowy(new THREE.Mesh(crystalGeo, crystalMat)));
  const crystalEdges = geo(new THREE.EdgesGeometry(crystalGeo, 1));
  const edgeLineMat = mat(
    new THREE.LineBasicMaterial({ color: new THREE.Color(PALETTE.grid).multiplyScalar(1.6), transparent: true, opacity: 0.85 }),
  );
  crystal.add(new THREE.LineSegments(crystalEdges, edgeLineMat));
  crystal.rotation.z = 0.12;
  root.add(crystal);
  placed.push({
    obj: crystal, fx: 0.11, fy: 0.07, z: 8, size: 0.075,
    bobAmp: 0.35, bobSpeed: 0.9, phase: 0, spin: new THREE.Vector3(0, 0.6, 0),
  });

  const popBall = shadowy(new THREE.Mesh(sphereGeo, glossyTracked(PALETTE.accent, { roughness: 0.2 })));
  root.add(popBall);
  placed.push({ obj: popBall, fx: -0.13, fy: -0.13, z: 5, size: 0.05, bobAmp: 0.3, bobSpeed: 1.1, phase: 2.1 });

  const haloGeo = geo(new THREE.TorusGeometry(1, 0.14, 8, 40));
  const haloMat = mat(
    patchRoomMaterial(
      new THREE.MeshStandardMaterial({
        color: 0x2a1408,
        emissive: new THREE.Color(PALETTE.accentHot),
        emissiveIntensity: 1.8,
        roughness: 0.35,
      }),
      uniforms,
    ),
  );
  const halo = shadowy(new THREE.Mesh(haloGeo, haloMat));
  root.add(halo);
  placed.push({
    obj: halo, fx: -0.03, fy: 0.16, z: 11, size: 0.035,
    bobAmp: 0.2, bobSpeed: 0.8, phase: 4, spin: new THREE.Vector3(0.45, 0.7, 0),
  });

  // ---------- lights ----------
  const hemi = new THREE.HemisphereLight(0x3a4f8f, 0x080a14, 0.55);
  root.add(hemi);

  const key = new THREE.SpotLight(0xfff1e0, 380, 0, 0.6, 0.65, 1);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  key.shadow.radius = 5;
  key.shadow.camera.near = 8;
  key.shadow.camera.far = 160;
  root.add(key, key.target);

  const rim = new THREE.PointLight(PALETTE.grid, 260, 0, 2);
  root.add(rim);
  const warm = new THREE.PointLight(PALETTE.accent, 320, 0, 2);
  root.add(warm);

  // ---------- layout ----------
  let w = 30;
  let h = 18;

  function layout(ctx: SceneContext): void {
    w = ctx.viewport.widthCm;
    h = ctx.viewport.heightCm;
    const hw = w / 2;
    const hh = h / 2;
    const m = Math.min(w, h);
    const e = 0.01; // tiny overlap so corners never show seams

    floor.position.set(0, -hh, -DEPTH / 2);
    floor.scale.set(w + e, DEPTH, 1);
    ceiling.position.set(0, hh, -DEPTH / 2);
    ceiling.scale.set(w + e, DEPTH, 1);
    left.position.set(-hw, 0, -DEPTH / 2);
    left.scale.set(DEPTH, h + e, 1);
    right.position.set(hw, 0, -DEPTH / 2);
    right.scale.set(DEPTH, h + e, 1);
    back.position.set(0, 0, -DEPTH);
    back.scale.set(w + e, h + e, 1);

    const sunR = Math.min(h * 0.3, w * 0.22);
    sun.position.set(0, h * 0.04, -DEPTH + 0.05);
    sun.scale.set(sunR * 4, sunR * 4, 1);

    // Snap cells so grid lines land exactly on every box edge.
    const nx = Math.max(2, Math.round(w / CELL));
    const ny = Math.max(2, Math.round(h / CELL));
    const nz = Math.max(2, Math.round(DEPTH / CELL));
    uniforms.uCell.value.set(w / nx, h / ny, DEPTH / nz);
    uniforms.uOrigin.value.set(-hw, -hh, 0);

    for (const s of stalked) {
      const r = s.size * m;
      const x = s.fx * w;
      const y = s.fy * h;
      s.target.position.set(x, y, s.z);
      s.target.scale.setScalar(r);
      const len = Math.max(0.01, y - r * 0.6 + hh);
      s.stalk.position.set(x, -hh, s.z - r * 0.08);
      s.stalk.scale.set(0.11, len, 0.11);
      s.foot.position.set(x, -hh, s.z - r * 0.08);
      s.foot.scale.set(0.5, 1, 0.5);
    }

    for (const p of placed) {
      const r = p.size * m;
      p.obj.scale.setScalar(r);
      p.baseY = p.floor ? -hh + r : p.fy * h;
      p.obj.position.set(p.fx * w, p.baseY, p.z);
    }

    // Key light: above and in front of the screen, upper-left, aimed into the box.
    key.position.set(-w * 0.22, hh + 6, 34);
    key.target.position.set(w * 0.04, -hh * 0.35, -DEPTH * 0.55);
    key.target.updateMatrixWorld();
    // Widen the cone just enough to cover the whole box.
    const dir = key.target.position.clone().sub(key.position).normalize();
    let maxAng = 0;
    const c = new THREE.Vector3();
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const z of [0, -DEPTH]) {
      c.set(sx * hw, sy * hh, z).sub(key.position).normalize();
      maxAng = Math.max(maxAng, Math.acos(THREE.MathUtils.clamp(c.dot(dir), -1, 1)));
    }
    key.angle = Math.min(maxAng * 1.08, Math.PI / 2 - 0.05);

    rim.position.set(hw * 0.75, hh * 0.7, -DEPTH + 6);
    warm.position.set(0, -hh * 0.35, -DEPTH + 7);
  }

  let time = 0;

  return {
    name: 'room',
    root,

    init(ctx: SceneContext) {
      envRT = createNeonEnvironment(ctx.renderer);
      for (const m of physMats) {
        m.envMap = envRT.texture;
        m.needsUpdate = true;
      }
      layout(ctx);
    },

    resize(ctx: SceneContext) {
      if (ctx.viewport.widthCm === w && ctx.viewport.heightCm === h) return;
      layout(ctx);
    },

    update(dt: number, _pose: HeadPose) {
      time += dt;
      for (const p of placed) {
        if (p.bobAmp) {
          p.obj.position.y = (p.baseY ?? 0) + Math.sin(time * (p.bobSpeed ?? 1) + (p.phase ?? 0)) * p.bobAmp;
        }
        if (p.spin) {
          p.obj.rotation.x += p.spin.x * dt;
          p.obj.rotation.y += p.spin.y * dt;
          p.obj.rotation.z += p.spin.z * dt;
        }
      }
      // Gentle sway on the targets so the scene never looks frozen.
      for (let i = 0; i < stalked.length; i++) {
        stalked[i].target.rotation.y = Math.sin(time * 0.4 + i * 2.1) * 0.12;
      }
      sunMat.uniforms.uTime.value = time;
    },

    dispose() {
      root.removeFromParent();
      root.clear();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
      envRT?.dispose();
      envRT = null;
      key.dispose();
      rim.dispose();
      warm.dispose();
      hemi.dispose();
    },
  };
}
