/**
 * Public transit: an elevated metro loop over the arterials (a rounded
 * rectangle through the middle of the city, clear of the elevated highways and
 * the coast) with stations every ~600 m, plus street-level subway entrances.
 * Pure geometry and placement; the renderer builds the viaduct and runs trains.
 */
import type { Box3, District, Emitter, RGB, Rect, SignSpec, Street } from './types';
import type { Zoning } from './zoning';
import { districtAt } from './zoning';
import type { Rng } from './rng';

export interface MetroStation {
  /** Arc length along the loop. */
  s: number;
  x: number;
  z: number;
  axis: 'x' | 'z';
  name: string;
}

export interface MetroLine {
  /** Track centre rectangle (rounded at the corners by `radius`). */
  rect: Rect;
  radius: number;
  /** Rail level (deck top). */
  y: number;
  /** Deck width (two tracks). */
  width: number;
  length: number;
  stations: MetroStation[];
  /** Pillar positions as arc lengths (kept clear of road crossings). */
  pillars: number[];
  color: RGB;
}

export interface SubwayEntrance {
  x: number;
  z: number;
  /** Facing (unit vector toward the street). */
  nx: number;
  nz: number;
}

export interface Transit {
  metro: MetroLine[];
  entrances: SubwayEntrance[];
}

/** Position and heading on a metro loop at arc length s. */
export function metroAt(m: MetroLine, s: number): { x: number; z: number; dx: number; dz: number; straight: boolean } {
  const { x0, z0, x1, z1 } = m.rect;
  const R = m.radius;
  const a = x1 - x0 - 2 * R;
  const b = z1 - z0 - 2 * R;
  const q = (Math.PI / 2) * R;
  let t = ((s % m.length) + m.length) % m.length;
  const arc = (cx: number, cz: number, a0: number, tt: number): { x: number; z: number; dx: number; dz: number; straight: boolean } => {
    const ang = a0 + tt / R;
    return { x: cx + Math.cos(ang) * R, z: cz + Math.sin(ang) * R, dx: -Math.sin(ang), dz: Math.cos(ang), straight: false };
  };
  // north edge, heading +x
  if (t < a) return { x: x0 + R + t, z: z0, dx: 1, dz: 0, straight: true };
  t -= a;
  if (t < q) return arc(x1 - R, z0 + R, -Math.PI / 2, t);
  t -= q;
  // east edge, heading +z
  if (t < b) return { x: x1, z: z0 + R + t, dx: 0, dz: 1, straight: true };
  t -= b;
  if (t < q) return arc(x1 - R, z1 - R, 0, t);
  t -= q;
  // south edge, heading -x
  if (t < a) return { x: x1 - R - t, z: z1, dx: -1, dz: 0, straight: true };
  t -= a;
  if (t < q) return arc(x0 + R, z1 - R, Math.PI / 2, t);
  t -= q;
  // west edge, heading -z
  if (t < b) return { x: x0, z: z1 - R - t, dx: 0, dz: -1, straight: true };
  t -= b;
  return arc(x0 + R, z0 + R, Math.PI, Math.min(t, q));
}

