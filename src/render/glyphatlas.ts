/**
 * A distance-field atlas of every glyph the signs use, generated in code at
 * startup: the Latin stroke font, 96 invented kana-like glyphs and 96 invented
 * block glyphs (all original shapes). One quad per glyph then draws a neon
 * letter (core + glow) or a dark lightbox letter straight from the field.
 *
 * Atlas: 16 x 16 cells of 64 px, R8 storing the unsigned distance to the
 * nearest stroke in glyph units (value * DMAX). Cells span 5 x 5 glyph units.
 */
import * as THREE from 'three/webgpu';
import { GLYPHS, pseudoGlyph, type Stroke } from '../core/glyphs';
import { Rng } from '../core/rng';

export const ATLAS = { cells: 16, px: 64, span: 5, dmax: 1.25 };
const LATIN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-./!:+&';
const KANA0 = 64;
const HANZI0 = 160;
const VARIANTS = 96;

/** Invented square block glyph on a 4 x 4 box (dense, stroke-heavy). */
export function blockGlyph(seed: number): Stroke[] {
  const r = new Rng(seed * 7919 + 13);
  const s: Stroke[] = [];
  const radical = r.int(3);
  if (radical === 0) {
    // left radical: a narrow box or a stem with ticks
    s.push([0.3, 3.8, 0.3, 0.2]);
    s.push([0, 2.8, 1.1, 2.8]);
    if (r.chance(0.5)) s.push([0.1, 1.4, 1.0, 1.9]);
  } else if (radical === 1) {
    // top radical: a roof
    s.push([0.2, 3.3, 2.0, 3.9, 3.8, 3.3]);
    s.push([2.0, 3.9, 2.0, 3.4]);
  } else {
    // enclosing frame
    s.push([0.2, 0.2, 0.2, 3.8, 3.8, 3.8, 3.8, 0.4, 3.4, 0.2]);
  }
  const x0 = radical === 0 ? 1.5 : 0.4;
  const yTop = radical === 1 ? 2.9 : 3.6;
  const n = r.intRange(3, 6);
  for (let i = 0; i < n; i++) {
    const k = r.int(5);
    if (k === 0) {
      const y = r.range(0.4, yTop);
      s.push([x0, y, 3.7, y]);
    } else if (k === 1) {
      const x = r.range(x0 + 0.2, 3.5);
      s.push([x, yTop, x, r.range(0.2, 1.6)]);
    } else if (k === 2) {
      const y0 = r.range(0.5, 1.5);
      const y1 = r.range(y0 + 0.8, yTop);
      s.push([x0 + 0.3, y1, x0 + 0.3, y0, 3.5, y0, 3.5, y1, x0 + 0.3, y1]);
    } else if (k === 3) {
      s.push([r.range(x0, 2.5), r.range(1.5, yTop), r.range(x0, 3.8), r.range(0.1, 1.2)]);
    } else {
      const x = r.range(x0, 3.4);
      const y = r.range(0.4, yTop);
      s.push([x, y, x + 0.35, y - 0.35]);
    }
  }
  return s;
}

/** Atlas cell for a sign item: a Latin character, or a glyph seed (1xxxxx kana-like, 2xxxxx block). */
export function glyphCell(item: string | number): number {
  if (typeof item === 'string') {
    const i = LATIN.indexOf(item.toUpperCase());
    return i < 0 ? -1 : i;
  }
  const fam = Math.floor(item / 100000);
  const v = item % VARIANTS;
  return fam === 2 ? HANZI0 + v : KANA0 + v;
}

/** Glyph box in glyph units (width, height) for layout: Latin 2x4, kana 2x4, block 4x4. */
export function glyphSize(item: string | number): [number, number] {
  if (typeof item === 'string') return [2, 4];
  return Math.floor(item / 100000) === 2 ? [4, 4] : [2, 4];
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px;
  const qy = ay + dy * t - py;
  return Math.sqrt(qx * qx + qy * qy);
}

let TEXTURE: THREE.DataTexture | null = null;

export function glyphAtlas(): THREE.DataTexture {
  if (TEXTURE) return TEXTURE;
  const { cells, px, span, dmax } = ATLAS;
  const size = cells * px;
  const data = new Uint8Array(size * size * 4);
  const cellStrokes: (Stroke[] | null)[] = new Array(cells * cells).fill(null);
  for (let i = 0; i < LATIN.length; i++) cellStrokes[i] = GLYPHS[LATIN[i] as string] ?? null;
  for (let v = 0; v < VARIANTS; v++) {
    cellStrokes[KANA0 + v] = pseudoGlyph(100000 + v * 7 + 3);
    cellStrokes[HANZI0 + v] = blockGlyph(200000 + v * 11 + 5);
  }
  for (let c = 0; c < cells * cells; c++) {
    const strokes = cellStrokes[c];
    const cx = (c % cells) * px;
    const cy = Math.floor(c / cells) * px;
    // glyph box centred in the 5 x 5 cell
    const isBlock = c >= HANZI0 && c < HANZI0 + VARIANTS;
    const ox = isBlock ? 0.5 : 1.5;
    const oy = 0.5;
    const segs: number[] = [];
    if (strokes) for (const s of strokes) for (let k = 0; k + 3 < s.length; k += 2) segs.push((s[k] as number) + ox, (s[k + 1] as number) + oy, (s[k + 2] as number) + ox, (s[k + 3] as number) + oy);
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        const gx = ((x + 0.5) / px) * span;
        const gy = ((y + 0.5) / px) * span;
        let d = dmax;
        for (let k = 0; k < segs.length; k += 4) {
          const dd = segDist(gx, gy, segs[k] as number, segs[k + 1] as number, segs[k + 2] as number, segs[k + 3] as number);
          if (dd < d) d = dd;
        }
        const o = ((cy + y) * size + cx + x) * 4;
        const val = Math.round((Math.min(d, dmax) / dmax) * 255);
        data[o] = val;
        data[o + 1] = val;
        data[o + 2] = val;
        data[o + 3] = 255;
      }
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  TEXTURE = tex;
  return tex;
}
