import type { Settings } from '../types';

/** Normalised image landmark (x, y in 0..1 of width / height; z on the same scale as x). */
export interface Landmark {
  x: number;
  y: number;
  z: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** The subset of Settings the pose math depends on. */
export type PoseSettings = Pick<Settings, 'screen' | 'ipdCm' | 'cameraFovDeg' | 'cameraOffsetYcm'>;

// Landmark indices (MediaPipe face mesh, 478-point model with irises).
export const IRIS_A = 468;
export const IRIS_B = 473;
// Eye corners, used when iris landmarks are missing.
const EYE_A_CORNERS = [33, 133] as const;
const EYE_B_CORNERS = [362, 263] as const;

export const FOV_MIN_DEG = 20;
export const FOV_MAX_DEG = 150;
export const Z_MIN_CM = 10;
export const Z_MAX_CM = 400;
export const FORESHORTENING_MIN = 0.5;
/** Eye spacings at or below this many pixels are rejected as unusable. */
export const MIN_IPD_PX = 4;

/**
 * Raw (unfiltered) cyclopean-eye position, monitor-centred, in cm. null if no usable face.
 *
 * Pinhole model with the principal point at the image centre:
 *   f   = (W/2) / tan(hFov/2)                          focal length in px
 *   z   = f * ipdCm / ipdPx                            distance from camera (cm)
 *   X_c = (u - cx) * z / f,  Y_c = (v - cy) * z / f    camera-image axes (u right, v DOWN)
 *
 * SIGNS. getUserMedia frames are NOT mirrored: the camera looks at the viewer, so the
 * viewer's right side appears on the LEFT of the image. Image +u therefore points toward
 * the viewer's LEFT, i.e. world -x:   x = -(u - cx) * z / f.
 * Image +v points down, world +y is up:  y = -(v - cy) * z / f.
 * The camera lens sits in the screen plane, so the camera's depth is the world z directly.
 *
 * The camera is at the top-centre of the monitor, cameraOffsetYcm above the top edge, so
 * to get monitor-centred coordinates we add the distance from monitor centre to camera:
 *   y_monitor = y_cam + screen.heightCm/2 + cameraOffsetYcm.   (x needs no shift.)
 *
 * @param transformMatrix optional column-major 4x4 facial transformation matrix (camera space),
 *   used only for its rotation to undo yaw/pitch foreshortening of the eye distance.
 */
export function estimateHeadPosition(
  landmarks: ArrayLike<Landmark> | undefined | null,
  W: number,
  H: number,
  settings: PoseSettings,
  transformMatrix?: ArrayLike<number> | null,
): Vec3 | null {
  const lms = landmarks;
  if (!lms || lms.length < 468 || !(W > 0) || !(H > 0)) return null;

  let a: Landmark;
  let b: Landmark;
  if (lms.length > IRIS_B) {
    a = lms[IRIS_A];
    b = lms[IRIS_B];
  } else {
    a = midpoint(lms[EYE_A_CORNERS[0]], lms[EYE_A_CORNERS[1]]);
    b = midpoint(lms[EYE_B_CORNERS[0]], lms[EYE_B_CORNERS[1]]);
  }

  // Pixel-space eye vector (normalised coords are relative to width / height separately).
  const dxPx = (b.x - a.x) * W;
  const dyPx = (b.y - a.y) * H;
  const ipdPx2d = Math.hypot(dxPx, dyPx);
  if (!(ipdPx2d > MIN_IPD_PX)) return null;

  // Undo foreshortening from head yaw (and pitch) so turning the head doesn't fake depth.
  const fore = foreshortening(a, b, W, H, transformMatrix);
  const ipdPx = ipdPx2d / fore;

  const fovRad = (clamp(settings.cameraFovDeg, FOV_MIN_DEG, FOV_MAX_DEG) * Math.PI) / 180;
  const f = W / 2 / Math.tan(fovRad / 2);
  const z = clamp((f * settings.ipdCm) / ipdPx, Z_MIN_CM, Z_MAX_CM);

  const u = ((a.x + b.x) / 2) * W;
  const v = ((a.y + b.y) / 2) * H;
  const xCam = (-(u - W / 2) * z) / f;
  const yCam = (-(v - H / 2) * z) / f;

  const x = xCam;
  const y = yCam + settings.screen.heightCm / 2 + settings.cameraOffsetYcm;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

/**
 * Fraction (0.5..1) of the true inter-eye distance that is visible in the image plane.
 * Preferred: the face transform's local x axis (column 0 of the column-major 4x4 matrix,
 * expressed in camera space): its in-image share |(r0, r1)| / |(r0, r1, r2)| is cos of the
 * out-of-plane rotation. Fallback: landmark z (same scale as normalised x) for the 3D eye vector.
 * Clamped so extreme turns can't blow up the estimate.
 */
export function foreshortening(
  a: Landmark,
  b: Landmark,
  W: number,
  H: number,
  m?: ArrayLike<number> | null,
): number {
  let c = 1;
  if (m && m.length >= 16) {
    const inPlane = Math.hypot(m[0], m[1]);
    const full = Math.hypot(m[0], m[1], m[2]);
    if (full > 1e-6) c = inPlane / full;
  } else {
    const d2 = Math.hypot((b.x - a.x) * W, (b.y - a.y) * H);
    const d3 = Math.hypot(d2, (b.z - a.z) * W);
    if (d3 > 1e-6) c = d2 / d3;
  }
  return Number.isFinite(c) ? clamp(c, FORESHORTENING_MIN, 1) : 1;
}

/**
 * Next timestamp (ms) for FaceLandmarker.detectForVideo, which throws unless timestamps are
 * strictly increasing. Non-finite or backwards clocks still yield last + 1.
 */
export function nextDetectTimestamp(nowMs: number, lastMs: number): number {
  const last = Number.isFinite(lastMs) ? lastMs : 0;
  return Number.isFinite(nowMs) && nowMs >= last + 1 ? nowMs : last + 1;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function midpoint(p: Landmark, q: Landmark): Landmark {
  return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, z: (p.z + q.z) / 2 };
}