export function makeTransit(z: Zoning, streets: readonly Street[], rng: Rng): Transit {
  const metro: MetroLine[] = [];
  const entrances: SubwayEntrance[] = [];
  // ---- pick the loop: inner, non-highway arterial lines, over land on every edge
  const xsOk = z.linesX.map((l, i) => i > 0 && i < z.xs.length - 1 && l.kind !== 'highway');
  const zsOk = z.linesZ.map((l, j) => j > 0 && l.kind !== 'highway');
  const pickPair = (ok: boolean[], n: number, lo: number, hi: number): [number, number] | null => {
    const cands = ok.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    if (cands.length < 2) return null;
    const near = (f: number): number => cands.reduce((best, i) => (Math.abs(i - f * (n - 1)) < Math.abs(best - f * (n - 1)) ? i : best), cands[0] as number);
    let a = near(lo);
    let b = near(hi);
    if (b - a < 2) {
      a = cands[0] as number;
      b = cands[cands.length - 1] as number;
    }
    return b - a >= 2 ? [a, b] : null;
  };
  const r = rng.fork('metro');
  const px = pickPair(xsOk, z.xs.length, r.range(0.18, 0.3), r.range(0.7, 0.82));
  // keep the south edge a row north of the shore across the loop's columns
  let pz: [number, number] | null = null;
  if (px) {
    let minLand = Infinity;
    for (let c = px[0]; c < px[1]; c++) minLand = Math.min(minLand, z.landRows[c] ?? 0);
    const zsOk2 = zsOk.map((v, j) => v && j <= minLand - 1);
    pz = pickPair(zsOk2, z.zs.length, r.range(0.15, 0.28), r.range(0.62, 0.75));
  }
  if (px && pz) {
    const rect: Rect = { x0: z.xs[px[0]] as number, x1: z.xs[px[1]] as number, z0: z.zs[pz[0]] as number, z1: z.zs[pz[1]] as number };
    const radius = 46;
    const a = rect.x1 - rect.x0 - 2 * radius;
    const b = rect.z1 - rect.z0 - 2 * radius;
    const length = 2 * (a + b) + 2 * Math.PI * radius;
    const m: MetroLine = { rect, radius, y: 34, width: 10, length, stations: [], pillars: [], color: r.pick([[0.1, 0.85, 1], [1, 0.25, 0.6], [1, 0.75, 0.15]] as RGB[]) };
    // road crossings along the loop: every arterial and local street that meets an edge
    const crossings: number[] = [];
    for (let s = 0; s < length; s += 2) {
      const p = metroAt(m, s);
      if (!p.straight) continue;
      for (const st of streets) {
        if (st.kind === 'alley') continue;
        const along = p.dx !== 0 ? 'z' : 'x'; // streets running across the track
        if (st.axis !== along) continue;
        const c = along === 'z' ? p.x : p.z;
        const o = along === 'z' ? p.z : p.x;
        if (Math.abs(st.pos - c) < st.road / 2 + 3 && o >= st.lo - 1 && o <= st.hi + 1) {
          crossings.push(s);
          break;
        }
      }
    }
    const clear = (s: number): boolean => !crossings.some((c) => Math.abs(c - s) < 10);
    for (let s = 18; s < length; s += 36) {
      if (!metroAt(m, s).straight) continue;
      let t = s;
      for (let k = 0; k < 6 && !clear(t); k++) t += 4;
      if (clear(t) && metroAt(m, t).straight) m.pillars.push(t);
    }
    // stations, mid-edge where possible
    const n = Math.max(4, Math.floor(length / 620));
    for (let k = 0; k < n; k++) {
      let s = ((k + 0.5) / n) * length;
      for (let g = 0; g < 40 && !metroAt(m, s).straight; g++) s += 8;
      for (let g = 0; g < 10 && (!metroAt(m, s - 45).straight || !metroAt(m, s + 45).straight); g++) s += 10;
      const p = metroAt(m, s);
      if (!p.straight) continue;
      const di = districtAt(z, p.x + (p.dz !== 0 ? 30 : 0), p.z + (p.dx !== 0 ? 30 : 0));
      const d = di >= 0 ? (z.districts[di] as District) : null;
      const name = (d ? d.name : 'Central').toUpperCase().slice(0, 16);
      m.stations.push({ s, x: p.x, z: p.z, axis: p.dx !== 0 ? 'x' : 'z', name });
    }
    metro.push(m);
    // a street-level entrance under each station, on the sidewalk
    for (const st of m.stations) {
      const side = r.chance(0.5) ? 1 : -1;
      const off = 14;
      if (st.axis === 'x') entrances.push({ x: st.x + r.range(-25, 25), z: st.z + side * off, nx: 0, nz: -side });
      else entrances.push({ x: st.x + side * off, z: st.z + r.range(-25, 25), nx: -side, nz: 0 });
    }
  }
  // ---- more subway entrances along arterials elsewhere
  const re = rng.fork('subway');
  for (const st of streets) {
    if (st.kind !== 'arterial' || st.hi - st.lo < 300) continue;
    if (!re.chance(0.45)) continue;
    const along = st.lo + (st.hi - st.lo) * re.range(0.3, 0.7);
    const side = re.chance(0.5) ? 1 : -1;
    const off = st.road / 2 + st.walk * 0.55;
    if (st.axis === 'x') entrances.push({ x: along, z: st.pos + side * off, nx: 0, nz: -side });
    else entrances.push({ x: st.pos + side * off, z: along, nx: -side, nz: 0 });
  }
  return { metro, entrances };
}

