// STUB — to be implemented. Keep this exact public API.
import * as THREE from 'three';
import type { HoloScene } from '../types';

export interface PhotoScene extends HoloScene {
  /** Load an image (File or URL), estimate depth, and show it as a 3D relief. */
  loadImage(src: File | string, onStatus?: (msg: string) => void): Promise<void>;
}

export function createPhotoScene(): PhotoScene {
  const root = new THREE.Group();
  return {
    name: 'photo', root, init() {}, resize() {}, update() {}, dispose() {},
    async loadImage() {},
  };
}
