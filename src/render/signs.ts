/**
 * Turns SignSpecs into geometry: kit boxes for panels, brackets and frames,
 * one quad per glyph (neon letters or dark lightbox ink from the glyph atlas),
 * capsule tubes for outlines and marquee bulbs, halos, LED screens and holograms.
 */
import type { RGB, SignSpec } from '../core/types';
import { clamp } from '../core/rng';
import { MeshBuilder } from './geometry';
import { addCapsule } from './neon';
import { glyphCell, glyphSize } from './glyphatlas';
import { CLS, type Inst, type KitGeom, type LodClass } from './kits';

export const GLYPH_EXTRAS = { aGl: 4, aCol: 3 };
export const SCREEN_EXTRAS = { aBB: 4, aCol: 3, aCol2: 3 };

export interface SignTargets {
  kit: (geom: KitGeom, lod: LodClass, i: Inst) => void;
  glyph: MeshBuilder;
  ink: MeshBuilder;
  tube: MeshBuilder;
  halo: MeshBuilder;
  screen: MeshBuilder;
  holo: MeshBuilder;
}

const mode = (s: SignSpec): number => (s.flicker === 3 ? 3 : s.flicker === 2 ? 2 : s.flicker === 1 ? 1 : 0);

function box(T: SignTargets, lod: LodClass, x: number, y: number, z: number, rot: number, sx: number, sy: number, sz: number, col: RGB, cls: number, seed: number, emit = 0, ecol: RGB = [0, 0, 0], m = 0): void {
  // kit boxes stand on their base: y is the bottom
  T.kit('box', lod, { x, y: y - sy / 2, z, rot, sx, sy, sz, emit, r: col[0], g: col[1], b: col[2], cs: cls + (seed % 1) * 0.999, er: ecol[0], eg: ecol[1], eb: ecol[2], mode: m });
}

interface Layout {
  items: (string | number)[];
  /** Glyph boxes in glyph units: x offset, y offset (lower-left of the glyph box). */
  pos: [number, number][];
  w: number;
  h: number;
}

function layoutH(items: (string | number)[]): Layout {
  const pos: [number, number][] = [];
  let x = 0;
  for (const it of items) {
    const [w] = glyphSize(it);
    pos.push([x, 0]);
    x += w + 1;
  }
  return { items, pos, w: Math.max(1, x - 1), h: 4 };
}

function layoutV(items: (string | number)[]): Layout {
  const pos: [number, number][] = [];
  const n = items.length;
  let maxW = 2;
  for (const it of items) maxW = Math.max(maxW, glyphSize(it)[0]);
  for (let i = 0; i < n; i++) {
    const [w] = glyphSize(items[i] as string | number);
    pos.push([(maxW - w) / 2, (n - 1 - i) * 5]);
  }
  return { items, pos, w: maxW, h: n * 5 - 1 };
}

function itemsOf(s: SignSpec): (string | number)[] {
  if (s.text) return [...s.text.toUpperCase()].filter((c) => c !== ' ' || !s.vertical).map((c) => (c === ' ' ? ' ' : c));
  return s.glyphs.slice();
}

/** Emit glyph quads for a layout centred at (cx, cy, cz) on a face with normal n and right vector r. */
function emitGlyphs(b: MeshBuilder, L: Layout, scale: number, cx: number, cy: number, cz: number, nx: number, nz: number, rx: number, rz: number, off: number, col: RGB, radius: number, m: number, seed: number): void {
  const ox0 = -L.w / 2;
  const oy0 = -L.h / 2;
  L.items.forEach((it, i) => {
    if (it === ' ') return;
    const cell = glyphCell(it);
    if (cell < 0) return;
    const [gw] = glyphSize(it);
    const [px, py] = L.pos[i] as [number, number];
    // the atlas cell spans 5 x 5 units with the glyph box at (1.5, 0.5) (narrow) or (0.5, 0.5) (block)
    const ox = gw === 4 ? 0.5 : 1.5;
    const u0 = (ox0 + px - ox) * scale;
    const v0 = (oy0 + py - 0.5) * scale;
    const u1 = u0 + 5 * scale;
    const v1 = v0 + 5 * scale;
    const phase = seed + i * 0.137;
    // broken signs: a few letters fault on their own
    const mm = m === 2 ? ((seed * 997 + i * 31) % 1 < 0.25 ? 2 : 0) : m;
    b.set('aGl', cell, mm, phase, radius);
    b.set('aCol', col[0], col[1], col[2]);
    const P = (u: number, v: number): [number, number, number] => [cx + rx * u + nx * off, cy + v, cz + rz * u + nz * off];
    const a = P(u0, v0);
    const bb = P(u1, v0);
    const c = P(u1, v1);
    const d = P(u0, v1);
    const ia = b.vert(a[0], a[1], a[2], nx, 0, nz, 0, 0);
    const ib = b.vert(bb[0], bb[1], bb[2], nx, 0, nz, 1, 0);
    const ic = b.vert(c[0], c[1], c[2], nx, 0, nz, 1, 1);
    const id = b.vert(d[0], d[1], d[2], nx, 0, nz, 0, 1);
    b.quad(ia, ib, ic, id);
  });
}

