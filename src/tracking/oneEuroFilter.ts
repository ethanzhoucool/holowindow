/**
 * One Euro filter (Casiez, Roussel, Vogel — CHI 2012).
 *
 * An adaptive low-pass filter: at low speeds the cutoff is `minCutoff` (kills jitter),
 * and it rises with speed (`beta * |velocity|`) so fast motion has little lag.
 */
export interface OneEuroParams {
  /** Hz. Cutoff when the signal is still. Lower = less jitter, more lag. */
  minCutoff: number;
  /** Speed coefficient. Higher = less lag during fast motion. */
  beta: number;
  /** Hz. Cutoff for the derivative estimate. */
  dCutoff: number;
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private lastT = 0;

  constructor(public params: OneEuroParams) {}

  reset(): void {
    this.x = null;
    this.dx = 0;
  }

  /** @param value raw sample  @param tSec timestamp in seconds */
  filter(value: number, tSec: number): number {
    if (this.x === null) {
      this.x = value;
      this.dx = 0;
      this.lastT = tSec;
      return value;
    }
    // Guard against duplicate / out-of-order timestamps and long stalls.
    const dt = Math.min(Math.max(tSec - this.lastT, 1e-3), 0.5);
    this.lastT = tSec;

    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.params.dCutoff, dt) * (rawDx - this.dx);

    const cutoff = this.params.minCutoff + this.params.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

/**
 * Map the user-facing smoothing slider (0 = responsive, 1 = very smooth) to filter params.
 * Interpolated logarithmically, since perceived lag/jitter scale multiplicatively.
 *   s = 0   → minCutoff 2.5 Hz, beta 1.0
 *   s = 0.5 → minCutoff 0.5 Hz, beta 0.1   (still ~45 ms lag at 30 cm/s head motion)
 *   s = 1   → minCutoff 0.1 Hz, beta 0.01
 * Units: positions are in cm, so beta is in 1/cm.
 */
export function smoothingToParams(smoothing: number): OneEuroParams {
  const s = Math.min(Math.max(smoothing, 0), 1);
  return {
    minCutoff: 2.5 * Math.pow(0.04, s),
    beta: 1.0 * Math.pow(0.01, s),
    dCutoff: 1.0,
  };
}
