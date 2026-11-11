// STUB — to be implemented. Keep this exact public API.
import { DEFAULT_POSE, type HeadPose, type HeadSource, type Settings } from '../types';

export class FaceTracker implements HeadSource {
  readonly name = 'face';
  constructor(_settings: Settings, _video: HTMLVideoElement) {}
  updateSettings(_settings: Settings): void {}
  /** Treat the current head position as the straight-on (x=0,y=0) position. */
  recenter(): void {}
  async start(): Promise<void> {
    throw new Error('not implemented');
  }
  stop(): void {}
  /** Pose relative to the centre of the whole MONITOR, in cm. */
  getPose(): HeadPose {
    return { ...DEFAULT_POSE };
  }
}
