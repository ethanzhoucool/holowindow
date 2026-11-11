import { describe, expect, it } from 'vitest';
import {
  estimateHeadPosition,
  foreshortening,
  IRIS_A,
  IRIS_B,
  nextDetectTimestamp,
  Z_MAX_CM,
  Z_MIN_CM,
  type Landmark,
  type PoseSettings,
} from './poseMath';

const W = 640;
const H = 480;

const SETTINGS: PoseSettings = {
  screen: { widthCm: 30.4, heightCm: 19.7 },
  ipdCm: 6.3,
  cameraFovDeg: 60,
  cameraOffsetYcm: 0.8,
};

function focalPx(fovDeg: number, width = W): number {
  return width / 2 / Math.tan((fovDeg * Math.PI) / 360);
}

/**
 * 478 landmarks with the two irises placed so their midpoint is at pixel (cu, cv) and they are
 * `ipdPx` apart horizontally. `dz` sets the normalised depth difference between the eyes.
 */
function face(cu: number, cv: number, ipdPx: number, dz = 0, count = 478): Landmark[] {
  const lms: Landmark[] = Array.from({ length: count }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  if (count > IRIS_B) {
    lms[IRIS_A] = { x: (cu - ipdPx / 2) / W, y: cv / H, z: -dz / 2 };
    lms[IRIS_B] = { x: (cu + ipdPx / 2) / W, y: cv / H, z: dz / 2 };
  }
  return lms;
}

/** Column-major 4x4 with a rotation of `deg` about the camera's y axis (head yaw). */
function yawMatrix(deg: number): number[] {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  // columns: x axis, y axis, z axis, translation
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, -50, 1];
}

/** y of a face centred in the image (camera axis) in monitor coordinates. */
function cameraAxisY(s: PoseSettings): number {
  return s.screen.heightCm / 2 + s.cameraOffsetYcm;
}

describe('estimateHeadPosition — depth', () => {
  it('centred face: z = f * ipd / ipdPx with f = (W/2)/tan(fov/2)', () => {
    const ipdPx = 60;
    const p = estimateHeadPosition(face(W / 2, H / 2, ipdPx), W, H, SETTINGS)!;
    const f = focalPx(60);
    expect(p).not.toBeNull();
    expect(p.z).toBeCloseTo((f * 6.3) / ipdPx, 6);
    expect(p.z).toBeCloseTo(58.19, 1);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(cameraAxisY(SETTINGS), 9);
  });

  it('halving the eye spacing doubles z', () => {
    const near = estimateHeadPosition(face(W / 2, H / 2, 80), W, H, SETTINGS)!;
    const far = estimateHeadPosition(face(W / 2, H / 2, 40), W, H, SETTINGS)!;
    expect(far.z / near.z).toBeCloseTo(2, 9);
  });

  it('respects ipdCm and cameraFovDeg', () => {
    const base = estimateHeadPosition(face(W / 2, H / 2, 60), W, H, SETTINGS)!;
    const bigIpd = estimateHeadPosition(face(W / 2, H / 2, 60), W, H, { ...SETTINGS, ipdCm: 7 })!;
    expect(bigIpd.z / base.z).toBeCloseTo(7 / 6.3, 9);
    const wide = estimateHeadPosition(face(W / 2, H / 2, 60), W, H, { ...SETTINGS, cameraFovDeg: 90 })!;
    expect(wide.z).toBeCloseTo((focalPx(90) * 6.3) / 60, 6);
    expect(wide.z).toBeLessThan(base.z);
  });

  it('is resolution independent (same normalised face, different video size)', () => {
    const lms = face(W / 2, H / 2, 60);
    const a = estimateHeadPosition(lms, W, H, SETTINGS)!;
    const b = estimateHeadPosition(lms, W * 2, H * 2, SETTINGS)!;
    expect(b.z).toBeCloseTo(a.z, 9);
  });

  it('uses tilted (rolled) eye spacing via its full 2D length', () => {
    const lms = face(W / 2, H / 2, 0);
    // 60 px apart along a 45° line
    const d = 60 / Math.SQRT2;
    lms[IRIS_A] = { x: (W / 2 - d / 2) / W, y: (H / 2 - d / 2) / H, z: 0 };
    lms[IRIS_B] = { x: (W / 2 + d / 2) / W, y: (H / 2 + d / 2) / H, z: 0 };
    const p = estimateHeadPosition(lms, W, H, SETTINGS)!;
    expect(p.z).toBeCloseTo((focalPx(60) * 6.3) / 60, 6);
  });
});

