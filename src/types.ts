import type * as THREE from 'three';

/**
 * WORLD CONVENTIONS (shared by every module — do not change without updating all of them)
 *
 * - Units are CENTIMETRES.
 * - The physical display (the browser viewport) is the plane z = 0, centred on the origin.
 *   It spans x ∈ [-viewport.widthCm/2, +viewport.widthCm/2], y ∈ [-viewport.heightCm/2, +viewport.heightCm/2].
 * - +x is the viewer's right, +y is up, +z points OUT of the screen toward the viewer.
 * - Content "inside" the window lives at z < 0. Content that "pops out" lives at z > 0.
 * - The viewer's eye is at HeadPose (x, y, z) with z > 0 (typically 40–80 cm).
 */

/** Head (cyclopean eye) position relative to the centre of the viewport, in cm. */
export interface HeadPose {
  x: number;
  y: number;
  z: number;
  /** 0..1 — how much to trust this sample. */
  confidence: number;
  /** false when the face is lost; the pose then holds the last good value (or a default). */
  tracked: boolean;
}

export const DEFAULT_POSE: HeadPose = { x: 0, y: 0, z: 60, confidence: 0, tracked: false };

/** Physical size of the full monitor in cm. */
export interface ScreenSpec {
  widthCm: number;
  heightCm: number;
}

/** Physical size of the region we render into (the browser viewport), in cm. */
export interface ViewportSpec {
  widthCm: number;
  heightCm: number;
}

/** Anything that produces head poses (webcam face tracker, mouse fallback, ...). */
export interface HeadSource {
  readonly name: string;
  start(): Promise<void>;
  stop(): void;
  /** Called every animation frame. Must be cheap. Returns the latest (already smoothed) pose. */
  getPose(): HeadPose;
}

/** Every scene the app can show. Order here = order in the HUD's mode picker. */
export const MODES = ['room', 'space', 'aquarium', 'photo', 'model'] as const;
export type Mode = (typeof MODES)[number];

export const MODE_LABELS: Record<Mode, string> = {
  room: 'Room',
  space: 'Space',
  aquarium: 'Aquarium',
  photo: 'Photo',
  model: '3D model',
};
export type SourceKind = 'face' | 'mouse';

export interface Settings {
  /** Full physical monitor size. */
  screen: ScreenSpec;
  mode: Mode;
  source: SourceKind;
  /** Average human interpupillary distance used to estimate depth from eye spacing. */
  ipdCm: number;
  /** Horizontal field of view of the webcam in degrees. */
  cameraFovDeg: number;
  /** Webcam position relative to the top-centre of the SCREEN, in cm (+ = above the top edge). */
  cameraOffsetYcm: number;
  /** 0 = raw/jittery, 1 = very smooth/laggy. */
  smoothing: number;
  /** Multiplies head motion. 1 = physically correct. >1 exaggerates the effect. */
  motionGain: number;
  /** Photo mode: how deep the depth-displaced image is, in cm. */
  depthScale: number;
  showDebug: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  screen: { widthCm: 30.4, heightCm: 19.7 }, // ~14" laptop
  mode: 'room',
  source: 'face',
  ipdCm: 6.3,
  cameraFovDeg: 60,
  cameraOffsetYcm: 0.8,
  smoothing: 0.5,
  motionGain: 1,
  depthScale: 12,
  showDebug: false,
};

export interface SceneContext {
  renderer: THREE.WebGLRenderer;
  /** Current viewport size in cm. Scenes should size themselves to fill it. */
  viewport: ViewportSpec;
  settings: Settings;
}

/** A 3D scene shown "through" the screen. */
export interface HoloScene {
  readonly name: string;
  /** Root object; main.ts adds this to the THREE.Scene. */
  readonly root: THREE.Object3D;
  init(ctx: SceneContext): Promise<void> | void;
  /** Called when the viewport's physical size or settings change. */
  resize(ctx: SceneContext): void;
  /** Called every frame. dt in seconds. */
  update(dt: number, pose: HeadPose, ctx: SceneContext): void;
  dispose(): void;
}
