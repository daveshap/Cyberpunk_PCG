/**
 * Neon-tube stroke font. Each glyph is a set of polylines on a grid that is
 * 2 units wide and 4 units tall (x right, y up). Also a generator for invented
 * "kana-like" glyphs so signs carry unreadable-but-plausible script without
 * borrowing any real writing system's characters.
 */
import { Rng } from './rng';

export type Stroke = number[]; // flattened [x0, y0, x1, y1, ...]

function parse(s: string): Stroke {
  const out: number[] = [];
  for (const pair of s.trim().split(/\s+/)) {
    const [x, y] = pair.split(',');
    out.push(Number(x), Number(y));
  }
  return out;
}

const RAW: Record<string, string[]> = {
  A: ['0,0 0,3 0.5,4 1.5,4 2,3 2,0', '0,2 2,2'],
  B: ['0,0 0,4 1.5,4 2,3.5 2,2.5 1.5,2 0,2', '1.5,2 2,1.5 2,0.5 1.5,0 0,0'],
  C: ['2,3.5 1.5,4 0.5,4 0,3.5 0,0.5 0.5,0 1.5,0 2,0.5'],
  D: ['0,0 0,4 1.5,4 2,3.5 2,0.5 1.5,0 0,0'],
  E: ['2,4 0,4 0,0 2,0', '0,2 1.5,2'],
  F: ['2,4 0,4 0,0', '0,2 1.5,2'],
  G: ['2,3.5 1.5,4 0.5,4 0,3.5 0,0.5 0.5,0 1.5,0 2,0.5 2,2 1,2'],
  H: ['0,0 0,4', '2,0 2,4', '0,2 2,2'],
  I: ['0.5,4 1.5,4', '1,4 1,0', '0.5,0 1.5,0'],
  J: ['2,4 2,0.5 1.5,0 0.5,0 0,0.5'],
  K: ['0,0 0,4', '2,4 0,2 2,0'],
  L: ['0,4 0,0 2,0'],
  M: ['0,0 0,4 1,2.4 2,4 2,0'],
  N: ['0,0 0,4 2,0 2,4'],
  O: ['0.5,0 1.5,0 2,0.5 2,3.5 1.5,4 0.5,4 0,3.5 0,0.5 0.5,0'],
  P: ['0,0 0,4 1.5,4 2,3.5 2,2.5 1.5,2 0,2'],
  Q: ['0.5,0 1.5,0 2,0.5 2,3.5 1.5,4 0.5,4 0,3.5 0,0.5 0.5,0', '1.1,1.1 2,0'],
  R: ['0,0 0,4 1.5,4 2,3.5 2,2.5 1.5,2 0,2', '1,2 2,0'],
  S: ['2,3.5 1.5,4 0.5,4 0,3.5 0,2.5 0.5,2 1.5,2 2,1.5 2,0.5 1.5,0 0.5,0 0,0.5'],
  T: ['0,4 2,4', '1,4 1,0'],
  U: ['0,4 0,0.5 0.5,0 1.5,0 2,0.5 2,4'],
  V: ['0,4 1,0 2,4'],
  W: ['0,4 0.5,0 1,2 1.5,0 2,4'],
  X: ['0,4 2,0', '0,0 2,4'],
  Y: ['0,4 1,2 2,4', '1,2 1,0'],
  Z: ['0,4 2,4 0,0 2,0'],
  '0': ['0.5,0 1.5,0 2,0.5 2,3.5 1.5,4 0.5,4 0,3.5 0,0.5 0.5,0', '0.5,0.6 1.5,3.4'],
  '1': ['0.4,3 1,4 1,0', '0.4,0 1.6,0'],
  '2': ['0,3.5 0.5,4 1.5,4 2,3.5 2,2.5 0,0 2,0'],
  '3': ['0,3.5 0.5,4 1.5,4 2,3.5 2,2.5 1.5,2 0.6,2', '1.5,2 2,1.5 2,0.5 1.5,0 0.5,0 0,0.5'],
  '4': ['1.5,0 1.5,4 0,1 2,1'],
  '5': ['2,4 0,4 0,2.2 1.5,2.5 2,2 2,0.5 1.5,0 0.5,0 0,0.5'],
  '6': ['2,3.5 1.5,4 0.5,4 0,3.5 0,0.5 0.5,0 1.5,0 2,0.5 2,1.5 1.5,2 0,2'],
  '7': ['0,4 2,4 0.7,0'],
  '8': [
    '0.5,2 0,2.5 0,3.5 0.5,4 1.5,4 2,3.5 2,2.5 1.5,2 0.5,2',
    '0.5,2 0,1.5 0,0.5 0.5,0 1.5,0 2,0.5 2,1.5 1.5,2',
  ],
  '9': ['0,0.5 0.5,0 1.5,0 2,0.5 2,3.5 1.5,4 0.5,4 0,3.5 0,2.5 0.5,2 2,2'],
  '-': ['0.3,2 1.7,2'],
  '.': ['1,0 1,0.35'],
  '/': ['0,0 2,4'],
  '!': ['1,4 1,1.3', '1,0 1,0.35'],
  ':': ['1,3 1,2.65', '1,1 1,1.35'],
  '+': ['0.2,2 1.8,2', '1,3.2 1,0.8'],
  '&': ['2,0 0.2,2.4 0.2,3.4 0.8,4 1.4,3.4 1.4,2.6 0,0.8 0.2,0.2 0.9,0 1.6,0.6'],
  ' ': [],
};

