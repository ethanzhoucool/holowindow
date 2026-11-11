import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeRng } from './spaceMaterials';

/** Seeded 3D value noise for CPU-side displacement. */
function createNoise3(seed: number) {
  const rnd = makeRng(seed);
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    perm[i] = i;
    vals[i] = rnd();
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[256 + i] = perm[i];
  const h = (x: number, y: number, z: number) => vals[perm[perm[perm[x & 255] + (y & 255)] + (z & 255)]];
  const sm = (t: number) => t * t * (3 - 2 * t);
  const noise = (x: number, y: number, z: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const fx = sm(x - xi);
    const fy = sm(y - yi);
    const fz = sm(z - zi);
    const l = THREE.MathUtils.lerp;
    return l(
      l(l(h(xi, yi, zi), h(xi + 1, yi, zi), fx), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), fx), fy),
      l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), fx), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), fx), fy),
      fz,
    );
  };
  return (x: number, y: number, z: number, oct = 4) => {
    let s = 0;
    let a = 0.5;
    let f = 1;
    for (let i = 0; i < oct; i++) {
      s += a * noise(x * f, y * f, z * f);
      f *= 2.1;
      a *= 0.5;
    }
    return s;
  };
}

/** Cratered moon: smooth-shaded displaced sphere with bowl-shaped craters and raised rims. */
export function createMoonGeometry(seed = 7): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 5);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const rnd = makeRng(seed);
  const fbm = createNoise3(seed);
  const craters: { c: THREE.Vector3; r: number; depth: number }[] = [];
  for (let i = 0; i < 26; i++) {
    const c = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
    const r = 0.06 + Math.pow(rnd(), 2.5) * 0.32;
    craters.push({ c, r, depth: r * 0.12 });
  }
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).normalize();
    let d = (fbm(p.x * 3 + 5, p.y * 3, p.z * 3) - 0.5) * 0.04;
    for (const cr of craters) {
      const ang = Math.acos(THREE.MathUtils.clamp(p.dot(cr.c), -1, 1));
      const x = ang / cr.r;
      if (x < 1.6) {
        if (x < 1) d -= cr.depth * (1 - x * x);
        else d += cr.depth * 0.35 * Math.exp(-((x - 1.08) ** 2) / 0.02);
      }
    }
    const maria = THREE.MathUtils.smoothstep(fbm(p.x * 1.4 + 9, p.y * 1.4, p.z * 1.4, 3), 0.48, 0.56);
    const shade = 1 - maria * 0.38 + (fbm(p.x * 8, p.y * 8 + 3, p.z * 8, 2) - 0.5) * 0.15;
    colors[i * 3] = shade;
    colors[i * 3 + 1] = shade * 0.98;
    colors[i * 3 + 2] = shade * 0.95;
    p.multiplyScalar(1 + d);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

/** Lumpy low-poly asteroid (flat shaded). */
export function createAsteroidGeometry(seed = 3): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 2);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const fbm = createNoise3(seed);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).normalize();
    const d = 0.7 + fbm(p.x * 1.6 + 2, p.y * 1.6, p.z * 1.6) * 0.75;
    p.multiplyScalar(d);
    p.x *= 1.35;
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  const flat = g.toNonIndexed();
  g.dispose();
  flat.computeVertexNormals();
  return flat;
}

export interface Satellite {
  group: THREE.Group;
  beacon: THREE.MeshBasicMaterial;
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
}

/** A tiny satellite (~3.6 units across): gold-foil bus, two solar wings, a dish and a beacon. */
export function createSatellite(panelTex: THREE.Texture, envMap: THREE.Texture | null): Satellite {
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const geo = <G extends THREE.BufferGeometry>(g: G): G => (geometries.push(g), g);
  const mat = <M extends THREE.Material>(m: M): M => (materials.push(m), m);
  const group = new THREE.Group();
  group.name = 'satellite';

  const foil = mat(
    new THREE.MeshStandardMaterial({ color: 0xf0b848, metalness: 0.55, roughness: 0.38, envMap, envMapIntensity: 1.4, flatShading: true }),
  );
  const silver = mat(new THREE.MeshStandardMaterial({ color: 0xc8ccd4, metalness: 0.9, roughness: 0.25, envMap, envMapIntensity: 1.2 }));
  const panel = mat(
    new THREE.MeshStandardMaterial({
      map: panelTex,
      color: 0x8fa8ff,
      metalness: 0.6,
      roughness: 0.3,
      envMap,
      envMapIntensity: 1.6,
      emissive: 0x0a1640,
      emissiveIntensity: 0.6,
    }),
  );

  const bus = new THREE.Mesh(geo(new THREE.BoxGeometry(0.8, 0.8, 1.1, 2, 2, 2)), foil);
  // Crinkle the foil a bit.
  const bp = bus.geometry.getAttribute('position') as THREE.BufferAttribute;
  const rnd = makeRng(11);
  for (let i = 0; i < bp.count; i++) {
    bp.setXYZ(i, bp.getX(i) * (1 + (rnd() - 0.5) * 0.06), bp.getY(i) * (1 + (rnd() - 0.5) * 0.06), bp.getZ(i));
  }
  bus.geometry.computeVertexNormals();
  group.add(bus);

  const strutGeo = geo(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 6));
  strutGeo.rotateZ(Math.PI / 2);
  const wingGeo = geo(new THREE.BoxGeometry(1.4, 0.03, 0.7));
  for (const side of [-1, 1]) {
    const strut = new THREE.Mesh(strutGeo, silver);
    strut.position.x = side * 0.62;
    const wing = new THREE.Mesh(wingGeo, panel);
    wing.position.x = side * 1.55;
    wing.rotation.x = 0.35;
    group.add(strut, wing);
  }

  const dishGeo = geo(
    new THREE.LatheGeometry(
      Array.from({ length: 7 }, (_, i) => {
        const r = (i / 6) * 0.42;
        return new THREE.Vector2(r, r * r * 1.1);
      }),
      18,
    ),
  );
  dishGeo.rotateX(Math.PI / 2);
  const dishMat = mat(new THREE.MeshStandardMaterial({ color: 0xeeeeee, metalness: 0.2, roughness: 0.45, side: THREE.DoubleSide, envMap }));
  const dish = new THREE.Mesh(dishGeo, dishMat);
  dish.position.z = 0.62;
  group.add(dish);
  const feed = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.015, 0.015, 0.36, 5)), silver);
  feed.rotation.x = Math.PI / 2;
  feed.position.z = 0.8;
  group.add(feed);

  const antenna = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.012, 0.012, 0.7, 5)), silver);
  antenna.position.set(0.2, 0.72, -0.2);
  group.add(antenna);
  const beacon = mat(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3020).multiplyScalar(3) }));
  const bulb = new THREE.Mesh(geo(new THREE.SphereGeometry(0.05, 8, 6)), beacon);
  bulb.position.set(0.2, 1.08, -0.2);
  group.add(bulb);

  return { group, beacon, geometries, materials };
}
