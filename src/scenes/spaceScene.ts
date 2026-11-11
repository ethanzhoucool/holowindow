import * as THREE from 'three';
import type { HeadPose, HoloScene, SceneContext } from '../types';
import {
  createNebulaTexture,
  createPanelTexture,
  createPlanetMaterial,
  createRingMaterial,
  createSpaceEnvironment,
  createStarMaterial,
  createVignetteMaterial,
  makeRng,
} from './space/spaceMaterials';
import { createAsteroidGeometry, createMoonGeometry, createSatellite } from './space/spaceProps';

/** Nominal viewing distance used to lay things out in "screen fractions". */
const REF_Z = 60;
const STAR_COUNT = 7000;
const STAR_NEAR = 28;
const STAR_FAR = 1880;
/** Extra cm around the viewport the star field covers, so head motion never reveals its edge. */
const STAR_MARGIN = 14;
/** Forward drift of the star field, cm/s. */
const DRIFT_SPEED = 3.2;
const FRAME_T = 0.16;
const FRAME_DEPTH = 0.8;
/** Direction toward the (unseen) sun: upper left, in front of the screen. */
const SUN_DIR = new THREE.Vector3(-0.72, 0.38, 0.58).normalize();

/** Scale that keeps an object at depth z the same apparent size/offset from the nominal eye. */
const depthScale = (z: number) => (REF_Z - z) / REF_Z;

