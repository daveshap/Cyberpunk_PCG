/**
 * Traffic: stacked flying-car lanes over the arterials and elevated highways.
 * Lanes are straight polylines; the renderer loops cars along them.
 */
import type { AirLane, Highway, RGB, Street, Vec3 } from './types';
import type { Zoning } from './zoning';
import type { Transit } from './transit';
import { Rng } from './rng';

const BANDS = [26, 42, 64, 96, 140, 200];
/** The hive stacks its traffic the whole way up the canyons. */
export const HIVE_BANDS = [34, 70, 120, 185, 260, 350, 460, 590, 740, 910, 1100, 1320];

export function makeLanes(z: Zoning, streets: readonly Street[], rng: Rng, transit?: Transit): { lanes: AirLane[]; highways: Highway[] } {
  // arterials carrying the metro viaduct keep their lowest air lane clear of it
  const onMetro = (st: Street): boolean =>
    (transit?.metro ?? []).some((m) => (st.axis === 'x' ? Math.abs(st.pos - m.rect.z0) < 1 || Math.abs(st.pos - m.rect.z1) < 1 : Math.abs(st.pos - m.rect.x0) < 1 || Math.abs(st.pos - m.rect.x1) < 1));
  const lanes: AirLane[] = [];
  const highways: Highway[] = [];
  for (const st of streets) {
    // the hive also flies its lower canyons, between the blocks
    const local = z.hive && st.kind === 'local';
    if (st.kind !== 'arterial' && st.kind !== 'highway' && !local) continue;
    const r = rng.fork('lane' + st.key);
    const len = st.hi - st.lo;
    if (len < 200) continue;
    if (st.kind === 'highway') {
      highways.push({ axis: st.axis, pos: st.pos, lo: st.lo, hi: st.hi, y: r.range(17, 21), width: 22, span: 42 });
    }
    // a few altitude bands per arterial, two directions each (the hive: many, stacked)
    const bands = z.hive ? HIVE_BANDS : BANDS;
    const nb = z.hive ? (local ? r.intRange(1, 3) : r.intRange(5, 8)) : st.kind === 'highway' ? 3 : r.intRange(1, 3);
    const used = new Set<number>();
    for (let k = 0; k < nb; k++) {
      const bi = r.int(local ? 7 : bands.length);
      if (used.has(bi) || (bi === 0 && onMetro(st))) continue;
      used.add(bi);
      const y = (bands[bi] as number) + r.range(-3, 3);
      for (const dir of [1, -1]) {
        const off = dir * r.range(5, 9);
        const pts: Vec3[] =
          st.axis === 'x'
            ? [
                [st.lo, y, st.pos + off],
                [st.hi, y, st.pos + off],
              ]
            : [
                [st.pos + off, y, st.lo],
                [st.pos + off, y, st.hi],
              ];
        const col: RGB = r.chance(0.2) ? (r.pick([
          [1, 0.2, 0.6],
          [0.2, 0.9, 1],
          [1, 0.75, 0.2],
        ]) as RGB) : [1, 0.08, 0.04];
        lanes.push({ pts, speed: r.range(16, 34) * (y > 100 ? 1.4 : 1) * (y > 400 ? 1.3 : 1), count: Math.max(2, Math.round(len / r.range(45, 90))), dir, col, seed: r.next() });
      }
    }
    // ground traffic on the highway deck
    if (st.kind === 'highway') {
      const hw = highways[highways.length - 1] as Highway;
      for (const dir of [1, -1]) {
        for (const lane of [3.5, 7.5]) {
          const off = dir * lane;
          const y = hw.y + 1.6;
          const pts: Vec3[] =
            st.axis === 'x'
              ? [
                  [st.lo, y, st.pos + off],
                  [st.hi, y, st.pos + off],
                ]
              : [
                  [st.pos + off, y, st.lo],
                  [st.pos + off, y, st.hi],
                ];
          lanes.push({ pts, speed: r.range(22, 30), count: Math.round(len / r.range(30, 55)), dir, col: [1, 0.06, 0.03], seed: r.next() });
        }
      }
    }
  }
  return { lanes, highways };
}