/** Collision boxes for the viaduct, pillars and stations. */
export function transitBoxes(t: Transit): Box3[] {
  const out: Box3[] = [];
  for (const m of t.metro) {
    const hw = m.width / 2;
    const yb = m.y - 2.2;
    const yt = m.y + 1.4;
    const { x0, z0, x1, z1 } = m.rect;
    const R = m.radius;
    out.push({ x0: x0 + R, x1: x1 - R, z0: z0 - hw, z1: z0 + hw, y0: yb, y1: yt });
    out.push({ x0: x0 + R, x1: x1 - R, z0: z1 - hw, z1: z1 + hw, y0: yb, y1: yt });
    out.push({ x0: x0 - hw, x1: x0 + hw, z0: z0 + R, z1: z1 - R, y0: yb, y1: yt });
    out.push({ x0: x1 - hw, x1: x1 + hw, z0: z0 + R, z1: z1 - R, y0: yb, y1: yt });
    // corners as a few boxes along the arc
    for (let s = 0; s < m.length; s += 6) {
      const p = metroAt(m, s);
      if (p.straight) continue;
      out.push({ x0: p.x - hw, x1: p.x + hw, z0: p.z - hw, z1: p.z + hw, y0: yb, y1: yt });
    }
    for (const s of m.pillars) {
      const p = metroAt(m, s);
      out.push({ x0: p.x - 1.6, x1: p.x + 1.6, z0: p.z - 1.6, z1: p.z + 1.6, y0: 0, y1: yb });
    }
    for (const st of m.stations) {
      const L = 42;
      const W = m.width / 2 + 5;
      if (st.axis === 'x') out.push({ x0: st.x - L, x1: st.x + L, z0: st.z - W, z1: st.z + W, y0: yb, y1: m.y + 7 });
      else out.push({ x0: st.x - W, x1: st.x + W, z0: st.z - L, z1: st.z + L, y0: yb, y1: m.y + 7 });
    }
  }
  return out;
}

/** Station lights and the under-deck lamps for the light volume; station name signs. */
export function transitDressing(t: Transit): { emitters: Emitter[]; signs: SignSpec[] } {
  const emitters: Emitter[] = [];
  const signs: SignSpec[] = [];
  for (const m of t.metro) {
    for (const s of m.pillars) {
      const p = metroAt(m, s);
      emitters.push({ x: p.x, y: m.y - 4, z: p.z, r: 1.2, g: 0.8, b: 0.45, radius: 16, src: 'lamp' });
    }
    for (const st of m.stations) {
      for (const k of [-24, 0, 24]) {
        const x = st.axis === 'x' ? st.x + k : st.x;
        const zz = st.axis === 'x' ? st.z : st.z + k;
        emitters.push({ x, y: m.y + 3, z: zz, r: 2.2, g: 2.4, b: 2.7, radius: 24, src: 'lamp' });
      }
      // name boards on both canopy faces, in the line colour
      for (const side of [-1, 1]) {
        const off = m.width / 2 + 5.2;
        const nx = st.axis === 'x' ? 0 : side;
        const nz = st.axis === 'x' ? side : 0;
        signs.push({
          kind: 'fascia',
          culture: 'us',
          x: st.x + nx * off,
          y: m.y + 6.2,
          z: st.z + nz * off,
          nx,
          nz,
          wnx: nx,
          wnz: nz,
          w: Math.min(30, st.name.length * 1.5 + 4),
          h: 1.5,
          depth: 0.3,
          arm: 0,
          text: st.name,
          glyphs: [],
          vertical: false,
          col: m.color,
          col2: [1, 1, 1],
          intensity: 2.6,
          flicker: 0,
          lightbox: true,
          frame: true,
          twoSided: false,
          seed: (st.s * 0.618) % 1,
        });
      }
    }
  }
  for (const e of t.entrances) emitters.push({ x: e.x, y: 3, z: e.z, r: 0.6, g: 1.4, b: 1.8, radius: 9, src: 'lamp' });
  return { emitters, signs };
}
