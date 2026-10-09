/**
 * Zoning: the arterial grid, the coastline and the district map.
 *
 * Arterials split the land into superblocks of roughly 300 m. District sites are
 * placed by suitability rules (core in the middle, port and beach on the coast,
 * markets around the core, decay at the edge) and grow over the superblock grid
 * with a weighted multi-source Dijkstra, so every district is one contiguous,
 * legible region bounded by arterials. Lots near a district border blend toward
 * the neighbour (see `blendAt`), so transitions read as gradients, not seams.
 */
import type { District, DistrictKind, Dials, Rect, Superblock } from './types';
import { DISTRICT_KINDS } from './types';
import { NEUTRAL_TUNE, PROFILES, districtName, lightColor, styleFor, hexToLinear } from './profiles';
import { Rng, clamp, hash01, noise2, smoothstep } from './rng';

export interface Arterial {
  axis: 'x' | 'z';
  /** Index of the line in xs (axis 'z') or zs (axis 'x'). */
  index: number;
  pos: number;
  road: number;
  walk: number;
  kind: 'arterial' | 'boulevard' | 'highway';
}

export interface Zoning {
  size: number;
  bounds: Rect;
  /** x positions of the arterials that run along z. */
  xs: number[];
  /** z positions of the arterials that run along x. */
  zs: number[];
  cols: number;
  rows: number;
  /** Arterial descriptors for the z-running lines (index = xs index). */
  linesX: Arterial[];
  /** Arterial descriptors for the x-running lines (index = zs index). */
  linesZ: Arterial[];
  /** Land rows per column, counted from the north (z0); rows >= landRows[c] are sea. */
  landRows: number[];
  superblocks: Superblock[];
  districts: District[];
  /** District id per cell (col + row * cols), -1 for sea. */
  cell: Int32Array;
  coastZ: (x: number) => number;
  seed: number;
  /** The hive: no coast, kilometre-scale towers (see Dials.world). */
  hive: boolean;
}

function lines(rng: Rng, half: number, min: number, max: number): number[] {
  const out: number[] = [-half];
  let p = -half;
  for (;;) {
    const step = rng.range(min, max);
    if (p + step > half - min * 0.6) break;
    p += step;
    out.push(Math.round(p * 2) / 2);
  }
  out.push(half);
  return out;
}

