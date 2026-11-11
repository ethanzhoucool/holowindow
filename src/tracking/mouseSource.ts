// STUB — to be implemented. Keep this exact public API.
import { DEFAULT_POSE, type HeadPose, type HeadSource } from '../types';

/** Fallback: pointer position drives the head pose (relative to the VIEWPORT centre). */
export class MouseSource implements HeadSource {
  readonly name = 'mouse';
  constructor(_el: HTMLElement) {}
  async start(): Promise<void> {}
  stop(): void {}
  getPose(): HeadPose {
    return { ...DEFAULT_POSE };
  }
}
