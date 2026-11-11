// STUB — to be implemented. Keep this exact public API.
import * as THREE from 'three';
import type { HoloScene } from '../types';

export function createSpaceScene(): HoloScene {
  const root = new THREE.Group();
  return { name: 'space', root, init() {}, resize() {}, update() {}, dispose() {} };
}
