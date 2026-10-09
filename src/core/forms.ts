/**
 * Shaped towers. The genre's cities are not boxes: towers bulge, taper to a point,
 * twist, lean over the street, pile up in lumps and carry whole decks on their
 * heads. These builders use the vocabulary of complex tall buildings (Vollers'
 * classes: rotors, twisters, anglers and sliders, carvers) on original designs:
 *
 *  - egg     a lathed shell (rotor): a bulging, rounded profile on a round or
 *            squircle plan, glazed with a diagrid, topped by a small lantern,
 *  - prism   a faceted taper: an n-gon base turning into a smaller n-gon set half a
 *            side round, so the walls fold into triangles,
 *  - helix   a rounded section twisting (and tapering) as it climbs,
 *  - lean    a slab whose axis leans or bows out over its lot,
 *  - stack   lumpy accretion: boxes piled off-centre, turned and overhanging, each in
 *            its own material,
 *  - bundle  a bundle of tubes of different heights,
 *  - skyship a row of slabs carrying one long hull across their tops,
 *  - hulk    a plain core with whole buildings bolted to its flanks at every height.
 *
 * A shell (a run of tiers joined by `seam`) is one surface to the renderer: no roofs
 * or parapets inside it, window rows and light lines running on through the joins.
 * Every point stays inside the lot.
 */
import type { Facade, FacadeStyle, Lot, RoofKind, Skin, Tier, Vec2 } from './types';
import type { PROFILES } from './profiles';
import { clamp, lerp } from './rng';
import { type Ctx, frontEdges, inset, makeFacade, ok, pickHeight, rd, rectPoly, rw, snapFloors, tier } from './massingkit';

type Prof = (typeof PROFILES)[keyof typeof PROFILES];

/** A shaped-tower builder: returns false when the lot cannot hold it (the caller falls back). */
export type Former = (lot: Lot, c: Ctx, out: Tier[], prof: Prof) => boolean;

// ------------------------------------------------------------------ sections

/** Superellipse ring, counter-clockwise: half axes a (x) and b (z), exponent e (2 ellipse, ~4 squircle), turned by rot. */
export function superRing(cx: number, cz: number, a: number, b: number, e: number, n: number, rot = 0): Vec2[] {
  const out: Vec2[] = [];
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    const x = a * Math.sign(ct) * Math.pow(Math.abs(ct), 2 / e);
    const z = b * Math.sign(st) * Math.pow(Math.abs(st), 2 / e);
    out.push([cx + x * c - z * s, cz + x * s + z * c]);
  }
  return out;
}

/**
 * Convex n-gon with rounded corners, counter-clockwise: circumradius R, corners
 * rounded with radius f * R (0..0.9), `seg` points on each corner arc.
 */
export function roundedPoly(cx: number, cz: number, R: number, n: number, f: number, seg: number, rot = 0): Vec2[] {
  const rc = R * clamp(f, 0, 0.9);
  const ri = R - rc;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const th = rot + (i / n) * Math.PI * 2;
    const vx = cx + Math.cos(th) * ri;
    const vz = cz + Math.sin(th) * ri;
    for (let k = 0; k < seg; k++) {
      const ph = th - Math.PI / n + ((2 * Math.PI) / n) * (seg === 1 ? 0.5 : k / (seg - 1));
      out.push([vx + Math.cos(ph) * rc, vz + Math.sin(ph) * rc]);
    }
  }
  return out;
}

function centroid(p: readonly Vec2[]): Vec2 {
  let x = 0;
  let z = 0;
  for (const q of p) {
    x += q[0];
    z += q[1];
  }
  return [x / p.length, z / p.length];
}

/** The ring scaled about (cx, cz), turned by rot and moved by (dx, dz). */
function xform(p: readonly Vec2[], cx: number, cz: number, s: number, rot: number, dx = 0, dz = 0): Vec2[] {
  const c = Math.cos(rot) * s;
  const sn = Math.sin(rot) * s;
  return p.map(([x, z]) => {
    const lx = x - cx;
    const lz = z - cz;
    return [cx + lx * c - lz * sn + dx, cz + lx * sn + lz * c + dz] as Vec2;
  });
}

