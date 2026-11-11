import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { HeadPose, ViewportSpec } from '../types';
import { OffAxisCamera } from './offAxisCamera';

const VIEWPORT: ViewportSpec = { widthCm: 30.4, heightCm: 17.1 };

function pose(x: number, y: number, z: number): HeadPose {
  return { x, y, z, confidence: 1, tracked: true };
}

function cameraAt(x: number, y: number, z: number, viewport = VIEWPORT): OffAxisCamera {
  const cam = new OffAxisCamera();
  cam.updateFromHead(pose(x, y, z), viewport);
  return cam;
}

/** World point -> NDC via projectionMatrix * matrixWorldInverse (explicit, then perspective divide). */
function toNdc(cam: THREE.Camera, p: THREE.Vector3): THREE.Vector3 {
  const v = new THREE.Vector4(p.x, p.y, p.z, 1);
  v.applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
  expect(v.w).toBeGreaterThan(0); // in front of the camera
  return new THREE.Vector3(v.x / v.w, v.y / v.w, v.z / v.w);
}

function corners(vp: ViewportSpec): Array<[THREE.Vector3, number, number]> {
  const hw = vp.widthCm / 2;
  const hh = vp.heightCm / 2;
  return [
    [new THREE.Vector3(-hw, -hh, 0), -1, -1],
    [new THREE.Vector3(hw, -hh, 0), 1, -1],
    [new THREE.Vector3(hw, hh, 0), 1, 1],
    [new THREE.Vector3(-hw, hh, 0), -1, 1],
  ];
}

/** Deterministic eye positions, including ones well outside the screen rectangle. */
function eyePositions(): Array<[number, number, number]> {
  const fixed: Array<[number, number, number]> = [
    [0, 0, 60],
    [12, -5, 45],
    [-30, 20, 80],
    [40, 30, 25],
    [-3.3, 11.1, 150],
    [0, 0, 5],
  ];
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 40; i++) fixed.push([(rnd() - 0.5) * 100, (rnd() - 0.5) * 60, 10 + rnd() * 140]);
  return fixed;
}

