/**
 * Dressing: signs, kit instances (AC units, tanks, lamps...), one-off
 * structures (cranes, wires, lantern strings, awnings, docks), steam vents and
 * the light emitters that feed the light volume. Everything is driven by the
 * building's resolved style and culture, so the same rules give a Japanese
 * street stacked vertical tenant signs and overhead wires, a Hong Kong street
 * projecting framed signs and AC boxes, and an American street billboards,
 * marquees and rooftop letters.
 */
import type { Block, Building, Culture, District, DistrictKind, Emitter, EmitterSrc, KitInstance, KitKind, LandUse, Lot, RGB, RoadPiece, SignKind, SignSpec, SteamVent, Street, Structure, Tier, Vec2 } from './types';
import type { Zoning } from './zoning';
import { PROFILES, tuneMul } from './profiles';
import { Rng, clamp, hash01, lerp } from './rng';
import { bladeWord, roofWord, shopName } from './names';

export interface DressingResult {
  signs: SignSpec[];
  kits: KitInstance[];
  structures: Structure[];
  emitters: Emitter[];
  steam: SteamVent[];
}

interface Wall {
  a: Vec2;
  b: Vec2;
  nx: number;
  nz: number;
  tx: number;
  tz: number;
  len: number;
  tier: Tier;
  edge: number;
  shop: boolean;
}

/** The footprint of a tier at height y (tapered tiers interpolate toward `top`). */
function polyAt(t: Tier, y: number): Vec2[] {
  if (!t.top) return t.poly;
  const k = clamp((y - t.y0) / Math.max(1e-3, t.y1 - t.y0), 0, 1);
  const top = t.top;
  return t.poly.map((p, i) => [lerp(p[0], (top[i] as Vec2)[0], k), lerp(p[1], (top[i] as Vec2)[1], k)] as Vec2);
}

function wallsOf(t: Tier, poly: readonly Vec2[] = t.poly): Wall[] {
  const out: Wall[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i] as Vec2;
    const b = poly[(i + 1) % n] as Vec2;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1) continue;
    out.push({ a, b, nx: dz / len, nz: -dx / len, tx: dx / len, tz: dz / len, len, tier: t, edge: i, shop: t.shopEdges.includes(i) });
  }
  return out;
}

const WARM: RGB = [1, 0.72, 0.42];
const COOL: RGB = [0.72, 0.84, 1];

function scaleC(c: RGB, k: number): RGB {
  return [c[0] * k, c[1] * k, c[2] * k];
}

const SIGN_CAP = 42000;
const KIT_CAP = 220000;
/** Building-sized ad walls and rooftop holograms across the whole city. */
const MEGA_CAP = 46;
const ROOF_HOLO_CAP = 140;
const MEGA_KINDS: ReadonlySet<DistrictKind> = new Set(['corporate', 'megablock', 'jpmarket', 'cnmarket', 'luxury']);

/** Signage multiplier per land use. */
const USE_SIGNS: Record<LandUse, number> = { residential: 0.4, commercial: 1, nightlife: 2.3, industrial: 0.35, civic: 0.55, green: 0.2 };
const CLOTH: readonly RGB[] = [
  [0.55, 0.12, 0.1],
  [0.12, 0.25, 0.5],
  [0.6, 0.55, 0.45],
  [0.15, 0.4, 0.3],
  [0.65, 0.5, 0.12],
  [0.4, 0.15, 0.4],
  [0.7, 0.7, 0.68],
];

