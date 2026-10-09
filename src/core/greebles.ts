/**
 * Bolted-on detail: what a city adds to its buildings once they stand. Risers and pipe
 * runs up and along the walls, ducts under the slabs, rooms hung off the facade on
 * brackets (in clusters, the way illegal extensions spread), capsules, catwalks, lift
 * shafts and service cores bolted up the outside, shacks, lattice masts and dishes on
 * the roofs. Small repeated detail is also what makes a big thing read as big (the
 * model makers' "greebles"), so megastructures get it at their own scale.
 *
 * Runs after dressing on its own random streams (keyed by each lot), so the rest of
 * the city stays put. How much a building carries follows its grime, its culture,
 * its district's clutter and its archetype: accreted blocks carry the most, glass
 * and luxury towers almost none.
 */
import type { Building, District, KitInstance, KitKind, Lot, RGB, Tier, Vec2 } from './types';
import { PROFILES } from './profiles';
import { Rng, clamp, lerp } from './rng';

interface Wall {
  a: Vec2;
  nx: number;
  nz: number;
  tx: number;
  tz: number;
  len: number;
}

function walls(t: Tier, min: number): Wall[] {
  const out: Wall[] = [];
  const p = t.poly;
  for (let i = 0; i < p.length; i++) {
    const a = p[i] as Vec2;
    const b = p[(i + 1) % p.length] as Vec2;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < min) continue;
    out.push({ a, nx: dz / len, nz: -dx / len, tx: dx / len, tz: dz / len, len });
  }
  return out;
}

/** Archetypes that grow by accretion carry the most; sleek ones almost none. */
const ACCRETE: Partial<Record<Building['archetype'], number>> = {
  stack: 1.5,
  hulk: 1.4,
  megablock: 1.3,
  arcology: 1.2,
  ziggurat: 1.1,
  stilts: 1.2,
  shophouse: 1.1,
  midrise: 1.1,
  ruin: 1.2,
  shack: 1.0,
  shed: 1.0,
  lean: 0.8,
  bundle: 0.7,
  tower: 0.55,
  monolith: 0.35,
  cantilever: 0.6,
  needle: 0.2,
  spire: 0.15,
  villa: 0.2,
  egg: 0.1,
  helix: 0.15,
  prism: 0.15,
  pyramid: 0.1,
  disc: 0.4,
  flare: 0.4,
  arch: 0.6,
  twist: 0.3,
  taper: 0.3,
  skyship: 0.4,
  podium: 0.6,
  tankfarm: 1.0,
};

const PAINT: readonly RGB[] = [
  [0.32, 0.31, 0.29],
  [0.22, 0.26, 0.24],
  [0.36, 0.3, 0.22],
  [0.2, 0.22, 0.27],
  [0.4, 0.16, 0.1],
  [0.28, 0.34, 0.36],
  [0.42, 0.38, 0.3],
  [0.15, 0.15, 0.16],
];
const PIPE: readonly RGB[] = [
  [0.26, 0.25, 0.23],
  [0.33, 0.32, 0.3],
  [0.2, 0.12, 0.07],
  [0.4, 0.36, 0.2],
  [0.15, 0.2, 0.18],
];