describe('OffAxisCamera', () => {
  it('has a symmetric frustum when the eye is centred at (0, 0, z)', () => {
    for (const z of [20, 60, 120]) {
      const cam = cameraAt(0, 0, z);
      const e = cam.projectionMatrix.elements;
      // Column-major: elements[8], [9] are the (right+left)/(right-left), (top+bottom)/(top-bottom) skew terms.
      expect(e[8]).toBeCloseTo(0, 12);
      expect(e[9]).toBeCloseTo(0, 12);
      // ...and the frustum exactly spans the screen: x scale = 2*z/width, y scale = 2*z/height.
      expect(e[0]).toBeCloseTo((2 * z) / VIEWPORT.widthCm, 9);
      expect(e[5]).toBeCloseTo((2 * z) / VIEWPORT.heightCm, 9);
    }
  });

  it('has a skewed frustum when the eye is off-centre', () => {
    const e = cameraAt(10, -4, 60).projectionMatrix.elements;
    expect(Math.abs(e[8])).toBeGreaterThan(0.1);
    expect(Math.abs(e[9])).toBeGreaterThan(0.1);
  });

  it('places the camera at the eye, looking straight down -z (no rotation)', () => {
    const cam = cameraAt(7, -3, 55);
    expect(cam.position.toArray()).toEqual([7, -3, 55]);
    const dir = cam.getWorldDirection(new THREE.Vector3());
    expect(dir.x).toBeCloseTo(0, 12);
    expect(dir.y).toBeCloseTo(0, 12);
    expect(dir.z).toBeCloseTo(-1, 12);
  });

  it.each(eyePositions())('screen corners land exactly on NDC (±1, ±1) — eye at (%f, %f, %f)', (x, y, z) => {
    const cam = cameraAt(x, y, z);
    for (const [corner, nx, ny] of corners(VIEWPORT)) {
      const ndc = toNdc(cam, corner);
      expect(ndc.x).toBeCloseTo(nx, 9);
      expect(ndc.y).toBeCloseTo(ny, 9);
      expect(ndc.z).toBeGreaterThan(-1);
      expect(ndc.z).toBeLessThan(1);
    }
  });

  it('corner invariant holds for other viewport sizes and agrees with Vector3.project', () => {
    const vp: ViewportSpec = { widthCm: 52, heightCm: 29.25 };
    const cam = cameraAt(-8, 6, 70, vp);
    for (const [corner, nx, ny] of corners(vp)) {
      const ndc = corner.clone().project(cam);
      expect(ndc.x).toBeCloseTo(nx, 9);
      expect(ndc.y).toBeCloseTo(ny, 9);
    }
  });

  it('keeps the corner invariant when the eye is closer than the minimum distance', () => {
    const cam = cameraAt(3, 2, -10); // clamped to z = 5
    expect(cam.position.z).toBe(5);
    for (const [corner, nx, ny] of corners(VIEWPORT)) {
      const ndc = toNdc(cam, corner);
      expect(ndc.x).toBeCloseTo(nx, 9);
      expect(ndc.y).toBeCloseTo(ny, 9);
    }
  });

  it('ignores updateProjectionMatrix() (PerspectiveCamera must not overwrite the skew)', () => {
    const cam = cameraAt(10, 5, 50);
    const before = cam.projectionMatrix.clone();
    cam.fov = 90;
    cam.aspect = 3;
    cam.updateProjectionMatrix();
    expect(cam.projectionMatrix.equals(before)).toBe(true);
  });

  /*
   * Parallax. Like a real window: a point behind the glass slides across the window in the
   * SAME direction the eye moves (in the limit of infinite depth it stays fixed in the eye's view
   * direction, i.e. it moves with the head), while a point in front of the glass moves OPPOSITE
   * to the eye, and a point on the glass doesn't move at all.
   */
  describe('parallax direction', () => {
    const behind = new THREE.Vector3(0, 0, -30);
    const front = new THREE.Vector3(0, 0, 10);
    const onGlass = new THREE.Vector3(0, 0, 0);

    it('a point on the screen plane stays put as the eye moves', () => {
      for (const [x, y] of [
        [15, 0],
        [-15, 0],
        [0, 10],
        [8, -6],
      ]) {
        const ndc = toNdc(cameraAt(x, y, 60), onGlass);
        expect(ndc.x).toBeCloseTo(0, 9);
        expect(ndc.y).toBeCloseTo(0, 9);
      }
    });

    it('a point behind the screen centre shifts WITH the eye, a point in front shifts AGAINST it', () => {
      const centre = toNdc(cameraAt(0, 0, 60), behind);
      expect(centre.x).toBeCloseTo(0, 9);
      expect(centre.y).toBeCloseTo(0, 9);

      const right = cameraAt(10, 0, 60);
      const up = cameraAt(0, 10, 60);
      expect(toNdc(right, behind).x).toBeGreaterThan(0);
      expect(toNdc(up, behind).y).toBeGreaterThan(0);
      expect(toNdc(right, front).x).toBeLessThan(0);
      expect(toNdc(up, front).y).toBeLessThan(0);

      const left = cameraAt(-10, 0, 60);
      const down = cameraAt(0, -10, 60);
      expect(toNdc(left, behind).x).toBeLessThan(0);
      expect(toNdc(down, behind).y).toBeLessThan(0);
    });

    it('the on-screen shift of a point behind the glass matches the ray/plane intersection', () => {
      // Ray from eye E to P crosses z = 0 at E + (P - E) * Ez / (Ez - Pz).
      const E = new THREE.Vector3(12, -7, 50);
      const P = new THREE.Vector3(3, 4, -40);
      const t = E.z / (E.z - P.z);
      const hit = E.clone().add(P.clone().sub(E).multiplyScalar(t));
      const ndc = toNdc(cameraAt(E.x, E.y, E.z), P);
      expect(ndc.x).toBeCloseTo(hit.x / (VIEWPORT.widthCm / 2), 9);
      expect(ndc.y).toBeCloseTo(hit.y / (VIEWPORT.heightCm / 2), 9);
    });

    it('deeper points move further with the eye (approaching the head motion itself)', () => {
      const cam = cameraAt(10, 0, 60);
      const shallow = toNdc(cam, new THREE.Vector3(0, 0, -10)).x;
      const deep = toNdc(cam, new THREE.Vector3(0, 0, -500)).x;
      expect(deep).toBeGreaterThan(shallow);
      expect(deep).toBeLessThan(10 / (VIEWPORT.widthCm / 2));
    });
  });
});