/** How far a set of rings reaches out of the rect R (0 when they all fit), as a factor to shrink them by about (cx, cz). */
function fitScale(rings: readonly Vec2[][], R: { x0: number; z0: number; x1: number; z1: number }, cx: number, cz: number): number {
  let s = 1;
  for (const ring of rings)
    for (const [x, z] of ring) {
      const dx = x - cx;
      const dz = z - cz;
      if (dx > 1e-6) s = Math.min(s, (R.x1 - cx) / dx);
      if (dx < -1e-6) s = Math.min(s, (R.x0 - cx) / dx);
      if (dz > 1e-6) s = Math.min(s, (R.z1 - cz) / dz);
      if (dz < -1e-6) s = Math.min(s, (R.z0 - cz) / dz);
    }
  return clamp(s, 0, 1);
}

/** Heights 0..1 for n rings, closer together toward the top where a profile curves fastest. */
function ringTs(n: number, bias: number): number[] {
  const out: number[] = [];
  for (let k = 0; k <= n; k++) out.push(1 - Math.pow(1 - k / n, bias));
  return out;
}

/**
 * One shell from rings (same vertex count) at heights ys: tier k runs from rings[k]
 * at ys[k] to rings[k + 1] at ys[k + 1]. Heights that collapse onto each other after
 * floor snapping are dropped.
 */
function shell(
  rings: Vec2[][],
  ys: number[],
  fac: Facade,
  roof: RoofKind,
  o: { smooth?: boolean; skin?: Skin; grounded?: boolean; shopEdges?: number[]; shopH?: number; under?: boolean } = {},
): Tier[] {
  const out: Tier[] = [];
  const keep: number[] = [0];
  for (let k = 1; k < ys.length; k++) if ((ys[k] as number) - (ys[keep[keep.length - 1] as number] as number) > 0.5) keep.push(k);
  for (let j = 0; j < keep.length - 1; j++) {
    const a = keep[j] as number;
    const b = keep[j + 1] as number;
    const last = j === keep.length - 2;
    const t = tier(rings[a] as Vec2[], ys[a] as number, ys[b] as number, { ...fac }, last ? roof : 'flat', j === 0 && (o.grounded ?? false), j === 0 ? (o.shopEdges ?? []) : [], j === 0 ? (o.shopH ?? 0) : 0);
    const top = rings[b] as Vec2[];
    if (top !== rings[a]) t.top = top;
    if (!last) t.seam = true;
    if (o.smooth) t.smooth = true;
    if (o.skin) t.skin = o.skin;
    if (o.under && j === 0) t.under = true;
    out.push(t);
  }
  return out;
}

/** Every edge of a ring as a shop front (round lobbies). */
function allEdges(p: readonly Vec2[]): number[] {
  return p.map((_, i) => i);
}

// ------------------------------------------------------------------ builders

/**
 * Lathed shell: a round or squircle plan whose radius follows a bulging profile,
 * widest a third of the way up and closing over in a rounded top, glazed with a
 * diagrid or spandrel bands. A small lantern caps it.
 */
