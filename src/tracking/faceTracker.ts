import {
  FaceLandmarker,
  FilesetResolver,
  type FaceLandmarkerResult,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';
import { DEFAULT_POSE, type HeadPose, type HeadSource, type Settings } from '../types';
import { OneEuroFilter, smoothingToParams } from './oneEuroFilter';

/** Must match the installed @mediapipe/tasks-vision version (see package.json). */
const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.2/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// Landmark indices (MediaPipe face mesh, 478-point model with irises).
const IRIS_A = 468;
const IRIS_B = 473;
// Eye corners, used when iris landmarks are missing.
const EYE_A_CORNERS = [33, 133] as const;
const EYE_B_CORNERS = [362, 263] as const;

/** After the face disappears, hold the last pose this long before easing away (ms). */
const LOST_GRACE_MS = 150;
/** Time constant for easing back to DEFAULT_POSE once lost (s). ~95% after 1 s. */
const LOST_EASE_TAU = 0.33;
/** Time constant for confidence decay once lost (s). */
const CONFIDENCE_TAU = 0.35;
/** When the face comes back, blend from the eased pose to the tracked one over this long (ms). */
const REACQUIRE_BLEND_MS = 300;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

type FrameLoopHandle = { kind: 'rvfc'; id: number } | { kind: 'raf'; id: number };

function cameraError(err: unknown): Error {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new Error('Camera permission denied');
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new Error('No camera found');
    case 'NotReadableError':
    case 'AbortError':
      return new Error('Camera is in use by another application or could not be started');
    default:
      return new Error(`Could not open camera: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function smoothstep(t: number): number {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
}

export class FaceTracker implements HeadSource {
  readonly name = 'face';

  private settings: Settings;
  private readonly video: HTMLVideoElement;

  private stream: MediaStream | null = null;
  private landmarker: FaceLandmarker | null = null;
  private startPromise: Promise<void> | null = null;
  private running = false;
  /** Bumped on every start/stop so stale async work and loops bail out. */
  private generation = 0;
  private loop: FrameLoopHandle | null = null;
  private lastVideoTime = -1;
  private lastDetectTs = 0;
  private detectErrorLogged = false;

  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;
  private readonly fz: OneEuroFilter;

  /** Latest filtered measurement, monitor-centred, BEFORE the recenter offset. */
  private measured: Vec3 = { x: DEFAULT_POSE.x, y: DEFAULT_POSE.y, z: DEFAULT_POSE.z };
  private hasMeasurement = false;
  private offset = { x: 0, y: 0 };
  private faceVisible = false;
  private lastSeenMs = -Infinity;
  private blendFrom: Vec3 | null = null;
  private blendStartMs = 0;

  /** What getPose() returns; advanced each getPose() call. */
  private display: HeadPose = { ...DEFAULT_POSE };
  private lastPoseMs = performance.now();

  constructor(settings: Settings, video: HTMLVideoElement) {
    this.settings = settings;
    this.video = video;
    const p = smoothingToParams(settings.smoothing);
    this.fx = new OneEuroFilter({ ...p });
    this.fy = new OneEuroFilter({ ...p });
    this.fz = new OneEuroFilter(this.depthParams(p));
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
    const p = smoothingToParams(settings.smoothing);
    this.fx.params = { ...p };
    this.fy.params = { ...p };
    this.fz.params = this.depthParams(p);
  }

  /** Treat the current head position as the straight-on (x=0,y=0) position. */
  recenter(): void {
    if (!this.hasMeasurement) return;
    this.offset = { x: this.measured.x, y: this.measured.y };
    // Glide to the new origin rather than jumping.
    this.blendFrom = { x: this.display.x, y: this.display.y, z: this.display.z };
    this.blendStartMs = performance.now();
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  stop(): void {
    this.generation++;
    this.running = false;
    this.cancelLoop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.faceVisible = false;
    // The landmarker is kept so a later start() doesn't re-download the model.
  }

  /** Pose relative to the centre of the whole MONITOR, in cm. */
  getPose(): HeadPose {
    const now = performance.now();
    const dt = Math.min(Math.max((now - this.lastPoseMs) / 1000, 0), 0.1);
    this.lastPoseMs = now;
    const d = this.display;

    if (this.faceVisible) {
      const target: Vec3 = {
        x: this.measured.x - this.offset.x,
        y: this.measured.y - this.offset.y,
        z: this.measured.z,
      };
      let out = target;
      if (this.blendFrom) {
        const k = smoothstep((now - this.blendStartMs) / REACQUIRE_BLEND_MS);
        const f = this.blendFrom;
        out = { x: f.x + (target.x - f.x) * k, y: f.y + (target.y - f.y) * k, z: f.z + (target.z - f.z) * k };
        if (k >= 1) this.blendFrom = null;
      }
      const conf = d.confidence + (1 - d.confidence) * (1 - Math.exp(-dt / 0.1));
      this.display = { ...out, confidence: conf, tracked: true };
    } else {
      const decay = Math.exp(-dt / CONFIDENCE_TAU);
      let { x, y, z } = d;
      if (now - this.lastSeenMs > LOST_GRACE_MS) {
        const a = 1 - Math.exp(-dt / LOST_EASE_TAU);
        x += (DEFAULT_POSE.x - x) * a;
        y += (DEFAULT_POSE.y - y) * a;
        z += (DEFAULT_POSE.z - z) * a;
      }
      this.display = { x, y, z, confidence: d.confidence * decay, tracked: false };
    }
    return { ...this.display };
  }

  // ---------------------------------------------------------------------------

  /** Depth from eye spacing is ~10x noisier than lateral position, so smooth it a bit harder. */
  private depthParams(p: ReturnType<typeof smoothingToParams>): ReturnType<typeof smoothingToParams> {
    return { ...p, minCutoff: p.minCutoff * 0.6 };
  }

  private async doStart(): Promise<void> {
    const gen = ++this.generation;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera API unavailable (page must be served over HTTPS or localhost)');
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 60 },
        },
      });
    } catch (err) {
      throw cameraError(err);
    }
    if (gen !== this.generation) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Face tracking was stopped while starting');
    }
    this.stream = stream;

    const video = this.video;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    try {
      if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise<void>((resolve, reject) => {
          video.addEventListener('loadedmetadata', () => resolve(), { once: true });
          video.addEventListener('error', () => reject(new Error('Video element error')), { once: true });
        });
      }
      await video.play();
    } catch (err) {
      this.stop();
      throw new Error(`Could not play camera stream: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (gen !== this.generation) throw new Error('Face tracking was stopped while starting');

    try {
      this.landmarker ??= await this.createLandmarker();
    } catch (err) {
      this.stop();
      throw new Error(`Could not load face model: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (gen !== this.generation) throw new Error('Face tracking was stopped while starting');

    this.running = true;
    this.lastVideoTime = -1;
    this.scheduleNext(gen);
  }

  private async createLandmarker(): Promise<FaceLandmarker> {
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    const make = (delegate: 'GPU' | 'CPU'): Promise<FaceLandmarker> =>
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: false,
        // Used only for its rotation, to undo yaw foreshortening of the eye distance.
        outputFacialTransformationMatrixes: true,
      });
    try {
      return await make('GPU');
    } catch (err) {
      console.warn('FaceLandmarker GPU delegate failed, falling back to CPU', err);
      return make('CPU');
    }
  }

  // ---------- frame loop ----------

  private scheduleNext(gen: number): void {
    if (gen !== this.generation || !this.running) return;
    const video = this.video;
    if (typeof video.requestVideoFrameCallback === 'function') {
      // Fires exactly once per new decoded camera frame — lowest latency, no wasted work.
      const id = video.requestVideoFrameCallback(() => {
        this.processFrame(gen);
        this.scheduleNext(gen);
      });
      this.loop = { kind: 'rvfc', id };
    } else {
      const id = requestAnimationFrame(() => {
        if (video.currentTime !== this.lastVideoTime) {
          this.lastVideoTime = video.currentTime;
          this.processFrame(gen);
        }
        this.scheduleNext(gen);
      });
      this.loop = { kind: 'raf', id };
    }
  }

  private cancelLoop(): void {
    if (!this.loop) return;
    if (this.loop.kind === 'rvfc') this.video.cancelVideoFrameCallback(this.loop.id);
    else cancelAnimationFrame(this.loop.id);
    this.loop = null;
  }

  private processFrame(gen: number): void {
    const lm = this.landmarker;
    const video = this.video;
    if (gen !== this.generation || !lm || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (!video.videoWidth || !video.videoHeight) return;

    // detectForVideo requires strictly increasing timestamps (ms).
    const now = performance.now();
    const ts = Math.max(now, this.lastDetectTs + 1);
    this.lastDetectTs = ts;

    let result: FaceLandmarkerResult;
    try {
      result = lm.detectForVideo(video, ts);
    } catch (err) {
      if (!this.detectErrorLogged) {
        console.error('FaceLandmarker.detectForVideo failed', err);
        this.detectErrorLogged = true;
      }
      return;
    }

    const raw = this.estimate(result, video.videoWidth, video.videoHeight);
    if (!raw) {
      this.faceVisible = false;
      return;
    }

    if (!this.faceVisible && now - this.lastSeenMs > LOST_GRACE_MS) {
      // Re-acquired after a real loss: restart the filters from the new position and
      // blend the displayed pose over instead of jumping.
      this.fx.reset();
      this.fy.reset();
      this.fz.reset();
      this.blendFrom = { x: this.display.x, y: this.display.y, z: this.display.z };
      this.blendStartMs = now;
    }

    const t = ts / 1000;
    this.measured = { x: this.fx.filter(raw.x, t), y: this.fy.filter(raw.y, t), z: this.fz.filter(raw.z, t) };
    this.hasMeasurement = true;
    this.faceVisible = true;
    this.lastSeenMs = now;
  }

  // ---------- pose math ----------

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
   */
  private estimate(result: FaceLandmarkerResult, W: number, H: number): Vec3 | null {
    const lms = result.faceLandmarks[0];
    if (!lms || lms.length < 468) return null;

    let a: NormalizedLandmark;
    let b: NormalizedLandmark;
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
    if (!(ipdPx2d > 4)) return null;

    // Undo foreshortening from head yaw (and pitch) so turning the head doesn't fake depth.
    const fore = this.foreshortening(result, a, b, W, H);
    const ipdPx = ipdPx2d / fore;

    const fovRad = (Math.min(Math.max(this.settings.cameraFovDeg, 20), 150) * Math.PI) / 180;
    const f = W / 2 / Math.tan(fovRad / 2);
    const z = Math.min(Math.max((f * this.settings.ipdCm) / ipdPx, 10), 400);

    const u = ((a.x + b.x) / 2) * W;
    const v = ((a.y + b.y) / 2) * H;
    const xCam = (-(u - W / 2) * z) / f;
    const yCam = (-(v - H / 2) * z) / f;

    const x = xCam;
    const y = yCam + this.settings.screen.heightCm / 2 + this.settings.cameraOffsetYcm;
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
  private foreshortening(
    result: FaceLandmarkerResult,
    a: NormalizedLandmark,
    b: NormalizedLandmark,
    W: number,
    H: number,
  ): number {
    let c = 1;
    const m = result.facialTransformationMatrixes?.[0]?.data;
    if (m && m.length >= 16) {
      const inPlane = Math.hypot(m[0], m[1]);
      const full = Math.hypot(m[0], m[1], m[2]);
      if (full > 1e-6) c = inPlane / full;
    } else {
      const d2 = Math.hypot((b.x - a.x) * W, (b.y - a.y) * H);
      const d3 = Math.hypot(d2, (b.z - a.z) * W);
      if (d3 > 1e-6) c = d2 / d3;
    }
    return Number.isFinite(c) ? Math.min(Math.max(c, 0.5), 1) : 1;
  }
}

function midpoint(p: NormalizedLandmark, q: NormalizedLandmark): NormalizedLandmark {
  return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, z: (p.z + q.z) / 2, visibility: 0 };
}