function scaled(c: RGB, k: number): RGB {
  return [c[0] * k, c[1] * k, c[2] * k];
}

function pale(c: RGB, k: number): RGB {
  return [(c[0] * 0.65 + 0.35) * k, (c[1] * 0.65 + 0.35) * k, (c[2] * 0.65 + 0.35) * k];
}

export function addSign(s: SignSpec, T: SignTargets): void {
  const nx = s.nx;
  const nz = s.nz;
  const rx = nz;
  const rz = -nx;
  const rot = Math.atan2(nx, nz);
  const I = s.intensity * (s.flicker === 3 ? 0.04 : 1);
  const col = scaled(s.col, I);
  const col2 = scaled(s.col2, I * 0.9);
  const m = mode(s);
  const faces = s.twoSided ? [1, -1] : [1];
  const dark: RGB = [0.02, 0.021, 0.026];
  const steel: RGB = [0.06, 0.06, 0.065];
  const seed = s.seed;

  // ---------------------------------------------------------- screens and holos
  if (s.kind === 'screen' || s.kind === 'billboard') {
    if (s.kind === 'billboard') {
      // posts down to the roof and a dark frame
      const postH = 1.8 + s.h / 2;
      for (const sd of [-1, 1]) box(T, 'small', s.x + rx * sd * (s.w / 2 - 0.4), s.y - s.h / 2 - 1.8 + postH / 2 + 0.0, s.z + rz * sd * (s.w / 2 - 0.4), rot, 0.25, postH, 0.25, steel, CLS.metal, seed);
    }
    box(T, 'mid', s.x - nx * 0.15, s.y, s.z - nz * 0.15, rot, s.w + 0.5, s.h + 0.5, 0.35, dark, CLS.metal, seed);
    const o = 0.04;
    // aBB: seed, program, aspect, glyph family (0 latin, 1 kana-like, 2 block)
    T.screen.set('aBB', seed, s.program ?? 0, s.w / s.h, s.culture === 'cn' ? 2 : (seed * 7) % 1 < 0.2 ? 2 : 1);
    T.screen.set('aCol', s.col[0], s.col[1], s.col[2]);
    T.screen.set('aCol2', s.col2[0], s.col2[1], s.col2[2]);
    const hw = s.w / 2;
    const hh = s.h / 2;
    const P = (u: number, v: number): [number, number, number] => [s.x + rx * u + nx * o, s.y + v, s.z + rz * u + nz * o];
    const pts = [P(-hw, -hh), P(hw, -hh), P(hw, hh), P(-hw, hh)];
    const uvs = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const ids = pts.map((p, i) => T.screen.vert(p[0], p[1], p[2], nx, 0, nz, uvs[i]![0]!, uvs[i]![1]!));
    T.screen.quad(ids[0]!, ids[1]!, ids[2]!, ids[3]!);
    if (s.frame) {
      const fr = clamp(Math.min(s.w, s.h) * 0.012, 0.03, 0.09);
      const q = [P(-hw - 0.2, -hh - 0.2), P(hw + 0.2, -hh - 0.2), P(hw + 0.2, hh + 0.2), P(-hw - 0.2, hh + 0.2)];
      for (let i = 0; i < 4; i++) {
        const a = q[i]!;
        const bb = q[(i + 1) % 4]!;
        addCapsule(T.tube, a[0] + nx * 0.06, a[1], a[2] + nz * 0.06, bb[0] + nx * 0.06, bb[1], bb[2] + nz * 0.06, nx, 0, nz, fr, 0.5, col2, seed, 0);
      }
    }
    // a soft glow round the whole panel (glare and haze): a capsule along the long side,
    // wide enough to reach past the short sides; building-sized walls glow tens of metres
    const shortHalf = Math.min(s.w, s.h) / 2;
    const glowR = shortHalf + clamp(shortHalf * 0.4, 1.2, 14);
    const half = Math.max(0, Math.max(s.w, s.h) / 2 - shortHalf);
    const ux = s.h > s.w ? 0 : rx;
    const uy = s.h > s.w ? 1 : 0;
    const uz = s.h > s.w ? 0 : rz;
    addCapsule(T.halo, s.x - ux * half + nx * 0.3, s.y - uy * half, s.z - uz * half + nz * 0.3, s.x + ux * half + nx * 0.3, s.y + uy * half, s.z + uz * half + nz * 0.3, nx, 0, nz, glowR, (s.program ?? 0) > 0 ? 0.035 : 0.05, col, seed, 0, 1.7);
    return;
  }
  if (s.kind === 'holo') {
    T.holo.set('aBB', seed, s.program ?? 0, s.w / s.h, s.culture === 'cn' ? 2 : s.culture === 'jp' ? 1 : seed * 7 % 1 < 0.5 ? 1 : 0);
    T.holo.set('aCol', col[0], col[1], col[2]);
    T.holo.set('aCol2', col2[0], col2[1], col2[2]);
    for (const [ax, az] of [
      [nx, nz],
      [rx, rz],
    ] as const) {
      const qx = az;
      const qz = -ax;
      const hw = s.w / 2;
      const hh = s.h / 2;
      const P = (u: number, v: number): [number, number, number] => [s.x + qx * u, s.y + v, s.z + qz * u];
      const pts = [P(-hw, -hh), P(hw, -hh), P(hw, hh), P(-hw, hh)];
      const ids = pts.map((p, i) => T.holo.vert(p[0], p[1], p[2], ax, 0, az, i === 1 || i === 2 ? 1 : 0, i >= 2 ? 1 : 0));
      T.holo.quad(ids[0]!, ids[1]!, ids[2]!, ids[3]!);
    }
    // projector pad, `arm` metres below the projection (on the plaza or the roof)
    box(T, 'small', s.x, s.y - s.h / 2 - s.arm + 0.4, s.z, rot, 2.2, 0.8, 2.2, steel, CLS.metal, seed, 2.5, scaled(s.col, 1), 0);
    return;
  }

  // ---------------------------------------------------------- backing structures
  switch (s.kind) {
    case 'fascia':
      box(T, 'small', s.x, s.y, s.z, rot, s.w, s.h, s.depth, s.lightbox ? [0.6, 0.6, 0.6] : dark, s.lightbox ? CLS.lightbox : CLS.painted, seed, s.lightbox ? 1 : 0, s.lightbox ? pale(s.col, I * 0.42) : [0, 0, 0], m);
      break;
    case 'blade': {
      box(T, s.lightbox ? 'mid' : 'small', s.x, s.y, s.z, rot, s.w, s.h, s.depth, s.lightbox ? [0.6, 0.6, 0.6] : dark, s.lightbox ? CLS.lightbox : CLS.painted, seed, s.lightbox ? 1 : 0, s.lightbox ? pale(s.col, I * 0.42) : [0, 0, 0], m);
      // brackets back to the wall
      const reach = Math.max(0.2, s.arm - s.w / 2);
      const brot = Math.atan2(s.wnx, s.wnz);
      for (const dy of [-1, 1]) {
        const y = s.y + dy * (s.h / 2 - 0.4);
        box(T, 'tiny', s.x - s.wnx * (s.w / 2 + reach / 2), y + 0.04, s.z - s.wnz * (s.w / 2 + reach / 2), brot, 0.07, 0.08, reach + 0.1, steel, CLS.metal, seed);
      }
      break;
    }
    case 'frame': {
      // steel frame around the panel, two arms back to the wall
      box(T, 'mid', s.x, s.y, s.z, rot, s.w, s.h, s.depth, s.lightbox ? [0.6, 0.6, 0.6] : dark, s.lightbox ? CLS.lightbox : CLS.painted, seed, s.lightbox ? 1 : 0, s.lightbox ? pale(s.col, I * 0.42) : [0, 0, 0], m);
      const t = 0.09;
      box(T, 'small', s.x, s.y + s.h / 2 + t / 2, s.z, rot, s.w + 0.2, t, 0.12, steel, CLS.metal, seed);
      box(T, 'small', s.x, s.y - s.h / 2 - t / 2, s.z, rot, s.w + 0.2, t, 0.12, steel, CLS.metal, seed);
      const reach = Math.max(0.3, s.arm - s.w / 2);
      const brot = Math.atan2(s.wnx, s.wnz);
      for (const dy of [-1, 1]) {
        const y = s.y + dy * (s.h / 2 - 0.2);
        box(T, 'tiny', s.x - s.wnx * (s.w / 2 + reach / 2), y + 0.05, s.z - s.wnz * (s.w / 2 + reach / 2), brot, 0.1, 0.1, reach + 0.1, steel, CLS.metal, seed);
      }
      break;
    }
    case 'roof': {
      const postH = s.h + 1.8;
      const py = s.y - s.h / 2 - 1.8 + postH / 2;
      for (const sd of [-1, 1]) box(T, 'small', s.x + rx * sd * (s.w / 2 - 0.3), py, s.z + rz * sd * (s.w / 2 - 0.3), rot, 0.16, postH, 0.16, steel, CLS.metal, seed);
      for (const dy of [-1, 1]) box(T, 'small', s.x, s.y + dy * (s.h / 2 + 0.08), s.z, rot, s.w, 0.1, 0.14, steel, CLS.metal, seed);
      break;
    }
    case 'marquee': {
      // canopy box over the sidewalk with a lightbox front
      box(T, 'small', s.x, s.y, s.z, rot, s.w, s.h, s.depth, [0.6, 0.55, 0.5], CLS.lightbox, seed, 1, pale(s.col2, I * 0.4), m);
      break;
    }
    default:
      break;
  }

  // ---------------------------------------------------------- letters
  const items = itemsOf(s);
  if (items.length > 0) {
    const L = s.vertical ? layoutV(items) : layoutH(items);
    const innerW = s.w * (s.vertical ? 0.78 : s.kind === 'logo' ? 0.96 : 0.88);
    const innerH = s.h * (s.vertical ? 0.92 : s.kind === 'logo' ? 0.9 : 0.66);
    const scale = Math.min(innerW / L.w, innerH / L.h);
    const ink = s.lightbox || s.kind === 'marquee';
    const front = s.kind === 'marquee' ? s.depth / 2 + 0.02 : s.depth / 2 + 0.025;
    for (const f of faces) {
      const fnx = nx * f;
      const fnz = nz * f;
      const frx = rx * f;
      const frz = rz * f;
      // the marquee text sits on the front face (facing the street), not the panel normal
      emitGlyphs(ink ? T.ink : T.glyph, L, scale, s.x, s.y, s.z, fnx, fnz, frx, frz, front, ink ? s.col : col, ink ? 0.22 : 0.15, m, seed);
    }
  }

  // ---------------------------------------------------------- outlines and bulbs
  if (s.frame || s.kind === 'marquee') {
    const fr = s.kind === 'marquee' ? 0.07 : clamp(Math.min(s.w, s.h) * 0.025, 0.018, 0.05);
    const inset = s.kind === 'marquee' ? -0.02 : Math.min(0.08, 0.08 * Math.min(s.w, s.h));
    const hw = s.w / 2 - inset;
    const hh = s.h / 2 - inset;
    const o = s.depth / 2 + 0.04;
    for (const f of faces) {
      const P = (u: number, v: number): [number, number, number] => [s.x + rx * f * u + nx * f * o, s.y + v, s.z + rz * f * u + nz * f * o];
      const q = [P(-hw, -hh), P(hw, -hh), P(hw, hh), P(-hw, hh)];
      for (let i = 0; i < 4; i++) {
        const a = q[i]!;
        const bb = q[(i + 1) % 4]!;
        addCapsule(T.tube, a[0], a[1], a[2], bb[0], bb[1], bb[2], nx * f, 0, nz * f, fr, 0.55, s.kind === 'marquee' ? scaled([1, 0.82, 0.5], I) : col2, seed, s.kind === 'marquee' ? 5 : m === 1 ? 1 : 0);
      }
    }
  }

  // ---------------------------------------------------------- halo
  if (s.flicker !== 3) {
    const o = s.depth / 2 + 0.3;
    const gain = s.kind === 'logo' ? 0.06 : s.lightbox ? 0.07 : 0.1;
    const glowCol = s.lightbox ? pale(s.col, I * 0.6) : col;
    for (const f of s.kind === 'blade' || s.kind === 'frame' ? faces : [1]) {
      if (s.vertical) {
        const glowR = clamp(s.w * 1.1 + 0.6, 0.8, 4.5);
        const half = Math.max(0, s.h / 2 - glowR * 0.5);
        addCapsule(T.halo, s.x + nx * f * o, s.y - half, s.z + nz * f * o, s.x + nx * f * o, s.y + half, s.z + nz * f * o, nx * f, 0, nz * f, glowR, gain, glowCol, seed, m === 1 ? 1 : 0, 1.7);
      } else {
        const glowR = clamp(s.h * 0.8, 0.5, 9);
        const half = Math.max(0, s.w / 2 - glowR * 0.5);
        addCapsule(T.halo, s.x - rx * half + nx * o, s.y, s.z - rz * half + nz * o, s.x + rx * half + nx * o, s.y, s.z + rz * half + nz * o, nx, 0, nz, glowR, gain, glowCol, seed, m === 1 ? 1 : 0, 1.7);
      }
    }
  }
}