export const egg: Former = (lot, c, out, prof) => {
  const r = c.r;
  const L = inset(lot.rect, r.range(2, 5));
  const side = Math.min(rw(L), rd(L));
  if (side < 26) return false;
  const cx = (L.x0 + L.x1) / 2;
  const cz = (L.z0 + L.z1) / 2;
  const e = r.weighted([2, 2.4, 3.1], [0.55, 0.25, 0.2]);
  const longX = rw(L) >= rd(L);
  const stretch = clamp(Math.max(rw(L), rd(L)) / side, 1, r.range(1, 1.3));
  const R = (side / 2) * 0.98;
  const a = longX ? R * stretch : R;
  const b = longX ? R : R * stretch;
  let H = pickHeight(c, [prof.height[0] * 1.05, prof.height[1] * 1.1], 1.15);
  if (r.chance(prof.spike.p)) H = r.range(prof.spike.h[0], prof.spike.h[1]) * c.hmul;
  H = clamp(H, side * 2.2, side * 7.5);
  // profile: base b0, swelling to 1 at tm, then a superellipse quadrant closing to the top
  const tm = r.range(0.26, 0.46);
  const k = r.range(1.7, 2.8);
  const b0 = r.range(0.66, 0.9);
  const f = (t: number): number => (t < tm ? b0 + (1 - b0) * (1 - Math.pow(1 - t / tm, 2)) : Math.pow(Math.max(0, 1 - Math.pow((t - tm) / (1 - tm), k)), 1 / k));
  // stop where the shell has closed to ~13 % of its width and cap it with a lantern
  let tEnd = 0.99;
  while (tEnd > tm && f(tEnd) < 0.13) tEnd -= 0.005;
  const style: FacadeStyle = c.style.edge > 0.75 && r.chance(0.4) ? 'panel' : 'glass';
  const fac = makeFacade(c, style, { strips: clamp(0.4 + 0.4 * c.style.flash + r.range(-0.1, 0.2), 0, 1) });
  const n = clamp(Math.round(H / 13), 10, 22);
  const N = side > 60 ? 32 : 24;
  const base = superRing(cx, cz, a, b, e, N, 0);
  const rings: Vec2[][] = [];
  const ys: number[] = [];
  for (const t of ringTs(n, 1.3)) {
    const tt = t * tEnd;
    rings.push(t === 0 ? base : superRing(cx, cz, a * f(tt), b * f(tt), e, N, 0));
    ys.push(t === 0 ? 0 : t === 1 ? H * tEnd : snapFloors(H * tt, fac.floorH));
  }
  const skin: Skin = r.chance(0.7) ? 'diagrid' : 'bands';
  const tiers = shell(rings, ys, fac, 'crown', { smooth: true, skin, grounded: true, shopEdges: allEdges(base), shopH: snapFloors(r.range(6, 9), 3) });
  out.push(...tiers);
  // lantern: a short glass drum on the closed top
  const last = tiers[tiers.length - 1] as Tier;
  const ring = last.top ?? last.poly;
  const lr = Math.max(2.5, Math.min(...ring.map(([x, z]) => Math.hypot(x - cx, z - cz))) * 0.75);
  out.push(tier(superRing(cx, cz, lr, lr, 2, 16, 0), last.y1, last.y1 + Math.max(4, lr * 1.2), makeFacade(c, 'glass', { lit: 0.95, warm: 0.35, strips: 1, accent: fac.accent }), 'crown', false));
  return true;
};

/**
 * Faceted taper: an n-gon base whose corners fold in as it rises until the top is
 * a smaller n-gon turned half a side round, so every wall is a pair of tall
 * triangles. On a chamfered base, under a lit crown.
 */