export function boltOn(buildings: readonly Building[], lots: readonly Lot[], districts: readonly District[], rng: Rng): KitInstance[] {
  const kits: KitInstance[] = [];
  for (const b of buildings) {
    const d = districts[b.district];
    if (!d) continue;
    const prof = PROFILES[d.kind];
    const s = b.style;
    const tn = d.tune;
    const lot = lots[b.lot];
    const r = rng.fork('bolt' + (lot?.key ?? b.id));
    // how much this building carries
    const culture = 0.45 * s.cn + 0.25 * s.jp;
    let g = prof.greeble * (0.5 + 0.75 * s.grime + culture - 0.45 * s.luxury - 0.25 * s.edge) * (1 + 0.5 * tn.decay - 0.3 * tn.budget + 0.3 * tn.density);
    g *= ACCRETE[b.archetype] ?? 0.6;
    if (b.use === 'residential' || b.use === 'nightlife') g *= 1.2;
    if (b.use === 'civic') g *= 0.5;
    g = clamp(g, 0, 1.8);
    if (g < 0.04) continue;
    // greebles grow with the building, so a megastructure's pipes read at its scale
    const S = clamp(b.height / 140, 1, 4.5);
    const cap = Math.round(40 + Math.min(b.height, 900) * 0.6);
    let n = 0;
    const kit = (kind: KitKind, x: number, y: number, z: number, rot: number, sx: number, sy: number, sz: number, col: RGB, emit = 0): void => {
      if (n >= cap) return;
      n++;
      kits.push({ kind, x, y, z, rot, sx, sy, sz, col, emit, seed: r.next() });
    };
    const industrial = d.kind === 'industrial' || b.use === 'industrial';
    for (const t of b.tiers) {
      // walls only where they are plumb and flat; inside a sloped or curved shell nothing hangs
      if (t.top || t.smooth) continue;
      const st = t.facade.style;
      const sleek = st === 'glass' || st === 'lux' ? 0.2 : st === 'panel' ? 0.55 : 1;
      const fh = t.facade.floorH;
      const H = t.y1 - t.y0;
      const floors = Math.max(1, Math.floor(H / fh + 0.01));
      // greebles start above the shop band on the ground storey
      const yBase = t.grounded ? Math.max(t.shopH, fh) + 0.2 : t.y0 + 0.2;
      for (const w of walls(t, 5)) {
        const at = (u: number, out: number): [number, number] => [w.a[0] + w.tx * u + w.nx * out, w.a[1] + w.tz * u + w.nz * out];
        const rotOut = Math.atan2(w.nx, w.nz);
        const rotAlong = Math.atan2(-w.tz, w.tx);
        // ---- risers: a bundle of pipes up the wall, turning along it at the top
        if (t.y1 - yBase > 8 && r.chance(0.32 * g * sleek)) {
          const np = r.intRange(1, industrial ? 4 : 3);
          const rad = (industrial ? r.range(0.2, 0.55) : r.range(0.09, 0.24)) * S;
          const gap = rad * r.range(2.4, 3.4);
          const u0 = clamp(r.range(0.06, 0.94) * w.len, gap * np, w.len - gap * np);
          const col = PIPE[r.int(PIPE.length)] as RGB;
          for (let k = 0; k < np; k++) {
            const rk = rad * r.range(0.65, 1.15);
            const [x, z] = at(u0 + (k - (np - 1) / 2) * gap, rk + 0.06);
            kit('pipeV', x, yBase, z, 0, rk, t.y1 - yBase + 0.3, rk, col);
          }
          if (r.chance(0.5)) {
            const run = Math.min(w.len - 1, r.range(0.25, 0.8) * w.len);
            const dir = u0 > w.len / 2 ? -1 : 1;
            const [x, z] = at(u0 + (dir * run) / 2, rad + 0.06);
            kit('pipeH', x, t.y1 - rad * 2 - 0.4, z, rotAlong, run, rad, rad, col);
          }
        }
        // ---- a pipe run or a duct along the wall under a slab
        if (floors >= 2 && r.chance(0.26 * g * sleek)) {
          const f = r.intRange(1, floors - 1);
          const run = w.len * r.range(0.3, 0.92);
          const u = r.range(run / 2, w.len - run / 2);
          if (r.chance(0.45)) {
            const hh = r.range(0.45, 1.0) * S;
            const dd = r.range(0.45, 0.9) * S;
            const [x, z] = at(u, dd / 2 + 0.05);
            kit('duct', x, t.y0 + f * fh - hh - 0.15, z, rotAlong, run, hh, dd, [0.42, 0.43, 0.44]);
          } else {
            const rad = r.range(0.08, 0.2) * S;
            const [x, z] = at(u, rad + 0.05);
            const col = PIPE[r.int(PIPE.length)] as RGB;
            for (let k = 0; k < r.intRange(1, 3); k++) kit('pipeH', x + w.nx * k * rad * 2.4, t.y0 + f * fh - rad - 0.25, z + w.nz * k * rad * 2.4, rotAlong, run, rad, rad, col);
          }
        }
        // ---- rooms hung off the wall, in clusters
        if (st !== 'glass' && st !== 'lux' && floors >= 3) {
          const want = g * (w.len / 24) * clamp(floors / 9, 0.4, 2.4) * (b.use === 'residential' || b.use === 'nightlife' ? 1.2 : 0.75);
          let clusters = Math.floor(want) + (r.chance(want % 1) ? 1 : 0);
          clusters = Math.min(clusters, 6);
          for (let c = 0; c < clusters; c++) {
            const f0 = r.intRange(t.grounded ? 2 : 1, Math.max(t.grounded ? 2 : 1, floors - 2));
            let u = r.range(0.12, 0.88) * w.len;
            let y = t.y0 + f0 * fh;
            const m = r.intRange(1, 4);
            const col = PAINT[r.int(PAINT.length)] as RGB;
            for (let k = 0; k < m; k++) {
              const mw = Math.min(w.len * 0.4, r.range(2.2, 5.5));
              const mh = fh * r.weighted([1, 2, 3], [0.55, 0.35, 0.1]) - 0.2;
              const md = r.range(1.1, 2.6);
              if (u - mw / 2 < 0.3 || u + mw / 2 > w.len - 0.3 || y + mh > t.y1 - 0.5) break;
              const [x, z] = at(u, md / 2 + 0.02);
              const tint: RGB = r.chance(0.7) ? col : (PAINT[r.int(PAINT.length)] as RGB);
              kit('module', x, y, z, rotOut, mw, mh, md, tint, r.chance(0.5 + 0.2 * culture) ? r.range(1.0, 2.0) : 0);
              // a bracket under the first room of the cluster
              if (k === 0) {
                const [bx, bz] = at(u, md * 0.4);
                kit('box', bx, y - 0.9, bz, rotOut, mw * 0.85, 0.9, md * 0.7, [0.12, 0.1, 0.09]);
              }
              // the next room grows up or sideways from this one
              if (r.chance(0.6)) y += mh + 0.15;
              else u += (mw + r.range(0.1, 0.6)) * r.sign();
            }
          }
        }
        // ---- capsules: a patch of pods on the blocks that grow by accretion
        if ((b.archetype === 'stack' || b.archetype === 'megablock' || b.archetype === 'arcology') && floors >= 6 && r.chance(0.34 * g)) {
          const cols = Math.min(8, Math.floor(w.len / 3.2));
          const rows = Math.min(10, floors - 3);
          const f0 = r.intRange(2, Math.max(2, floors - rows));
          const u0 = r.range(1, Math.max(1.2, w.len - cols * 3));
          const col = PAINT[r.int(PAINT.length)] as RGB;
          for (let i = 0; i < cols; i++)
            for (let j = 0; j < rows; j++) {
              if (!r.chance(0.72)) continue;
              const [x, z] = at(u0 + i * 3 + 1.4, 1.2 + r.range(0, 0.6));
              kit('pod', x, t.y0 + (f0 + j) * fh + 0.1, z, rotOut + r.range(-0.08, 0.08), 2.5, Math.min(2.5, fh - 0.2), 2.4, r.chance(0.8) ? col : [0.5, 0.5, 0.48], r.chance(0.45) ? r.range(1.0, 1.8) : 0);
            }
        }
        // ---- a catwalk with its railing along an upper floor
        if ((industrial || b.archetype === 'megablock' || b.archetype === 'stack' || st === 'metal') && floors >= 3 && r.chance(0.16 * g)) {
          const f = r.intRange(1, floors - 1);
          const run = w.len * r.range(0.4, 1.0);
          const u = r.range(run / 2, w.len - run / 2);
          const y = t.y0 + f * fh;
          const [x, z] = at(u, 0.65);
          kit('box', x, y - 0.15, z, rotOut, run, 0.15, 1.2, [0.18, 0.18, 0.19]);
          const [rx, rz] = at(u, 1.25);
          kit('cage', rx, y + 0.5, rz, rotOut, run, 1.0, 0.05, [0.3, 0.3, 0.3]);
        }
      }
    }
    // ---- a lift shaft or service core bolted up the outside of a tall tower
    const tall = b.tiers.filter((t) => !t.top && !t.smooth && t.y1 - t.y0 > 40);
    if (b.height > 70 && tall.length > 0 && r.chance(clamp(0.2 * g + 0.12, 0, 0.6))) {
      const t = tall.reduce((m, x) => (x.y1 - x.y0 > m.y1 - m.y0 ? x : m), tall[0] as Tier);
      const ws = walls(t, 12);
      if (ws.length > 0) {
        const w = ws[r.int(ws.length)] as Wall;
        const sw = r.range(2.6, 4.2) * Math.sqrt(S);
        const sd = r.range(2.2, 3.6) * Math.sqrt(S);
        const u = r.range(sw, w.len - sw);
        const x = w.a[0] + w.tx * u + w.nx * (sd / 2);
        const z = w.a[1] + w.tz * u + w.nz * (sd / 2);
        const y0 = t.grounded ? 0 : t.y0;
        kit('shaft', x, y0, z, Math.atan2(w.nx, w.nz), sw, t.y1 - y0 + r.range(2, 6), sd, PAINT[r.int(PAINT.length)] as RGB, r.chance(0.7) ? r.range(0.8, 1.6) : 0);
      }
    }
    // ---- roofs: shacks, lattice masts with dishes, tanks
    const roofs = b.tiers.filter((t) => !t.seam && (t.roof === 'flat' || t.roof === 'crown') && t.y1 >= b.height * 0.5);
    for (const t of roofs) {
      const cap2 = t.top ?? t.poly;
      const xs = cap2.map((p) => p[0]);
      const zs = cap2.map((p) => p[1]);
      // round tops: keep to the inscribed square
      const ins = cap2.length > 4 ? 1 - Math.SQRT1_2 : 0;
      const x0 = Math.min(...xs) + (Math.max(...xs) - Math.min(...xs)) * ins * 0.5 + 1.5;
      const x1 = Math.max(...xs) - (Math.max(...xs) - Math.min(...xs)) * ins * 0.5 - 1.5;
      const z0 = Math.min(...zs) + (Math.max(...zs) - Math.min(...zs)) * ins * 0.5 + 1.5;
      const z1 = Math.max(...zs) - (Math.max(...zs) - Math.min(...zs)) * ins * 0.5 - 1.5;
      if (x1 - x0 < 4 || z1 - z0 < 4) continue;
      const area = (x1 - x0) * (z1 - z0);
      const shacks = Math.min(5, Math.floor((area / 260) * g + (r.chance(g * 0.6) ? 1 : 0)));
      for (let k = 0; k < shacks; k++) {
        const w = Math.min(x1 - x0, r.range(3, 7));
        const dd = Math.min(z1 - z0, r.range(2.5, 5));
        const x = lerp(x0 + w / 2, x1 - w / 2, r.next());
        const z = lerp(z0 + dd / 2, z1 - dd / 2, r.next());
        kit('module', x, t.y1, z, r.pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]), w, r.range(2.4, 3.2), dd, PAINT[r.int(PAINT.length)] as RGB, r.chance(0.55) ? r.range(0.9, 1.8) : 0);
      }
      if (b.height > 30 && r.chance(clamp(0.18 + 0.35 * g, 0, 0.75))) {
        const mh = r.range(8, 22) * Math.sqrt(S) * (b.height > 150 ? 1.6 : 1);
        const mw = clamp(mh * 0.07, 0.9, 3.2);
        const x = lerp(x0 + mw, x1 - mw, r.next());
        const z = lerp(z0 + mw, z1 - mw, r.next());
        kit('truss', x, t.y1, z, r.range(0, Math.PI), mw, mh, mw, [0.42, 0.42, 0.44]);
        // dishes and panels up the mast
        const nd = r.intRange(1, 3);
        for (let k = 0; k < nd; k++) kit('dish', x + mw * 0.6, t.y1 + mh * r.range(0.45, 0.9), z, r.range(0, Math.PI * 2), r.range(0.6, 1.4), 1, 1, [0.6, 0.6, 0.62]);
        kit('beacon', x, t.y1 + mh + 0.3, z, 0, 0.3, 0.3, 0.3, [1, 0.08, 0.05], 6);
      }
    }
  }
  return kits;
}
