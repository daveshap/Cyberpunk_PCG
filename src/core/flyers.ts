/**
 * Flyers: the big and official traffic above the lanes. Ad airships drift on
 * wide loops over the skyline; police units patrol the arterials and ring the
 * odd street incident with their searchlights; medevac flyers run fast loops;
 * cargo haulers lumber along the low bands. This stage only lays out routes and
 * scenes; the renderer moves the craft.
 *
 * Routes follow the arterials (where the city leaves the sky open) at heights
 * between the car lanes, and airship loops are lifted above the tallest roof
 * along their path.
 */
import type { Building, District, DistrictKind, Emitter, FlyerRoute, Flyers, Incident, Street, Vec3 } from './types';
import type { Zoning } from './zoning';
import { clamp, type Rng } from './rng';

/** Coarse grid of the tallest roof per cell, for clearance queries. */
class Skyline {
  private readonly cells = new Map<string, number>();
  constructor(
    buildings: readonly Building[],
    private readonly cell = 60,
  ) {
    for (const b of buildings) {
      const i0 = Math.floor(b.rect.x0 / cell);
      const i1 = Math.floor(b.rect.x1 / cell);
      const j0 = Math.floor(b.rect.z0 / cell);
      const j1 = Math.floor(b.rect.z1 / cell);
      for (let i = i0; i <= i1; i++)
        for (let j = j0; j <= j1; j++) {
          const k = i + ':' + j;
          this.cells.set(k, Math.max(this.cells.get(k) ?? 0, b.height));
        }
    }
  }
  /** Tallest roof within r of (x, z). */
  at(x: number, z: number, r: number): number {
    const c = this.cell;
    let h = 0;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++)
      for (let j = Math.floor((z - r) / c); j <= Math.floor((z + r) / c); j++) h = Math.max(h, this.cells.get(i + ':' + j) ?? 0);
    return h;
  }
}

/** Districts in the order airships favour them. */
const BLIMP_ORDER: DistrictKind[] = ['corporate', 'jpmarket', 'megablock', 'cnmarket', 'luxury', 'industrial'];