export const prism: Former = (lot, c, out, prof) => {
  const r = c.r;
  const L = inset(lot.rect, r.range(2, 5));
  const side = Math.min(rw(L), rd(L));
  if (side < 28) return false;
  const cx = (L.x0 + L.x1) / 2;
  const cz = (L.z0 + L.z1) / 2;
  const n = r.weighted([4, 3, 6, 5], [0.5, 0.2, 0.18, 0.12]);
  // circumradius so the base fits the lot: a square sits square to the streets
  const rot0 = n === 4 ? Math.PI / 4 : n === 3 ? -Math.PI / 2 : n === 6 ? 0 : -Math.PI / 2;
  const R = n === 4 ? (side / 2) * Math.SQRT2 : side / 2;
  let H = pickHeight(c, [prof.height[0] * 1.1, prof.height[1] * 1.15], 1.1);
  if (r.chance(prof.spike.p * 1.5)) H = r.range(prof.spike.h[0], prof.spike.h[1]) * c.hmul;
  H = Math.max(H, side * 2.4);
  const corners: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const th = rot0 + (i / n) * Math.PI * 2;
    corners.push([cx + Math.cos(th) * R, cz + Math.sin(th) * R]);
  }
  // base: a short plumb podium (chamfered square on n = 4)
  const podH = snapFloors(r.range(12, 26), 4.4);
  const podFac = makeFacade(c, r.chance(0.6) ? 'panel' : 'glass', { lit: 0.6, strips: clamp(0.3 + 0.5 * c.style.edge, 0, 1) });
  out.push(tier(corners, 0, podH, podFac, 'flat', true, frontEdges(corners, lot, 14), 7));
  // the fold: ring of 2n points (each base corner twice, each top corner twice)
  const s = r.range(0.42, 0.66);
  const twist = r.chance(0.3) ? r.range(-0.12, 0.12) : 0;
  const tops: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const th = rot0 + ((i + 0.5) / n) * Math.PI * 2 + twist;
    // the top corner sits over the middle of base edge i, pulled in by s
    const ap = R * Math.cos(Math.PI / n);
    tops.push([cx + Math.cos(th) * ap * s * 1.06, cz + Math.sin(th) * ap * s * 1.06]);
  }
  // the fold: a ring of 2n points. Entry pair i runs base corner i to corner i + 1 under top
  // corner i twice, so face 2i is an upright triangle (a base edge up to top corner i) and
  // face 2i + 1, from corner i + 1 to itself under top corners i and i + 1, the inverted one
  const ringB: Vec2[] = [];
  const ringT: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    ringB.push(corners[i] as Vec2, corners[(i + 1) % n] as Vec2);
    ringT.push(tops[i] as Vec2, tops[i] as Vec2);
  }
  const fac = makeFacade(c, r.chance(0.75) ? 'glass' : 'panel', { strips: clamp(0.55 + 0.4 * c.style.edge, 0, 1) });
  const t = tier(ringB, podH, H, fac, 'crown', false);
  t.top = ringT;
  // one surface with the crown above it: window rows and light lines run on into it
  t.seam = true;
  if (r.chance(0.35)) t.skin = 'ribs';
  out.push(t);
  // crown: the top n-gon carried up plumb a few floors, lit
  const crownH = r.range(8, 20);
  out.push(tier(tops, H, H + crownH, makeFacade(c, 'glass', { strips: 1, lit: 0.85, accent: fac.accent }), r.chance(0.5) ? 'crown' : 'helipad', false));
  return true;
};

/** A rounded section twisting as it climbs, tapering (and sometimes pinched at the waist). */
export const helix: Former = (lot, c, out, prof) => {
  const r = c.r;
  const L = inset(lot.rect, r.range(2, 4));
  const side = Math.min(rw(L), rd(L));
  if (side < 26) return false;
  const cx = (L.x0 + L.x1) / 2;
  const cz = (L.z0 + L.z1) / 2;
  let H = pickHeight(c, [prof.height[0] * 1.1, prof.height[1] * 1.15], 1.0);
  if (r.chance(prof.spike.p * 1.8)) H = r.range(prof.spike.h[0], prof.spike.h[1]) * c.hmul;
  H = Math.max(H, side * 2.6);
  // section: a rounded triangle or square, or a long squircle; turned it must stay in the lot
  const kind = r.weighted(['tri', 'sq', 'oval'] as const, [0.35, 0.3, 0.35]);
  const R = side / 2;
  const sec =
    kind === 'tri' ? roundedPoly(cx, cz, R, 3, r.range(0.3, 0.5), 6, r.range(0, 2)) : kind === 'sq' ? roundedPoly(cx, cz, R, 4, r.range(0.25, 0.5), 5, Math.PI / 4) : superRing(cx, cz, R, R * r.range(0.5, 0.72), r.range(2.2, 3.4), 24, 0);
  const turn = r.range(0.8, 2.6) * r.sign();
  const taper = r.range(0.05, 0.38);
  const waist = r.chance(0.35) ? r.range(0.06, 0.16) : 0;
  const n = clamp(Math.round(H / 12), 9, 22);
  const style: FacadeStyle = c.style.cn > 0.5 && r.chance(0.4) ? 'balcony' : r.chance(0.7) ? 'glass' : 'panel';
  const fac = makeFacade(c, style, { strips: clamp(0.45 + 0.4 * c.style.flash, 0, 1) });
  const rings: Vec2[][] = [];
  const ys: number[] = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const sc = (1 - taper * t) * (1 - waist * Math.sin(Math.PI * t));
    rings.push(xform(sec, cx, cz, sc, turn * t));
    ys.push(k === n ? H : snapFloors(H * t, fac.floorH));
  }
  const fit = fitScale(rings, L, cx, cz);
  const fitted = fit < 1 ? rings.map((g) => xform(g, cx, cz, fit, 0)) : rings;
  const skin: Skin | undefined = style === 'glass' ? r.weighted(['bands', 'ribs', 'diagrid'] as const, [0.45, 0.35, 0.2]) : undefined;
  out.push(...shell(fitted, ys, fac, r.chance(0.5) ? 'crown' : 'helipad', { smooth: true, ...(skin ? { skin } : {}), grounded: true, shopEdges: frontEdges(fitted[0] as Vec2[], lot, side * 0.3), shopH: 6 }));
  return true;
};

