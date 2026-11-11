import * as THREE from 'three';
import type { HeadPose, HoloScene, SceneContext } from '../types';
import {
  createAquaUniforms,
  createBubbleMaterial,
  createGlassMaterial,
  createShaftMaterial,
  createSurfaceMaterial,
  patchAquaMaterial,
} from './aquarium/aquaMaterials';
import { createFishGeometry, createKelpGeometry, createRockGeometry, dunes, makeRng } from './aquarium/aquaGeometry';
import { FishSchool, type Species } from './aquarium/fishSchool';

/** Tank depth behind the glass, cm. */
const DEPTH = 40;
const SAND_NX = 56;
const SAND_NZ = 36;
const FRAME_T = 0.22;
const FRAME_DEPTH = 0.7;
const BUBBLES = 160;

const SPECIES: Species[] = [
  { count: 18, length: [2.0, 2.6], speed: [4.5, 6.5], colors: [0x9fb8c8, 0xb0c4d0], pattern: 2, cohesion: 1.4, band: [0.35, 0.8] },
  { count: 7, length: [4.2, 5.2], speed: [3.2, 4.4], colors: [0x1e5cff, 0x2a6cff], pattern: 3, cohesion: 0.6, band: [0.3, 0.75] },
  { count: 6, length: [3.0, 3.6], speed: [2.4, 3.4], colors: [0xff6a14, 0xff7a1e], pattern: 1, cohesion: 0.35, band: [0.08, 0.4] },
  { count: 3, length: [3.4, 4.0], speed: [2.8, 3.6], colors: [0xffd21c], pattern: 0, cohesion: 0.2, band: [0.2, 0.6] },
];

/** Kelp clumps as (fx, fz) fractions: x of half-width, z of depth. Kept to the sides and back. */
const KELP_CLUMPS: [number, number, number][] = [
  [-0.82, 0.78, 6],
  [-0.62, 0.92, 5],
  [0.78, 0.85, 7],
  [0.55, 0.95, 4],
  [-0.15, 0.95, 4],
  [0.9, 0.45, 3],
  [-0.9, 0.4, 3],
];
/** Rocks as (fx, fz, size as fraction of min(w, h)). */
const ROCKS: [number, number, number][] = [
  [-0.7, 0.7, 0.16],
  [-0.48, 0.82, 0.1],
  [0.62, 0.62, 0.13],
  [0.8, 0.78, 0.08],
  [0.1, 0.88, 0.12],
  [0.28, 0.9, 0.07],
  [-0.3, 0.35, 0.05],
  [0.45, 0.22, 0.045],
  [-0.62, 0.18, 0.06],
  [0.02, 0.6, 0.04],
];