export function makeFlyers(z: Zoning, buildings: readonly Building[], streets: readonly Street[], rng: Rng): Flyers & { emitters: Emitter[] } {
  const routes: FlyerRoute[] = [];
  const incidents: Incident[] = [];
  const emitters: Emitter[] = [];
  const sky = new Skyline(buildings);
  const B = z.bounds;

  // ---- ad airships: wide tilted ellipses lifted over the roofs along them
  {
    const r = rng.fork('blimps');
    const picks: District[] = [];
    for (const k of BLIMP_ORDER) for (const d of z.districts) if (d.kind === k && picks.length < 5 && !picks.some((p) => Math.hypot(p.x - d.x, p.z - d.z) < 500)) picks.push(d);
    for (const d of picks) {
      // try a few loops and keep the one that clears the roofs lowest
      let best: { flat: [number, number][]; clear: number } | null = null;
      for (let k = 0; k < 8; k++) {
        const a = r.range(380, 680);
        const b = a * r.range(0.55, 0.85);
        const rot = r.range(0, Math.PI);
        const cx = clamp(d.x + r.range(-220, 220), B.x0 + 200, B.x1 - 200);
        const cz = clamp(d.z + r.range(-220, 220), B.z0 + 200, B.z1 - 200);
        const flat: [number, number][] = [];
        const N = 32;
        for (let i = 0; i < N; i++) {
          const t = (i / N) * Math.PI * 2;
          const ex = Math.cos(t) * a;
          const ez = Math.sin(t) * b;
          flat.push([cx + ex * Math.cos(rot) - ez * Math.sin(rot), cz + ex * Math.sin(rot) + ez * Math.cos(rot)]);
        }
        let clear = 0;
        for (const [x, zz] of flat) clear = Math.max(clear, sky.at(x, zz, 90));
        if (!best || clear < best.clear) best = { flat, clear };
      }
      if (!best) continue;
      const y = Math.max(240, best.clear + 60) + r.range(0, 30);
      if (y > 700) continue;
      routes.push({ kind: 'blimp', pts: best.flat.map(([x, zz]) => [x, y, zz] as Vec3), speed: r.range(6, 9) * r.sign(), count: 1, seed: r.next() });
    }
  }

  // ---- loops along the arterials (a rectangle of superblocks)
  const xs = z.xs;
  const zs = z.zs;
  const loop = (r: Rng, span: number, y: number): Vec3[] | null => {
    if (xs.length < span + 1 || zs.length < span + 1) return null;
    const i = r.int(xs.length - span);
    const j = r.int(zs.length - span);
    const w = r.chance(0.5) ? span : Math.max(1, span - 1);
    const x0 = xs[i] as number;
    const x1 = xs[Math.min(xs.length - 1, i + w)] as number;
    const z0 = zs[j] as number;
    const z1 = zs[Math.min(zs.length - 1, j + span)] as number;
    // keep the loop over land, where the arterials are
    if (z1 > z.coastZ((x0 + x1) / 2) - 40) return null;
    const pts: Vec3[] = [
      [x0, y, z0],
      [x1, y, z0],
      [x1, y, z1],
      [x0, y, z1],
    ];
    return r.chance(0.5) ? pts : pts.reverse();
  };
  const addLoops = (kind: 'police' | 'medevac' | 'hauler', n: number, span: number, y: [number, number], speed: [number, number], count: [number, number]): void => {
    const r = rng.fork(kind + '-loops');
    let tries = 0;
    let made = 0;
    while (made < n && tries++ < n * 6) {
      const pts = loop(r, span, r.range(y[0], y[1]));
      if (!pts) continue;
      // no two loops of a kind on the same corner
      if (routes.some((o) => o.kind === kind && o.pts.some((q) => Math.hypot(q[0] - pts[0]![0], q[2] - pts[0]![2]) < 1))) continue;
      routes.push({ kind, pts, speed: r.range(speed[0], speed[1]), count: r.intRange(count[0], count[1]), seed: r.next() });
      made++;
    }
  };
  // heights sit between the car bands (26, 42, 64, 96, 140, 200)
  addLoops('police', 5, 2, [104, 122], [30, 38], [1, 2]);
  addLoops('medevac', 3, 3, [150, 168], [46, 56], [1, 1]);
  addLoops('hauler', 4, 3, [50, 56], [15, 21], [2, 4]);

  // ---- incidents: police rings over a street in the loud districts
  {
    const r = rng.fork('incidents');
    const hot = streets.filter((s) => {
      if (s.kind !== 'local' || s.hi - s.lo < 90) return false;
      const d = z.districts[s.district];
      return s.use === 'nightlife' || d?.kind === 'jpmarket' || d?.kind === 'cnmarket' || d?.kind === 'decayed';
    });
    const n = Math.min(3, hot.length);
    for (let k = 0; k < n; k++) {
      const s = hot[r.int(hot.length)] as Street;
      const along = s.lo + (s.hi - s.lo) * r.range(0.3, 0.7);
      const x = s.axis === 'x' ? along : s.pos;
      const zz = s.axis === 'x' ? s.pos : along;
      if (incidents.some((i) => Math.hypot(i.x - x, i.z - zz) < 400)) continue;
      const radius = r.range(24, 36);
      const y = Math.min(150, Math.max(34, sky.at(x, zz, radius + 12) + 14));
      incidents.push({ x, z: zz, y, radius, units: r.intRange(2, 3), seed: r.next() });
      // the red and blue wash on the street, baked as a violet glow
      emitters.push({ x, y: 6, z: zz, r: 1.4, g: 0.25, b: 1.6, radius: 34 });
      emitters.push({ x, y: y * 0.5, z: zz, r: 0.8, g: 0.2, b: 1.0, radius: 40 });
    }
  }

  return { routes, incidents, emitters };
}