/** A slab whose axis leans out over its lot, straight or bowed (anglers and sliders). */
export const lean: Former = (lot, c, out, prof) => {
  const r = c.r;
  const L = inset(lot.rect, r.range(1.5, 3.5));
  const long = Math.max(rw(L), rd(L));
  const short = Math.min(rw(L), rd(L));
  if (short < 24 || long < 34) return false;
  const alongX = rw(L) >= rd(L);
  // the slab: narrow across the lean, long the other way
  const w = long * r.range(0.42, 0.58);
  const d = short * r.range(0.62, 0.86);
  const free = long - w;
  let H = pickHeight(c, [prof.height[0] * 1.05, prof.height[1] * 1.05], 1.1);
  if (r.chance(prof.spike.p)) H = r.range(prof.spike.h[0], prof.spike.h[1]) * c.hmul;
  H = Math.max(H, 60);
  const bow = r.chance(0.45);
  const dir = r.sign();
  // offset along the long axis at t (0..1): a straight lean, or a bow out and back
  const off = (t: number): number => (bow ? Math.sin(Math.PI * t) * free * 0.9 : t * free) * dir;
  const startS = dir > 0 ? 0 : free;
  const n = bow ? 9 : r.intRange(5, 8);
  const style: FacadeStyle = r.weighted(['glass', 'grid', 'balcony', 'panel'] as const, [0.4 + 0.3 * c.style.edge, 0.2, 0.25 + 0.3 * c.style.cn, 0.2]);
  const fac = makeFacade(c, style);
  const rings: Vec2[][] = [];
  const ys: number[] = [];
  const cAcross = alongX ? (L.z0 + L.z1) / 2 : (L.x0 + L.x1) / 2;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const s0 = (alongX ? L.x0 : L.z0) + startS + off(t);
    const rect = alongX ? { x0: s0, x1: s0 + w, z0: cAcross - d / 2, z1: cAcross + d / 2 } : { x0: cAcross - d / 2, x1: cAcross + d / 2, z0: s0, z1: s0 + w };
    rings.push(rectPoly(rect));
    ys.push(k === n ? H : snapFloors(H * t, fac.floorH));
  }
  const skin: Skin | undefined = r.chance(0.4) ? (style === 'glass' ? 'ribs' : 'bands') : undefined;
  out.push(...shell(rings, ys, fac, r.chance(0.4) ? 'garden' : 'crown', { ...(skin ? { skin } : {}), grounded: true, shopEdges: frontEdges(rings[0] as Vec2[], lot, 8), shopH: 5.5 }));
  return true;
};

/**
 * Lumpy accretion: boxes piled up off-centre, some turned, each overhanging the one
 * below and clad in its own material, the way blocks grow when every owner builds
 * another storey on what is there.
 */
