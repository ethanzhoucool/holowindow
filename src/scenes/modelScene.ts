// STUB — to be implemented. Keep this exact public API.
import * as THREE from 'three';
import type { HoloScene } from '../types';

export interface ModelScene extends HoloScene {
  /** Load a .glb/.gltf (File or URL), fit it into the window box, and show it. */
  loadModel(src: File | string, onStatus?: (msg: string) => void): Promise<void>;
}

export function createModelScene(): ModelScene {
  const root = new THREE.Group();
  return {
    name: 'model', root, init() {}, resize() {}, update() {}, dispose() {},
    async loadModel() {},
  };
}
