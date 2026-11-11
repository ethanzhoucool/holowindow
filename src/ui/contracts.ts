import type { HeadPose, Settings } from '../types';

export interface HudCallbacks {
  /** Fired whenever any setting changes. The HUD passes the full, updated settings object. */
  onSettingsChange(settings: Settings): void;
  /** User picked / dropped an image for photo mode. */
  onImage(file: File): void;
  /** User picked / dropped a 3D model (.glb / .gltf) for model mode. */
  onModel(file: File): void;
  /** User clicked "recenter" — treat the current head position as straight-on. */
  onRecenter(): void;
  onToggleFullscreen(): void;
  /** User clicked the "enable camera" call-to-action. */
  onStartCamera(): void;
}

export interface Hud {
  setStatus(text: string, kind?: 'info' | 'ok' | 'error'): void;
  /** Called every frame — must be cheap (throttle DOM writes internally). */
  update(pose: HeadPose, fps: number): void;
  /** Show the webcam feed in a small debug preview (only visible when settings.showDebug). */
  setVideo(video: HTMLVideoElement): void;
  /** Push settings changed from outside (e.g. after loading from storage). */
  setSettings(settings: Settings): void;
}
