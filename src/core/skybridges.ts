/**
 * Skybridges: enclosed bridges between tall neighbours, across the gaps and the
 * local streets between them (never over arterials, which carry the air lanes
 * and the metro). One of the genre's signature shapes: the city knits itself
 * together above the street.
 */
import type { Building, Rect, RoadPiece, Street, Structure, Tier } from './types';
import type { Rng } from './rng';

function aabb(t: Tier): Rect {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const [x, z] of t.poly) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
  }
  return { x0, z0, x1, z1 };
}

/** The plumb (non-sloped) tier spanning height y, if any. */
function tierAt(b: Building, y: number): Tier | null {
  for (const t of b.tiers) if (!t.top && t.y0 <= y - 4 && t.y1 >= y + 6) return t;
  return null;
}

export function makeSkybridges(buildings: readonly Building[], streets: readonly Street[], roads: readonly RoadPiece[], rng: Rng, alien: number): Structure[] {
  const out: Structure[] = [];
  if (alien <= 0.02) return out;
  const r = rng.fork('skybridges');
  const tall = buildings.filter((b) => b.height >= 55 && b.archetype !== 'ruin' && b.archetype !== 'shack' && b.archetype !== 'pyramid');
  // spatial hash of tall buildings
  const cell = 160;
  const grid = new Map<string, Building[]>();
  const key = (i: number, j: number): string => i + ':' + j;
  for (const b of tall) {
    const i = Math.floor((b.rect.x0 + b.rect.x1) / 2 / cell);
    const j = Math.floor((b.rect.z0 + b.rect.z1) / 2 / cell);
    const k = key(i, j);
    const list = grid.get(k);
    if (list) list.push(b);
    else grid.set(k, [b]);
  }
  const arterialRects = roads.filter((p) => {
    const st = streets[p.streetId];
    return st && (st.kind === 'arterial' || st.kind === 'highway');
  }).map((p) => p.rect);
  const crossesArterial = (x0: number, z0: number, x1: number, z1: number): boolean =>
    arterialRects.some((q) => Math.min(x0, x1) < q.x1 + 4 && Math.max(x0, x1) > q.x0 - 4 && Math.min(z0, z1) < q.z1 + 4 && Math.max(z0, z1) > q.z0 - 4);
  const cap = Math.round(30 + 110 * alien);
  const p = Math.min(0.85, 0.25 + 0.7 * alien);
  const placed: [number, number, number][] = [];
  for (const a of tall) {
    if (out.length >= cap) break;
    const ai = Math.floor((a.rect.x0 + a.rect.x1) / 2 / cell);
    const aj = Math.floor((a.rect.z0 + a.rect.z1) / 2 / cell);
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++) {
        for (const b of grid.get(key(ai + di, aj + dj)) ?? []) {
          if (b.id <= a.id || out.length >= cap) continue;
          if (!r.chance(p)) continue;
          const top = Math.min(a.height, b.height) - 14;
          const lo = Math.max(42, Math.min(a.height, b.height) * 0.28);
          if (top <= lo) continue;
          const y = lo + (top - lo) * Math.pow(r.next(), 0.7);
          const ta = tierAt(a, y);
          const tb = tierAt(b, y);
          if (!ta || !tb) continue;
          const A = aabb(ta);
          const B = aabb(tb);
          const w = r.range(4.5, 8);
          const h = r.range(3.8, 6);
          let seg: [number, number, number, number] | null = null;
          // east-west gap with a shared span along z
          const oz0 = Math.max(A.z0, B.z0) + w;
          const oz1 = Math.min(A.z1, B.z1) - w;
          const ox0 = Math.max(A.x0, B.x0) + w;
          const ox1 = Math.min(A.x1, B.x1) - w;
          if (oz1 > oz0) {
            const z = oz0 + (oz1 - oz0) * r.next();
            if (B.x0 - A.x1 >= 8 && B.x0 - A.x1 <= 75) seg = [A.x1, z, B.x0, z];
            else if (A.x0 - B.x1 >= 8 && A.x0 - B.x1 <= 75) seg = [B.x1, z, A.x0, z];
          }
          if (!seg && ox1 > ox0) {
            const x = ox0 + (ox1 - ox0) * r.next();
            if (B.z0 - A.z1 >= 8 && B.z0 - A.z1 <= 75) seg = [x, A.z1, x, B.z0];
            else if (A.z0 - B.z1 >= 8 && A.z0 - B.z1 <= 75) seg = [x, B.z1, x, A.z0];
          }
          if (!seg) continue;
          const [x0, z0, x1, z1] = seg;
          if (crossesArterial(x0, z0, x1, z1)) continue;
          // nothing else in the way at that height
          const mx = (x0 + x1) / 2;
          const mz = (z0 + z1) / 2;
          let blocked = false;
          for (const c2 of grid.get(key(Math.floor(mx / cell), Math.floor(mz / cell))) ?? []) {
            if (c2 === a || c2 === b) continue;
            for (const t of c2.tiers) {
              if (t.y0 > y + h || t.y1 < y) continue;
              const R = aabb(t);
              if (Math.min(x0, x1) < R.x1 && Math.max(x0, x1) > R.x0 && Math.min(z0, z1) < R.z1 && Math.max(z0, z1) > R.z0) blocked = true;
            }
          }
          if (blocked) continue;
          if (placed.some(([px, py, pz]) => Math.hypot(px - mx, pz - mz) < 18 && Math.abs(py - y) < 25)) continue;
          placed.push([mx, y, mz]);
          out.push({ kind: 'bridge', p: [x0, y, z0, x1, y, z1, w, h], col: a.tiers[0]?.facade.base ?? [0.2, 0.2, 0.22], col2: a.palette[0] ?? [1, 1, 1], seed: r.next() });
        }
      }
  }
  return out;
}
