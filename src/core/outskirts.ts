/**
 * The sprawl beyond the city limits: a cheap ring of plain blocks (no signs,
 * no props) that carries the city to the horizon so the playable core never
 * ends at a cliff edge. Heights fall off with the distance from the core, with
 * the odd taller tower. Land only: nothing is placed on the sea side of the coast.
 */
import type { Dials, FacadeStyle, Rect, RGB } from './types';
import type { Rng } from './rng';

export interface OutskirtBuilding {
  rect: Rect;
  h: number;
  style: FacadeStyle;
  floorH: number;
  bayW: number;
  win: number;
  lit: number;
  warm: number;
  grime: number;
  base: RGB;
  accent: RGB;
  strips: number;
  seed: number;
}

export interface Outskirts {
  buildings: OutskirtBuilding[];
  /** Outer extent of the ring. */
  extent: Rect;
  /** The sprawl's street grid (for its lamps and traffic). */
  grid: OutskirtGrid;
}

/** Street centre lines of the sprawl. Lines inside `inner` (the city plus its ring road) carry no street. */
export interface OutskirtGrid {
  xs: number[];
  zs: number[];
  inner: Rect;
  extent: Rect;
  coastWest: number;
  coastEast: number;
}

const STYLES: readonly FacadeStyle[] = ['grid', 'balcony', 'panel', 'raw', 'metal', 'shop'];
const FLOOR: Record<string, number> = { grid: 3.3, balcony: 3.0, panel: 3.8, raw: 3.2, metal: 6.0, shop: 3.4 };
const WALLS: readonly RGB[] = [
  [0.16, 0.15, 0.14],
  [0.12, 0.12, 0.13],
  [0.18, 0.14, 0.12],
  [0.1, 0.11, 0.12],
  [0.15, 0.13, 0.11],
  [0.2, 0.19, 0.17],
];
const ACCENTS: readonly RGB[] = [
  [1, 0.1, 0.4],
  [0.1, 0.8, 1],
  [1, 0.6, 0.1],
  [0.6, 0.2, 1],
];

/** Outward grid lines from `from` (exclusive) to `to`, with random pitch. */
function lines(rng: Rng, from: number, to: number, p0: number, p1: number): number[] {
  const out: number[] = [];
  const dir = Math.sign(to - from);
  let x = from;
  for (let guard = 0; guard < 400; guard++) {
    x += dir * rng.range(p0, p1);
    if ((to - x) * dir < p0 * 0.5) break;
    out.push(x);
  }
  out.push(to);
  return out;
}

/**
 * @param bounds the city's land rect
 * @param coastWest shore z west of the city (sea is z > shore)
 * @param coastEast shore z east of the city
 * @param width how far the sprawl reaches beyond the bounds (m)
 */
