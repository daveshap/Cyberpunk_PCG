/**
 * Lot subdivision: recursive splits of each block along its longer axis until
 * the pieces fit the district's frontage range. Blocks are axis-aligned, so
 * this is the axis-aligned case of the OBB split used in CityEngine-style
 * parcel generators.
 */
import type { Block, District, DistrictKind, LandUse, Lot, Rect } from './types';
import { PROFILES, tuneMul } from './profiles';
import { Rng } from './rng';

/** Chance (at alien 0.5) that a block is kept whole, or halved, for a megastructure. */
const MEGA_P: Record<DistrictKind, number> = { corporate: 0.5, megablock: 0.36, luxury: 0.2, jpmarket: 0.04, cnmarket: 0.05, industrial: 0.08, decayed: 0.05 };
const MEGA_USE: Record<LandUse, number> = { residential: 1, commercial: 1, civic: 1.2, nightlife: 0, industrial: 0.5, green: 0 };

export function makeLots(blocks: readonly Block[], districts: readonly District[], rng: Rng, density: number, alien = 0.5): Lot[] {
  const lots: Lot[] = [];
  for (const b of blocks) {
    if (b.open !== 'none') continue;
    const d = districts[b.district] as District;
    const p = PROFILES[d.kind];
    const r = rng.fork('lots' + b.key);
    // megastructure lots: a separate stream, so the ordinary splits stay put
    const rm = rng.fork('mega' + b.key);
    const bw = b.rect.x1 - b.rect.x0;
    const bd = b.rect.z1 - b.rect.z0;
    const pMega = MEGA_P[d.kind] * MEGA_USE[b.use] * Math.min(2.2, alien * 2) * tuneMul(d.tune.scale, 1.4);
    const mega = !b.landmark && Math.min(bw, bd) >= 44 && rm.chance(Math.min(0.85, pMega));
    // tuned scale widens frontages, tuned density narrows them
    const k = (1 / Math.sqrt(density)) * tuneMul(d.tune.scale, 1.5) / tuneMul(d.tune.density, 1.35);
    const lmin = p.lot[0] * k;
    const lmax = p.lot[1] * k;
    const market = d.kind === 'jpmarket' || d.kind === 'cnmarket';
    const out: Rect[] = [];
    const split = (rc: Rect, depth: number): void => {
      const w = rc.x1 - rc.x0;
      const h = rc.z1 - rc.z0;
      const long = Math.max(w, h);
      const short = Math.min(w, h);
      // stop when the frontage fits; market lots may run deep (party-wall strips)
      const fits = market ? short <= lmax * 1.15 && long <= Math.max(lmax * 2.8, short * 2.4) : long <= lmax;
      if (depth > 12 || fits || long < lmin * 2) {
        out.push(rc);
        return;
      }
      // markets cut across the long axis to make narrow frontages; others split the longer side
      const t = r.range(market ? 0.3 : 0.38, market ? 0.7 : 0.62);
      if (w >= h) {
        const x = rc.x0 + w * t;
        if (x - rc.x0 < lmin || rc.x1 - x < lmin) return out.push(rc), undefined;
        split({ ...rc, x1: x }, depth + 1);
        split({ ...rc, x0: x }, depth + 1);
      } else {
        const z = rc.z0 + h * t;
        if (z - rc.z0 < lmin || rc.z1 - z < lmin) return out.push(rc), undefined;
        split({ ...rc, z1: z }, depth + 1);
        split({ ...rc, z0: z }, depth + 1);
      }
    };
    if (b.landmark) out.push(b.rect);
    else if (mega) {
      // long blocks are halved across their length so the piece stays squarish
      const long = Math.max(bw, bd);
      const short = Math.min(bw, bd);
      if (long > short * 2.1) {
        const t = rm.range(0.42, 0.58);
        if (bw >= bd) out.push({ ...b.rect, x1: b.rect.x0 + bw * t }, { ...b.rect, x0: b.rect.x0 + bw * t });
        else out.push({ ...b.rect, z1: b.rect.z0 + bd * t }, { ...b.rect, z0: b.rect.z0 + bd * t });
      } else out.push(b.rect);
    } else split(b.rect, 0);
    const R = b.rect;
    const e = 0.05;
    for (const [n, rc] of out.entries()) {
      lots.push({
        id: lots.length,
        key: `${b.key}:${n}`,
        block: b.id,
        rect: rc,
        district: b.district,
        use: b.use,
        ...(b.landmark ? { landmark: b.landmark } : {}),
        ...(mega ? { mega: true } : {}),
        front: [Math.abs(rc.x0 - R.x0) < e, Math.abs(rc.x1 - R.x1) < e, Math.abs(rc.z0 - R.z0) < e, Math.abs(rc.z1 - R.z1) < e],
      });
    }
  }
  return lots;
}