export const GLYPHS: Record<string, Stroke[]> = {};
for (const [k, v] of Object.entries(RAW)) GLYPHS[k] = v.map(parse);

export const GLYPH_W = 2;
export const GLYPH_H = 4;
export const ADVANCE = 3;
export const ROW_PITCH = 5.6;

/** Characters the sign name generator may emit. */
export function hasGlyph(ch: string): boolean {
  return GLYPHS[ch] !== undefined;
}

/** Deterministic invented glyph on the same grid: bar, stem, tail, tick. */
export function pseudoGlyph(seed: number): Stroke[] {
  const r = new Rng(seed);
  const strokes: Stroke[] = [];
  const barY = r.pick([3.2, 3.6, 2.8]);
  const style = r.int(4);
  if (style === 0) {
    // bar + stem + tail (a "ta"-like shape)
    const sx = r.range(0.7, 1.3);
    strokes.push([0, barY, 2, barY]);
    strokes.push([sx, 4, sx, r.range(0.4, 1.2)]);
    const tx = sx + r.pick([-1, 1]) * r.range(0.6, 1.1);
    strokes.push([sx, r.range(1.6, 2.4), Math.min(2, Math.max(0, tx)), 0]);
  } else if (style === 1) {
    // two verticals joined by a hook
    const a = r.range(0.2, 0.8);
    const b = r.range(1.2, 1.8);
    strokes.push([a, 4, a, 0.8, a + 0.5, 0]);
    strokes.push([b, 3.4, b, 0.4]);
    strokes.push([0, barY - 0.6, 2, barY - 0.6]);
  } else if (style === 2) {
    // box with a tick
    strokes.push([0.2, 3.6, 1.8, 3.6, 1.8, 0.6, 0.2, 0.6, 0.2, 3.6]);
    strokes.push([0.2, 2.1, 1.8, 2.1]);
    strokes.push([1.0, 4, 1.4, 4.0]);
  } else {
    // diagonal cross + dot
    strokes.push([0.2, 3.8, 1.8, 0.2]);
    strokes.push([1.8, 3.8, 0.2, 0.2]);
    strokes.push([r.range(0.4, 1.6), barY, r.range(0.4, 1.6) + 0.01, barY]);
  }
  if (r.chance(0.5)) strokes.push([1.6, 3.9, 1.95, 4.0]);
  return strokes;
}

export interface TextLayout {
  /** Polylines in glyph units, origin at the lower-left of the text block. */
  strokes: Stroke[];
  width: number;
  height: number;
}

/** Horizontal Latin text. Unknown characters are skipped. */
export function layoutText(text: string): TextLayout {
  const strokes: Stroke[] = [];
  let x = 0;
  let n = 0;
  for (const ch of text.toUpperCase()) {
    const g = GLYPHS[ch];
    if (!g) continue;
    for (const s of g) {
      const o: number[] = [];
      for (let i = 0; i < s.length; i += 2) o.push((s[i] as number) + x, s[i + 1] as number);
      strokes.push(o);
    }
    x += ADVANCE;
    n++;
  }
  return { strokes, width: Math.max(0, n * ADVANCE - (ADVANCE - GLYPH_W)), height: GLYPH_H };
}

/** Vertical stack: one glyph per row. Latin characters and pseudo glyph seeds mix. */
export function layoutStack(items: readonly (string | number)[]): TextLayout {
  const strokes: Stroke[] = [];
  const n = items.length;
  for (let i = 0; i < n; i++) {
    const it = items[i] as string | number;
    const g = typeof it === 'number' ? pseudoGlyph(it) : GLYPHS[it.toUpperCase()] ?? [];
    const yOff = (n - 1 - i) * ROW_PITCH;
    for (const s of g) {
      const o: number[] = [];
      for (let k = 0; k < s.length; k += 2) o.push(s[k] as number, (s[k + 1] as number) + yOff);
      strokes.push(o);
    }
  }
  return { strokes, width: GLYPH_W, height: n > 0 ? (n - 1) * ROW_PITCH + GLYPH_H : 0 };
}