export function makeOutskirts(rng: Rng, bounds: Rect, coastWest: number, coastEast: number, dials: Dials, width = 2100): Outskirts {
  const hive = dials.world === 'hive';
  const gap = hive ? 34 : 22; // ring road between the city and the sprawl
  const X0 = bounds.x0 - gap;
  const X1 = bounds.x1 + gap;
  const Z0 = bounds.z0 - gap;
  const Z1 = bounds.z1 + gap;
  // the hive has no coast: the ring closes round the south as well
  if (hive) coastWest = coastEast = bounds.z1 + width;
  const extent: Rect = { x0: bounds.x0 - width, z0: bounds.z0 - width, x1: bounds.x1 + width, z1: Math.max(coastWest, coastEast) };
  const xsW = lines(rng.fork('xw'), X0, extent.x0, 95, 150).reverse();
  const xsE = lines(rng.fork('xe'), X1, extent.x1, 95, 150);
  const xsMid = lines(rng.fork('xm'), X0, X1, hive ? 130 : 110, hive ? 180 : 160);
  const xs = [...xsW, X0, ...xsMid];
  if (xs[xs.length - 1] !== X1) xs.push(X1);
  xs.push(...xsE);
  const zsN = lines(rng.fork('zn'), Z0, extent.z0, 95, 150).reverse();
  const zsS = hive ? [...lines(rng.fork('zm'), Z0, Z1, 130, 180), ...lines(rng.fork('zs'), Z1, extent.z1, 95, 150)] : lines(rng.fork('zs'), Z0, extent.z1, 95, 150);
  const zs = [...zsN, Z0, ...zsS];

  const grime = Math.max(0, Math.min(1, 0.45 + 0.35 * dials.grime));
  const out: OutskirtBuilding[] = [];
  const r = rng.fork('lots');
  for (let j = 0; j < zs.length - 1; j++) {
    for (let i = 0; i < xs.length - 1; i++) {
      const sw = r.range(12, 18);
      const cell: Rect = { x0: (xs[i] as number) + sw / 2, x1: (xs[i + 1] as number) - sw / 2, z0: (zs[j] as number) + sw / 2, z1: (zs[j + 1] as number) - sw / 2 };
      const cx = (cell.x0 + cell.x1) / 2;
      const cz = (cell.z0 + cell.z1) / 2;
      // inside the city: skip; south of the shore: clip or skip
      if (hive ? cx > X0 && cx < X1 && cz > Z0 && cz < Z1 : cx > X0 && cx < X1 && cz > Z0) continue;
      const shore = cx <= X0 ? coastWest : cx >= X1 ? coastEast : Z0;
      cell.z1 = Math.min(cell.z1, shore - 14);
      if (cell.z1 - cell.z0 < 30 || cell.x1 - cell.x0 < 30) continue;
      // distance from the city edge (Chebyshev, outside the bounds)
      const dx = Math.max(bounds.x0 - cx, cx - bounds.x1, 0);
      const dz = Math.max(bounds.z0 - cz, hive ? cz - bounds.z1 : 0, 0);
      const d = Math.max(dx, dz);
      const fall = Math.exp(-d / 850);
      // split the block into lots
      const lots: Rect[] = [cell];
      for (let k = 0; k < lots.length && k < 24; k++) {
        const L = lots[k] as Rect;
        const w = L.x1 - L.x0;
        const dd = L.z1 - L.z0;
        const big = Math.max(w, dd);
        // hive blocks stay whole (one megatower each) unless they are long
        if (big < (hive ? r.range(150, 210) : r.range(46, 84))) continue;
        const t = r.range(0.35, 0.65);
        if (w >= dd) {
          const m = L.x0 + w * t;
          lots[k] = { ...L, x1: m };
          lots.push({ ...L, x0: m });
        } else {
          const m = L.z0 + dd * t;
          lots[k] = { ...L, z1: m };
          lots.push({ ...L, z0: m });
        }
        k--;
      }
      for (const L of lots) {
        if (r.chance(hive ? 0.02 : 0.1)) continue; // yards, car parks
        const ins = r.range(1.5, 5);
        const rect: Rect = { x0: L.x0 + ins, x1: L.x1 - ins, z0: L.z0 + ins, z1: L.z1 - ins };
        if (rect.x1 - rect.x0 < 10 || rect.z1 - rect.z0 < 10) continue;
        const style = r.weighted(STYLES, [0.34, 0.26, 0.14, 0.12 * (0.5 + grime), 0.08, 0.06]);
        const fh = (FLOOR[style] ?? 3.3) * r.range(0.95, 1.06);
        let h = (8 + 30 * fall) * r.range(0.55, 1.5);
        if (r.chance(0.012 + 0.05 * fall)) h = r.range(55, 135) * (0.6 + 0.4 * fall);
        // the hive does not thin out: megatowers to the horizon
        if (hive) h = r.range(240, 1100) * (r.chance(0.1) ? 1.6 : 1);
        h = Math.max(fh * 2, Math.round(h / fh) * fh);
        const lit = Math.max(0.08, r.range(0.3, 0.55) * (1 - 0.35 * grime));
        const neon = r.chance(0.08 + 0.1 * Math.max(0, dials.flash));
        out.push({
          rect,
          h,
          style,
          floorH: fh,
          bayW: r.range(2.8, 4.6),
          win: style === 'panel' ? r.range(0.15, 0.3) : style === 'metal' ? r.range(0.1, 0.2) : r.range(0.4, 0.66),
          lit,
          warm: r.range(0.55, 0.9),
          grime: Math.max(0, Math.min(1, grime + r.range(-0.15, 0.15))),
          base: r.pick(WALLS),
          accent: r.pick(ACCENTS),
          strips: neon ? r.range(0.35, 0.6) : 0,
          seed: r.next(),
        });
      }
    }
  }
  return { buildings: out, extent, grid: { xs, zs, inner: { x0: X0, z0: Z0, x1: X1, z1: hive ? Z1 : extent.z1 }, extent, coastWest, coastEast } };
}