export function createSpaceScene(): HoloScene {
  const root = new THREE.Group();
  root.name = 'space';

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];
  let envRT: THREE.WebGLRenderTarget | null = null;
  const geo = <G extends THREE.BufferGeometry>(g: G): G => (geometries.push(g), g);
  const mat = <M extends THREE.Material>(m: M): M => (materials.push(m), m);
  const tex = <T extends THREE.Texture>(t: T): T => (textures.push(t), t);

  // ---------- stars ----------
  const starMat = mat(createStarMaterial(STAR_NEAR, STAR_FAR, REF_Z));
  const starGeo = geo(new THREE.BufferGeometry());
  {
    const rnd = makeRng(1234);
    const aStar = new Float32Array(STAR_COUNT * 3);
    const aParams = new Float32Array(STAR_COUNT * 4);
    const aColor = new Float32Array(STAR_COUNT * 3);
    const tints = [
      [0.75, 0.85, 1.0],
      [1.0, 1.0, 1.0],
      [1.0, 0.95, 0.85],
      [1.0, 0.82, 0.62],
      [0.7, 0.78, 1.0],
    ];
    for (let i = 0; i < STAR_COUNT; i++) {
      aStar[i * 3] = (rnd() * 2 - 1) * 1.35;
      aStar[i * 3 + 1] = (rnd() * 2 - 1) * 1.35;
      aStar[i * 3 + 2] = STAR_NEAR + rnd() * (STAR_FAR - STAR_NEAR);
      const big = rnd() < 0.05;
      aParams[i * 4] = big ? 0.12 + rnd() * 0.14 : 0.03 + rnd() * 0.06;
      aParams[i * 4 + 1] = rnd() * Math.PI * 2;
      aParams[i * 4 + 2] = 0.6 + rnd() * 2.6;
      aParams[i * 4 + 3] = 0.6 + Math.pow(rnd(), 3) * 2.4;
      const t = tints[Math.floor(rnd() * tints.length)];
      const b = 0.6 + Math.pow(rnd(), 2) * 1.6;
      aColor[i * 3] = t[0] * b;
      aColor[i * 3 + 1] = t[1] * b;
      aColor[i * 3 + 2] = t[2] * b;
    }
    starGeo.setAttribute('aStar', new THREE.BufferAttribute(aStar, 3));
    starGeo.setAttribute('aParams', new THREE.BufferAttribute(aParams, 4));
    starGeo.setAttribute('aColor', new THREE.BufferAttribute(aColor, 3));
    // Positions are generated in the shader; this attribute only sets the draw count.
    starGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(STAR_COUNT * 3), 3));
  }
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  stars.renderOrder = -1;
  root.add(stars);

  // ---------- nebula backdrop: two baked additive layers at different depths ----------
  const nebulaGeo = geo(new THREE.PlaneGeometry(1, 1));
  const makeNebula = (seed: number, pal: Parameters<typeof createNebulaTexture>[1], angle: number, intensity: number, res: number) => {
    const t = tex(createNebulaTexture(seed, pal, res, angle));
    const m = mat(
      new THREE.MeshBasicMaterial({
        map: t,
        color: new THREE.Color(intensity, intensity, intensity),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    const mesh = new THREE.Mesh(nebulaGeo, m);
    mesh.renderOrder = -2;
    mesh.frustumCulled = false;
    root.add(mesh);
    return mesh;
  };
  const nebulaFar = makeNebula(
    5,
    { a: [0.25, 0.18, 0.75], b: [0.85, 0.22, 0.6], c: [0.95, 0.65, 0.85] },
    0.42,
    1.25,
    512,
  );
  const nebulaNear = makeNebula(
    19,
    { a: [0.05, 0.35, 0.6], b: [0.2, 0.55, 0.75], c: [0.7, 0.9, 1.0] },
    -0.35,
    0.7,
    384,
  );

  // ---------- lights ----------
  const sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
  sun.position.copy(SUN_DIR).multiplyScalar(100);
  root.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0x5a60b0, 0x1a0e28, 0.8);
  root.add(hemi);

  // ---------- ringed planet ----------
  const planet = new THREE.Group();
  planet.name = 'planet';
  planet.rotation.set(0.32, 0, -0.38, 'XYZ');
  const planetMat = mat(createPlanetMaterial());
  const globe = new THREE.Mesh(geo(new THREE.SphereGeometry(1, 72, 36)), planetMat);
  const ringMat = mat(createRingMaterial());
  const ringGeo = geo(new THREE.RingGeometry(1.32, 2.35, 160, 1));
  ringGeo.rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.renderOrder = -3;
  planet.add(globe, ring);
  root.add(planet);
  const planetLayout = { fx: 0.2, fy: 0.1, z: -440, size: 0.15 };
  {
    const inv = new THREE.Quaternion().setFromEuler(planet.rotation).invert();
    const l = SUN_DIR.clone().applyQuaternion(inv);
    planetMat.uniforms.uLightLocal.value.copy(l);
    ringMat.uniforms.uLightLocal.value.copy(l);
  }

  // ---------- moon ----------
  const moonMat = mat(new THREE.MeshStandardMaterial({ color: 0xc4beb6, roughness: 0.95, metalness: 0, vertexColors: true }));
  const moon = new THREE.Mesh(geo(createMoonGeometry()), moonMat);
  moon.name = 'moon';
  root.add(moon);
  const moonLayout = { fx: -0.27, fy: -0.16, z: -230, size: 0.05 };

  // ---------- pop-out objects ----------
  const panelTex = tex(createPanelTexture());
  const satellite = createSatellite(panelTex, null);
  geometries.push(...satellite.geometries);
  materials.push(...satellite.materials);
  root.add(satellite.group);
  const satLayout = { fx: -0.13, fy: 0.11, z: 7, size: 0.05 };

  const asteroidMat = mat(new THREE.MeshStandardMaterial({ color: 0x6d625a, roughness: 0.9, flatShading: true }));
  const asteroid = new THREE.Mesh(geo(createAsteroidGeometry()), asteroidMat);
  asteroid.name = 'asteroid';
  root.add(asteroid);
  const pebbleGeo = geo(createAsteroidGeometry(9));
  const pebbles: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const p = new THREE.Mesh(pebbleGeo, asteroidMat);
    pebbles.push(p);
    root.add(p);
  }

  // ---------- window frame at z = 0 ----------
  const frameMat = mat(new THREE.MeshStandardMaterial({ color: 0x141a28, metalness: 0.85, roughness: 0.38, envMapIntensity: 0.9 }));
  const frameGeo = geo(new THREE.BoxGeometry(1, 1, 1));
  const frameBars = [0, 1, 2, 3].map(() => {
    const m = new THREE.Mesh(frameGeo, frameMat);
    root.add(m);
    return m;
  });
  const lipMat = mat(new THREE.MeshBasicMaterial({ color: new THREE.Color(0x6fa8ff).multiplyScalar(0.22) }));
  const lipBars = [0, 1, 2, 3].map(() => {
    const m = new THREE.Mesh(frameGeo, lipMat);
    root.add(m);
    return m;
  });
  const vignetteMat = mat(createVignetteMaterial());
  const vignette = new THREE.Mesh(geo(new THREE.PlaneGeometry(2, 2)), vignetteMat);
  vignette.position.z = -0.05;
  vignette.renderOrder = 10;
  vignette.frustumCulled = false;
  root.add(vignette);

  // ---------- layout ----------
  let w = 30;
  let h = 18;
  const drawSize = new THREE.Vector2();

  /** World position for a screen-fraction placement at depth z. */
  const place = (fx: number, fy: number, z: number, out: THREE.Vector3) => {
    const s = depthScale(z);
    return out.set(fx * w * s, fy * h * s, z);
  };

  function layout(ctx: SceneContext): void {
    w = ctx.viewport.widthCm;
    h = ctx.viewport.heightCm;
    const hw = w / 2;
    const hh = h / 2;
    const m = Math.min(w, h);

    starMat.uniforms.uSpan.value.set(hw + STAR_MARGIN, hh + STAR_MARGIN);

    const nf = -1820;
    nebulaFar.position.set(0, 0, nf);
    const sf = depthScale(nf);
    const big = Math.max(w, h) + 2 * STAR_MARGIN;
    nebulaFar.scale.set(big * sf * 1.5, big * sf * 1.5, 1);
    const nn = -1350;
    nebulaNear.position.set(-hw * 0.2 * depthScale(nn), -hh * 0.1 * depthScale(nn), nn);
    const sn = depthScale(nn);
    nebulaNear.scale.set(big * sn * 1.3, big * sn * 1.3, 1);

    place(planetLayout.fx, planetLayout.fy, planetLayout.z, planet.position);
    planet.scale.setScalar(planetLayout.size * m * depthScale(planetLayout.z));

    place(moonLayout.fx, moonLayout.fy, moonLayout.z, moon.position);
    moon.scale.setScalar(moonLayout.size * m * depthScale(moonLayout.z));

    place(satLayout.fx, satLayout.fy, satLayout.z, satellite.group.position);
    satellite.group.scale.setScalar(satLayout.size * m);
    asteroid.scale.setScalar(0.045 * m);
    for (let i = 0; i < pebbles.length; i++) pebbles[i].scale.setScalar(0.012 * m * (1 - i * 0.2));

    // Frame bars: top, bottom, left, right — thin, extending FRAME_DEPTH into the window.
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
    // A hairline of cool light at the inner back edge of the frame.
    const lt = 0.03;
    const lz = -FRAME_DEPTH + 0.02;
    lipBars[0].position.set(0, hh - t - lt / 2, lz);
    lipBars[0].scale.set(w - 2 * t, lt, 0.04);
    lipBars[1].position.set(0, -hh + t + lt / 2, lz);
    lipBars[1].scale.set(w - 2 * t, lt, 0.04);
    lipBars[2].position.set(-hw + t + lt / 2, 0, lz);
    lipBars[2].scale.set(lt, h - 2 * t, 0.04);
    lipBars[3].position.set(hw - t - lt / 2, 0, lz);
    lipBars[3].scale.set(lt, h - 2 * t, 0.04);

    vignette.scale.set(hw, hh, 1);
    vignetteMat.uniforms.uHalf.value.set(hw, hh);
    vignetteMat.uniforms.uWidth.value = Math.min(w, h) * 0.09;
  }

  let time = 0;
  const tmp = new THREE.Vector3();

  return {
    name: 'space',
    root,

    init(ctx: SceneContext) {
      envRT = createSpaceEnvironment(ctx.renderer, SUN_DIR);
      const env = envRT.texture;
      for (const m of [...satellite.materials, frameMat]) {
        if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
          (m as THREE.MeshStandardMaterial).envMap = env;
          m.needsUpdate = true;
        }
      }
      layout(ctx);
    },

    resize(ctx: SceneContext) {
      if (ctx.viewport.widthCm === w && ctx.viewport.heightCm === h) return;
      layout(ctx);
    },

    update(dt: number, _pose: HeadPose, ctx: SceneContext) {
      time += dt;
      const m = Math.min(w, h);

      ctx.renderer.getDrawingBufferSize(drawSize);
      const su = starMat.uniforms;
      su.uTime.value = time;
      su.uDrift.value = (time * DRIFT_SPEED) % (STAR_FAR - STAR_NEAR);
      su.uPxPerCm.value = drawSize.y / Math.max(h, 1e-3);
      su.uPixelRatio.value = ctx.renderer.getPixelRatio();
      planetMat.uniforms.uTime.value = time;

      nebulaFar.rotation.z = time * 0.004;
      nebulaNear.rotation.z = -time * 0.006 + 0.8;

      // Moon: slow drift on a small loop.
      place(moonLayout.fx + Math.sin(time * 0.05) * 0.02, moonLayout.fy + Math.sin(time * 0.07) * 0.01, moonLayout.z, moon.position);
      moon.rotation.y = time * 0.03;

      // Satellite: lazy bob and roll near centre, in front of the glass.
      const sat = satellite.group;
      place(satLayout.fx, satLayout.fy, satLayout.z, sat.position);
      sat.position.x += Math.sin(time * 0.31) * 0.5;
      sat.position.y += Math.sin(time * 0.43 + 1) * 0.35;
      sat.position.z += Math.sin(time * 0.23) * 1.2;
      sat.rotation.set(0.35 + Math.sin(time * 0.2) * 0.15, time * 0.25, 0.2 + Math.sin(time * 0.17) * 0.1);
      satellite.beacon.color.setScalar(0).r = (time % 1.6) < 0.12 ? 4 : 0.25;

      // Asteroid: arcs in from deep left, swings out through the glass near centre, back in on the right.
      const period = 34;
      const u = (time % period) / period;
      const arc = Math.sin(Math.PI * u);
      const z = -70 + 81 * arc * arc;
      place(-0.75 + 1.5 * u, -0.06 - 0.1 * Math.sin(Math.PI * 2 * u), z, asteroid.position);
      asteroid.rotation.set(time * 0.37, time * 0.21, time * 0.11);
      for (let i = 0; i < pebbles.length; i++) {
        const a = time * (0.6 + i * 0.25) + i * 2.1;
        const r = 0.09 * m * (1 + i * 0.35);
        tmp.set(Math.cos(a) * r, Math.sin(a * 0.7) * r * 0.4, Math.sin(a) * r * 0.6);
        pebbles[i].position.copy(asteroid.position).add(tmp);
        pebbles[i].rotation.set(a, a * 0.6, 0);
      }
    },

    dispose() {
      root.removeFromParent();
      root.clear();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
      envRT?.dispose();
      envRT = null;
      sun.dispose();
      hemi.dispose();
    },
  };
}
