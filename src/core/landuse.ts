/**
 * Land use: the nested zoning layer inside each district (the way UE's PCG
 * nests a zone graph inside a biome). Every block gets a use:
 *
 *  - residential, commercial, nightlife and industrial compete through smooth
 *    noise fields weighted by the district's use mix, so uses form patches
 *    rather than confetti,
 *  - one street per district with a nightlife share becomes a nightlife strip
 *    (every block on it turns nightlife),
 *  - civic and green are sprinkled: a quota of blocks, kept apart, where those
 *    fields peak; green blocks become parks and pocket plazas.
 *
 * The district still decides style, culture and wealth; the use decides the
 * building programme (see massing.ts and dressing.ts).
 */
import type { Block, Dials, District, LandUse, Street } from './types';
import type { Zoning } from './zoning';
import { PROFILES, tuneMul } from './profiles';
import { noise2 } from './rng';
import type { Rng } from './rng';

const COMPETING: readonly LandUse[] = ['residential', 'commercial', 'nightlife', 'industrial'];

const useSeed: Record<LandUse, number> = { residential: 11, commercial: 23, nightlife: 37, industrial: 41, civic: 53, green: 67 };

/** District use weights with the global use dials and the district tuning applied. */
export function useWeights(d: District, dials: Dials): Record<LandUse, number> {
  const base = PROFILES[d.kind].uses;
  const t = d.tune;
  const w = {} as Record<LandUse, number>;
  for (const u of Object.keys(useSeed) as LandUse[]) w[u] = (base[u] ?? 0) * (dials.uses?.[u] ?? 1);
  w.nightlife *= tuneMul(t.neon, 1.8);
  w.green *= tuneMul(t.budget, 1.7) / tuneMul(t.density, 1.5);
  w.civic *= tuneMul(t.budget, 1.4);
  w.industrial *= tuneMul(Math.max(0, t.decay), 1.5);
  return w;
}

export function assignUses(z: Zoning, blocks: Block[], streets: Street[], rng: Rng, dials: Dials): void {
  const seed = z.seed;
  const byDistrict = new Map<number, Block[]>();
  for (const b of blocks) {
    const list = byDistrict.get(b.district);
    if (list) list.push(b);
    else byDistrict.set(b.district, [b]);
  }
  const centre = (b: Block): [number, number] => [(b.plate.x0 + b.plate.x1) / 2, (b.plate.z0 + b.plate.z1) / 2];
  const field = (u: LandUse, x: number, zz: number): number => noise2(seed ^ useSeed[u], x / 260, zz / 260) * 0.75 + noise2(seed ^ (useSeed[u] * 7), x / 90, zz / 90) * 0.25;

  for (const [di, list] of byDistrict) {
    const d = z.districts[di] as District;
    const w = useWeights(d, dials);
    const r = rng.fork('use' + di);
    // ---- patches: each use claims its share of the district where its smooth
    // field is highest (smallest shares first), so uses form contiguous patches in
    // the proportions of the mix; the largest share takes what is left
    const total = COMPETING.reduce((a, u) => a + w[u], 0);
    const order = COMPETING.filter((u) => w[u] > 0).sort((a, b) => w[a] - w[b]);
    const free = new Set(list);
    if (total <= 0 || order.length === 0) for (const b of list) b.use = 'residential';
    else {
      for (const u of order.slice(0, -1)) {
        const share = (w[u] / total) * list.length;
        const n = Math.floor(share) + (r.next() < share % 1 ? 1 : 0);
        const ranked = [...free].map((b) => ({ b, s: field(u, ...centre(b)) })).sort((a, b2) => b2.s - a.s);
        for (let k = 0; k < n && k < ranked.length; k++) {
          const b = (ranked[k] as { b: Block }).b;
          b.use = u;
          free.delete(b);
        }
      }
      const last = order[order.length - 1] as LandUse;
      for (const b of free) b.use = last;
    }
    // ---- a nightlife strip along one local street
    if (w.nightlife > 0.05 && r.chance(Math.min(1, w.nightlife * 4))) {
      const locals = streets.filter((s) => s.district === di && (s.kind === 'local' || s.kind === 'alley') && s.hi - s.lo > 60);
      if (locals.length) {
        locals.sort((a, b) => b.hi - b.lo - (a.hi - a.lo));
        const st = locals[Math.min(locals.length - 1, r.int(Math.min(3, locals.length)))] as Street;
        st.use = 'nightlife';
        for (const b of list) {
          const P = b.plate;
          const half = st.road / 2 + 0.75;
          const touches =
            st.axis === 'x'
              ? (Math.abs(P.z0 - (st.pos + st.road / 2)) < 0.75 || Math.abs(P.z1 - (st.pos - st.road / 2)) < 0.75 || (P.z0 <= st.pos + half && P.z1 >= st.pos - half)) && P.x1 > st.lo && P.x0 < st.hi
              : (Math.abs(P.x0 - (st.pos + st.road / 2)) < 0.75 || Math.abs(P.x1 - (st.pos - st.road / 2)) < 0.75 || (P.x0 <= st.pos + half && P.x1 >= st.pos - half)) && P.z1 > st.lo && P.z0 < st.hi;
          if (touches) b.use = 'nightlife';
        }
      }
    }
    // ---- civic and green: a quota of blocks where their fields peak, kept apart
    const sprinkle = (u: LandUse, minGap: number): void => {
      const quota = Math.round(list.length * w[u] + (r.next() < (list.length * w[u]) % 1 ? 1 : 0));
      if (quota <= 0) return;
      const ranked = list
        .filter((b) => b.use !== 'nightlife' && b.use !== 'civic' && b.use !== 'green')
        .map((b) => ({ b, s: field(u, ...centre(b)) + r.next() * 0.15 }))
        .sort((a, b2) => b2.s - a.s);
      const picked: [number, number][] = [];
      for (const { b } of ranked) {
        if (picked.length >= quota) break;
        const [x, zz] = centre(b);
        if (picked.some(([px, pz]) => Math.hypot(px - x, pz - zz) < minGap)) continue;
        b.use = u;
        picked.push([x, zz]);
      }
    };
    sprinkle('civic', 260);
    sprinkle('green', 140);
    for (const b of list) {
      if (b.use !== 'green') continue;
      const area = (b.rect.x1 - b.rect.x0) * (b.rect.z1 - b.rect.z0);
      b.open = d.kind === 'corporate' || area < 1600 ? (r.chance(0.6) ? 'plaza' : 'park') : 'park';
    }
    // open lots that the street pass made keep their look but take a fitting use
    for (const b of list) {
      if (b.use === 'green') continue;
      if (b.open === 'park' || b.open === 'plaza') b.use = 'green';
      else if (b.open === 'yard') b.use = 'industrial';
    }
  }
}
