// STUB — to be implemented. Keep this exact public API.
import type { Settings } from '../types';
import type { Hud, HudCallbacks } from './contracts';

export function createHud(_parent: HTMLElement, _settings: Settings, _cb: HudCallbacks): Hud {
  return { setStatus() {}, update() {}, setVideo() {}, setSettings() {} };
}