export function createAquariumScene(): HoloScene {
  const root = new THREE.Group();
  root.name = 'aquarium';

  const uniforms = createAquaUniforms(DEPTH);
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const geo = <G extends THREE.BufferGeometry>(g: G): G => (geometries.push(g), g);
  const mat = <M extends THREE.Material>(m: M): M => (materials.push(m), m);

  let w = 30;
  let h = 18;
  let hw = 15;
  let hh = 9;

  /** Sand surface height. Exactly a gentle slope toward the back plus dunes, flattened at the glass. */
  const sandY = (x: number, z: number): number => {
    const t = THREE.MathUtils.clamp(-z / DEPTH, 0, 1);
    const lift = Math.min(h * 0.09, 2.2);
    return -hh + lift + t * Math.min(h * 0.18, 4.5) + dunes(x, z) * (0.35 + t * 0.4);
  };

  // ---------- sand (heightfield rebuilt on resize) + front cross-section ----------
  const sandGeo = geo(new THREE.BufferGeometry());
  {
    const vCount = (SAND_NX + 1) * (SAND_NZ + 1);
    sandGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vCount * 3), 3));
    sandGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(vCount * 3), 3));
    sandGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vCount * 3), 3));
    const idx: number[] = [];
    for (let j = 0; j < SAND_NZ; j++) {
      for (let i = 0; i < SAND_NX; i++) {
        const a = j * (SAND_NX + 1) + i;
        const b = a + 1;
        const c = a + SAND_NX + 1;
        const d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    sandGeo.setIndex(idx);
  }
  const sandMat = mat(patchAquaMaterial(new THREE.MeshLambertMaterial({ color: 0xd8bd8e, vertexColors: true }), uniforms));
  const sand = new THREE.Mesh(sandGeo, sandMat);
  sand.receiveShadow = true;
  sand.frustumCulled = false;
  root.add(sand);

  const skirtGeo = geo(new THREE.BufferGeometry());
  skirtGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SAND_NX + 1) * 2 * 3), 3));
  skirtGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array((SAND_NX + 1) * 2 * 3), 3));
  {
    const idx: number[] = [];
    for (let i = 0; i < SAND_NX; i++) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    skirtGeo.setIndex(idx);
  }
  const skirtMat = mat(
    patchAquaMaterial(new THREE.MeshLambertMaterial({ color: 0xe6c48c, vertexColors: true, emissive: 0x3a2a14 }), uniforms, { caustics: false }),
  );
  const skirt = new THREE.Mesh(skirtGeo, skirtMat);
  skirt.frustumCulled = false;
  root.add(skirt);

  // ---------- tank walls + water surface ----------
  const plane = geo(new THREE.PlaneGeometry(1, 1));
  const wallMat = mat(patchAquaMaterial(new THREE.MeshLambertMaterial({ color: 0x2f7f8c }), uniforms));
  const back = new THREE.Mesh(plane, wallMat);
  const leftW = new THREE.Mesh(plane, wallMat);
  leftW.rotation.y = Math.PI / 2;
  const rightW = new THREE.Mesh(plane, wallMat);
  rightW.rotation.y = -Math.PI / 2;
  back.receiveShadow = true;
  root.add(back, leftW, rightW);
  const surfaceMat = mat(createSurfaceMaterial(uniforms));
  const surface = new THREE.Mesh(plane, surfaceMat);
  surface.rotation.x = Math.PI / 2;
  root.add(surface);

  // ---------- rocks ----------
  const rockMat = mat(patchAquaMaterial(new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), uniforms));
  const rocks = new THREE.InstancedMesh(geo(createRockGeometry()), rockMat, ROCKS.length);
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  rocks.frustumCulled = false;
  {
    const rnd = makeRng(5);
    const c = new THREE.Color();
    const tones = [0x6d6a66, 0x7d7268, 0x5b5f63, 0x8a7d6c];
    for (let i = 0; i < ROCKS.length; i++) rocks.setColorAt(i, c.set(tones[Math.floor(rnd() * tones.length)]));
  }
  root.add(rocks);

  // ---------- kelp ----------
  const kelpCount = KELP_CLUMPS.reduce((n, k) => n + k[2], 0);
  const kelpMat = mat(
    patchAquaMaterial(new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide }), uniforms, {
      sway: true,
    }),
  );
  const kelp = new THREE.InstancedMesh(geo(createKelpGeometry()), kelpMat, kelpCount);
  kelp.frustumCulled = false;
  {
    const rnd = makeRng(9);
    const c = new THREE.Color();
    const greens = [0x3f8a2a, 0x5a9a2a, 0x6e7f22, 0x2f7a3a, 0x86a830];
    for (let i = 0; i < kelpCount; i++) kelp.setColorAt(i, c.set(greens[Math.floor(rnd() * greens.length)]));
  }
  root.add(kelp);

  // ---------- fish ----------
  const fishMat = mat(
    patchAquaMaterial(
      new THREE.MeshPhongMaterial({
        color: 0xffffff,
        vertexColors: true,
        flatShading: true,
        side: THREE.DoubleSide,
        shininess: 70,
        specular: 0x3a5560,
      }),
      uniforms,
      { fish: true },
    ),
  );
  const school = new FishSchool(geo(createFishGeometry()), fishMat, SPECIES);
  root.add(school.mesh);

  // ---------- bubbles ----------
  const bubbleMat = mat(createBubbleMaterial(uniforms));
  const bubbleGeo = geo(new THREE.BufferGeometry());
  {
    const rnd = makeRng(21);
    const aB = new Float32Array(BUBBLES * 4);
    const aS = new Float32Array(BUBBLES);
    // Two air stones (streams) plus stray bubbles, some right behind the glass.
    const stones: [number, number][] = [
      [-0.55, 0.85],
      [0.66, 0.7],
    ];
    for (let i = 0; i < BUBBLES; i++) {
      let fx: number;
      let fz: number;
      let speed: number;
      let size: number;
      if (i < 90) {
        const s = stones[i % 2];
        fx = s[0] + (rnd() - 0.5) * 0.03;
        fz = s[1] + (rnd() - 0.5) * 0.02;
        speed = 6 + rnd() * 4;
        size = 0.06 + rnd() * 0.1;
      } else if (i < 120) {
        fx = (rnd() * 2 - 1) * 0.85;
        fz = 0.04 + rnd() * 0.08;
        speed = 2.5 + rnd() * 2.5;
        size = 0.05 + rnd() * 0.09;
      } else {
        fx = (rnd() * 2 - 1) * 0.9;
        fz = 0.1 + rnd() * 0.85;
        speed = 2 + rnd() * 3;
        size = 0.04 + rnd() * 0.08;
      }
      aB.set([fx, fz, speed, rnd()], i * 4);
      aS[i] = size;
    }
    bubbleGeo.setAttribute('aBubble', new THREE.BufferAttribute(aB, 4));
    bubbleGeo.setAttribute('aSize', new THREE.BufferAttribute(aS, 1));
    bubbleGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BUBBLES * 3), 3));
  }
  const bubbles = new THREE.Points(bubbleGeo, bubbleMat);
  bubbles.frustumCulled = false;
  bubbles.renderOrder = 2;
  root.add(bubbles);

  // ---------- light shafts ----------
  const SHAFTS = 5;
  const shaftMat = mat(createShaftMaterial(uniforms));
  const shaftGeo = geo(new THREE.PlaneGeometry(1, 1));
  shaftGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array([0.1, 0.35, 0.6, 0.8, 0.95]), 1));
  const shafts = new THREE.InstancedMesh(shaftGeo, shaftMat, SHAFTS);
  shafts.frustumCulled = false;
  shafts.renderOrder = 1;
  root.add(shafts);

  // ---------- glass frame + sheen ----------
  const frameMat = mat(new THREE.MeshStandardMaterial({ color: 0x0a0d10, roughness: 0.5, metalness: 0.2 }));
  const frameGeo = geo(new THREE.BoxGeometry(1, 1, 1));
  const frameBars = [0, 1, 2, 3].map(() => {
    const m = new THREE.Mesh(frameGeo, frameMat);
    root.add(m);
    return m;
  });
  const glassMat = mat(createGlassMaterial());
  const glass = new THREE.Mesh(geo(new THREE.PlaneGeometry(2, 2)), glassMat);
  glass.position.z = -0.02;
  glass.renderOrder = 10;
  glass.frustumCulled = false;
  root.add(glass);

  // ---------- lights ----------
  const hemi = new THREE.HemisphereLight(0x9fe8f0, 0x1a3a40, 0.95);
  root.add(hemi);
  const sun = new THREE.DirectionalLight(0xe8fbff, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 4;
  root.add(sun, sun.target);

  // ---------- layout ----------
  const drawSize = new THREE.Vector2();
  let laidOut = false;

  function layout(ctx: SceneContext): void {
    w = ctx.viewport.widthCm;
    h = ctx.viewport.heightCm;
    hw = w / 2;
    hh = h / 2;
    const m = Math.min(w, h);
    const e = 0.02;
    uniforms.uHalf.value.set(hw, hh);

    // Sand heightfield.
    const pos = sandGeo.getAttribute('position') as THREE.BufferAttribute;
    const col = sandGeo.getAttribute('color') as THREE.BufferAttribute;
    for (let j = 0; j <= SAND_NZ; j++) {
      const z = -(j / SAND_NZ) * DEPTH;
      for (let i = 0; i <= SAND_NX; i++) {
        const x = -hw + (i / SAND_NX) * w;
        const k = j * (SAND_NX + 1) + i;
        pos.setXYZ(k, x, sandY(x, z), z);
        const v = 0.86 + 0.14 * Math.sin(x * 1.7 + z * 2.3) * Math.sin(x * 0.9 - z * 1.3) + 0.06 * dunes(x * 3, z * 3);
        col.setXYZ(k, v, v * 0.98, v * 0.94);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    sandGeo.computeVertexNormals();
    sandGeo.computeBoundingSphere();

    const sp = skirtGeo.getAttribute('position') as THREE.BufferAttribute;
    const sc = skirtGeo.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i <= SAND_NX; i++) {
      const x = -hw + (i / SAND_NX) * w;
      sp.setXYZ(i * 2, x, -hh - 0.05, -0.03);
      sp.setXYZ(i * 2 + 1, x, sandY(x, 0), -0.03);
      sc.setXYZ(i * 2, 0.45, 0.42, 0.38);
      sc.setXYZ(i * 2 + 1, 0.95, 0.9, 0.82);
    }
    sp.needsUpdate = true;
    sc.needsUpdate = true;
    skirtGeo.computeVertexNormals();

    back.position.set(0, 0, -DEPTH);
    back.scale.set(w + e, h + e, 1);
    leftW.position.set(-hw, 0, -DEPTH / 2);
    leftW.scale.set(DEPTH + e, h + e, 1);
    rightW.position.set(hw, 0, -DEPTH / 2);
    rightW.scale.set(DEPTH + e, h + e, 1);
    surface.position.set(0, hh, -DEPTH / 2);
    surface.scale.set(w + e, DEPTH + e, 1);

    // Rocks sit half-buried in the sand.
    const rm = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const rnd = makeRng(31);
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    for (let i = 0; i < ROCKS.length; i++) {
      const [fx, fz, size] = ROCKS[i];
      const r = size * m;
      const x = fx * hw;
      const z = -fz * DEPTH;
      q.setFromEuler(new THREE.Euler(rnd() * 0.4, rnd() * Math.PI * 2, rnd() * 0.3));
      v.set(x, sandY(x, z) + r * 0.15, z);
      s.set(r, r * (0.8 + rnd() * 0.5), r);
      rocks.setMatrixAt(i, rm.compose(v, q, s));
    }
    rocks.instanceMatrix.needsUpdate = true;

    // Kelp clumps.
    let k = 0;
    const krnd = makeRng(41);
    for (const [fx, fz, n] of KELP_CLUMPS) {
      for (let i = 0; i < n; i++, k++) {
        const x = THREE.MathUtils.clamp(fx * hw + (krnd() - 0.5) * 3, -hw + 0.6, hw - 0.6);
        const z = THREE.MathUtils.clamp(-fz * DEPTH + (krnd() - 0.5) * 4, -DEPTH + 0.6, -3);
        const height = h * (0.45 + krnd() * 0.5) * (fz < 0.6 ? 0.6 : 1);
        q.setFromEuler(new THREE.Euler((krnd() - 0.5) * 0.15, krnd() * Math.PI * 2, (krnd() - 0.5) * 0.15));
        v.set(x, sandY(x, z) - 0.3, z);
        s.set(height, height, height);
        kelp.setMatrixAt(k, rm.compose(v, q, s));
      }
    }
    kelp.instanceMatrix.needsUpdate = true;

    // Light shafts: slanted planes hanging from the surface.
    const srnd = makeRng(51);
    for (let i = 0; i < SHAFTS; i++) {
      const x = (-0.75 + 1.5 * (i / (SHAFTS - 1)) + (srnd() - 0.5) * 0.2) * hw;
      const z = -DEPTH * (0.35 + srnd() * 0.5);
      const len = h * 1.25;
      q.setFromEuler(new THREE.Euler(0, (srnd() - 0.5) * 0.4, 0.28));
      v.set(x + Math.sin(0.28) * len * 0.5, hh - len * 0.5 * Math.cos(0.28), z);
      s.set(m * (0.12 + srnd() * 0.1), len, 1);
      shafts.setMatrixAt(i, rm.compose(v, q, s));
    }
    shafts.instanceMatrix.needsUpdate = true;

    // Frame: thin dark trim around the glass.
    const t = FRAME_T;
    const zc = -FRAME_DEPTH / 2;
    frameBars[0].position.set(0, hh - t / 2, zc);
    frameBars[0].scale.set(w, t, FRAME_DEPTH);
    frameBars[1].position.set(0, -hh + t / 2, zc);
    frameBars[1].scale.set(w, t, FRAME_DEPTH);
    frameBars[2].position.set(-hw + t / 2, 0, zc);
    frameBars[2].scale.set(t, h, FRAME_DEPTH);
    frameBars[3].position.set(hw - t / 2, 0, zc);
    frameBars[3].scale.set(t, h, FRAME_DEPTH);
    glass.scale.set(hw, hh, 1);
    glassMat.uniforms.uHalf.value.set(hw, hh);
    glassMat.uniforms.uWidth.value = m * 0.1;

    (bubbleMat.uniforms.uFloorY as THREE.IUniform<number>).value = -hh + 1;

    // Sun: high above, slightly in front, covering the whole tank with its shadow camera.
    sun.position.set(-w * 0.15, hh + 40, 12);
    sun.target.position.set(0, -hh, -DEPTH / 2);
    sun.target.updateMatrixWorld();
    const ext = Math.max(w, DEPTH) * 0.62 + 4;
    const cam = sun.shadow.camera;
    cam.left = -ext;
    cam.right = ext;
    cam.top = ext;
    cam.bottom = -ext;
    cam.near = 5;
    cam.far = h + 120;
    cam.updateProjectionMatrix();

    const fishScale = THREE.MathUtils.clamp(m / 19, 0.75, 1.6);
    school.setBounds({ hw, hh, depth: DEPTH, floorY: sandY }, fishScale, !laidOut);
    laidOut = true;
  }

  return {
    name: 'aquarium',
    root,

    init(ctx: SceneContext) {
      layout(ctx);
    },

    resize(ctx: SceneContext) {
      if (ctx.viewport.widthCm === w && ctx.viewport.heightCm === h && laidOut) return;
      layout(ctx);
    },

    update(dt: number, pose: HeadPose, ctx: SceneContext) {
      uniforms.uTime.value += dt;
      ctx.renderer.getDrawingBufferSize(drawSize);
      (bubbleMat.uniforms.uPxPerCm as THREE.IUniform<number>).value = drawSize.y / Math.max(h, 1e-3);
      school.update(dt, pose);
    },

    dispose() {
      root.removeFromParent();
      root.clear();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      rocks.dispose();
      kelp.dispose();
      school.mesh.dispose();
      shafts.dispose();
      sun.dispose();
      hemi.dispose();
    },
  };
}
