import * as THREE from 'three';
import type { HeadPose, ViewportSpec } from '../types';

/**
 * Off-axis (asymmetric frustum) camera.
 *
 * The screen is a fixed rectangle at z = 0. The eye moves around in front of it.
 * Instead of rotating the camera toward the scene, we keep it facing -z and skew the
 * frustum so its edges always pass through the screen's physical corners.
 * That is what makes the monitor behave like a real window.
 */
export class OffAxisCamera extends THREE.PerspectiveCamera {
  near = 0.5;
  far = 2000;

  updateFromHead(pose: HeadPose, viewport: ViewportSpec): void {
    const ez = Math.max(pose.z, 5); // never let the eye touch the screen plane
    this.position.set(pose.x, pose.y, ez);
    this.quaternion.identity();
    this.updateMatrixWorld(true);

    const hw = viewport.widthCm / 2;
    const hh = viewport.heightCm / 2;
    const k = this.near / ez;
    const left = (-hw - pose.x) * k;
    const right = (hw - pose.x) * k;
    const top = (hh - pose.y) * k;
    const bottom = (-hh - pose.y) * k;

    this.projectionMatrix.makePerspective(left, right, top, bottom, this.near, this.far);
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
  }

  /** PerspectiveCamera would overwrite our skewed matrix; ignore it. */
  override updateProjectionMatrix(): void {
    /* projection is driven by updateFromHead */
  }
}