describe('estimateHeadPosition — lateral signs (unmirrored webcam image)', () => {
  it("a face on the image's LEFT maps to +x (viewer's right)", () => {
    const p = estimateHeadPosition(face(W / 4, H / 2, 60), W, H, SETTINGS)!;
    expect(p.x).toBeGreaterThan(0);
    // x = -(u - cx) * z / f
    expect(p.x).toBeCloseTo((-(W / 4 - W / 2) * p.z) / focalPx(60), 9);
  });

  it("a face on the image's RIGHT maps to -x", () => {
    const p = estimateHeadPosition(face((3 * W) / 4, H / 2, 60), W, H, SETTINGS)!;
    expect(p.x).toBeLessThan(0);
  });

  it('a face higher in the image maps to +y', () => {
    const centre = estimateHeadPosition(face(W / 2, H / 2, 60), W, H, SETTINGS)!;
    const high = estimateHeadPosition(face(W / 2, H / 4, 60), W, H, SETTINGS)!;
    const low = estimateHeadPosition(face(W / 2, (3 * H) / 4, 60), W, H, SETTINGS)!;
    expect(high.y).toBeGreaterThan(centre.y);
    expect(low.y).toBeLessThan(centre.y);
    expect(high.y - centre.y).toBeCloseTo(((H / 4) * centre.z) / focalPx(60), 9);
  });

  it('cameraOffsetYcm shifts y one-for-one; screen height shifts it by half', () => {
    const lms = face(W / 3, H / 3, 60);
    const base = estimateHeadPosition(lms, W, H, SETTINGS)!;
    const raised = estimateHeadPosition(lms, W, H, { ...SETTINGS, cameraOffsetYcm: SETTINGS.cameraOffsetYcm + 2 })!;
    expect(raised.y - base.y).toBeCloseTo(2, 9);
    const taller = estimateHeadPosition(lms, W, H, {
      ...SETTINGS,
      screen: { ...SETTINGS.screen, heightCm: SETTINGS.screen.heightCm + 10 },
    })!;
    expect(taller.y - base.y).toBeCloseTo(5, 9);
    // x and z are unaffected by camera placement
    expect(raised.x).toBeCloseTo(base.x, 9);
    expect(taller.z).toBeCloseTo(base.z, 9);
  });

  it('a head level with the camera is above the monitor centre by H/2 + offset', () => {
    const p = estimateHeadPosition(face(W / 2, H / 2, 60), W, H, { ...SETTINGS, cameraOffsetYcm: 0 })!;
    expect(p.y).toBeCloseTo(SETTINGS.screen.heightCm / 2, 9);
  });
});

describe('estimateHeadPosition — head-turn correction', () => {
  const trueIpdPx = 60;
  const reference = estimateHeadPosition(face(W / 2, H / 2, trueIpdPx), W, H, SETTINGS)!;

  it.each([15, 30, 45, -40])('transform matrix: z stays stable at %i° yaw', (deg) => {
    const visible = trueIpdPx * Math.cos((deg * Math.PI) / 180);
    const turned = estimateHeadPosition(face(W / 2, H / 2, visible), W, H, SETTINGS, yawMatrix(deg))!;
    expect(turned.z).toBeCloseTo(reference.z, 6);
  });

  it('without correction, the same turn would fake a larger distance', () => {
    const visible = trueIpdPx * Math.cos(Math.PI / 4);
    const naive = estimateHeadPosition(face(W / 2, H / 2, visible), W, H, SETTINGS, yawMatrix(0))!;
    expect(naive.z).toBeGreaterThan(reference.z * 1.3);
  });

  it('landmark-z fallback (no matrix) also keeps z stable', () => {
    const deg = 35;
    const t = (deg * Math.PI) / 180;
    const visible = trueIpdPx * Math.cos(t);
    // Landmark z is on the same scale as normalised x, i.e. pixels / W.
    const dz = (trueIpdPx * Math.sin(t)) / W;
    const turned = estimateHeadPosition(face(W / 2, H / 2, visible, dz), W, H, SETTINGS)!;
    expect(turned.z).toBeCloseTo(reference.z, 6);
  });

  it('a matrix shorter than 16 entries is ignored in favour of landmark z', () => {
    const p = estimateHeadPosition(face(W / 2, H / 2, trueIpdPx), W, H, SETTINGS, [0, 0, 1])!;
    expect(p.z).toBeCloseTo(reference.z, 9);
  });

  it('foreshortening is clamped to [0.5, 1] for extreme turns', () => {
    const a: Landmark = { x: 0.45, y: 0.5, z: 0 };
    const b: Landmark = { x: 0.55, y: 0.5, z: 0 };
    expect(foreshortening(a, b, W, H, yawMatrix(80))).toBe(0.5);
    expect(foreshortening(a, b, W, H, yawMatrix(0))).toBe(1);
    expect(foreshortening(a, b, W, H, [NaN, NaN, NaN, ...new Array(13).fill(0)])).toBe(1);
    // An 80° turn is corrected only by 1/0.5, not 1/cos(80°) ≈ 5.8.
    const visible = trueIpdPx * Math.cos((80 * Math.PI) / 180);
    const p = estimateHeadPosition(face(W / 2, H / 2, visible), W, H, SETTINGS, yawMatrix(80))!;
    expect(p.z).toBeCloseTo((focalPx(60) * 6.3) / (visible / 0.5), 6);
  });
});

