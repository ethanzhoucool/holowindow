// STUB — to be implemented. Keep this exact public API.
import * as THREE from 'three';
import type { HoloScene } from '../types';

export function createAquariumScene(): HoloScene {
  const root = new THREE.Group();
  return { name: 'aquarium', root, init() {}, resize() {}, update() {}, dispose() {} };
}