export function makeZoning(rng: Rng, dials: Dials): Zoning {
  const S = dials.size * 1000;
  const half = S / 2;
  const seed = rng.seed;
  const xs = lines(rng.fork('xs'), half, 270, 380);
  const zs = lines(rng.fork('zs'), half, 270, 380);
  const cols = xs.length - 1;
  const rows = zs.length - 1;

  // ---- arterial kinds: one boulevard and one elevated highway each way (if there is room)
  const pickInner = (r: Rng, n: number, avoid: number[]): number => {
    const cands: number[] = [];
    for (let i = 1; i < n - 1; i++) if (!avoid.includes(i)) cands.push(i);
    return cands.length ? r.pick(cands) : -1;
  };
  const rk = rng.fork('kinds');
  const hiX = pickInner(rk, xs.length, []);
  const blX = pickInner(rk, xs.length, [hiX, hiX - 1, hiX + 1]);
  const hiZ = pickInner(rk, zs.length - 1, []); // keep the highway off the coast row
  const blZ = pickInner(rk, zs.length - 1, [hiZ, hiZ - 1, hiZ + 1]);
  const mk = (axis: 'x' | 'z', index: number, pos: number, hi: number, bl: number): Arterial => {
    const kind = index === hi ? 'highway' : index === bl ? 'boulevard' : 'arterial';
    const road = kind === 'boulevard' ? 26 : kind === 'highway' ? 22 : 17;
    const walk = kind === 'boulevard' ? 7 : 5;
    return { axis, index, pos, road, walk, kind };
  };
  const linesX = xs.map((x, i) => mk('z', i, x, hiX, blX));
  const linesZ = zs.map((z, i) => mk('x', i, z, hiZ, blZ));

  const hive = dials.world === 'hive';
  // ---- coast: the south edge is sea; each column keeps 1-2 fewer land rows, noisy but smooth
  // (the hive has no coast: the city runs on in every direction)
  const landRows: number[] = [];
  const cr = rng.fork('coast');
  const phase = cr.range(0, 100);
  for (let c = 0; c < cols; c++) {
    const n = noise2(seed ^ 0x51, phase + c * 0.55, 3.1);
    const drop = n > 0.62 ? 2 : n > 0.18 ? 1 : 1;
    landRows.push(Math.max(2, rows - drop));
  }
  // the bay: make one stretch two rows deep so the coast has a recognisable shape
  const bay = cr.int(Math.max(1, cols - 2)) + 1;
  for (let c = bay - 1; c <= Math.min(cols - 1, bay); c++) landRows[c] = Math.max(2, rows - 2);
  if (hive) for (let c = 0; c < cols; c++) landRows[c] = rows;
  const coastZ = (x: number): number => {
    if (hive) return half + 9000;
    let c = 0;
    while (c < cols - 1 && x > (xs[c + 1] as number)) c++;
    return zs[landRows[c] as number] as number;
  };

  // ---- superblocks
  const superblocks: Superblock[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const ax = linesX[i] as Arterial;
      const bx = linesX[i + 1] as Arterial;
      const az = linesZ[j] as Arterial;
      const bz = linesZ[j + 1] as Arterial;
      const rect: Rect = {
        x0: ax.pos + ax.road / 2,
        x1: bx.pos - bx.road / 2,
        z0: az.pos + az.road / 2,
        z1: bz.pos - bz.road / 2,
      };
      superblocks.push({ id: superblocks.length, rect, i, j, district: -1, land: j < (landRows[i] as number) });
    }
  }

  // ---- district sites
  const land = superblocks.filter((s) => s.land);
  const nLand = land.length;
  const scale = nLand / 58;
  const counts: Record<DistrictKind, number> = { corporate: 0, jpmarket: 0, cnmarket: 0, megablock: 0, industrial: 0, decayed: 0, luxury: 0 };
  for (const k of DISTRICT_KINDS) {
    const m = dials.mix[k];
    const base = PROFILES[k].sites * m * scale;
    counts[k] = m <= 0.05 ? 0 : Math.max(1, Math.round(base));
  }
  // never more sites than land cells
  let total = DISTRICT_KINDS.reduce((a, k) => a + counts[k], 0);
  while (total > nLand) {
    const k = DISTRICT_KINDS.slice().sort((a, b) => counts[b] - counts[a])[0] as DistrictKind;
    counts[k]--;
    total--;
  }
  if (total === 0) counts.megablock = 1;

  // land centre (cells), slightly north because the sea is south
  let cx = 0;
  let cz = 0;
  for (const s of land) {
    cx += s.i;
    cz += s.j;
  }
  cx /= nLand;
  cz /= nLand;
  const maxD = Math.hypot(cols, rows) / 2;
  const coastal = (s: Superblock): boolean => {
    const below = superblocks[s.i + (s.j + 1) * cols];
    return !below || !below.land;
  };
  const sites: { kind: DistrictKind; cell: Superblock; weight: number }[] = [];
  const taken = new Set<number>();
  const sr = rng.fork('sites');
  const distTo = (a: Superblock, b: Superblock): number => Math.hypot(a.i - b.i, a.j - b.j);
  const nearestKind = (s: Superblock, k: DistrictKind): number => {
    let best = Infinity;
    for (const t of sites) if (t.kind === k) best = Math.min(best, distTo(s, t.cell));
    return best === Infinity ? maxD * 2 : best;
  };
  const score = (k: DistrictKind, s: Superblock): number => {
    const d = Math.hypot(s.i - cx, s.j - cz) / maxD;
    const n = sr.next() * 0.25;
    const coast = coastal(s) ? 1 : 0;
    const sameK = nearestKind(s, k);
    const spread = Math.min(sameK, 4) * 0.12; // keep districts of one kind apart
    switch (k) {
      case 'corporate':
        return -d * 2 + n + spread;
      case 'luxury':
        return coast * 0.7 + d * 0.5 - (nearestKind(s, 'industrial') < 2 ? 1 : 0) + n + spread;
      case 'industrial':
        return coast * 0.9 + d * 0.35 + Math.min(nearestKind(s, 'luxury'), 4) * 0.25 + n + spread;
      case 'jpmarket':
      case 'cnmarket':
        return -Math.abs(d - 0.28) * 2.2 + n + spread;
      case 'megablock':
        return -Math.abs(d - 0.55) * 2 + n + spread;
      case 'decayed':
        return d * 1.2 + (nearestKind(s, 'industrial') < 2.5 ? 0.5 : 0) - (nearestKind(s, 'luxury') < 2 ? 0.8 : 0) + n + spread;
    }
  };
  const order: DistrictKind[] = ['corporate', 'luxury', 'industrial', 'jpmarket', 'cnmarket', 'megablock', 'decayed'];
  for (const k of order) {
    for (let n = 0; n < counts[k]; n++) {
      let best: Superblock | null = null;
      let bestS = -Infinity;
      for (const s of land) {
        if (taken.has(s.id)) continue;
        // keep a one-cell gap between any two sites
        let near = false;
        for (const t of sites) if (Math.max(Math.abs(t.cell.i - s.i), Math.abs(t.cell.j - s.j)) < 2) near = true;
        const sc = score(k, s) - (near ? 3 : 0);
        if (sc > bestS) {
          bestS = sc;
          best = s;
        }
      }
      if (!best) break;
      taken.add(best.id);
      sites.push({ kind: k, cell: best, weight: PROFILES[k].weight * sr.range(0.85, 1.15) * (0.7 + 0.3 * dials.mix[k]) });
    }
  }

  // ---- growth: multi-source Dijkstra over land cells
  const cell = new Int32Array(cols * rows).fill(-1);
  const cost = new Float64Array(cols * rows).fill(Infinity);
  const heap: [number, number, number][] = []; // cost, cell index, site
  const push = (c: number, idx: number, site: number): void => {
    heap.push([c, idx, site]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((heap[p] as [number, number, number])[0] <= (heap[i] as [number, number, number])[0]) break;
      [heap[p], heap[i]] = [heap[i] as [number, number, number], heap[p] as [number, number, number]];
      i = p;
    }
  };
  const pop = (): [number, number, number] | undefined => {
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop() as [number, number, number];
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && (heap[l] as [number, number, number])[0] < (heap[m] as [number, number, number])[0]) m = l;
        if (r < heap.length && (heap[r] as [number, number, number])[0] < (heap[m] as [number, number, number])[0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i] as [number, number, number], heap[m] as [number, number, number]];
        i = m;
      }
    }
    return top;
  };
  sites.forEach((s, k) => {
    const idx = s.cell.i + s.cell.j * cols;
    cost[idx] = 0;
    push(0, idx, k);
  });
  for (;;) {
    const it = pop();
    if (!it) break;
    const [c, idx, site] = it;
    if (cell[idx] !== -1) continue;
    cell[idx] = site;
    const i = idx % cols;
    const j = Math.floor(idx / cols);
    const w = (sites[site] as { weight: number }).weight;
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
      const nidx = ni + nj * cols;
      if (!(superblocks[nidx] as Superblock).land || cell[nidx] !== -1) continue;
      const step = (1 + 0.45 * hash01(seed ^ 0x77, ni, nj)) / w;
      const nc = c + step;
      if (nc < (cost[nidx] as number)) {
        cost[nidx] = nc;
        push(nc, nidx, site);
      }
    }
  }

  // ---- districts
  const districts: District[] = sites.map((s, id) => {
    const p = PROFILES[s.kind];
    const r = rng.fork('district' + id);
    const style = styleFor(s.kind, dials);
    const tune = { ...(dials.tune?.[s.kind] ?? NEUTRAL_TUNE) };
    const cxm = (s.cell.rect.x0 + s.cell.rect.x1) / 2;
    const czm = (s.cell.rect.z0 + s.cell.rect.z1) / 2;
    const fogT = hexToLinear(p.fog.tint);
    return {
      id,
      kind: s.kind,
      x: cxm,
      z: czm,
      cells: [],
      style,
      tune,
      palette: p.palette.map(lightColor),
      fog: { density: p.fog.density * (0.85 + 0.3 * style.grime) * (1 + 0.25 * tune.decay), tint: fogT },
      name: districtName(s.kind, r.next(), r.next()),
    };
  });
  for (const s of superblocks) {
    const d = cell[s.i + s.j * cols] as number;
    s.district = d;
    if (d >= 0) (districts[d] as District).cells.push(s.id);
  }
  // recentre each district's label on its cells
  for (const d of districts) {
    if (d.cells.length === 0) continue;
    let x = 0;
    let z = 0;
    for (const c of d.cells) {
      const r = (superblocks[c] as Superblock).rect;
      x += (r.x0 + r.x1) / 2;
      z += (r.z0 + r.z1) / 2;
    }
    d.x = x / d.cells.length;
    d.z = z / d.cells.length;
  }

  // ---- one landmark megastructure on a whole superblock, near the heart of the
  // corporate core (or the megablocks): fully on land, away from the coast row
  if (dials.alien >= 0.2) {
    const lr = rng.fork('landmark');
    const host = ['corporate', 'megablock'].map((k) => districts.filter((d) => d.kind === k && d.cells.length >= 2)).flat();
    const d = host[0] ?? null;
    if (d) {
      let best: Superblock | null = null;
      let bd = Infinity;
      for (const id of d.cells) {
        const sb = superblocks[id] as Superblock;
        if (!sb.land || sb.j >= (landRows[sb.i] ?? 0) - 1 || sb.i === 0 || sb.i === cols - 1 || sb.j === 0) continue;
        const dist = Math.hypot((sb.rect.x0 + sb.rect.x1) / 2 - d.x, (sb.rect.z0 + sb.rect.z1) / 2 - d.z) * lr.range(0.85, 1.15);
        if (dist < bd) {
          bd = dist;
          best = sb;
        }
      }
      if (best) best.landmark = 'pyramid';
    }
  }

  return {
    size: S,
    bounds: { x0: -half, z0: -half, x1: half, z1: half },
    xs,
    zs,
    cols,
    rows,
    linesX,
    linesZ,
    landRows,
    superblocks,
    districts,
    cell,
    coastZ,
    seed,
    hive,
  };
}

