import type { ScreenSpec } from '../types';

export interface ScreenPreset {
  id: string;
  label: string;
  /** Visible diagonal in inches (marketing sizes are usually rounded up). */
  diagonalIn: number;
  aspect: [number, number];
}

const RAW_PRESETS: ScreenPreset[] = [
  { id: 'laptop-13', label: '13" laptop (16:10)', diagonalIn: 13.3, aspect: [16, 10] },
  { id: 'laptop-14', label: '14" laptop (16:10)', diagonalIn: 14.0, aspect: [16, 10] },
  { id: 'laptop-16', label: '16" laptop (16:10)', diagonalIn: 16.0, aspect: [16, 10] },
  { id: 'monitor-24', label: '24" monitor (16:9)', diagonalIn: 23.8, aspect: [16, 9] },
  { id: 'monitor-27', label: '27" monitor (16:9)', diagonalIn: 27.0, aspect: [16, 9] },
];

const round1 = (v: number): number => Math.round(v * 10) / 10;

export function presetSize(p: ScreenPreset): ScreenSpec {
  const diagCm = p.diagonalIn * 2.54;
  const [aw, ah] = p.aspect;
  const k = diagCm / Math.hypot(aw, ah);
  return { widthCm: round1(aw * k), heightCm: round1(ah * k) };
}

export const SCREEN_PRESETS = RAW_PRESETS.map((p) => ({ ...p, size: presetSize(p) }));

/** Returns the id of the preset matching `s` (within 3 mm), or null for custom sizes. */
export function matchPreset(s: ScreenSpec): string | null {
  for (const p of SCREEN_PRESETS) {
    if (Math.abs(p.size.widthCm - s.widthCm) < 0.3 && Math.abs(p.size.heightCm - s.heightCm) < 0.3) return p.id;
  }
  return null;
}