export const stack: Former = (lot, c, out, prof) => {
  const r = c.r;
  const L = inset(lot.rect, r.range(1, 2.5));
  if (!ok(L, 18)) return false;
  let H = pickHeight(c, [prof.height[0] * 1.1, prof.height[1] * 1.2], 1.1);
  H = Math.max(H, 34);
  // a kilometre stack piles bigger lumps
  const S = Math.max(1, H / 220);
  const styles: FacadeStyle[] = ['balcony', 'grid', 'raw', 'metal', 'panel', 'glass'];
  const wts = [0.3 + 0.4 * c.style.cn, 0.3, 0.15 + 0.4 * c.style.grime, 0.12 + 0.2 * c.style.grime, 0.12 + 0.3 * c.style.edge, 0.1 + 0.3 * c.style.edge];
  let y = 0;
  let prev = L;
  let lvl = 0;
  while (y < H - 6 && lvl < 12) {
    const h = Math.min(H - y, r.range(9, 26) * S);
    const parts = lvl === 0 ? 1 : r.weighted([1, 2, 3], [0.45, 0.4, 0.15]);
    let top = prev;
    for (let p = 0; p < parts; p++) {
      const fw = r.range(0.4, 0.82);
      const fd = r.range(0.4, 0.82);
      const w = rw(L) * (lvl === 0 ? r.range(0.75, 0.95) : fw);
      const d = rd(L) * (lvl === 0 ? r.range(0.75, 0.95) : fd);
      // centre over the level below, shoved toward a random side so it overhangs
      const pcx = (prev.x0 + prev.x1) / 2 + (r.next() - 0.5) * rw(prev) * 0.8;
      const pcz = (prev.z0 + prev.z1) / 2 + (r.next() - 0.5) * rd(prev) * 0.8;
      const x0 = clamp(pcx - w / 2, L.x0, L.x1 - w);
      const z0 = clamp(pcz - d / 2, L.z0, L.z1 - d);
      const rect = { x0, z0, x1: x0 + w, z1: z0 + d };
      // a turned box keeps inside its own rect
      const turned = lvl > 0 && r.chance(0.3);
      let poly: Vec2[] = rectPoly(rect);
      if (turned) {
        const ang = r.range(0.12, 0.55) * r.sign();
        const hw = w / 2;
        const hd = d / 2;
        const k = 1 / (Math.abs(Math.cos(ang)) + Math.abs(Math.sin(ang)) * Math.max(hw, hd) / Math.min(hw, hd));
        const pc = centroid(poly);
        poly = xform(poly, pc[0], pc[1], k, ang);
      }
      const st = r.weighted(styles, wts);
      const t = tier(poly, y, y + h + (p > 0 ? r.range(-4, 6) * S : 0), makeFacade(c, st), r.chance(0.3) ? 'garden' : 'flat', lvl === 0, lvl === 0 ? frontEdges(poly, lot, 6) : [], lvl === 0 ? 5 : 0);
      if (lvl > 0) t.under = true;
      out.push(t);
      if (p === 0) top = rect;
    }
    prev = top;
    y += h;
    lvl++;
  }
  return out.length > 0;
};

/** A bundle of square tubes of different heights, each with its own setback crown. */
export const bundle: Former = (lot, c, out, prof) => {
  const r = c.r;
  const L = inset(lot.rect, r.range(2, 4));
  if (!ok(L, 30)) return false;
  const gx = rw(L) > 70 ? 3 : 2;
  const gz = rd(L) > 70 ? 3 : 2;
  let H = pickHeight(c, [prof.height[0] * 1.1, prof.height[1] * 1.2], 1.0);
  if (r.chance(prof.spike.p * 1.4)) H = r.range(prof.spike.h[0], prof.spike.h[1]) * c.hmul;
  H = Math.max(H, 70);
  const style: FacadeStyle = r.chance(0.5 + 0.3 * c.style.edge) ? 'panel' : 'glass';
  const fac = makeFacade(c, style, { strips: clamp(0.4 + 0.5 * c.style.edge, 0, 1) });
  const tall = [r.int(gx), r.int(gz)];
  for (let i = 0; i < gx; i++)
    for (let j = 0; j < gz; j++) {
      const rect = { x0: lerp(L.x0, L.x1, i / gx), x1: lerp(L.x0, L.x1, (i + 1) / gx), z0: lerp(L.z0, L.z1, j / gz), z1: lerp(L.z0, L.z1, (j + 1) / gz) };
      const isTall = i === tall[0] && j === tall[1];
      const h = snapFloors(isTall ? H : H * r.range(0.28, 0.88), fac.floorH);
      const poly = rectPoly(rect);
      const t = tier(poly, 0, h, { ...fac, seed: fac.seed + (i * 3 + j) * 0.11 }, isTall ? 'crown' : r.chance(0.5) ? 'flat' : 'garden', true, frontEdges(poly, lot, 6), 6);
      if (r.chance(0.3)) t.skin = 'bands';
      out.push(t);
      if (isTall && r.chance(0.7)) {
        const cr = inset(rect, Math.min(rw(rect), rd(rect)) * r.range(0.15, 0.3));
        if (ok(cr, 6)) out.push(tier(rectPoly(cr), h, h + r.range(10, 24), makeFacade(c, 'glass', { strips: 1, lit: 0.8, accent: fac.accent }), 'crown', false));
      }
    }
  return true;
};