/** Superblock cell under a point, or -1. */
export function cellAt(z: Zoning, x: number, zz: number): number {
  if (x < z.bounds.x0 || x > z.bounds.x1 || zz < z.bounds.z0 || zz > z.bounds.z1) return -1;
  let i = 0;
  while (i < z.cols - 1 && x > (z.xs[i + 1] as number)) i++;
  let j = 0;
  while (j < z.rows - 1 && zz > (z.zs[j + 1] as number)) j++;
  return i + j * z.cols;
}

export function districtAt(z: Zoning, x: number, zz: number): number {
  const c = cellAt(z, x, zz);
  return c < 0 ? -1 : (z.cell[c] as number);
}

/**
 * Blend weights near district borders: the own district plus up to one
 * neighbour, with the neighbour weight rising toward the shared superblock edge
 * (0 at `band` metres in, 0.5 at the edge).
 */
export function blendAt(z: Zoning, x: number, zz: number, band = 90): { own: number; other: number; t: number } {
  const c = cellAt(z, x, zz);
  if (c < 0) return { own: -1, other: -1, t: 0 };
  const own = z.cell[c] as number;
  const sb = z.superblocks[c] as Superblock;
  const i = sb.i;
  const j = sb.j;
  let best = -1;
  let bestT = 0;
  const check = (ni: number, nj: number, dist: number): void => {
    if (ni < 0 || nj < 0 || ni >= z.cols || nj >= z.rows) return;
    const d = z.cell[ni + nj * z.cols] as number;
    if (d < 0 || d === own) return;
    const t = 0.5 * smoothstep(band, 0, dist);
    if (t > bestT) {
      bestT = t;
      best = d;
    }
  };
  check(i - 1, j, x - sb.rect.x0);
  check(i + 1, j, sb.rect.x1 - x);
  check(i, j - 1, zz - sb.rect.z0);
  check(i, j + 1, sb.rect.z1 - zz);
  return { own, other: best, t: clamp(bestT, 0, 0.5) };
}