describe('estimateHeadPosition — clamping and rejection', () => {
  it(`clamps z to [${Z_MIN_CM}, ${Z_MAX_CM}] cm`, () => {
    const far = estimateHeadPosition(face(W / 2, H / 2, 5), W, H, SETTINGS)!;
    expect(far.z).toBe(Z_MAX_CM);
    const near = estimateHeadPosition(face(W / 2, H / 2, 600), W, H, SETTINGS)!;
    expect(near.z).toBe(Z_MIN_CM);
  });

  it('clamps the camera FOV to [20°, 150°]', () => {
    const lms = face(W / 2, H / 2, 60);
    const huge = estimateHeadPosition(lms, W, H, { ...SETTINGS, cameraFovDeg: 179 })!;
    const max = estimateHeadPosition(lms, W, H, { ...SETTINGS, cameraFovDeg: 150 })!;
    expect(huge.z).toBeCloseTo(max.z, 9);
    const tiny = estimateHeadPosition(face(W / 2, H / 2, 300), W, H, { ...SETTINGS, cameraFovDeg: 1 })!;
    const min = estimateHeadPosition(face(W / 2, H / 2, 300), W, H, { ...SETTINGS, cameraFovDeg: 20 })!;
    expect(tiny.z).toBeCloseTo(min.z, 9);
  });

  it('rejects eye spacing of 4 px or less', () => {
    expect(estimateHeadPosition(face(W / 2, H / 2, 3.99), W, H, SETTINGS)).toBeNull();
    expect(estimateHeadPosition(face(W / 2, H / 2, 0), W, H, SETTINGS)).toBeNull();
    expect(estimateHeadPosition(face(W / 2, H / 2, 4.5), W, H, SETTINGS)).not.toBeNull();
  });

  it('rejects missing / truncated landmark sets and bad video sizes', () => {
    expect(estimateHeadPosition(undefined, W, H, SETTINGS)).toBeNull();
    expect(estimateHeadPosition([], W, H, SETTINGS)).toBeNull();
    expect(estimateHeadPosition(face(W / 2, H / 2, 60, 0, 467), W, H, SETTINGS)).toBeNull();
    expect(estimateHeadPosition(face(W / 2, H / 2, 60), 0, H, SETTINGS)).toBeNull();
  });

  it('rejects non-finite landmarks', () => {
    const lms = face(W / 2, H / 2, 60);
    lms[IRIS_A] = { x: NaN, y: 0.5, z: 0 };
    expect(estimateHeadPosition(lms, W, H, SETTINGS)).toBeNull();
  });

  it('falls back to eye-corner midpoints for the 468-point (no iris) mesh', () => {
    const lms = face(W / 2, H / 2, 0, 0, 468);
    const at = (u: number): Landmark => ({ x: u / W, y: 0.5, z: 0 });
    // eye A centred at 290 px, eye B at 350 px → 60 px apart, midpoint at image centre
    lms[33] = at(280);
    lms[133] = at(300);
    lms[362] = at(340);
    lms[263] = at(360);
    const p = estimateHeadPosition(lms, W, H, SETTINGS)!;
    expect(p.z).toBeCloseTo((focalPx(60) * 6.3) / 60, 6);
    expect(p.x).toBeCloseTo(0, 9);
  });
});

describe('nextDetectTimestamp', () => {
  it('passes a clock that is already increasing through unchanged', () => {
    expect(nextDetectTimestamp(1000, 0)).toBe(1000);
    expect(nextDetectTimestamp(1016.7, 1000)).toBe(1016.7);
  });

  it('stays strictly increasing for duplicate, backwards or sub-ms clocks', () => {
    let last = 0;
    const clock = [100, 100, 99, 100.2, 50, 101.5, 101.5, Infinity, NaN, 200];
    for (const now of clock) {
      const ts = nextDetectTimestamp(now, last);
      expect(Number.isFinite(ts)).toBe(true);
      expect(ts).toBeGreaterThan(last);
      expect(ts - last).toBeGreaterThanOrEqual(1);
      last = ts;
    }
  });
});