/**
 * A row of slabs carrying one long hull across their tops: a sky deck with a pointed
 * bow cantilevered past the last slab, lit underneath.
 */
export const skyship: Former = (lot, c, out, prof) => {
  const r = c.r;
  const L = inset(lot.rect, r.range(2, 4));
  const long = Math.max(rw(L), rd(L));
  const short = Math.min(rw(L), rd(L));
  if (long < 84 || short < 32) return false;
  const alongX = rw(L) >= rd(L);
  const m = long > 150 ? r.intRange(3, 4) : r.intRange(2, 3);
  const H = Math.max(80, pickHeight(c, [prof.height[0] * 1.2, prof.height[1] * 1.1], 0.9));
  const deckH = r.range(8, 14) * Math.max(1, H / 260);
  // the slabs sit in the middle of the lot; the hull runs nearly its whole length
  const bowAtEnd = r.sign();
  const span0 = long * r.range(0.1, 0.16);
  const span1 = long * r.range(0.18, 0.26);
  const sA = (alongX ? L.x0 : L.z0) + (bowAtEnd > 0 ? span0 : span1);
  const sB = (alongX ? L.x1 : L.z1) - (bowAtEnd > 0 ? span1 : span0);
  const cAcross = alongX ? (L.z0 + L.z1) / 2 : (L.x0 + L.x1) / 2;
  const slabD = short * r.range(0.62, 0.82);
  const gap = (sB - sA) / m;
  const slabW = gap * r.range(0.38, 0.56);
  const style: FacadeStyle = c.style.luxury > 0.6 ? 'lux' : r.chance(0.6) ? 'glass' : 'balcony';
  const fac = makeFacade(c, style);
  for (let k = 0; k < m; k++) {
    const s0 = sA + gap * k + (gap - slabW) / 2;
    const rect = alongX ? { x0: s0, x1: s0 + slabW, z0: cAcross - slabD / 2, z1: cAcross + slabD / 2 } : { x0: cAcross - slabD / 2, x1: cAcross + slabD / 2, z0: s0, z1: s0 + slabW };
    const poly = rectPoly(rect);
    // each leg flares slightly outward at the foot (a battered slab)
    const t = tier(poly, 0, H, { ...fac, seed: fac.seed + k * 0.17 }, 'flat', true, frontEdges(poly, lot, 10), 6);
    t.seam = true;
    out.push(t);
  }
  // the hull: a long convex outline with a pointed bow and a blunt stern
  const a0 = alongX ? L.x0 : L.z0;
  const a1 = alongX ? L.x1 : L.z1;
  const hw = Math.min(short / 2, slabD / 2 + r.range(1, 4));
  const bowL = (a1 - a0) * r.range(0.12, 0.2);
  const pts: [number, number][] = bowAtEnd > 0 ? [[a0, -hw * 0.82], [a1 - bowL, -hw], [a1, 0], [a1 - bowL, hw], [a0, hw * 0.82]] : [[a1, -hw * 0.82], [a1, hw * 0.82], [a0 + bowL, hw], [a0, 0], [a0 + bowL, -hw]];
  const hull: Vec2[] = pts.map(([s, q]) => (alongX ? [s, cAcross + q] : [cAcross + q, s]) as Vec2);
  const ccw = hull.reduce((acc, p, i) => {
    const q = hull[(i + 1) % hull.length] as Vec2;
    return acc + p[0] * q[1] - q[0] * p[1];
  }, 0);
  const deck = ccw < 0 ? hull.slice().reverse() : hull;
  const t = tier(deck, H, H + deckH, makeFacade(c, 'panel', { strips: 1, win: 0.55, lit: 0.8 }), 'garden', false);
  t.under = true;
  out.push(t);
  return true;
};

/**
 * A hulk: a plain core with whole buildings bolted to its flanks at every height, each
 * its own size, material and age, overhanging the street on brackets of shadow. The
 * megastructure version of the extensions people hang off a block.
 */
