import { DEFAULT_POSE, type HeadPose, type HeadSource } from '../types';

const RANGE_X_CM = 25;
const RANGE_Y_CM = 15;
const Z_MIN = 25;
const Z_MAX = 120;
/** Easing time constant toward the pointer target (s). */
const EASE_TAU = 0.08;

/** Fallback: pointer position drives the head pose (relative to the VIEWPORT centre). */
export class MouseSource implements HeadSource {
  readonly name = 'mouse';

  private readonly el: HTMLElement;
  private started = false;
  private target = { x: DEFAULT_POSE.x, y: DEFAULT_POSE.y, z: DEFAULT_POSE.z };
  private pose: HeadPose = { ...DEFAULT_POSE, confidence: 1, tracked: true };
  private lastMs = performance.now();
  private prevTouchAction = '';

  constructor(el: HTMLElement) {
    this.el = el;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Let touch drags on the canvas move the "head" instead of scrolling the page.
    this.prevTouchAction = this.el.style.touchAction;
    this.el.style.touchAction = 'none';
    // Move/leave on window so HUD overlays above the canvas don't swallow the motion.
    window.addEventListener('pointermove', this.onPointerMove, { passive: true });
    window.addEventListener('pointerdown', this.onPointerMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', this.onPointerLeave);
    this.el.addEventListener('wheel', this.onWheel, { passive: false });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.el.style.touchAction = this.prevTouchAction;
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerdown', this.onPointerMove);
    document.documentElement.removeEventListener('pointerleave', this.onPointerLeave);
    this.el.removeEventListener('wheel', this.onWheel);
  }

  getPose(): HeadPose {
    const now = performance.now();
    const dt = Math.min(Math.max((now - this.lastMs) / 1000, 0), 0.1);
    this.lastMs = now;
    const a = 1 - Math.exp(-dt / EASE_TAU);
    const p = this.pose;
    this.pose = {
      x: p.x + (this.target.x - p.x) * a,
      y: p.y + (this.target.y - p.y) * a,
      z: p.z + (this.target.z - p.z) * a,
      confidence: 1,
      tracked: true,
    };
    return { ...this.pose };
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const r = this.el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const nx = Math.min(Math.max(((e.clientX - r.left) / r.width) * 2 - 1, -1), 1);
    const ny = Math.min(Math.max(((e.clientY - r.top) / r.height) * 2 - 1, -1), 1);
    // Pointer right → head right (+x); pointer down (clientY grows) → head down (-y).
    this.target.x = nx * RANGE_X_CM;
    this.target.y = -ny * RANGE_Y_CM;
  };

  private readonly onPointerLeave = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    this.target.x = 0;
    this.target.y = 0;
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const scale = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 400 : 1;
    // Scroll down → move back; scroll up (or trackpad pinch-zoom in) → lean in.
    const dz = e.deltaY * scale * 0.05;
    this.target.z = Math.min(Math.max(this.target.z + dz, Z_MIN), Z_MAX);
  };
}
