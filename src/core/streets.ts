/**
 * Streets, junctions and block plates.
 *
 * Arterials run along superblock edges that touch land. Inside each superblock
 * the owning district lays its own local pattern: wide spacing for the core and
 * the megablocks, a dense grid plus alleys in the markets, a jittered irregular
 * grid in the decayed zone, almost nothing in the port. Every street is an
 * axis-aligned road rectangle, so junctions are rectangle intersections and the
 * plates between streets are rectangles too.
 */
import type { Block, District, RoadPiece, Rect, Street, StreetKind, Superblock } from './types';
import type { Arterial, Zoning } from './zoning';
import { PROFILES, tuneMul } from './profiles';
import { Rng } from './rng';

export interface StreetsResult {
  streets: Street[];
  roads: RoadPiece[];
  blocks: Block[];
}

interface Line {
  pos: number;
  road: number;
  walk: number;
  kind: StreetKind;
}

function laneCount(kind: StreetKind, road: number): number {
  if (kind === 'alley') return 0;
  if (kind === 'local') return road >= 12 ? 2 : 1;
  return road >= 24 ? 3 : 2;
}

export function makeStreets(z: Zoning, rng: Rng, density: number): StreetsResult {
  const streets: Street[] = [];
  const add = (s: Omit<Street, 'id'>): Street => {
    const st = { ...s, id: streets.length };
    streets.push(st);
    return st;
  };
  const sb = (i: number, j: number): Superblock | undefined => (i < 0 || j < 0 || i >= z.cols || j >= z.rows ? undefined : z.superblocks[i + j * z.cols]);
  const isLand = (i: number, j: number): boolean => sb(i, j)?.land ?? false;

  // ---- arterials: merge consecutive edge pieces into one street per run
  for (let i = 0; i < z.xs.length; i++) {
    const a = z.linesX[i] as Arterial;
    let start = -1;
    for (let j = 0; j <= z.rows; j++) {
      const on = j < z.rows && (isLand(i - 1, j) || isLand(i, j));
      if (on && start < 0) start = j;
      if (!on && start >= 0) {
        add({ key: `az${i}:${start}`, axis: 'z', pos: a.pos, lo: z.zs[start] as number, hi: z.zs[j] as number, kind: a.kind === 'highway' ? 'highway' : 'arterial', road: a.road, walk: a.walk, district: -1 });
        start = -1;
      }
    }
  }
  for (let j = 0; j < z.zs.length; j++) {
    const a = z.linesZ[j] as Arterial;
    let start = -1;
    for (let i = 0; i <= z.cols; i++) {
      const on = i < z.cols && (isLand(i, j - 1) || isLand(i, j));
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        add({ key: `ax${j}:${start}`, axis: 'x', pos: a.pos, lo: z.xs[start] as number, hi: z.xs[i] as number, kind: a.kind === 'highway' ? 'highway' : 'arterial', road: a.road, walk: a.walk, district: -1 });
        start = -1;
      }
    }
  }

  // ---- local streets and plates per superblock
  const blocks: Block[] = [];
  for (const cell of z.superblocks) {
    if (!cell.land || cell.district < 0) continue;
    const d = z.districts[cell.district] as District;
    const prof = PROFILES[d.kind];
    const r = rng.fork('sb' + cell.id);
    const R = cell.rect;
    const ax = z.linesX[cell.i] as Arterial;
    const bx = z.linesX[cell.i + 1] as Arterial;
    const az = z.linesZ[cell.j] as Arterial;
    const bz = z.linesZ[cell.j + 1] as Arterial;
    const irregular = d.kind === 'decayed' || d.kind === 'cnmarket' || d.tune.decay > 0.5;
    // bigger buildings want bigger blocks; denser districts cut more streets
    const tuneK = tuneMul(d.tune.scale, 1.35) / tuneMul(d.tune.density, 1.45);
    const spacing = (lo: number, hi: number): number => (r.range(lo, hi) / Math.sqrt(density)) * tuneK;

    const localLines = (from: number, to: number): Line[] => {
      const out: Line[] = [];
      const span = to - from;
      const [smin, smax] = prof.streets.spacing;
      const target = spacing(smin, smax);
      const n = Math.max(0, Math.round(span / target) - 1);
      for (let k = 1; k <= n; k++) {
        let p = from + (span * k) / (n + 1);
        p += (r.next() - 0.5) * (span / (n + 1)) * (irregular ? 0.45 : 0.16);
        const road = prof.streets.road * (irregular ? r.range(0.8, 1.1) : 1);
        out.push({ pos: Math.round(p * 2) / 2, road, walk: prof.streets.walk, kind: 'local' });
      }
      return out;
    };
    // lines running along z (positions in x) and along x (positions in z)
    // a landmark takes the whole superblock: no local streets inside it
    const vx = cell.landmark ? [] : localLines(R.x0, R.x1);
    const vz = cell.landmark ? [] : localLines(R.z0, R.z1);
    vx.forEach((l, k) => add({ key: `s${cell.id}z${k}`, axis: 'z', pos: l.pos, lo: az.pos, hi: bz.pos, kind: 'local', road: l.road, walk: l.walk, district: d.id }));
    vz.forEach((l, k) => add({ key: `s${cell.id}x${k}`, axis: 'x', pos: l.pos, lo: ax.pos, hi: bx.pos, kind: 'local', road: l.road, walk: l.walk, district: d.id }));

    // plate grid: boundaries are the arterial edges plus the local lines
    const xb: Line[] = [{ pos: ax.pos, road: ax.road, walk: ax.walk, kind: 'arterial' }, ...vx, { pos: bx.pos, road: bx.road, walk: bx.walk, kind: 'arterial' }];
    const zb: Line[] = [{ pos: az.pos, road: az.road, walk: az.walk, kind: 'arterial' }, ...vz, { pos: bz.pos, road: bz.road, walk: bz.walk, kind: 'arterial' }];
    for (let a = 0; a < xb.length - 1; a++) {
      for (let b = 0; b < zb.length - 1; b++) {
        const L = xb[a] as Line;
        const Rr = xb[a + 1] as Line;
        const T = zb[b] as Line;
        const B = zb[b + 1] as Line;
        const plate: Rect = { x0: L.pos + L.road / 2, x1: Rr.pos - Rr.road / 2, z0: T.pos + T.road / 2, z1: B.pos - B.road / 2 };
        if (plate.x1 - plate.x0 < 8 || plate.z1 - plate.z0 < 8) continue;
        // alleys split deep market plates along their long axis
        const plates: { plate: Rect; walk: [number, number, number, number] }[] = [];
        const walk: [number, number, number, number] = [L.walk, Rr.walk, T.walk, B.walk];
        const w = plate.x1 - plate.x0;
        const h = plate.z1 - plate.z0;
        const deep = Math.min(w, h) > (d.kind === 'jpmarket' || d.kind === 'cnmarket' ? 30 : 70);
        if (deep && !cell.landmark && r.chance(prof.streets.alley)) {
          const aw = r.range(3.2, 4.6);
          const alongX = w >= h; // alley runs along the long axis
          const mid = alongX ? (plate.z0 + plate.z1) / 2 + (r.next() - 0.5) * h * 0.2 : (plate.x0 + plate.x1) / 2 + (r.next() - 0.5) * w * 0.2;
          if (alongX) {
            add({ key: `s${cell.id}a${a}:${b}`, axis: 'x', pos: mid, lo: L.pos, hi: Rr.pos, kind: 'alley', road: aw, walk: 0, district: d.id });
            plates.push({ plate: { ...plate, z1: mid - aw / 2 }, walk: [walk[0], walk[1], walk[2], 0] });
            plates.push({ plate: { ...plate, z0: mid + aw / 2 }, walk: [walk[0], walk[1], 0, walk[3]] });
          } else {
            add({ key: `s${cell.id}a${a}:${b}`, axis: 'z', pos: mid, lo: T.pos, hi: B.pos, kind: 'alley', road: aw, walk: 0, district: d.id });
            plates.push({ plate: { ...plate, x1: mid - aw / 2 }, walk: [walk[0], 0, walk[2], walk[3]] });
            plates.push({ plate: { ...plate, x0: mid + aw / 2 }, walk: [0, walk[1], walk[2], walk[3]] });
          }
        } else plates.push({ plate, walk });
        for (const [pi, p] of plates.entries()) {
          const rect: Rect = { x0: p.plate.x0 + p.walk[0], x1: p.plate.x1 - p.walk[1], z0: p.plate.z0 + p.walk[2], z1: p.plate.z1 - p.walk[3] };
          if (rect.x1 - rect.x0 < 4 || rect.z1 - rect.z0 < 4) continue;
          let open: Block['open'] = 'none';
          const tn = d.tune;
          // budget buys plazas and parks, decay leaves rubble lots, density fills them in
          const openP = prof.open * tuneMul(tn.budget, 1.6) * tuneMul(Math.max(0, tn.decay), 1.8) / tuneMul(tn.density, 1.8);
          if (!cell.landmark && r.chance(Math.min(0.45, openP))) {
            open = d.kind === 'corporate' ? 'plaza' : d.kind === 'luxury' ? 'park' : d.kind === 'industrial' ? 'yard' : d.kind === 'decayed' ? 'rubble' : d.kind === 'megablock' ? 'plaza' : 'none';
            if (tn.decay > 0.35 && r.chance(tn.decay * 0.8)) open = 'rubble';
            else if (tn.budget > 0.35 && r.chance(tn.budget * 0.7)) open = r.chance(0.5) ? 'park' : 'plaza';
            else if (open === 'none' && (tn.decay > 0 || tn.budget > 0)) open = tn.decay > tn.budget ? 'rubble' : 'plaza';
          }
          blocks.push({ id: blocks.length, key: `${cell.id}:${a}:${b}:${pi}`, rect, plate: p.plate, walk: p.walk, district: d.id, superblock: cell.id, open, use: 'residential', ...(cell.landmark ? { landmark: cell.landmark } : {}) });
        }
      }
    }
  }

  // ---- junctions and road segments
  const roads: RoadPiece[] = [];
  const junctionKeys = new Set<string>();
  const roadRect = (s: Street): Rect =>
    s.axis === 'x' ? { x0: s.lo, x1: s.hi, z0: s.pos - s.road / 2, z1: s.pos + s.road / 2 } : { x0: s.pos - s.road / 2, x1: s.pos + s.road / 2, z0: s.lo, z1: s.hi };
  const xsS = streets.filter((s) => s.axis === 'x');
  const zsS = streets.filter((s) => s.axis === 'z');
  // spatial bucket for the perpendicular lookups
  const bucket = new Map<number, Street[]>();
  const B = 200;
  const keyOf = (i: number, j: number): number => (i + 512) * 4096 + (j + 512);
  for (const s of zsS) {
    const rr = roadRect(s);
    for (let i = Math.floor(rr.x0 / B); i <= Math.floor(rr.x1 / B); i++)
      for (let j = Math.floor(rr.z0 / B); j <= Math.floor(rr.z1 / B); j++) {
        const k = keyOf(i, j);
        const arr = bucket.get(k);
        if (arr) arr.push(s);
        else bucket.set(k, [s]);
      }
  }
  const crossings = new Map<number, Rect[]>();
  const addCross = (s: Street, r: Rect): void => {
    const arr = crossings.get(s.id);
    if (arr) arr.push(r);
    else crossings.set(s.id, [r]);
  };
  for (const s of xsS) {
    const a = roadRect(s);
    const seen = new Set<Street>();
    for (let i = Math.floor(a.x0 / B); i <= Math.floor(a.x1 / B); i++)
      for (let j = Math.floor(a.z0 / B); j <= Math.floor(a.z1 / B); j++) {
        for (const t of bucket.get(keyOf(i, j)) ?? []) {
          if (seen.has(t)) continue;
          seen.add(t);
          const b = roadRect(t);
          const x0 = Math.max(a.x0, b.x0);
          const x1 = Math.min(a.x1, b.x1);
          const z0 = Math.max(a.z0, b.z0);
          const z1 = Math.min(a.z1, b.z1);
          if (x1 - x0 <= 0.01 || z1 - z0 <= 0.01) continue;
          // a junction must actually join the two streets (not a parallel overlap)
          const j0 = { x0, x1, z0, z1 };
          addCross(s, j0);
          addCross(t, j0);
          const key = `${Math.round(x0 * 4)},${Math.round(z0 * 4)},${Math.round(x1 * 4)},${Math.round(z1 * 4)}`;
          if (!junctionKeys.has(key)) {
            junctionKeys.add(key);
            const kind: StreetKind = s.kind === 'alley' || t.kind === 'alley' ? 'alley' : s.kind === 'local' || t.kind === 'local' ? 'local' : 'arterial';
            roads.push({ rect: j0, axis: 'j', kind, streetId: s.id, lanes: 0 });
          }
        }
      }
  }
  for (const s of streets) {
    const rr = roadRect(s);
    const cuts = (crossings.get(s.id) ?? []).map((c) => (s.axis === 'x' ? [c.x0, c.x1] : [c.z0, c.z1]) as [number, number]).sort((p, q) => p[0] - q[0]);
    let cur = s.axis === 'x' ? rr.x0 : rr.z0;
    const end = s.axis === 'x' ? rr.x1 : rr.z1;
    const emit = (a: number, b: number): void => {
      if (b - a < 0.3) return;
      const rect = s.axis === 'x' ? { x0: a, x1: b, z0: rr.z0, z1: rr.z1 } : { x0: rr.x0, x1: rr.x1, z0: a, z1: b };
      roads.push({ rect, axis: s.axis, kind: s.kind, streetId: s.id, lanes: laneCount(s.kind, s.road) });
    };
    for (const [c0, c1] of cuts) {
      if (c0 > cur) emit(cur, c0);
      cur = Math.max(cur, c1);
    }
    if (end > cur) emit(cur, end);
  }

  return { streets, roads, blocks };
}