export const hulk: Former = (lot, c, out, prof) => {
  const r = c.r;
  const L = inset(lot.rect, r.range(1.5, 3.5));
  if (!ok(L, 40)) return false;
  let H = pickHeight(c, [prof.height[0] * 1.1, prof.height[1] * 1.2], 1.0);
  if (r.chance(prof.spike.p)) H = r.range(prof.spike.h[0], prof.spike.h[1]) * c.hmul;
  H = Math.max(H, 90);
  const S = Math.max(1, H / 300);
  const mx = rw(L) * r.range(0.16, 0.26);
  const mz = rd(L) * r.range(0.16, 0.26);
  const core = { x0: L.x0 + mx, x1: L.x1 - mx, z0: L.z0 + mz, z1: L.z1 - mz };
  const coreStyle: FacadeStyle = r.weighted(['panel', 'grid', 'balcony', 'raw'] as const, [0.3 + 0.4 * c.style.edge, 0.3, 0.25 + 0.3 * c.style.cn, 0.1 + 0.4 * c.style.grime]);
  const fac = makeFacade(c, coreStyle);
  // a wide podium with the shops, then the core
  const podH = snapFloors(r.range(10, 24) * Math.min(S, 2), fac.floorH);
  const pod = rectPoly(L);
  out.push(tier(pod, 0, podH, makeFacade(c, 'shop'), 'flat', true, frontEdges(pod, lot, 4), 6));
  const coreT = tier(rectPoly(core), podH, H, fac, r.chance(0.5) ? 'crown' : 'helipad', false);
  if (coreStyle === 'panel' && r.chance(0.4)) coreT.skin = 'frame';
  out.push(coreT);
  // annexes on the flanks: a side, a height band, a width along the side, a depth out to the lot edge
  const styles: FacadeStyle[] = ['balcony', 'grid', 'raw', 'metal', 'panel', 'glass'];
  const wts = [0.3 + 0.4 * c.style.cn, 0.3, 0.1 + 0.4 * c.style.grime, 0.12 + 0.2 * c.style.grime, 0.15 + 0.3 * c.style.edge, 0.08 + 0.3 * c.style.edge];
  const boxes: { x0: number; z0: number; x1: number; z1: number; y0: number; y1: number }[] = [];
  const n = r.intRange(5, 12);
  for (let k = 0, tries = 0; k < n && tries < n * 4; tries++) {
    const side = r.int(4);
    const y0 = r.range(podH + 4, H * 0.86);
    const h = Math.min(H - y0 - 2, r.range(0.05, 0.22) * H * (r.chance(0.2) ? 2 : 1));
    if (h < 8) continue;
    const along = side < 2 ? rd(core) : rw(core);
    const w = along * r.range(0.25, 0.85);
    const s0 = r.range(0, along - w);
    const depth = (side < 2 ? mx : mz) * r.range(0.45, 1.0);
    const b =
      side === 0
        ? { x0: core.x0 - depth, x1: core.x0 + 0.6, z0: core.z0 + s0, z1: core.z0 + s0 + w }
        : side === 1
          ? { x0: core.x1 - 0.6, x1: core.x1 + depth, z0: core.z0 + s0, z1: core.z0 + s0 + w }
          : side === 2
            ? { x0: core.x0 + s0, x1: core.x0 + s0 + w, z0: core.z0 - depth, z1: core.z0 + 0.6 }
            : { x0: core.x0 + s0, x1: core.x0 + s0 + w, z0: core.z1 - 0.6, z1: core.z1 + depth };
    // keep clear of the other annexes (no faces fighting)
    if (boxes.some((o) => b.x0 < o.x1 + 1 && b.x1 > o.x0 - 1 && b.z0 < o.z1 + 1 && b.z1 > o.z0 - 1 && y0 < o.y1 + 2 && y0 + h > o.y0 - 2)) continue;
    boxes.push({ ...b, y0, y1: y0 + h });
    const st = r.weighted(styles, wts);
    const t = tier(rectPoly(b), y0, y0 + h, makeFacade(c, st), r.chance(0.35) ? 'garden' : 'flat', false);
    t.under = true;
    out.push(t);
    k++;
  }
  return true;
};

export const FORMS = { egg, prism, helix, lean, stack, bundle, skyship, hulk } as const;