export function dress(z: Zoning, buildings: readonly Building[], lots: readonly Lot[], blocks: readonly Block[], streets: readonly Street[], roads: readonly RoadPiece[], rng: Rng, structures: Structure[]): DressingResult {
  const signs: SignSpec[] = [];
  const kits: KitInstance[] = [];
  const emitters: Emitter[] = [];
  const steam: SteamVent[] = [];

  const emit = (x: number, y: number, zz: number, c: RGB, k: number, radius: number, src?: EmitterSrc): void => {
    const e: Emitter = { x, y, z: zz, r: c[0] * k, g: c[1] * k, b: c[2] * k, radius };
    if (src) e.src = src;
    emitters.push(e);
  };
  const kit = (kind: KitKind, x: number, y: number, zz: number, rot: number, sx: number, sy: number, sz: number, col: RGB, e = 0, seed = 0): void => {
    if (kits.length >= KIT_CAP) return;
    kits.push({ kind, x, y, z: zz, rot, sx, sy, sz, col, emit: e, seed });
  };

  let megaScreens = 0;
  let roofHolos = 0;

  // ------------------------------------------------------------- buildings
  // visit buildings in a fixed shuffled order: if a cap is ever reached it thins
  // signs and kits evenly instead of starving whichever districts come last
  const visit = buildings.slice().sort((a, b2) => hash01(0x5a17, a.id, 3) - hash01(0x5a17, b2.id, 3));
  for (const b of visit) {
    const r = rng.fork('dress' + (lots[b.lot]?.key ?? b.id));
    const d = z.districts[b.district] as District;
    const prof = PROFILES[d.kind];
    const s = b.style;
    const tn = d.tune;
    const decay = Math.max(0, tn.decay);
    // tuned clutter: decay and density pile it on, budget tidies it away
    const greeble = clamp(prof.greeble * (1 + 0.5 * tn.decay - 0.3 * tn.budget + 0.3 * tn.density), 0, 1.4);
    const pal = b.palette;
    const col = (i: number): RGB => pal[i % pal.length] ?? [1, 1, 1];
    const night = b.use === 'nightlife';
    const intensity = (k = 1): number => (1.6 + 1.6 * s.flash) * (1 + 0.35 * tn.neon) * (night ? 1.3 : 1) * r.range(0.75, 1.25) * k;
    const flickerOf = (): 0 | 1 | 2 | 3 => {
      const x = r.next();
      if (x < s.grime * s.grime * 0.22 + decay * 0.12) return 3;
      if (x < s.grime * 0.32 + decay * 0.18) return 2;
      if (x < 0.12 + s.grime * 0.2) return 1;
      return 0;
    };
    const textFor = (c: Culture, n: number, latin: () => string): { text: string; glyphs: number[] } => {
      if (c === 'us') return { text: latin(), glyphs: [] };
      const glyphs: number[] = [];
      const base = c === 'jp' ? 1 : 2; // the renderer maps seed ranges to kana-like / block glyph families
      for (let k = 0; k < n; k++) glyphs.push(base * 100000 + r.int(99999));
      return { text: c === 'jp' && r.chance(0.18) ? latin() : '', glyphs };
    };
    // nightlife strips in a low-sign district still need a floor of signage
    const signDensity = Math.max(prof.signs * (0.45 + 1.1 * s.flash) * tuneMul(tn.neon, 1.9) * USE_SIGNS[b.use], night ? 1.4 : 0);
    const ground = b.tiers.filter((t) => t.grounded);
    const top = b.tiers.reduce((m, t) => (t.y1 > m.y1 ? t : m), b.tiers[0] as Tier);

    for (const t of ground) {
      // signs need a plumb wall: battered and tapered tiers take none
      if (t.top) continue;
      for (const w of wallsOf(t)) {
        if (!w.shop || signs.length >= SIGN_CAP) continue;
        const culture = b.culture;
        const market = d.kind === 'jpmarket' || d.kind === 'cnmarket';
        const unitW = market ? r.range(4.2, 7.5) : d.kind === 'decayed' ? r.range(6, 11) : r.range(9, 18);
        const units = Math.max(1, Math.floor(w.len / unitW));
        const uw = w.len / units;
        const shopH = t.shopH > 0 ? t.shopH : 4;
        for (let u = 0; u < units; u++) {
          const along = (u + 0.5) * uw;
          const px = w.a[0] + w.tx * along;
          const pz = w.a[1] + w.tz * along;
          // ---- fascia
          if (r.chance(clamp(0.3 + signDensity * 0.35, 0, 0.98)) && uw > 2.5) {
            const sw = uw * r.range(0.7, 0.92);
            const sh = clamp(sw * 0.18, 0.7, 1.5);
            const dep = 0.22;
            const tx = textFor(culture, r.intRange(2, 5), () => shopName(r));
            const lb = culture !== 'us' ? r.chance(0.55) : r.chance(0.25);
            const c = col(u);
            const sp: SignSpec = {
              kind: 'fascia',
              culture,
              x: px + w.nx * (dep / 2 + 0.03),
              y: shopH - sh / 2 - 0.25,
              z: pz + w.nz * (dep / 2 + 0.03),
              nx: w.nx,
              nz: w.nz,
              wnx: w.nx,
              wnz: w.nz,
              w: sw,
              h: sh,
              depth: dep,
              arm: 0,
              text: tx.text,
              glyphs: tx.glyphs,
              vertical: false,
              col: c,
              col2: col(u + 1),
              intensity: intensity(),
              flicker: flickerOf(),
              lightbox: lb,
              frame: !lb && r.chance(0.4),
              twoSided: false,
              seed: r.next(),
            };
            signs.push(sp);
            emit(sp.x + w.nx * 2, sp.y - 0.5, sp.z + w.nz * 2, c, sp.intensity * sw * 0.18 * (sp.flicker === 3 ? 0 : 1), clamp(sw * 1.6, 6, 18), 'sign');
          }
          // ---- awnings in markets
          if (market && r.chance(0.28)) structures.push({ kind: 'awning', p: [px - w.tx * uw * 0.45, pz - w.tz * uw * 0.45, px + w.tx * uw * 0.45, pz + w.tz * uw * 0.45, shopH - 0.15, r.range(1.2, 2.2)], col: col(u + 2), col2: [0.05, 0.05, 0.05], seed: r.next() });

          // ---- culture-specific upper signs
          // upper signs climb this tier's own wall, never past its top
          const roomUp = t.y1 - shopH - 1;
          if (roomUp < 2.5) continue;
          if (culture === 'jp' && r.chance(clamp(signDensity * 0.32, 0, 0.9))) {
            // vertical tenant stack or neon blade projecting from the facade
            const h = Math.min(roomUp - 0.5, r.range(3.5, 11));
            if (h < 2.5) continue;
            const wv = r.range(0.75, 1.25);
            const arm = r.range(0.7, 1.3);
            const lb = r.chance(0.5);
            const c = col(u + 1);
            const sp: SignSpec = {
              kind: 'blade',
              culture,
              x: px + w.nx * arm,
              y: shopH + 0.6 + h / 2,
              z: pz + w.nz * arm,
              nx: w.tx,
              nz: w.tz,
              wnx: w.nx,
              wnz: w.nz,
              w: wv,
              h,
              depth: 0.35,
              arm,
              text: r.chance(0.2) ? bladeWord(r) : '',
              glyphs: Array.from({ length: Math.max(2, Math.floor(h / (wv * 1.15))) }, () => 100000 + r.int(99999)),
              vertical: true,
              col: c,
              col2: col(u + 2),
              intensity: intensity(1.1),
              flicker: flickerOf(),
              lightbox: lb,
              frame: !lb,
              twoSided: true,
              seed: r.next(),
            };
            signs.push(sp);
            emit(sp.x, sp.y, sp.z, c, sp.intensity * h * 0.35 * (sp.flicker === 3 ? 0 : 1), clamp(h * 1.8, 8, 22), 'sign');
          } else if (culture === 'cn' && r.chance(clamp(signDensity * 0.3, 0, 0.85))) {
            // big projecting framed sign over the street
            const sh = Math.min(roomUp - 0.5, r.range(2.6, 7.5));
            if (sh < 2) continue;
            const sw = r.range(1.6, 3.6);
            const arm = r.range(1.4, 3.6);
            const y = shopH + 0.8 + r.range(0, Math.max(0, roomUp - sh - 1)) * 0.6 + sh / 2;
            const c = col(u);
            const sp: SignSpec = {
              kind: 'frame',
              culture,
              x: px + w.nx * (arm + sw / 2),
              y,
              z: pz + w.nz * (arm + sw / 2),
              nx: w.tx,
              nz: w.tz,
              wnx: w.nx,
              wnz: w.nz,
              w: sw,
              h: sh,
              depth: 0.3,
              arm: arm + sw / 2,
              text: '',
              glyphs: Array.from({ length: Math.max(2, Math.round(sh / (sw * 0.55))) }, () => 200000 + r.int(99999)),
              vertical: true,
              col: c,
              col2: col(u + 1),
              intensity: intensity(1.15),
              flicker: flickerOf(),
              lightbox: r.chance(0.45),
              frame: true,
              twoSided: true,
              seed: r.next(),
            };
            signs.push(sp);
            emit(sp.x, sp.y, sp.z, c, sp.intensity * sw * sh * 0.12 * (sp.flicker === 3 ? 0 : 1), clamp(sh * 2.2, 8, 26), 'sign');
          } else if (culture === 'us' && (u === 0 || (night && u % 2 === 0)) && r.chance(clamp(signDensity * 0.18, 0, night ? 0.85 : 0.6))) {
            // classic vertical letter blade at the corner, or a marquee
            if (r.chance(0.5) && roomUp > 5) {
              const word = bladeWord(r);
              const h = Math.min(roomUp - 0.5, word.length * 1.25 + 0.8);
              const arm = r.range(0.8, 1.4);
              const c = col(u);
              const sp: SignSpec = {
                kind: 'blade',
                culture,
                x: px + w.nx * arm,
                y: shopH + 0.6 + h / 2,
                z: pz + w.nz * arm,
                nx: w.tx,
                nz: w.tz,
                wnx: w.nx,
                wnz: w.nz,
                w: 1.1,
                h,
                depth: 0.35,
                arm,
                text: word,
                glyphs: [],
                vertical: true,
                col: c,
                col2: col(u + 1),
                intensity: intensity(1.1),
                flicker: flickerOf(),
                lightbox: false,
                frame: true,
                twoSided: true,
                seed: r.next(),
              };
              signs.push(sp);
              emit(sp.x, sp.y, sp.z, c, sp.intensity * h * 0.3, clamp(h * 2, 8, 20), 'sign');
            } else {
              const sw = Math.min(uw * 0.95, r.range(5, 9));
              const c = col(u);
              const sp: SignSpec = {
                kind: 'marquee',
                culture,
                x: px + w.nx * 1.2,
                y: shopH + 0.2,
                z: pz + w.nz * 1.2,
                nx: w.nx,
                nz: w.nz,
                wnx: w.nx,
                wnz: w.nz,
                w: sw,
                h: 1.6,
                depth: 2.2,
                arm: 1.2,
                text: shopName(r),
                glyphs: [],
                vertical: false,
                col: c,
                col2: [1, 0.85, 0.55],
                intensity: intensity(1.2),
                flicker: flickerOf(),
                lightbox: true,
                frame: true,
                twoSided: false,
                seed: r.next(),
              };
              signs.push(sp);
              emit(sp.x + w.nx * 2, sp.y, sp.z + w.nz * 2, c, sp.intensity * sw * 0.4, 18, 'sign');
            }
          }
        }
        // ---- screens / big LED walls on podiums and megablock ends
        const big = (d.kind === 'corporate' || d.kind === 'megablock' || (d.kind === 'jpmarket' && b.height > 25) || (tn.budget + tn.neon > 0.8 && b.height > 20)) && w.len > 14 && r.chance(clamp(0.12 + 0.35 * s.flash + 0.15 * tn.budget + 0.12 * tn.neon, 0, 0.9));
        if (big && signs.length < SIGN_CAP) {
          const sw = Math.min(w.len * 0.8, r.range(12, 34));
          const sh = Math.min(t.y1 - shopH - 2, sw * r.range(0.45, 0.9));
          if (sh > 5) {
            const along = w.len * r.range(0.35, 0.65);
            const y = Math.min(t.y1 - sh / 2 - 1, shopH + 2 + sh / 2 + r.range(0, 8));
            const c = col(0);
            signs.push({
              kind: 'screen',
              culture: b.culture,
              x: w.a[0] + w.tx * along + w.nx * 0.35,
              y,
              z: w.a[1] + w.tz * along + w.nz * 0.35,
              nx: w.nx,
              nz: w.nz,
              wnx: w.nx,
              wnz: w.nz,
              w: sw,
              h: sh,
              depth: 0.6,
              arm: 0,
              text: '',
              glyphs: [],
              vertical: false,
              col: c,
              col2: col(1),
              intensity: intensity(1),
              flicker: 0,
              lightbox: false,
              frame: r.chance(0.5),
              twoSided: false,
              seed: r.next(),
            });
            emit(w.a[0] + w.tx * along + w.nx * 10, y, w.a[1] + w.tz * along + w.nz * 10, c, 2.2 * sw * sh * 0.025, clamp(sw * 1.5, 18, 50), 'sign');
          }
        }
      }
    }

    // ---- roof signs, billboards, logos (on the roof outline: a tapered top is smaller than its base)
    const topWalls = wallsOf(top, top.top ?? top.poly);
    if (signs.length < SIGN_CAP && topWalls.length > 0) {
      const tw = topWalls.reduce((m, w) => (w.len > m.len ? w : m), topWalls[0] as Wall);
      if ((d.kind === 'corporate' || b.archetype === 'spire' || b.archetype === 'needle') && !top.top && b.height > 90 && r.chance(0.55 + 0.3 * s.edge)) {
        // giant logo near the crown, on the two widest faces
        const faces = topWalls.slice().sort((p, q) => q.len - p.len).slice(0, 2);
        const logoText = roofWord(r);
        const c = col(r.int(3));
        for (const f of faces) {
          const sw = Math.min(f.len * 0.7, 36);
          const sh = sw * 0.32;
          const cx = (f.a[0] + f.b[0]) / 2;
          const cz = (f.a[1] + f.b[1]) / 2;
          signs.push({
            kind: 'logo',
            culture: 'us',
            x: cx + f.nx * 0.6,
            y: top.y1 - sh / 2 - 3,
            z: cz + f.nz * 0.6,
            nx: f.nx,
            nz: f.nz,
            wnx: f.nx,
            wnz: f.nz,
            w: sw,
            h: sh,
            depth: 0.4,
            arm: 0,
            text: logoText,
            glyphs: [],
            vertical: false,
            col: c,
            col2: col(1),
            intensity: 2.6 + 1.6 * s.flash,
            flicker: 0,
            lightbox: false,
            frame: false,
            twoSided: false,
            seed: r.next(),
          });
          emit(cx + f.nx * 12, top.y1 - sh, cz + f.nz * 12, c, sw * sh * 0.04, clamp(sw * 1.4, 20, 60), 'sign');
        }
      } else if (top.roof === 'flat' && b.height > 10 && b.height < 90 && tw.len > 6 && r.chance(clamp((b.culture === 'cn' ? 0.08 : 0.14) + 0.25 * s.flash * prof.signs * 0.3 + (night ? 0.4 : 0), 0, night ? 0.85 : 0.55))) {
        // rooftop letters or a framed billboard facing the widest street side
        const isBoard = b.culture !== 'us' ? r.chance(0.5) : r.chance(0.35);
        const sw = Math.min(tw.len * 0.85, isBoard ? r.range(8, 16) : r.range(6, 14));
        const sh = isBoard ? sw * r.range(0.35, 0.55) : clamp(sw * 0.2, 1.5, 4);
        const cx = (tw.a[0] + tw.b[0]) / 2 - tw.nx * 1.5;
        const cz = (tw.a[1] + tw.b[1]) / 2 - tw.nz * 1.5;
        const c = col(r.int(3));
        const tx = textFor(b.culture, r.intRange(2, 5), () => roofWord(r));
        signs.push({
          kind: isBoard ? 'billboard' : 'roof',
          culture: b.culture,
          x: cx,
          y: top.y1 + 1.8 + sh / 2,
          z: cz,
          nx: tw.nx,
          nz: tw.nz,
          wnx: tw.nx,
          wnz: tw.nz,
          w: sw,
          h: sh,
          depth: 0.3,
          arm: 0,
          text: isBoard ? '' : tx.text || roofWord(r),
          glyphs: isBoard ? [] : tx.glyphs,
          vertical: false,
          col: c,
          col2: col(r.int(3)),
          intensity: intensity(1.2),
          flicker: flickerOf(),
          lightbox: false,
          frame: isBoard,
          twoSided: !isBoard,
          seed: r.next(),
        });
        emit(cx + tw.nx * 6, top.y1 + 3, cz + tw.nz * 6, c, sw * sh * 0.05, clamp(sw * 1.5, 10, 30), 'sign');
      }
    }

    // ---- megascreens: building-sized video walls high on tall towers
    if (MEGA_KINDS.has(d.kind) && b.height >= 130 && megaScreens < MEGA_CAP && signs.length < SIGN_CAP) {
      const rm = rng.fork('mega-screen' + (lots[b.lot]?.key ?? b.id));
      const p = clamp((0.1 + 0.45 * s.flash + 0.25 * tn.neon + 0.15 * tn.budget) * (d.kind === 'corporate' ? 1.25 : 1), 0, 0.8);
      // a tall plumb tier that is alone at its height (no wing or podium in front of the wall)
      const alone = (x: Tier): boolean => !b.tiers.some((o) => o !== x && o.y0 < x.y1 - 10 && o.y1 > x.y0 + 10);
      const t = b.tiers.filter((x) => !x.top && x.y1 - x.y0 > 45 && x.y0 > 6 && alone(x)).sort((a, c) => c.y1 - c.y0 - (a.y1 - a.y0))[0];
      if (t && rm.chance(p)) {
        const f = wallsOf(t)
          .filter((w) => w.len >= 24)
          .sort((a, c) => c.len - a.len)[0];
        if (f) {
          const span = t.y1 - t.y0;
          const sw = Math.min(f.len * 0.84, 66);
          const portrait = rm.chance(0.6);
          const sh = Math.min(span * 0.75, portrait ? sw * rm.range(1.4, 2.3) : sw * rm.range(0.5, 0.72));
          if (sh > 16) {
            const along = f.len / 2 + rm.range(-0.06, 0.06) * f.len;
            const y = t.y1 - sh / 2 - Math.min(14, span * 0.08);
            const c = col(rm.int(3));
            const c2 = col(rm.int(3) + 1);
            // stand clear of the facade relief (balcony slabs reach out over a metre)
            const st = t.facade.style;
            const off = st === 'balcony' ? 1.5 : st === 'panel' ? 0.95 : 0.65;
            signs.push({
              kind: 'screen',
              culture: b.culture,
              x: f.a[0] + f.tx * along + f.nx * off,
              y,
              z: f.a[1] + f.tz * along + f.nz * off,
              nx: f.nx,
              nz: f.nz,
              wnx: f.nx,
              wnz: f.nz,
              w: sw,
              h: sh,
              depth: 1.2,
              arm: 0,
              text: '',
              glyphs: [],
              vertical: portrait,
              col: c,
              col2: c2,
              intensity: (1.6 + 1.6 * s.flash) * (1 + 0.35 * tn.neon) * rm.range(1.0, 1.3),
              flicker: 0,
              lightbox: false,
              frame: true,
              twoSided: false,
              seed: rm.next(),
              program: 1,
            });
            megaScreens++;
            emit(f.a[0] + f.tx * along + f.nx * 25, y, f.a[1] + f.tz * along + f.nz * 25, c, sw * sh * 0.0004, clamp(Math.max(sw, sh) * 0.8, 30, 70), 'sign');
          }
        }
      }
    }

    // ---- rooftop holograms: a projected column of glyphs or an emblem over the roof
    if (top.roof !== 'pagoda' && top.roof !== 'sawtooth' && b.height > 18 && b.height < 160 && roofHolos < ROOF_HOLO_CAP && signs.length < SIGN_CAP && (night || d.kind === 'jpmarket' || d.kind === 'cnmarket' || d.kind === 'corporate')) {
      const rh = rng.fork('roof-holo' + (lots[b.lot]?.key ?? b.id));
      if (rh.chance(clamp(0.03 + 0.12 * s.flash + 0.08 * tn.neon + (night ? 0.12 : 0), 0, 0.4))) {
        const cap = top.top ?? top.poly;
        const cx = cap.reduce((a2, q) => a2 + q[0], 0) / cap.length;
        const cz = cap.reduce((a2, q) => a2 + q[1], 0) / cap.length;
        const room = Math.min(...cap.map((q) => Math.hypot(q[0] - cx, q[1] - cz)));
        if (room > 4) {
          const glyphy = b.culture !== 'us' || rh.chance(0.3);
          const hw = Math.min(room * 1.3, rh.range(6, 14));
          const hh = glyphy ? hw * rh.range(1.8, 3.2) : hw * rh.range(0.9, 1.3);
          const ang = rh.range(0, Math.PI);
          const c = col(rh.int(3));
          signs.push({
            kind: 'holo',
            culture: b.culture,
            x: cx,
            y: top.y1 + 2.2 + hh / 2,
            z: cz,
            nx: Math.cos(ang),
            nz: Math.sin(ang),
            wnx: 0,
            wnz: 0,
            w: hw,
            h: hh,
            depth: 0,
            arm: 2.2,
            text: '',
            glyphs: [],
            vertical: glyphy,
            col: c,
            col2: col(rh.int(3) + 1),
            intensity: (1.6 + 1.6 * s.flash) * (1 + 0.35 * tn.neon) * (night ? 1.3 : 1) * rh.range(0.9, 1.2),
            flicker: 0,
            lightbox: false,
            frame: false,
            twoSided: true,
            seed: rh.next(),
            program: glyphy ? 1 : 0,
          });
          roofHolos++;
          emit(cx, top.y1 + hh * 0.5, cz, c, hw * hh * 0.004, clamp(hh, 10, 26), 'sign');
        }
      }
    }

    // ---- facade kits: AC units, cages, pipes
    const acP = (0.06 + 0.28 * s.cn + 0.12 * s.jp + 0.18 * s.grime) * greeble * 1.3;
    let acCount = 0;
    const acMax = 70;
    for (const t of b.tiers) {
      const st = t.facade.style;
      if (st === 'glass' || st === 'panel' || st === 'lux' || t.top) continue;
      const fh = t.facade.floorH;
      const floors = Math.floor((t.y1 - t.y0) / fh);
      const startF = t.grounded ? Math.max(1, Math.ceil((t.shopH || 0) / fh)) : 0;
      for (const w of wallsOf(t)) {
        if (w.len < 4) continue;
        const bays = Math.max(1, Math.floor(w.len / t.facade.bayW));
        const bw = w.len / bays;
        for (let f = startF; f < floors && acCount < acMax; f++) {
          for (let k = 0; k < bays && acCount < acMax; k++) {
            if (!r.chance(acP)) continue;
            const along = (k + 0.5 + r.range(-0.25, 0.25)) * bw;
            const y = t.y0 + f * fh + r.range(0.2, 0.6);
            const x = w.a[0] + w.tx * along + w.nx * 0.24;
            const zz = w.a[1] + w.tz * along + w.nz * 0.24;
            const rot = Math.atan2(w.nx, w.nz);
            const shade = r.range(0.45, 0.8) * (1 - 0.35 * s.grime);
            kit('ac', x, y, zz, rot, 0.85, 0.55, 0.45, [shade, shade * 0.98, shade * 0.94], 0, r.next());
            acCount++;
          }
          // window cages (Hong Kong style) on lower floors
          if (b.culture === 'cn' && f < 8 && r.chance(0.35 * greeble)) {
            const k = r.int(bays);
            const along = (k + 0.5) * bw;
            const x = w.a[0] + w.tx * along + w.nx * 0.35;
            const zz = w.a[1] + w.tz * along + w.nz * 0.35;
            kit('cage', x, t.y0 + f * fh + fh * 0.48, zz, Math.atan2(w.nx, w.nz), Math.min(bw * 0.8, 2.2), fh * 0.82, 0.7, [0.22, 0.22, 0.2], 0, r.next());
          }
        }
        // homes: laundry strung along the facade, planters on balconies
        if (b.use === 'residential' && (st === 'balcony' || st === 'grid' || st === 'raw') && w.len > 6) {
          const lines = b.culture === 'us' ? (r.chance(0.15) ? 1 : 0) : r.chance(0.55) ? r.intRange(1, 2) : 0;
          for (let n = 0; n < lines && floors > startF + 1; n++) {
            const f = r.intRange(startF, Math.min(floors - 1, startF + 9));
            const y = t.y0 + f * fh + fh * 0.72;
            const a0 = r.range(0.05, 0.4) * w.len;
            const a1 = Math.min(w.len - 0.4, a0 + r.range(3, 9));
            const out = st === 'balcony' ? 1.25 : 0.7;
            structures.push({
              kind: 'laundry',
              p: [w.a[0] + w.tx * a0 + w.nx * out, y, w.a[1] + w.tz * a0 + w.nz * out, w.a[0] + w.tx * a1 + w.nx * out, y, w.a[1] + w.tz * a1 + w.nz * out, 0.25, Math.floor((a1 - a0) / 0.9)],
              col: CLOTH[r.int(CLOTH.length)] as RGB,
              col2: CLOTH[r.int(CLOTH.length)] as RGB,
              seed: r.next(),
            });
          }
          if (st === 'balcony') {
            for (let f = startF; f < Math.min(floors, startF + 14); f++) {
              if (!r.chance(0.25 + 0.3 * Math.max(0, tn.budget))) continue;
              const along = r.range(0.1, 0.9) * w.len;
              kit('planter', w.a[0] + w.tx * along + w.nx * 1.0, t.y0 + f * fh + 0.05, w.a[1] + w.tz * along + w.nz * 1.0, Math.atan2(w.nx, w.nz), r.range(0.6, 1.4), r.range(0.5, 1.1), 0.5, [0.05, 0.1, 0.05], 0, r.next());
            }
          }
        }
        // drain pipes and service risers
        if ((st === 'metal' || st === 'raw' || st === 'balcony' || d.kind === 'industrial') && r.chance(0.35 * greeble + 0.15)) {
          const along = w.len * r.range(0.08, 0.92);
          const rad = d.kind === 'industrial' ? r.range(0.25, 0.6) : r.range(0.1, 0.18);
          kit('pipeV', w.a[0] + w.tx * along + w.nx * (rad + 0.05), t.y0, w.a[1] + w.tz * along + w.nz * (rad + 0.05), 0, rad, t.y1 - t.y0, rad, [0.25, 0.24, 0.22], 0, r.next());
        }
      }
    }

    // ---- roof kits
    for (const t of b.tiers) {
      if (t.y1 < b.height - 0.1 && !(t.roof === 'flat' && r.chance(0.35))) continue;
      const cap = t.top ?? t.poly;
      // round footprints (discs) use their inscribed square so kits stay on the roof
      const ins = cap.length > 4 ? 1 - Math.SQRT1_2 : 0;
      const ex0 = Math.min(...cap.map((p) => p[0]));
      const ex1 = Math.max(...cap.map((p) => p[0]));
      const ez0 = Math.min(...cap.map((p) => p[1]));
      const ez1 = Math.max(...cap.map((p) => p[1]));
      const bx0 = ex0 + (ex1 - ex0) * ins * 0.5 + 1.2;
      const bx1 = ex1 - (ex1 - ex0) * ins * 0.5 - 1.2;
      const bz0 = ez0 + (ez1 - ez0) * ins * 0.5 + 1.2;
      const bz1 = ez1 - (ez1 - ez0) * ins * 0.5 - 1.2;
      if (bx1 - bx0 < 2 || bz1 - bz0 < 2) continue;
      const area = (bx1 - bx0) * (bz1 - bz0);
      const y = t.y1;
      const place = (): [number, number] => [lerp(bx0, bx1, r.next()), lerp(bz0, bz1, r.next())];
      if (t.roof === 'flat' || t.roof === 'crown' || t.roof === 'sawtooth') {
        const n = Math.min(14, Math.round(area / 90 * (0.4 + greeble)));
        for (let k = 0; k < n; k++) {
          const [x, zz] = place();
          const pick = r.next();
          const g = r.range(0.3, 0.55) * (1 - 0.3 * s.grime);
          if (pick < 0.3) kit('vent', x, y, zz, r.range(0, Math.PI), r.range(1.2, 3.2), r.range(0.8, 2), r.range(1.2, 2.8), [g, g, g * 1.03], 0, r.next());
          else if (pick < 0.48) kit('fan', x, y, zz, 0, r.range(1.4, 2.6), r.range(0.9, 1.6), r.range(1.4, 2.6), [g * 0.9, g, g], 0, r.next());
          else if (pick < 0.6 && (b.culture !== 'cn' || r.chance(0.5)) && b.height < 120) kit('tank', x, y, zz, 0, r.range(1.6, 2.8), r.range(3, 5), 0, [0.32, 0.24, 0.18], 0, r.next());
          else if (pick < 0.72) kit('dish', x, y, zz, r.range(0, Math.PI * 2), r.range(0.6, 1.4), 1, 1, [0.6, 0.6, 0.62], 0, r.next());
          else if (pick < 0.84) kit('antenna', x, y, zz, 0, 0.12, r.range(4, 14), 0.12, [0.25, 0.25, 0.27], 0, r.next());
          else kit('box', x, y, zz, r.range(0, Math.PI), r.range(1.5, 4), r.range(1, 2.5), r.range(1.5, 4), [g, g * 0.97, g * 0.94], 0, r.next());
        }
      }
      // aviation beacons on tall roofs
      if (b.height > 55) {
        const red: RGB = [1, 0.08, 0.05];
        for (const p of cap.length <= 4 ? cap : cap.filter((_, i) => i % Math.max(2, Math.floor(cap.length / 4)) === 0)) {
          kit('beacon', p[0] - Math.sign(p[0] - (bx0 + bx1) / 2) * 0.8, y + 0.4, p[1] - Math.sign(p[1] - (bz0 + bz1) / 2) * 0.8, 0, 0.35, 0.35, 0.35, red, 6, r.next());
        }
      }
      if (b.archetype === 'needle' && t.y1 >= b.height - 0.1) {
        const cx = (bx0 + bx1) / 2;
        const cz = (bz0 + bz1) / 2;
        kit('antenna', cx, y, cz, 0, 0.6, r.range(30, 60), 0.6, [0.4, 0.4, 0.42], 0, r.next());
      }
    }

    // ---- window glow emitters (aggregated per wall and height band)
    for (const t of b.tiers) {
      const f = t.facade;
      if (t.y1 - t.y0 < 6) continue;
      const lc = f.warm > 0.5 ? WARM : COOL;
      const band = 45;
      for (let y = t.y0; y < t.y1; y += band) {
        const h = Math.min(band, t.y1 - y);
        // a tapered tier's walls lean in: take the outline at the band's middle
        for (const w of wallsOf(t, polyAt(t, y + h / 2))) {
          if (w.len < 8) continue;
          const k = f.lit * f.win * w.len * h * 0.0016;
          if (k < 0.05) continue;
          const cx = (w.a[0] + w.b[0]) / 2 + w.nx * 7;
          const cz = (w.a[1] + w.b[1]) / 2 + w.nz * 7;
          emit(cx, y + h / 2, cz, lc, k, clamp(Math.max(w.len, h) * 0.6, 12, 55), 'window');
        }
      }
      const cap = t.top ?? t.poly;
      if (f.strips > 0.35 && t.y1 > 40) {
        const cx = cap.reduce((a, p) => a + p[0], 0) / cap.length;
        const cz = cap.reduce((a, p) => a + p[1], 0) / cap.length;
        emit(cx, t.y1, cz, f.accent, f.strips * 2.5, 40);
      }
      // a lit soffit pools warm light on whatever is below the overhang, when the
      // overhang is real: a plate sitting almost square on the one below (a twist
      // tower) has no underside to speak of
      const bbox = (p: readonly Vec2[]): [number, number, number, number] => [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))];
      const [ux0, uz0, ux1, uz1] = bbox(t.poly);
      const covered = b.tiers.some((o) => {
        if (o === t || Math.abs((o.top ? o.y1 : o.y1) - t.y0) > 1.5) return false;
        const [ox0, oz0, ox1, oz1] = bbox(o.top ?? o.poly);
        const ix = Math.max(0, Math.min(ux1, ox1) - Math.max(ux0, ox0));
        const iz = Math.max(0, Math.min(uz1, oz1) - Math.max(uz0, oz0));
        return ix * iz > 0.7 * (ux1 - ux0) * (uz1 - uz0);
      });
      if (t.under && !covered) {
        const xs = t.poly.map((p) => p[0]);
        const zs = t.poly.map((p) => p[1]);
        const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
        const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
        const cz = (Math.max(...zs) + Math.min(...zs)) / 2;
        // (well below it, so the soffit itself is not washed out by its own light)
        emit(cx, t.y0 - 12, cz, [1, 0.8, 0.58], size * 0.025, clamp(size * 0.7, 14, 40));
        emit(cx, t.y0 - 10, cz, f.accent, size * 0.012 * Math.max(0.35, f.strips), clamp(size * 0.6, 12, 34));
      }
    }

    // ---- industrial lots: tank farms, stacks, containers
    if (b.archetype === 'tankfarm' || (b.kind === 'industrial' && r.chance(0.35))) {
      const lot = lots[b.lot] as Lot;
      const L = lot.rect;
      const tr = r.range(5, 10);
      const gap = tr * 2.6;
      const occupied = b.rect;
      for (let x = L.x0 + tr + 4; x < L.x1 - tr - 3; x += gap) {
        for (let zz = L.z0 + tr + 4; zz < L.z1 - tr - 3; zz += gap) {
          if (x + tr > occupied.x0 - 2 && x - tr < occupied.x1 + 2 && zz + tr > occupied.z0 - 2 && zz - tr < occupied.z1 + 2) continue;
          if (!r.chance(b.archetype === 'tankfarm' ? 0.85 : 0.25)) continue;
          const h = r.range(8, 18);
          const g = r.range(0.45, 0.7) * (1 - 0.3 * s.grime);
          kit('tank', x, 0, zz, 0, tr, h, 1, [g, g * 0.97, g * 0.9], 0, r.next());
          emit(x, h + 2, zz, [1, 0.7, 0.35], 0.4, 14);
        }
      }
    }
    if (b.kind === 'industrial' && r.chance(0.22)) {
      const x = lerp(b.rect.x0, b.rect.x1, r.next());
      const zz = lerp(b.rect.z0, b.rect.z1, r.next());
      const h = r.range(35, 80);
      kit('stack', x, b.height, zz, 0, r.range(1.5, 3), h, 1, [0.4, 0.36, 0.32], 0, r.next());
      emit(x, b.height + h, zz, [1, 0.25, 0.1], 1.2, 20);
      steam.push({ x, z: zz, h: b.height + h, seed: r.next() });
    }
  }

  // ------------------------------------------------------------- blocks and streets
  for (const blk of blocks) {
    const d = z.districts[blk.district] as District;
    const prof = PROFILES[d.kind];
    const s = d.style;
    const r = rng.fork('blk' + blk.key);
    const P = blk.plate;
    // street lamps along each sidewalk edge
    const lampCol: RGB =
      blk.use === 'industrial' || d.kind === 'industrial' || d.kind === 'decayed'
        ? [1, 0.55, 0.2]
        : blk.use === 'nightlife'
          ? r.chance(0.5)
            ? [1, 0.35, 0.7]
            : [0.65, 0.45, 1]
          : d.kind === 'luxury' || blk.use === 'green'
            ? [1, 0.82, 0.6]
            : d.kind === 'corporate' || blk.use === 'civic'
              ? [0.8, 0.9, 1]
              : blk.use === 'residential'
                ? [1, 0.72, 0.42]
                : r.chance(0.5)
                  ? [1, 0.6, 0.3]
                  : [0.75, 0.85, 1];
    const sides: [number, number, number, number, number, number][] = [
      // x0, z0, x1, z1, nx, nz (from the plate edge toward the road)
      [P.x0, P.z0, P.x0, P.z1, -1, 0],
      [P.x1, P.z0, P.x1, P.z1, 1, 0],
      [P.x0, P.z0, P.x1, P.z0, 0, -1],
      [P.x0, P.z1, P.x1, P.z1, 0, 1],
    ];
    sides.forEach(([x0, z0, x1, z1, nx, nz], si) => {
      const walk = blk.walk[si] as number;
      if (walk < 1.6) return;
      const len = Math.hypot(x1 - x0, z1 - z0);
      const spacing = d.kind === 'jpmarket' || d.kind === 'cnmarket' ? r.range(16, 22) : r.range(24, 32);
      const n = Math.floor(len / spacing);
      for (let k = 1; k <= n; k++) {
        const t = k / (n + 1);
        const x = lerp(x0, x1, t) - nx * 0.6;
        const zz = lerp(z0, z1, t) - nz * 0.6;
        if (r.chance(0.06 + 0.25 * s.grime * s.grime + 0.3 * Math.max(0, d.tune.decay))) continue; // dead lamp
        const h = d.kind === 'corporate' || d.kind === 'megablock' ? 9 : 7;
        kit('lamp', x, 0.15, zz, Math.atan2(nx, nz), 1, h, 1, lampCol, 3, r.next());
        emit(x + nx * 1.6, h - 0.5, zz + nz * 1.6, lampCol, 1.6, 16, 'lamp');
        if ((d.kind === 'luxury' || (d.kind === 'corporate' && r.chance(0.5)) || r.chance(Math.max(0, d.tune.budget) * 0.7)) && walk > 2.6 && !r.chance(Math.max(0, d.tune.decay) * 0.8)) {
          const tt = (k + 0.5) / (n + 1);
          if (tt < 1) kit('tree', lerp(x0, x1, tt) - nx * 1.4, 0.15, lerp(z0, z1, tt) - nz * 1.4, r.range(0, 6.28), r.range(2.2, 3.4), r.range(6, 9), 1, [0.05, 0.09, 0.06], 0, r.next());
        }
      }
    });
    // open blocks
    if (blk.open === 'park' || blk.open === 'plaza') {
      const R = blk.rect;
      const n = Math.floor((((R.x1 - R.x0) * (R.z1 - R.z0)) / (blk.open === 'park' ? 120 : 400)) * tuneMul(d.tune.budget, 1.6));
      for (let k = 0; k < Math.min(n, 60); k++) {
        const x = lerp(R.x0 + 3, R.x1 - 3, r.next());
        const zz = lerp(R.z0 + 3, R.z1 - 3, r.next());
        kit('tree', x, 0.15, zz, r.range(0, 6.28), r.range(2.4, 4), r.range(6, 11), 1, [0.05, 0.08, 0.05], 0, r.next());
      }
      // parks: a pond, path lamps and benches
      if (blk.open === 'park') {
        const w = R.x1 - R.x0;
        const h = R.z1 - R.z0;
        const cx = (R.x0 + R.x1) / 2;
        const cz = (R.z0 + R.z1) / 2;
        if (w * h > 2600 && r.chance(0.7)) {
          const pw = w * r.range(0.25, 0.4);
          const pd = h * r.range(0.25, 0.4);
          const ox = r.range(-0.15, 0.15) * w;
          const oz = r.range(-0.15, 0.15) * h;
          structures.push({ kind: 'pond', p: [cx + ox - pw / 2, cz + oz - pd / 2, cx + ox + pw / 2, cz + oz + pd / 2, 0.18], col: [0.006, 0.012, 0.016], col2: [0.004, 0.02, 0.026], seed: r.next() });
        }
        const lampN = Math.min(10, Math.floor((w + h) / 26));
        for (let k = 0; k < lampN; k++) {
          const along = r.next();
          const onX = r.chance(0.5);
          const x = onX ? lerp(R.x0 + 4, R.x1 - 4, along) : cx + r.range(-2, 2);
          const zz = onX ? cz + r.range(-2, 2) : lerp(R.z0 + 4, R.z1 - 4, along);
          kit('lamp', x, 0.15, zz, r.range(0, 6.28), 1, 4.5, 1, [1, 0.8, 0.55], 3, r.next());
          emit(x, 4, zz, [1, 0.78, 0.5], 1.1, 11, 'lamp');
          if (r.chance(0.5)) kit('box', x + 1.4, 0.15, zz, r.range(0, 6.28), 1.8, 0.45, 0.6, [0.2, 0.14, 0.1], 0, r.next());
        }
      }
      if (blk.open === 'plaza' && r.chance(0.6)) {
        // a hologram ad hovering over the plaza
        const cx = (R.x0 + R.x1) / 2;
        const cz = (R.z0 + R.z1) / 2;
        const c = d.palette[r.int(d.palette.length)] as RGB;
        const sw = r.range(10, 22);
        const sh = sw * r.range(1.1, 1.8);
        const ang = r.range(0, Math.PI * 2);
        signs.push({ kind: 'holo', culture: 'us', x: cx, y: sh / 2 + 3, z: cz, nx: Math.cos(ang), nz: Math.sin(ang), wnx: 0, wnz: 0, w: sw, h: sh, depth: 0, arm: 2.85, text: '', glyphs: [], vertical: false, col: c, col2: d.palette[r.int(d.palette.length)] as RGB, intensity: 1.6 + s.flash, flicker: 0, lightbox: false, frame: false, twoSided: true, seed: r.next() });
        emit(cx, sh / 2 + 3, cz, c, sw * sh * 0.02, 40, 'sign');
      }
    } else if (blk.open === 'yard') {
      const R = blk.rect;
      for (let x = R.x0 + 4; x < R.x1 - 8; x += 13) {
        for (let zz = R.z0 + 4; zz < R.z1 - 4; zz += 3.2) {
          if (!r.chance(0.55)) continue;
          const stack = r.intRange(1, 4);
          for (let k = 0; k < stack; k++) {
            const hue = r.pick([
              [0.5, 0.12, 0.08],
              [0.08, 0.25, 0.45],
              [0.45, 0.35, 0.08],
              [0.12, 0.3, 0.2],
              [0.35, 0.35, 0.36],
            ] as RGB[]);
            kit('container', x + 6, 0.15 + k * 2.6, zz, 0, 12, 2.6, 2.44, hue, 0, r.next());
          }
        }
      }
    } else if (blk.open === 'rubble') {
      const R = blk.rect;
      const n = Math.min(24, Math.floor(((R.x1 - R.x0) * (R.z1 - R.z0)) / 160));
      for (let k = 0; k < n; k++) {
        const x = lerp(R.x0 + 2, R.x1 - 2, r.next());
        const zz = lerp(R.z0 + 2, R.z1 - 2, r.next());
        kit('box', x, 0.1, zz, r.range(0, 6), r.range(1, 4), r.range(0.4, 1.6), r.range(1, 4), [0.3, 0.28, 0.25], 0, r.next());
        if (r.chance(0.18)) {
          kit('barrel', x + 2, 0.15, zz + 1, 0, 0.32, 0.9, 0.32, [0.3, 0.12, 0.06], 0, r.next());
          emit(x + 2, 1.6, zz + 1, [1, 0.42, 0.12], 2.2, 12, 'fire');
          steam.push({ x: x + 2, z: zz + 1, h: 0.95, seed: r.next() });
        }
      }
    }
    void prof;
  }

  // ---- wires and lantern strings across market streets, steam from the roads
  for (const st of streets) {
    if (st.kind !== 'local' || st.district < 0) continue;
    const d = z.districts[st.district] as District;
    const r = rng.fork('st' + st.key);
    const jp = d.kind === 'jpmarket';
    const cn = d.kind === 'cnmarket';
    const half = st.road / 2 + st.walk;
    if (st.use === 'nightlife') {
      for (let p = st.lo + r.range(6, 10); p < st.hi - 6; p += r.range(7, 12)) {
        const y0 = r.range(6, 8.5);
        const y1 = y0 + r.range(-0.8, 0.8);
        const a = st.axis === 'x' ? [p, y0, st.pos - half] : [st.pos - half, y0, p];
        const b2 = st.axis === 'x' ? [p + r.range(-2, 2), y1, st.pos + half] : [st.pos + half, y1, p + r.range(-2, 2)];
        const c: RGB = cn ? [1, 0.12, 0.06] : jp ? [1, 0.85, 0.6] : r.pick([[1, 0.3, 0.7], [1, 0.75, 0.35], [0.5, 0.6, 1]] as RGB[]);
        structures.push({ kind: 'cables', p: [a[0] as number, a[1] as number, a[2] as number, b2[0] as number, b2[1] as number, b2[2] as number, r.range(0.4, 1.0), 1], col: c, col2: c, seed: r.next() });
        emit(((a[0] as number) + (b2[0] as number)) / 2, y0 - 1, ((a[2] as number) + (b2[2] as number)) / 2, c, 0.7, 10, 'festoon');
      }
    } else if (jp || cn || d.kind === 'decayed') {
      for (let p = st.lo + r.range(8, 16); p < st.hi - 8; p += r.range(9, 18)) {
        const y0 = r.range(5.5, 9);
        const y1 = y0 + r.range(-1, 1);
        const a = st.axis === 'x' ? [p, y0, st.pos - half] : [st.pos - half, y0, p];
        const b2 = st.axis === 'x' ? [p + r.range(-3, 3), y1, st.pos + half] : [st.pos + half, y1, p + r.range(-3, 3)];
        if (cn && r.chance(0.3)) {
          structures.push({ kind: 'cables', p: [a[0] as number, a[1] as number, a[2] as number, b2[0] as number, b2[1] as number, b2[2] as number, r.range(0.6, 1.4), 1], col: [1, 0.12, 0.06], col2: [1, 0.5, 0.15], seed: r.next() });
          emit(((a[0] as number) + (b2[0] as number)) / 2, y0 - 1, ((a[2] as number) + (b2[2] as number)) / 2, [1, 0.25, 0.1], 1.6, 10, 'festoon');
        } else if (jp && r.chance(0.2)) {
          structures.push({ kind: 'cables', p: [a[0] as number, a[1] as number, a[2] as number, b2[0] as number, b2[1] as number, b2[2] as number, r.range(0.5, 1.1), 1], col: [1, 0.85, 0.6], col2: [1, 0.55, 0.3], seed: r.next() });
          emit(((a[0] as number) + (b2[0] as number)) / 2, y0 - 1, ((a[2] as number) + (b2[2] as number)) / 2, [1, 0.7, 0.4], 1.2, 10, 'festoon');
        } else if (jp || r.chance(0.35)) {
          structures.push({ kind: 'wires', p: [a[0] as number, a[1] as number + 1.5, a[2] as number, b2[0] as number, b2[1] as number + 1.5, b2[2] as number, r.range(0.4, 1.2), r.intRange(2, 6)], col: [0.02, 0.02, 0.02], col2: [0, 0, 0], seed: r.next() });
        }
      }
    }
  }
  for (const rp of roads) {
    if (rp.axis === 'j' || rp.kind === 'alley' || rp.kind === 'highway') continue;
    const st = streets[rp.streetId] as Street;
    const d = st.district >= 0 ? (z.districts[st.district] as District) : null;
    const len = rp.axis === 'x' ? rp.rect.x1 - rp.rect.x0 : rp.rect.z1 - rp.rect.z0;
    if (len < 20) continue;
    const r = rng.fork('vent' + Math.round(rp.rect.x0) + ':' + Math.round(rp.rect.z0));
    const p = d ? (d.kind === 'jpmarket' || d.kind === 'cnmarket' ? 0.25 : d.kind === 'decayed' || d.kind === 'megablock' ? 0.18 : 0.06) : 0.05;
    if (!r.chance(p)) continue;
    const t = r.range(0.2, 0.8);
    const off = (r.chance(0.5) ? -1 : 1) * (st.road / 2 - 2);
    const x = rp.axis === 'x' ? lerp(rp.rect.x0, rp.rect.x1, t) : st.pos + off;
    const zz = rp.axis === 'x' ? st.pos + off : lerp(rp.rect.z0, rp.rect.z1, t);
    steam.push({ x, z: zz, h: r.range(4, 8), seed: r.next() });
  }

  // ---- docks and cranes on the industrial waterfront
  for (const cell of z.superblocks) {
    if (!cell.land || cell.district < 0) continue;
    const below = z.superblocks[cell.i + (cell.j + 1) * z.cols];
    if (below && below.land) continue;
    const d = z.districts[cell.district] as District;
    const line = z.linesZ[cell.j + 1];
    if (!line) continue;
    const r = rng.fork('dock' + cell.id);
    const zq = line.pos + line.road / 2 + line.walk;
    if (d.kind === 'industrial') {
      const x0 = cell.rect.x0 - 4;
      const x1 = cell.rect.x1 + 4;
      structures.push({ kind: 'dock', p: [x0, zq, x1, zq + 34, 0.6], col: [0.3, 0.29, 0.27], col2: [1, 0.7, 0.2], seed: r.next() });
      const n = Math.max(1, Math.floor((x1 - x0) / 70));
      for (let k = 0; k < n; k++) {
        const x = lerp(x0 + 30, x1 - 30, n === 1 ? 0.5 : k / (n - 1));
        structures.push({ kind: 'crane', p: [x, zq + 16, 0, r.range(48, 62), r.range(40, 55)], col: r.chance(0.5) ? [0.55, 0.12, 0.05] : [0.6, 0.45, 0.08], col2: [1, 0.15, 0.05], seed: r.next() });
        emit(x, 55, zq + 16, [1, 0.6, 0.25], 3, 40);
      }
    } else if (d.kind === 'luxury') {
      structures.push({ kind: 'dock', p: [cell.rect.x0, zq, cell.rect.x1, zq + 14, 0.5], col: [0.42, 0.36, 0.3], col2: [1, 0.8, 0.5], seed: r.next() });
    }
  }

  return { signs, kits, structures, emitters, steam };
}
