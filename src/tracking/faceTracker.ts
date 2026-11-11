// Type-only: the runtime module is loaded with a dynamic import in start() so it is code-split
// out of the main bundle and only downloaded when the camera is enabled.
import type { FaceLandmarker, FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import { DEFAULT_POSE, type HeadPose, type HeadSource, type Settings } from '../types';
import { OneEuroFilter, smoothingToParams } from './oneEuroFilter';
import { estimateHeadPosition, nextDetectTimestamp, type Vec3 } from './poseMath';

/** Must match the installed @mediapipe/tasks-vision version (see package.json). */
const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.2/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

/** After the face disappears, hold the last pose this long before easing away (ms). */
const LOST_GRACE_MS = 150;
/** Time constant for easing back to DEFAULT_POSE once lost (s). ~95% after 1 s. */
const LOST_EASE_TAU = 0.33;
/** Time constant for confidence decay once lost (s). */
const CONFIDENCE_TAU = 0.35;
/** When the face comes back, blend from the eased pose to the tracked one over this long (ms). */
const REACQUIRE_BLEND_MS = 300;

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
  /** In-flight (or settled) landmarker creation; cleared on failure so a later start() retries. */
  private landmarkerPromise: Promise<FaceLandmarker> | null = null;
  private startPromise: Promise<void> | null = null;
  private running = false;
  /** Bumped on every start/stop so stale async work and loops bail out. */
  private generation = 0;
  private loop: FrameLoopHandle | null = null;
  /** Detection is suspended while the tab is hidden. */
  private paused = false;
  private visibilityListening = false;
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
    this.paused = false;
    this.cancelLoop();
    this.setVisibilityListener(false);
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

    // Start fetching the library + model now so the download overlaps the permission prompt.
    // loadLandmarker() attaches its own rejection handler, so a camera failure below that
    // abandons this promise can't surface as an unhandled rejection.
    const landmarkerReady = this.loadLandmarker();

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
      this.landmarker = await landmarkerReady;
    } catch (err) {
      if (gen === this.generation) this.stop();
      throw new Error(`Could not load face model: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (gen !== this.generation) throw new Error('Face tracking was stopped while starting');

    this.running = true;
    this.lastVideoTime = -1;
    this.setVisibilityListener(true);
    this.paused = document.hidden;
    this.scheduleNext(gen);
  }

  /** Shared, cached landmarker creation. Never produces an unhandled rejection on its own. */
  private loadLandmarker(): Promise<FaceLandmarker> {
    if (this.landmarker) return Promise.resolve(this.landmarker);
    if (!this.landmarkerPromise) {
      const p = this.createLandmarker();
      this.landmarkerPromise = p;
      p.then(
        (lm) => {
          // Kept across stop()/start() so a restart doesn't re-download the model.
          this.landmarker = lm;
        },
        () => {
          if (this.landmarkerPromise === p) this.landmarkerPromise = null;
        },
      );
    }
    return this.landmarkerPromise;
  }

  private async createLandmarker(): Promise<FaceLandmarker> {
    const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
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

  // ---------- tab visibility ----------

  private setVisibilityListener(on: boolean): void {
    if (on === this.visibilityListening) return;
    this.visibilityListening = on;
    if (on) document.addEventListener('visibilitychange', this.onVisibilityChange);
    else document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  private readonly onVisibilityChange = (): void => {
    if (!this.running) return;
    if (document.hidden) {
      if (this.paused) return;
      this.paused = true;
      this.cancelLoop();
      // Treat the hidden period as a face loss so the return re-acquires and blends smoothly.
      this.faceVisible = false;
    } else {
      if (!this.paused) return;
      this.paused = false;
      const gen = this.generation;
      // Some browsers pause media in background tabs; make sure frames are flowing again.
      if (this.video.paused) this.video.play().catch(() => {});
      this.lastVideoTime = -1;
      this.cancelLoop();
      this.scheduleNext(gen);
    }
  };

  // ---------- frame loop ----------

  private scheduleNext(gen: number): void {
    if (gen !== this.generation || !this.running || this.paused) return;
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
    if (gen !== this.generation || this.paused || !lm || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (!video.videoWidth || !video.videoHeight) return;

    // detectForVideo requires strictly increasing timestamps (ms).
    const now = performance.now();
    const ts = nextDetectTimestamp(now, this.lastDetectTs);
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

    const raw = estimateHeadPosition(
      result.faceLandmarks[0],
      video.videoWidth,
      video.videoHeight,
      this.settings,
      result.facialTransformationMatrixes?.[0]?.data,
    );
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
}
