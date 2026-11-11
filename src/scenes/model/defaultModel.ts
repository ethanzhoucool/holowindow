import * as THREE from 'three';

/**
 * Procedural showpiece shown before the user drops a file: an iridescent torus knot
 * hovering over a dark pedestal, with a few PBR primitives resting on the pedestal.
 * Units are arbitrary — the scene auto-fits it like any loaded model.
 */
export function createDefaultModel(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'default-showpiece';

  const shadowy = (m: THREE.Mesh): THREE.Mesh => {
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };

  // Pedestal: satin graphite drum with a thin brushed-metal ring.
  const pedestalMat = new THREE.MeshPhysicalMaterial({
    color: 0x111318,
    roughness: 0.55,
    metalness: 0,
    clearcoat: 0.35,
    clearcoatRoughness: 0.35,
    envMapIntensity: 0.6,
  });
  const ringMat = new THREE.MeshStandardMaterial({ color: 0xd8dde6, roughness: 0.22, metalness: 1 });
  const pedestal = shadowy(new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.25, 0.42, 96), pedestalMat));
  pedestal.position.y = 0.21;
  group.add(pedestal);
  const ring = shadowy(new THREE.Mesh(new THREE.TorusGeometry(1.16, 0.025, 12, 128), ringMat));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.42;
  group.add(ring);

  // Hero: glossy iridescent torus knot.
  const knotMat = new THREE.MeshPhysicalMaterial({
    color: 0xff4f7b,
    roughness: 0.16,
    metalness: 0.15,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    iridescence: 0.7,
    iridescenceIOR: 1.6,
    iridescenceThicknessMinimum: 200,
    iridescenceThicknessMaximum: 600,
  });
  const knot = shadowy(new THREE.Mesh(new THREE.TorusKnotGeometry(0.52, 0.17, 256, 32, 2, 3), knotMat));
  knot.name = 'knot';
  knot.position.y = 1.45;
  group.add(knot);

  // Supporting cast on the pedestal top.
  const gold = shadowy(
    new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 48, 24),
      new THREE.MeshStandardMaterial({ color: 0xffc66b, roughness: 0.18, metalness: 1 }),
    ),
  );
  gold.position.set(0.78, 0.62, 0.38);
  group.add(gold);

  const ceramic = shadowy(
    new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.3, 0.3),
      new THREE.MeshPhysicalMaterial({ color: 0xeef1f5, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.12 }),
    ),
  );
  ceramic.position.set(-0.72, 0.57, 0.45);
  ceramic.rotation.y = 0.6;
  group.add(ceramic);

  const teal = shadowy(
    new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.2, 0),
      new THREE.MeshPhysicalMaterial({
        color: 0x2fd3c4,
        roughness: 0.08,
        metalness: 0,
        clearcoat: 1,
        flatShading: true,
      }),
    ),
  );
  teal.position.set(-0.15, 0.6, -0.8);
  group.add(teal);

  return group;
}

/** Idle motion for the showpiece (the turntable handles the overall spin). */
export function animateDefaultModel(group: THREE.Object3D, time: number): void {
  const knot = group.getObjectByName('knot');
  if (!knot) return;
  knot.rotation.x = time * 0.5;
  knot.rotation.z = time * 0.23;
  knot.position.y = 1.45 + Math.sin(time * 1.3) * 0.05;
}
