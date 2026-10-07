/**
 * Massing: one building per lot, assembled by an archetype grammar chosen from
 * the district's table (plus the dials). Each archetype emits convex tiers
 * (extruded footprints with a facade description and a roof kind) and a few
 * structural features (pagoda roofs, open frames, skybridges, sawtooth roofs).
 */
import type { Archetype, Building, District, DistrictKind, DistrictTune, Facade, FacadeStyle, LandUse, Lot, RGB, Rect, RoofKind, Structure, Style, Tier, Vec2 } from './types';
import type { Zoning } from './zoning';
import { blendAt } from './zoning';
import { PROFILES, STYLE_PALETTES, blendStyle, dominantCulture, hexToLinear, lightColor, tuneMul } from './profiles';
import { chamferRect, regularPoly } from './geom2d';
import { Rng, clamp, lerp } from './rng';

interface Ctx {
  r: Rng;
  style: Style;
  tune: DistrictTune;
  use: LandUse;
  wall: RGB;
  palette: RGB[];
  hmul: number;
  structures: Structure[];
  seed: number;
  /** Set when a builder hands the lot to another archetype (the building records what was built). */
  built?: Archetype;
}

const FLOOR_H: Record<FacadeStyle, number> = { glass: 4.0, panel: 4.2, grid: 3.3, shop: 3.4, balcony: 3.0, metal: 6.0, raw: 3.2, lux: 3.8 };
const BAY_W: Record<FacadeStyle, [number, number]> = {
  glass: [1.4, 2.0],
  panel: [2.6, 4.2],
  grid: [2.4, 3.4],
  shop: [2.6, 4.0],
  balcony: [3.0, 4.2],
  metal: [4.0, 7.0],
  raw: [2.8, 3.8],
  lux: [2.2, 3.2],
};

function rectPoly(r: Rect): Vec2[] {
  return [
    [r.x0, r.z0],
    [r.x1, r.z0],
    [r.x1, r.z1],
    [r.x0, r.z1],
  ];
}

function inset(r: Rect, d: number): Rect {
  return { x0: r.x0 + d, x1: r.x1 - d, z0: r.z0 + d, z1: r.z1 - d };
}

function insetSides(r: Rect, l: number, rr: number, t: number, b: number): Rect {
  return { x0: r.x0 + l, x1: r.x1 - rr, z0: r.z0 + t, z1: r.z1 - b };
}

function ok(r: Rect, min = 3): boolean {
  return r.x1 - r.x0 >= min && r.z1 - r.z0 >= min;
}

function rw(r: Rect): number {
  return r.x1 - r.x0;
}
function rd(r: Rect): number {
  return r.z1 - r.z0;
}

/** Edges of `poly` that face a street side of the lot (within `maxDist` of it). */
function frontEdges(poly: readonly Vec2[], lot: Lot, maxDist: number): number[] {
  const out: number[] = [];
  const R = lot.rect;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Vec2;
    const b = poly[(i + 1) % poly.length] as Vec2;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 2) continue;
    const nx = dz / len;
    const nz = -dx / len;
    const mx = (a[0] + b[0]) / 2;
    const mz = (a[1] + b[1]) / 2;
    if (nx < -0.7 && lot.front[0] && mx - R.x0 < maxDist) out.push(i);
    else if (nx > 0.7 && lot.front[1] && R.x1 - mx < maxDist) out.push(i);
    else if (nz < -0.7 && lot.front[2] && mz - R.z0 < maxDist) out.push(i);
    else if (nz > 0.7 && lot.front[3] && R.z1 - mz < maxDist) out.push(i);
  }
  return out;
}

function mix3(a: RGB, b: RGB, t: number): RGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function makeFacade(c: Ctx, style: FacadeStyle, o: Partial<Facade> = {}): Facade {
  const r = c.r;
  const s = c.style;
  const fh = FLOOR_H[style] * r.range(0.94, 1.08);
  const [b0, b1] = BAY_W[style];
  let lit = 0.45;
  let warm = 0.6;
  switch (style) {
    case 'glass':
      lit = 0.55;
      warm = 0.22;
      break;
    case 'panel':
      lit = 0.35;
      warm = 0.15;
      break;
    case 'grid':
      lit = 0.48;
      warm = 0.62;
      break;
    case 'shop':
      lit = 0.6;
      warm = 0.65;
      break;
    case 'balcony':
      lit = 0.46;
      warm = 0.72;
      break;
    case 'metal':
      lit = 0.16;
      warm = 0.5;
      break;
    case 'raw':
      lit = 0.12;
      warm = 0.7;
      break;
    case 'lux':
      lit = 0.42;
      warm = 0.92;
      break;
  }
  lit *= (1 - 0.65 * s.grime * s.grime) * (0.8 + 0.4 * s.flash);
  // a well-funded district keeps its lights on; a decaying one has empty floors
  lit *= clamp(1 + 0.3 * c.tune.budget - 0.35 * Math.max(0, c.tune.decay), 0.3, 1.5);
  // land use: homes glow warm, offices cool, nightlife blazes, civic stays lit
  if (c.use === 'residential') {
    if ((style === 'glass' || style === 'panel') && !o.style && r.chance(0.55)) style = s.luxury > 0.6 ? 'lux' : 'balcony';
    warm += 0.3;
  } else if (c.use === 'commercial') warm -= 0.15;
  else if (c.use === 'nightlife') lit *= 1.25;
  else if (c.use === 'civic') lit = Math.max(lit, 0.6);
  warm = clamp(warm - 0.3 * s.edge + 0.25 * s.luxury + r.range(-0.12, 0.12), 0, 1);
  let base = c.wall;
  if (style === 'glass') base = mix3([0.03, 0.045, 0.06], base, 0.3);
  if (style === 'panel') base = mix3(base, [0.02, 0.022, 0.028], 0.55 + 0.3 * s.edge);
  if (style === 'lux') base = mix3(base, [0.4, 0.34, 0.26], 0.35 * s.luxury);
  const accent = (c.palette[r.int(c.palette.length)] ?? [1, 1, 1]) as RGB;
  let strips = clamp((style === 'glass' || style === 'panel' ? 0.55 * s.edge : 0.15 * s.edge) + 0.35 * s.flash * (style === 'shop' ? 0.2 : 1) + r.range(-0.15, 0.15), 0, 1);
  if (c.use === 'nightlife') strips = Math.max(strips, r.range(0.55, 0.9));
  else if (c.use === 'residential') strips *= 0.4;
  else if (c.use === 'civic') strips = Math.max(strips, 0.45);
  return {
    style,
    floorH: fh,
    bayW: r.range(b0, b1),
    win: style === 'glass' ? r.range(0.82, 0.94) : style === 'panel' ? r.range(0.12, 0.3) : style === 'metal' ? r.range(0.1, 0.25) : r.range(0.42, 0.7),
    lit: clamp(lit * r.range(0.75, 1.25), 0.02, 0.95),
    warm,
    base,
    accent,
    strips,
    grime: clamp(s.grime + r.range(-0.12, 0.12), 0, 1),
    seed: r.next(),
    ...o,
  };
}

function tier(poly: Vec2[], y0: number, y1: number, facade: Facade, roof: RoofKind, grounded: boolean, shopEdges: number[] = [], shopH = 0): Tier {
  return { poly, y0, y1, facade, roof, grounded, shopEdges, shopH };
}

function pickHeight(c: Ctx, range: [number, number], skew = 1.6): number {
  const t = Math.pow(c.r.next(), skew);
  return lerp(range[0], range[1], t) * c.hmul;
}

function snapFloors(h: number, fh: number): number {
  return Math.max(fh, Math.round(h / fh) * fh);
}

// ------------------------------------------------------------------ archetypes

type Builder = (lot: Lot, c: Ctx, out: Tier[], prof: (typeof PROFILES)[keyof typeof PROFILES]) => void;

const tower: Builder = (lot, c, out, prof) => {
  const r = c.r;
  const s = c.style;
  const L = lot.rect;
  const podR = inset(L, r.range(1.5, 3.5));
  if (!ok(podR, 12)) return swap('midrise', c)(lot, c, out, prof);
  const podH = snapFloors(r.range(10, 22), 4.4);
  const shopF = makeFacade(c, 'shop');
  out.push(tier(rectPoly(podR), 0, podH, makeFacade(c, s.edge > 0.7 && r.chance(0.5) ? 'panel' : 'glass'), 'flat', true, frontEdges(rectPoly(podR), lot, 6), 5.2));
  void shopF;
  let H = pickHeight(c, prof.height, 1.3);
  if (r.chance(prof.spike.p)) H = r.range(prof.spike.h[0], prof.spike.h[1]) * c.hmul;
  H = Math.max(H, podH + 12);
  let cur = inset(podR, r.range(3, Math.min(10, Math.min(rw(podR), rd(podR)) * 0.2)));
  if (!ok(cur, 14)) cur = inset(podR, 2);
  const glassy = r.chance(0.75 - 0.35 * s.edge);
  const fac = makeFacade(c, glassy ? 'glass' : 'panel');
  const chamfer = s.luxury > 0.5 && r.chance(0.5) ? Math.min(rw(cur), rd(cur)) * r.range(0.12, 0.28) : s.edge < 0.6 && r.chance(0.35) ? Math.min(rw(cur), rd(cur)) * 0.1 : 0;
  const steps = H > 160 ? r.intRange(1, 3) : r.intRange(0, 1);
  let y = podH;
  for (let k = 0; k <= steps; k++) {
    const top = k === steps ? H : y + (H - y) * r.range(0.45, 0.7);
    const poly = chamfer > 0.5 ? chamferRect(cur, chamfer, [true, true, true, true]) : rectPoly(cur);
    out.push(tier(poly, y, top, { ...fac, seed: fac.seed + k * 0.13 }, k === steps ? (s.edge > 0.6 && r.chance(0.6) ? 'helipad' : 'crown') : 'flat', false));
    y = top;
    const next = inset(cur, r.range(2.5, Math.min(8, Math.min(rw(cur), rd(cur)) * 0.18)));
    if (!ok(next, 10)) break;
    cur = next;
  }
  // crown block
  if (r.chance(0.55)) {
    const cr = inset(cur, Math.min(rw(cur), rd(cur)) * r.range(0.15, 0.3));
    if (ok(cr, 6)) out.push(tier(rectPoly(cr), y, y + r.range(8, 22), makeFacade(c, 'panel', { strips: clamp(0.5 + s.edge * 0.5, 0, 1) }), 'crown', false));
  }
};

const monolith: Builder = (lot, c, out, prof) => {
  const r = c.r;
  const L = lot.rect;
  const R = inset(L, r.range(3, 8));
  if (!ok(R, 16)) return swap('tower', c)(lot, c, out, prof);
  let H = pickHeight(c, [prof.height[0] * 1.1, prof.height[1] * 1.15], 1.1);
  if (r.chance(prof.spike.p)) H = r.range(prof.spike.h[0], prof.spike.h[1]) * c.hmul;
  const lobbyH = snapFloors(r.range(8, 14), 4.5);
  const lobby = inset(R, 2.5);
  out.push(tier(rectPoly(lobby), 0, lobbyH, makeFacade(c, 'glass', { lit: 0.85, warm: 0.2 }), 'flat', true, frontEdges(rectPoly(lobby), lot, 10), lobbyH));
  // notched: two slabs of different height side by side, or one block
  const fac = makeFacade(c, 'panel', { strips: clamp(0.55 + 0.45 * c.style.edge, 0, 1) });
  if (r.chance(0.45) && rw(R) > 30) {
    const mid = R.x0 + rw(R) * r.range(0.4, 0.6);
    out.push(tier(rectPoly({ ...R, x1: mid }), lobbyH, H, fac, 'helipad', false));
    out.push(tier(rectPoly({ ...R, x0: mid }), lobbyH, H * r.range(0.7, 0.88), { ...fac, seed: fac.seed + 0.31 }, 'flat', false));
  } else {
    out.push(tier(rectPoly(R), lobbyH, H, fac, r.chance(0.6) ? 'helipad' : 'crown', false));
  }
};

const needle: Builder = (lot, c, out, prof) => {
  const r = c.r;
  const L = lot.rect;
  const cx = (L.x0 + L.x1) / 2;
  const cz = (L.z0 + L.z1) / 2;
  let rad = Math.min(rw(L), rd(L)) * 0.3;
  rad = Math.min(clamp(rad, 9, 20), Math.min(rw(L), rd(L)) / 2 - 1.5);
  if (rad < 7) return swap('tower', c)(lot, c, out, prof);
  const H = (prof.spike.h[1] > 0 ? r.range(prof.spike.h[0], prof.spike.h[1]) : r.range(240, 380)) * c.hmul;
  const base = inset(L, 2);
  if (!ok(base, 10)) return swap('tower', c)(lot, c, out, prof);
  out.push(tier(rectPoly(base), 0, 9, makeFacade(c, 'glass', { lit: 0.8 }), 'flat', true, frontEdges(rectPoly(base), lot, 8), 9));
  const n = r.pick([8, 8, 12]);
  const fac = makeFacade(c, 'glass');
  let y = 9;
  const tiers = 4;
  for (let k = 0; k < tiers; k++) {
    const top = k === tiers - 1 ? H : y + (H - y) * (0.42 + 0.1 * k);
    out.push(tier(regularPoly(cx, cz, rad, n, Math.PI / n), y, top, { ...fac, seed: fac.seed + k * 0.1 }, k === tiers - 1 ? 'crown' : 'flat', false));
    y = top;
    rad *= r.range(0.72, 0.86);
  }
};

const podium: Builder = (lot, c, out) => {
  const r = c.r;
  const R = inset(lot.rect, r.range(0.8, 2));
  if (!ok(R, 8)) return;
  const fl = r.intRange(2, 5);
  const H = fl * 4.6;
  const poly = rectPoly(R);
  out.push(tier(poly, 0, H, makeFacade(c, c.style.flash > 0.5 ? 'shop' : 'glass', { floorH: 4.6 }), 'flat', true, frontEdges(poly, lot, 6), 5.5));
};

const shophouse: Builder = (lot, c, out, prof) => {
  const r = c.r;
  const L = lot.rect;
  // zero setback on street fronts, a hair on party walls so neighbours do not z-fight
  const R = insetSides(L, lot.front[0] ? 0.2 : 0.15, lot.front[1] ? 0.2 : 0.15, lot.front[2] ? 0.2 : 0.15, lot.front[3] ? 0.2 : 0.15);
  if (!ok(R, 3)) return;
  const shopH = r.range(3.4, 4.6);
  const H = Math.max(shopH + 3, pickHeight(c, [prof.height[0], prof.height[0] + (prof.height[1] - prof.height[0]) * 0.55], 1.4));
  const upper: FacadeStyle = c.style.cn > 0.5 && r.chance(0.6) ? 'balcony' : c.style.grime > 0.8 && r.chance(0.5) ? 'raw' : 'grid';
  const poly = rectPoly(R);
  const fronts = frontEdges(poly, lot, 1);
  out.push(tier(poly, 0, H, makeFacade(c, upper), r.chance(c.style.jp * 0.22 + c.style.cn * 0.12) ? 'pagoda' : 'flat', true, fronts, shopH));
  // penthouse box on some
  if (r.chance(0.3) && rw(R) > 6 && rd(R) > 6) {
    const pr = insetSides(R, rw(R) * r.range(0.1, 0.35), rw(R) * r.range(0.1, 0.35), rd(R) * r.range(0.1, 0.35), rd(R) * r.range(0.1, 0.35));
    if (ok(pr, 3)) out.push(tier(rectPoly(pr), H, H + r.range(2.8, 4.2), makeFacade(c, 'grid'), 'flat', false));
  }
};

const midrise: Builder = (lot, c, out, prof) => {
  const r = c.r;
  const L = lot.rect;
  const sb = r.range(0.2, 1.4);
  const R = insetSides(L, lot.front[0] ? 0.2 : sb, lot.front[1] ? 0.2 : sb, lot.front[2] ? 0.2 : sb, lot.front[3] ? 0.2 : sb);
  if (!ok(R, 5)) return;
  const shopH = r.range(3.6, 5);
  let H = pickHeight(c, prof.height, 1.25);
  if (r.chance(prof.spike.p * 0.6)) H = r.range(prof.spike.h[0], prof.spike.h[1]) * c.hmul;
  H = Math.max(H, 14);
  const style: FacadeStyle = c.style.grime > 0.85 && r.chance(0.5) ? 'raw' : c.style.cn > 0.45 || r.chance(0.3) ? 'balcony' : 'grid';
  const poly = rectPoly(R);
  out.push(tier(poly, 0, H, makeFacade(c, style), r.chance(c.style.jp * 0.15 + c.style.cn * 0.1) ? 'pagoda' : 'flat', true, frontEdges(poly, lot, 1.5), shopH));
  if (H > 40 && r.chance(0.35)) {
    const pr = inset(R, Math.min(rw(R), rd(R)) * r.range(0.15, 0.3));
    if (ok(pr, 5)) out.push(tier(rectPoly(pr), H, H + r.range(6, 16), makeFacade(c, style), 'flat', false));
  }
};

const megablock: Builder = (lot, c, out, prof) => {
  const r = c.r;
  const L = inset(lot.rect, r.range(3, 8));
  if (!ok(L, 24)) return swap('midrise', c)(lot, c, out, prof);
  let H = pickHeight(c, prof.height, 1.0);
  if (r.chance(prof.spike.p)) H = r.range(prof.spike.h[0], prof.spike.h[1]) * c.hmul;
  const fac = makeFacade(c, 'balcony');
  const shopH = 6;
  const depth = r.range(18, 28);
  const alongX = rw(L) >= rd(L);
  const variant = r.int(3);
  const slabs: Rect[] = [];
  if (variant === 0 || Math.min(rw(L), rd(L)) < depth * 2.6) {
    // one long slab
    const c0 = alongX ? (L.z0 + L.z1) / 2 : (L.x0 + L.x1) / 2;
    slabs.push(alongX ? { ...L, z0: c0 - depth / 2, z1: c0 + depth / 2 } : { ...L, x0: c0 - depth / 2, x1: c0 + depth / 2 });
  } else if (variant === 1) {
    // two parallel slabs with a courtyard
    slabs.push(alongX ? { ...L, z1: L.z0 + depth } : { ...L, x1: L.x0 + depth });
    slabs.push(alongX ? { ...L, z0: L.z1 - depth } : { ...L, x0: L.x1 - depth });
  } else {
    // U shape
    slabs.push(alongX ? { ...L, z1: L.z0 + depth } : { ...L, x1: L.x0 + depth });
    slabs.push(alongX ? { ...L, z0: L.z1 - depth } : { ...L, x0: L.x1 - depth });
    slabs.push(alongX ? { x0: L.x0, x1: L.x0 + depth, z0: L.z0 + depth, z1: L.z1 - depth } : { x0: L.x0 + depth, x1: L.x1 - depth, z0: L.z0, z1: L.z0 + depth });
  }
  slabs.forEach((sl, k) => {
    if (!ok(sl, 6)) return;
    const h = k === 0 ? H : H * r.range(0.72, 1.0);
    const poly = rectPoly(sl);
    out.push(tier(poly, 0, h, { ...fac, seed: fac.seed + k * 0.17 }, 'flat', true, frontEdges(poly, lot, 12), shopH));
  });
  // skybridges between parallel slabs
  if (slabs.length >= 2) {
    const a = slabs[0] as Rect;
    const b = slabs[1] as Rect;
    const nb = r.intRange(1, 3);
    for (let k = 0; k < nb; k++) {
      const y = H * r.range(0.25, 0.8);
      if (alongX) {
        const x = lerp(a.x0 + 6, a.x1 - 6, r.next());
        c.structures.push({ kind: 'bridge', p: [x, y, a.z1, x, y, b.z0, r.range(4, 7), r.range(3.5, 5)], col: c.wall, col2: c.palette[0] ?? [1, 1, 1], seed: r.next() });
      } else {
        const z = lerp(a.z0 + 6, a.z1 - 6, r.next());
        c.structures.push({ kind: 'bridge', p: [a.x1, y, z, b.x0, y, z, r.range(4, 7), r.range(3.5, 5)], col: c.wall, col2: c.palette[0] ?? [1, 1, 1], seed: r.next() });
      }
    }
  }
};

const arcology: Builder = (lot, c, out, prof) => {
  const r = c.r;
  let R = inset(lot.rect, r.range(4, 8));
  if (!ok(R, 40)) return swap('megablock', c)(lot, c, out, prof);
  const H = Math.max(120, pickHeight(c, [prof.height[1] * 0.8, prof.height[1] * 1.3], 1.0));
  const steps = r.intRange(3, 5);
  let y = 0;
  const fac = makeFacade(c, r.chance(0.5) ? 'balcony' : 'grid');
  for (let k = 0; k < steps; k++) {
    const top = k === steps - 1 ? H : y + H / steps;
    const poly = rectPoly(R);
    out.push(tier(poly, y, top, { ...fac, seed: fac.seed + k * 0.07 }, k === steps - 1 ? 'crown' : 'garden', k === 0, k === 0 ? frontEdges(poly, lot, 10) : [], 6));
    y = top;
    const ni = Math.min(rw(R), rd(R)) * r.range(0.1, 0.17);
    R = inset(R, ni);
    if (!ok(R, 12)) break;
  }
};

const shed: Builder = (lot, c, out, prof) => {
  const r = c.r;
  const R = inset(lot.rect, r.range(4, 12));
  if (!ok(R, 10)) return;
  const H = pickHeight(c, prof.height, 1.0);
  const fac = makeFacade(c, 'metal');
  const poly = rectPoly(R);
  const saw = r.chance(0.45);
  out.push(tier(poly, 0, H, fac, saw ? 'sawtooth' : 'flat', true, [], 0));
  if (saw) c.structures.push({ kind: 'sawtooth', p: [R.x0, R.z0, R.x1, R.z1, H, r.range(6, 10), rw(R) >= rd(R) ? 0 : 1], col: c.wall, col2: [0.3, 0.6, 0.65], seed: r.next() });
  // office annex on the street side
  const fr = frontEdges(poly, lot, 14);
  if (fr.length > 0 && r.chance(0.6)) {
    const annexD = r.range(8, 12);
    const side = fr[0] as number; // 0:-z 1:+x 2:+z 3:-x for rects
    const a: Rect =
      side === 0 ? { ...R, z1: R.z0 + annexD, x1: R.x0 + Math.min(rw(R), 30) } : side === 2 ? { ...R, z0: R.z1 - annexD, x1: R.x0 + Math.min(rw(R), 30) } : side === 1 ? { ...R, x0: R.x1 - annexD, z1: R.z0 + Math.min(rd(R), 30) } : { ...R, x1: R.x0 + annexD, z1: R.z0 + Math.min(rd(R), 30) };
    const ap = rectPoly(a);
    out.push(tier(ap, H, H + r.range(6, 10), makeFacade(c, 'grid', { lit: 0.35, warm: 0.3 }), 'flat', false));
  }
};

const tankfarm: Builder = (lot, c, out) => {
  const r = c.r;
  const L = inset(lot.rect, 6);
  if (!ok(L, 14)) return;
  const sh = { x0: L.x0, x1: L.x0 + Math.min(rw(L) * 0.35, 24), z0: L.z0, z1: L.z0 + Math.min(rd(L) * 0.4, 18) };
  out.push(tier(rectPoly(sh), 0, r.range(6, 10), makeFacade(c, 'metal'), 'flat', true, frontEdges(rectPoly(sh), lot, 8), 0));
};

const ruin: Builder = (lot, c, out, prof) => {
  const r = c.r;
  const R = inset(lot.rect, r.range(0.8, 4));
  if (!ok(R, 6)) return;
  const fl = 3.2;
  let H = pickHeight(c, prof.height, 1.2);
  if (r.chance(prof.spike.p)) H = r.range(prof.spike.h[0], prof.spike.h[1]) * c.hmul;
  H = snapFloors(Math.max(H, 9), fl);
  const fac = makeFacade(c, 'raw');
  const poly = rectPoly(R);
  // the walled part, then an open concrete frame above (unfinished or stripped)
  const walled = snapFloors(H * r.range(0.35, 0.8), fl);
  out.push(tier(poly, 0, walled, fac, 'flat', true, frontEdges(poly, lot, 4), 3.6));
  if (H - walled > fl) c.structures.push({ kind: 'frame', p: [R.x0, R.z0, R.x1, R.z1, walled, H, fl], col: [0.36, 0.34, 0.31], col2: [0.5, 0.25, 0.12], seed: r.next() });
  if (r.chance(0.3)) {
    const fr = frontEdges(poly, lot, 4)[0];
    if (fr !== undefined) {
      const a = poly[fr] as Vec2;
      const b = poly[(fr + 1) % poly.length] as Vec2;
      c.structures.push({ kind: 'scaffold', p: [a[0], a[1], b[0], b[1], 0, Math.min(H, walled + fl * 2), 1.2], col: [0.3, 0.28, 0.22], col2: [0.6, 0.2, 0.1], seed: r.next() });
    }
  }
};

const shack: Builder = (lot, c, out) => {
  const r = c.r;
  const L = inset(lot.rect, 0.8);
  if (!ok(L, 4)) return;
  // a few small boxes packed on the lot
  const n = r.intRange(1, 4);
  for (let k = 0; k < n; k++) {
    const w = Math.min(rw(L), r.range(4, 9));
    const d = Math.min(rd(L), r.range(4, 8));
    const x0 = lerp(L.x0, L.x1 - w, r.next());
    const z0 = lerp(L.z0, L.z1 - d, r.next());
    const R: Rect = { x0, z0, x1: x0 + w, z1: z0 + d };
    const poly = rectPoly(R);
    out.push(tier(poly, 0, r.range(2.8, 6.5), makeFacade(c, r.chance(0.6) ? 'metal' : 'raw', { floorH: 3 }), 'flat', true, frontEdges(poly, lot, 3), 2.6));
  }
};

const villa: Builder = (lot, c, out) => {
  const r = c.r;
  let R = inset(lot.rect, r.range(5, 11));
  if (!ok(R, 10)) return;
  const fac = makeFacade(c, 'lux');
  const levels = r.intRange(2, 3);
  let y = 0;
  for (let k = 0; k < levels; k++) {
    const h = r.range(3.6, 4.4);
    const poly = chamferRect(R, Math.min(rw(R), rd(R)) * r.range(0.04, 0.12), [r.chance(0.5), r.chance(0.5), r.chance(0.5), r.chance(0.5)]);
    out.push(tier(poly, y, y + h, { ...fac, seed: fac.seed + k * 0.2 }, k === levels - 1 ? (r.chance(0.5) ? 'garden' : 'flat') : 'garden', k === 0, k === 0 ? frontEdges(poly, lot, 14) : [], 0));
    y += h;
    // terraces step back toward one side
    const sx = r.range(0.15, 0.3);
    const next = r.chance(0.5) ? { ...R, x1: R.x1 - rw(R) * sx } : { ...R, z1: R.z1 - rd(R) * sx };
    if (!ok(next, 7)) break;
    R = next;
  }
  if (r.chance(0.55)) {
    const L = lot.rect;
    const pw = Math.min(14, rw(L) * 0.3);
    const pd = Math.min(6, rd(L) * 0.18);
    c.structures.push({ kind: 'pool', p: [L.x1 - pw - 3, L.z1 - pd - 3, L.x1 - 3, L.z1 - 3, 0.2], col: [0.1, 0.6, 0.65], col2: [0.4, 1.0, 0.95], seed: r.next() });
  }
};

const spire: Builder = (lot, c, out) => {
  const r = c.r;
  const L = lot.rect;
  const cx = (L.x0 + L.x1) / 2;
  const cz = (L.z0 + L.z1) / 2;
  let rad = Math.min(clamp(Math.min(rw(L), rd(L)) * 0.32, 10, 22), Math.min(rw(L), rd(L)) / 2 - 2);
  if (rad < 8) return villa(lot, c, out, PROFILES.luxury);
  const H = r.range(90, 230) * c.hmul;
  const n = r.pick([10, 12, 16]);
  const fac = makeFacade(c, r.chance(0.6) ? 'lux' : 'glass', { warm: 0.9 });
  const lobby = inset(L, r.range(4, 8));
  if (ok(lobby, 10)) out.push(tier(chamferRect(lobby, Math.min(rw(lobby), rd(lobby)) * 0.25, [true, true, true, true]), 0, 7, makeFacade(c, 'glass', { lit: 0.9, warm: 0.95 }), 'garden', true, frontEdges(rectPoly(lobby), lot, 12), 7));
  let y = 7;
  const tiers = r.intRange(3, 5);
  for (let k = 0; k < tiers; k++) {
    const top = k === tiers - 1 ? H : y + (H - y) * r.range(0.32, 0.5);
    out.push(tier(regularPoly(cx, cz, rad, n, (k * Math.PI) / n), y, top, { ...fac, seed: fac.seed + k * 0.11 }, k === tiers - 1 ? 'crown' : 'garden', false));
    y = top;
    rad *= r.range(0.8, 0.92);
  }
};

// ----------------------------------------------------------- megastructures
//
// Alien massing: sloped and stepped volumes, overhangs and spans. Tapered tiers
// carry a `top` polygon (same vertex order as `poly`); tiers that overhang what
// is below them set `under` so the renderer draws a lit soffit.

/** Uniform inward offset of a convex counter-clockwise polygon (negative d grows it). */
export function offsetConvex(p: readonly Vec2[], d: number): Vec2[] {
  const n = p.length;
  const out: Vec2[] = [];
  const nrm = (a: Vec2, b: Vec2): Vec2 => {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    return [dz / l, -dx / l];
  };
  for (let i = 0; i < n; i++) {
    const a = p[(i + n - 1) % n] as Vec2;
    const b = p[i] as Vec2;
    const c = p[(i + 1) % n] as Vec2;
    const n1 = nrm(a, b);
    const n2 = nrm(b, c);
    const c1 = n1[0] * a[0] + n1[1] * a[1] - d;
    const c2 = n2[0] * b[0] + n2[1] * b[1] - d;
    const det = n1[0] * n2[1] - n1[1] * n2[0];
    if (Math.abs(det) < 1e-9) out.push([b[0] - n1[0] * d, b[1] - n1[1] * d]);
    else out.push([(c1 * n2[1] - c2 * n1[1]) / det, (n1[0] * c2 - n2[0] * c1) / det]);
  }
  return out;
}

function squarePoly(cx: number, cz: number, half: number, rot = 0): Vec2[] {
  return regularPoly(cx, cz, half * Math.SQRT2, 4, Math.PI / 4 + rot);
}

function tapered(poly: Vec2[], top: Vec2[], y0: number, y1: number, facade: Facade, roof: RoofKind, under = false): Tier {
  const t = tier(poly, y0, y1, facade, roof, false);
  t.top = top;
  if (under) t.under = true;
  return t;
}

/** Plain fallback when a lot cannot hold the megastructure: a tower where the district is tall, else a midrise. */
const fallback: Builder = (lot, c, out, prof) => swap(prof.height[1] * c.hmul > 90 ? 'tower' : 'midrise', c)(lot, c, out, prof);

/** Hand a lot to another archetype's builder and record the swap. */
function swap(a: Archetype, c: Ctx): Builder {
  c.built = a;
  return BUILDERS[a];
}

function over(t: Tier): Tier {
  t.under = true;
  return t;
}

/**
 * Stepped glass pyramid. At landmark scale it takes a whole superblock and rises
 * 350-600 m; in a district table it is a 120-260 m corporate or arcology pyramid.
 */
const pyramid: Builder = (lot, c, out, prof) => {
  const r = c.r;
  const R = inset(lot.rect, lot.landmark ? r.range(8, 16) : r.range(3, 7));
  const side = Math.min(rw(R), rd(R));
  if (side < 56) return swap(lot.landmark ? 'arcology' : 'tower', c)(lot, c, out, prof);
  const cx = (R.x0 + R.x1) / 2;
  const cz = (R.z0 + R.z1) / 2;
  const half = side / 2;
  const H = lot.landmark ? clamp(side * r.range(1.45, 1.75), 360, 620) : clamp(side * r.range(1.2, 1.7), 110, 270) * c.hmul;
  const podH = snapFloors(r.range(10, 16), 4.5);
  const pod = squarePoly(cx, cz, half);
  out.push(tier(pod, 0, podH, makeFacade(c, 'glass', { lit: 0.85, warm: 0.3 }), 'flat', true, frontEdges(pod, lot, 20), podH));
  const apex = 0.07;
  const w = (y: number): number => half * (1 - (1 - apex) * ((y - podH) / (H - podH)));
  const stages = lot.landmark ? r.intRange(5, 7) : r.intRange(2, 4);
  const glassy = c.style.edge < 0.75 || r.chance(0.5);
  // one accent for the whole pyramid, so its ridges and bands read as a single sign
  const accent = (c.palette[r.int(c.palette.length)] ?? [0.6, 0.9, 1]) as RGB;
  const strips = lot.landmark ? 1 : clamp(0.55 + 0.4 * c.style.edge, 0, 1);
  let y = podH;
  for (let k = 0; k < stages; k++) {
    const y1 = k === stages - 1 ? H : y + (H - podH) / stages;
    // a terrace setback at every stage start, so the slope reads as stepped
    const hb = w(y) - (k > 0 ? Math.min(4, w(y) * 0.05) : 0);
    const ht = w(y1);
    if (hb <= 2 || ht <= 1) break;
    const band = k % 2 === 1 && lot.landmark;
    const fac = makeFacade(c, band ? 'panel' : glassy ? 'glass' : 'grid', { strips, accent, seed: c.seed + k * 0.13, ...(lot.landmark ? { lit: 0.8 } : {}) });
    out.push(tapered(squarePoly(cx, cz, hb), squarePoly(cx, cz, ht), y, y1, fac, k === stages - 1 ? 'crown' : 'garden'));
    y = y1;
  }
  // apex lantern
  const ah = Math.max(6, w(H) * 0.8);
  out.push(tier(squarePoly(cx, cz, ah), H, H + ah * 2.4, makeFacade(c, 'glass', { lit: 0.95, warm: 0.4, strips: 1, accent }), 'crown', false));
};

/** Stepped arcology with battered (sloped) walls and garden terraces. */
const ziggurat: Builder = (lot, c, out, prof) => {
  const r = c.r;
  let R = inset(lot.rect, r.range(3, 7));
  if (!ok(R, 40)) return swap('megablock', c)(lot, c, out, prof);
  const H = Math.max(70, pickHeight(c, [prof.height[0] * 1.1, prof.height[1] * 1.1], 1.0));
  const steps = r.intRange(3, 5);
  const style: FacadeStyle = c.style.cn > 0.5 || r.chance(0.5) ? 'balcony' : 'grid';
  let y = 0;
  let poly = rectPoly(R);
  for (let k = 0; k < steps; k++) {
    const y1 = k === steps - 1 ? H : y + H / steps;
    const batter = (y1 - y) * r.range(0.08, 0.16);
    const top = offsetConvex(poly, batter);
    const fac = makeFacade(c, style, { seed: c.seed + k * 0.07 });
    if (k === 0) {
      // the street storey stays vertical so shops and signs sit on a plumb wall
      out.push(tier(poly, 0, 6, makeFacade(c, 'shop'), 'flat', true, frontEdges(poly, lot, 10), 6));
      out.push(tapered(poly, top, 6, y1, fac, 'garden'));
    } else out.push(tapered(poly, top, y, y1, fac, k === steps - 1 ? 'crown' : 'garden'));
    y = y1;
    const terrace = Math.min(rw(R), rd(R)) * r.range(0.06, 0.1);
    R = inset(R, batter + terrace);
    if (!ok(R, 14)) break;
    poly = rectPoly(R);
  }
};

/** A tapering obelisk tower on a podium. */
const taper: Builder = (lot, c, out, prof) => {
  const r = c.r;
  const R = inset(lot.rect, r.range(3, 7));
  const side = Math.min(rw(R), rd(R));
  if (side < 24) return fallback(lot, c, out, prof);
  const cx = (R.x0 + R.x1) / 2;
  const cz = (R.z0 + R.z1) / 2;
  let H = pickHeight(c, prof.height, 1.1);
  if (r.chance(prof.spike.p * 1.5)) H = r.range(prof.spike.h[0], prof.spike.h[1]) * c.hmul;
  const podH = snapFloors(r.range(8, 14), 4.5);
  const pod = rectPoly(R);
  out.push(tier(pod, 0, podH, makeFacade(c, 'glass', { lit: 0.8 }), 'garden', true, frontEdges(pod, lot, 10), podH));
  const oct = r.chance(0.4);
  const rad = side * 0.42;
  const base = oct ? regularPoly(cx, cz, rad, 8, Math.PI / 8) : squarePoly(cx, cz, rad);
  const top = offsetConvex(base, rad * r.range(0.35, 0.55));
  out.push(tapered(base, top, podH, H, makeFacade(c, r.chance(0.6) ? 'glass' : 'panel', { strips: clamp(0.5 + 0.5 * c.style.edge, 0, 1) }), 'crown'));
};

/** Stacked boxes shoved off-centre, each overhanging the one below. */
const cantilever: Builder = (lot, c, out, prof) => {
  const r = c.r;
  const L = inset(lot.rect, r.range(1.5, 3));
  if (!ok(L, 26)) return fallback(lot, c, out, prof);
  const lux = c.style.luxury > 0.7;
  const H = Math.max(28, pickHeight(c, lux ? [prof.height[0] * 1.6, prof.height[1] * 1.8] : prof.height, 1.2));
  const n = clamp(Math.round(H / r.range(14, 28)), 2, 7);
  const bh = H / n;
  const fac = makeFacade(c, lux ? 'lux' : r.chance(0.55) ? 'glass' : 'panel', { strips: clamp(0.45 + 0.5 * c.style.edge, 0, 1) });
  let y = 0;
  let side = r.chance(0.5);
  for (let k = 0; k < n; k++) {
    const fw = r.range(0.5, 0.78);
    const fd = r.range(0.5, 0.78);
    const w = rw(L) * (k === 0 ? Math.min(fw, 0.6) : fw);
    const d = rd(L) * (k === 0 ? Math.min(fd, 0.6) : fd);
    // alternate the shove so each box hangs over the last
    const tx = side ? r.range(0.75, 1) : r.range(0, 0.25);
    const tz = r.chance(0.5) ? r.range(0.7, 1) : r.range(0, 0.3);
    const x0 = lerp(L.x0, L.x1 - w, tx);
    const z0 = lerp(L.z0, L.z1 - d, tz);
    const rect: Rect = { x0, z0, x1: x0 + w, z1: z0 + d };
    const poly = rectPoly(rect);
    // light lines on every box, glowing fins only on the top one
    const t = tier(poly, y, y + bh, { ...fac, seed: fac.seed + k * 0.19, strips: k === n - 1 ? fac.strips : Math.min(fac.strips, 0.72) }, k === n - 1 ? (r.chance(0.5) ? 'helipad' : 'garden') : 'garden', k === 0, k === 0 ? frontEdges(poly, lot, 12) : [], k === 0 ? 5 : 0);
    out.push(k === 0 ? t : over(t));
    y += bh;
    side = !side;
  }
};

/** A tower of square floors plates, each turned a few degrees from the last. */
const twist: Builder = (lot, c, out, prof) => {
  const r = c.r;
  const R = inset(lot.rect, r.range(2, 5));
  const side = Math.min(rw(R), rd(R));
  if (side < 26) return fallback(lot, c, out, prof);
  const cx = (R.x0 + R.x1) / 2;
  const cz = (R.z0 + R.z1) / 2;
  let H = pickHeight(c, prof.height, 1.0) * 1.15;
  if (r.chance(prof.spike.p * 2)) H = r.range(prof.spike.h[0], prof.spike.h[1]) * c.hmul;
  // a turned square must stay inside the lot: corner radius <= side / 2
  const half0 = (side / 2) * 0.68;
  const th = r.range(9, 16);
  const n = Math.max(4, Math.floor(H / th));
  const step = r.range(0.05, 0.11) * r.sign();
  const fac = makeFacade(c, r.chance(0.65) ? 'glass' : 'panel', { strips: clamp(0.5 + 0.4 * c.style.flash, 0, 1) });
  for (let k = 0; k < n; k++) {
    const half = half0 * (1 - 0.22 * (k / n));
    const poly = squarePoly(cx, cz, half, k * step);
    // only the crown plate carries light lines; on every plate they would stripe the tower white
    const t = tier(poly, k * th, (k + 1) * th, { ...fac, seed: fac.seed + k * 0.03, strips: k === n - 1 ? fac.strips : Math.min(fac.strips, 0.25) }, k === n - 1 ? 'crown' : 'flat', k === 0, k === 0 ? frontEdges(poly, lot, 14) : [], k === 0 ? 5.5 : 0);
    out.push(k === 0 ? t : over(t));
  }
};

/** A slim core holding one or two wide discs: sky platforms with lit undersides. */
const disc: Builder = (lot, c, out, prof) => {
  const r = c.r;
  const R = inset(lot.rect, r.range(1.5, 3));
  const side = Math.min(rw(R), rd(R));
  if (side < 36) return fallback(lot, c, out, prof);
  const cx = (R.x0 + R.x1) / 2;
  const cz = (R.z0 + R.z1) / 2;
  const H = Math.max(80, pickHeight(c, prof.height, 1.0));
  const core = regularPoly(cx, cz, side * 0.17, 8, Math.PI / 8);
  const coreFac = makeFacade(c, 'glass', { lit: 0.7 });
  const discs = r.chance(0.4) ? 2 : 1;
  let y = 0;
  for (let k = 0; k < discs; k++) {
    const dy = k === discs - 1 ? H : H * r.range(0.45, 0.65);
    const dh = r.range(7, 11);
    const coreTop = dy - dh;
    out.push(tier(core, y, coreTop, { ...coreFac, seed: coreFac.seed + k }, 'flat', y === 0, y === 0 ? frontEdges(core, lot, side) : [], y === 0 ? 6 : 0));
    const rad = side * (k === discs - 1 ? 0.48 : 0.36);
    const flat = k === discs - 1 && r.chance(0.5);
    out.push(over(tier(regularPoly(cx, cz, rad, 24), coreTop, dy, makeFacade(c, 'panel', { strips: 1, win: 0.5, lit: 0.75 }), flat ? 'helipad' : 'garden', false)));
    y = dy;
  }
  if (r.chance(0.6)) out.push(tier(regularPoly(cx, cz, side * 0.09, 8, Math.PI / 8), y, y + r.range(12, 30), makeFacade(c, 'glass', { strips: 1 }), 'crown', false));
};

/** Narrow shaft flaring into a wide head: an inverted pyramid on a stalk. */
const flare: Builder = (lot, c, out, prof) => {
  const r = c.r;
  const R = inset(lot.rect, r.range(1.5, 3));
  const side = Math.min(rw(R), rd(R));
  if (side < 30) return fallback(lot, c, out, prof);
  const cx = (R.x0 + R.x1) / 2;
  const cz = (R.z0 + R.z1) / 2;
  const H = Math.max(70, pickHeight(c, prof.height, 1.0));
  const b0 = side * 0.2;
  const b1 = side * 0.47;
  const f0 = H * r.range(0.3, 0.55);
  const f1 = Math.min(H - 10, f0 + (b1 - b0) * r.range(1.4, 2.4));
  const shaft = squarePoly(cx, cz, b0);
  out.push(tier(shaft, 0, f0, makeFacade(c, 'glass', { lit: 0.7 }), 'flat', true, frontEdges(shaft, lot, side), 6));
  out.push(tapered(shaft, squarePoly(cx, cz, b1), f0, f1, makeFacade(c, 'panel', { strips: clamp(0.6 + 0.4 * c.style.edge, 0, 1) }), 'flat'));
  out.push(tier(squarePoly(cx, cz, b1), f1, H, makeFacade(c, 'glass', { strips: clamp(0.4 + 0.5 * c.style.edge, 0, 1) }), r.chance(0.5) ? 'helipad' : 'crown', false));
};

/** Two towers bridged by a mass across the top: a gate. */
const arch: Builder = (lot, c, out, prof) => {
  const r = c.r;
  const R = inset(lot.rect, r.range(2, 4));
  const alongX = rw(R) >= rd(R);
  const long = Math.max(rw(R), rd(R));
  const short = Math.min(rw(R), rd(R));
  if (long < 64 || short < 22) return fallback(lot, c, out, prof);
  const H = Math.max(90, pickHeight(c, prof.height, 1.0) * 1.1);
  const span = r.range(16, 30);
  const legW = long * r.range(0.2, 0.28);
  const depth = short * r.range(0.75, 1);
  const off = (short - depth) / 2;
  const fac = makeFacade(c, r.chance(0.6) ? 'glass' : 'panel', { strips: clamp(0.5 + 0.4 * c.style.edge, 0, 1) });
  const legA: Rect = alongX ? { x0: R.x0, x1: R.x0 + legW, z0: R.z0 + off, z1: R.z1 - off } : { x0: R.x0 + off, x1: R.x1 - off, z0: R.z0, z1: R.z0 + legW };
  const legB: Rect = alongX ? { x0: R.x1 - legW, x1: R.x1, z0: R.z0 + off, z1: R.z1 - off } : { x0: R.x0 + off, x1: R.x1 - off, z0: R.z1 - legW, z1: R.z1 };
  for (const leg of [legA, legB]) {
    const p = rectPoly(leg);
    out.push(tier(p, 0, H - span, { ...fac, seed: fac.seed + leg.x0 * 0.001 }, 'flat', true, frontEdges(p, lot, 10), 6));
  }
  const top: Rect = alongX ? { ...R, z0: legA.z0, z1: legA.z1 } : { ...R, x0: legA.x0, x1: legA.x1 };
  out.push(over(tier(rectPoly(top), H - span, H, makeFacade(c, 'panel', { strips: 1, lit: 0.7 }), r.chance(0.5) ? 'helipad' : 'crown', false)));
};

/** A slab lifted on pylons over an open ground floor. */
const stilts: Builder = (lot, c, out, prof) => {
  const r = c.r;
  const R = inset(lot.rect, r.range(2, 5));
  if (!ok(R, 28)) return swap('megablock', c)(lot, c, out, prof);
  const y0 = r.range(14, 28);
  const H = Math.max(y0 + 24, pickHeight(c, prof.height, 1.0));
  const nx = rw(R) > 60 ? 4 : 3;
  const nz = rd(R) > 60 ? 3 : 2;
  const leg = r.range(3, 5);
  const legFac = makeFacade(c, 'raw', { lit: 0.05 });
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nz; j++) {
      const x = lerp(R.x0 + leg, R.x1 - leg, i / (nx - 1));
      const z = lerp(R.z0 + leg, R.z1 - leg, j / (nz - 1));
      out.push(tier(rectPoly({ x0: x - leg / 2, x1: x + leg / 2, z0: z - leg / 2, z1: z + leg / 2 }), 0, y0, legFac, 'flat', true));
    }
  // a glass lobby core under the slab
  const core = inset(R, Math.min(rw(R), rd(R)) * 0.34);
  if (ok(core, 6)) {
    const p = rectPoly(core);
    out.push(tier(p, 0, y0, makeFacade(c, 'glass', { lit: 0.9 }), 'flat', true, frontEdges(p, lot, 40), y0 > 10 ? 6 : 0));
  }
  out.push(over(tier(rectPoly(R), y0, H, makeFacade(c, r.chance(0.6) ? 'balcony' : 'grid'), r.chance(0.4) ? 'garden' : 'flat', false)));
};

const BUILDERS: Record<Archetype, Builder> = { tower, monolith, needle, podium, shophouse, midrise, megablock, shed, tankfarm, ruin, shack, villa, spire, arcology, pyramid, ziggurat, taper, cantilever, twist, disc, flare, arch, stilts };

const PREMIUM: ReadonlySet<Archetype> = new Set(['tower', 'monolith', 'needle', 'podium', 'spire', 'villa', 'arcology', 'pyramid', 'taper', 'cantilever', 'twist', 'disc', 'flare', 'arch']);
const DERELICT: ReadonlySet<Archetype> = new Set(['ruin', 'shack']);

/** Archetype multipliers per land use (archetypes not listed keep 1, or `rest`). */
const USE_ARCH: Record<LandUse, { m: Partial<Record<Archetype, number>>; rest: number; add?: Partial<Record<Archetype, number>> }> = {
  residential: { m: { midrise: 1.7, megablock: 1.4, villa: 1.6, arcology: 1.2, shophouse: 0.9, tower: 0.7, monolith: 0.3, needle: 0.3, podium: 0.3, shed: 0.15, tankfarm: 0.1 }, rest: 1 },
  commercial: { m: { podium: 1.5, tower: 1.25, shophouse: 1.3, midrise: 0.9, megablock: 0.7, villa: 0.4, shed: 0.5 }, rest: 1 },
  nightlife: { m: { shophouse: 2.0, podium: 1.2, midrise: 1.0, spire: 0.5 }, rest: 0.3, add: { shophouse: 0.35 } },
  industrial: { m: { shed: 3.0, tankfarm: 2.0, ruin: 1.0 }, rest: 0.35, add: { shed: 0.7, tankfarm: 0.15 } },
  civic: { m: { podium: 2.5, monolith: 1.3 }, rest: 0.5, add: { podium: 0.5 } },
  green: { m: {}, rest: 1 },
};

/** Heights for an archetype a district borrows from another kind's table. */
const BORROWED: Partial<Record<Archetype, DistrictKind>> = { shed: 'industrial', tankfarm: 'industrial', shophouse: 'jpmarket' };

/** Megastructure archetypes, scaled by the alien dial. */
const ALIEN: ReadonlySet<Archetype> = new Set(['pyramid', 'ziggurat', 'taper', 'cantilever', 'twist', 'disc', 'flare', 'arch', 'stilts']);

/** Smallest lot (short side, long side) each megastructure needs; smaller lots never pick it. */
const FITS: Partial<Record<Archetype, [number, number]>> = {
  pyramid: [70, 70],
  ziggurat: [54, 54],
  taper: [38, 38],
  cantilever: [32, 32],
  twist: [36, 36],
  disc: [42, 42],
  flare: [36, 36],
  arch: [30, 72],
  stilts: [38, 38],
};

/** What a megastructure lot (a whole block) becomes, per district kind. */
const MEGA_W: Record<DistrictKind, Partial<Record<Archetype, number>>> = {
  corporate: { pyramid: 0.8, taper: 1.2, twist: 1.2, cantilever: 1.0, disc: 0.8, flare: 0.8, arch: 0.9 },
  megablock: { ziggurat: 1.5, stilts: 1.2, arch: 1.0, cantilever: 0.7, disc: 0.4 },
  luxury: { cantilever: 1.2, disc: 1.2, twist: 0.8, taper: 0.6, flare: 0.5 },
  jpmarket: { ziggurat: 1.0, stilts: 0.8, cantilever: 0.6 },
  cnmarket: { ziggurat: 1.0, stilts: 1.0, cantilever: 0.5 },
  industrial: { stilts: 1.0, arch: 0.6, ziggurat: 0.4 },
  decayed: { ziggurat: 0.6, stilts: 0.6 },
};

function pickMega(r: Rng, kind: DistrictKind, lot: Rect, s: Style): Archetype | null {
  const short = Math.min(rw(lot), rd(lot));
  const long = Math.max(rw(lot), rd(lot));
  // the edge dial (neomilitarism) turns some of these blocks into sheer monoliths
  const table: Partial<Record<Archetype, number>> = { ...MEGA_W[kind] };
  if (kind === 'corporate' || kind === 'megablock') table.monolith = 1.8 * s.edge * s.edge;
  if (table.pyramid) table.pyramid *= 0.6 + s.edge;
  if (table.disc) table.disc *= 0.6 + s.luxury;
  const keys = (Object.keys(table) as Archetype[]).filter((k) => {
    const fit = FITS[k];
    return !fit || (short >= fit[0] && long >= fit[1]);
  });
  if (keys.length === 0) return null;
  return r.weighted(keys, keys.map((k) => table[k] ?? 0));
}

function pickArchetype(r: Rng, base: Partial<Record<Archetype, number>>, s: Style, tn: DistrictTune, use: LandUse, alien: number, lot: Rect): Archetype {
  const short = Math.min(rw(lot), rd(lot));
  const long = Math.max(rw(lot), rd(lot));
  // decay brings ruins and shacks into any district; budget favours its premium types
  const weights: Partial<Record<Archetype, number>> = { ...base };
  const total = Object.values(base).reduce((a, b) => a + (b ?? 0), 0);
  const ua = USE_ARCH[use];
  for (const [k, v] of Object.entries(ua.add ?? {}) as [Archetype, number][]) weights[k] = (weights[k] ?? 0) + total * v;
  for (const k of Object.keys(weights) as Archetype[]) weights[k] = (weights[k] ?? 0) * (ua.m[k] ?? ua.rest);
  if (tn.decay > 0) {
    weights.ruin = (weights.ruin ?? 0) + total * tn.decay * 0.4;
    weights.shack = (weights.shack ?? 0) + total * tn.decay * 0.18;
  }
  const keys = Object.keys(weights) as Archetype[];
  const w = keys.map((k) => {
    let v = weights[k] ?? 0;
    if (PREMIUM.has(k)) v *= tuneMul(tn.budget, 2.2);
    if (ALIEN.has(k)) v *= Math.pow(alien * 2, 1.4);
    const fit = FITS[k];
    if (fit && (short < fit[0] || long < fit[1])) v = 0;
    if (DERELICT.has(k)) v *= tuneMul(-tn.budget, 2.0);
    if (k === 'monolith') v *= 0.4 + 2.2 * s.edge;
    if (k === 'tower') v *= 0.8 + 0.6 * s.edge;
    if (k === 'spire' || k === 'villa') v *= 0.4 + 1.6 * s.luxury;
    if (k === 'ruin' || k === 'shack') v *= 0.3 + 1.8 * s.grime;
    if (k === 'podium') v *= 0.6 + 1.2 * s.flash;
    return v;
  });
  return r.weighted(keys, w);
}

const NIGHT_PALETTE = [0xff2a8a, 0xff3048, 0xb04bff, 0xffb02e, 0x29e6ff, 0xff5ad2] as const;

function buildingPalette(r: Rng, district: District, s: Style): RGB[] {
  const out: RGB[] = [];
  for (let k = 0; k < 3; k++) {
    const pull = [
      ['edge', s.edge * 0.55],
      ['flash', s.flash * 0.5],
      ['luxury', s.luxury * 0.55],
      ['grime', s.grime * 0.4],
    ] as const;
    let best: (typeof pull)[number] | null = null;
    for (const p of pull) if (r.next() < p[1] * 0.6 && (!best || p[1] > best[1])) best = p;
    if (best) {
      const pal = STYLE_PALETTES[best[0]];
      out.push(lightColor(pal[r.int(pal.length)] as number));
    } else out.push(district.palette[r.int(district.palette.length)] ?? [1, 1, 1]);
  }
  return out;
}

export function makeBuildings(z: Zoning, lots: readonly Lot[], rng: Rng, hmul: number, structures: Structure[], alien = 0.5): Building[] {
  const out: Building[] = [];
  for (const lot of lots) {
    const r = rng.fork('b' + lot.key);
    const L = lot.rect;
    const cx = (L.x0 + L.x1) / 2;
    const cz = (L.z0 + L.z1) / 2;
    const own = z.districts[lot.district] as District;
    const bl = blendAt(z, cx, cz);
    const other = bl.other >= 0 ? (z.districts[bl.other] as District) : null;
    const useOther = other !== null && r.next() < bl.t;
    const src = useOther ? (other as District) : own;
    const prof = PROFILES[src.kind];
    let style = other ? blendStyle(own.style, other.style, bl.t) : own.style;
    const j = (v: number): number => clamp(v + r.range(-0.08, 0.08), 0, 1);
    style = { ...style, grime: j(style.grime), edge: j(style.edge), flash: j(style.flash), luxury: j(style.luxury) };
    const tune = src.tune;
    const use = lot.use;
    const arch: Archetype = lot.landmark === 'pyramid' ? 'pyramid' : (lot.mega ? pickMega(r, src.kind, L, style) : null) ?? pickArchetype(r, prof.archetypes, style, tune, use, alien, L);
    const archProf = prof.archetypes[arch] === undefined && BORROWED[arch] ? PROFILES[BORROWED[arch] as DistrictKind] : prof;
    const wallHex = prof.walls[r.int(prof.walls.length)] as number;
    let wall = hexToLinear(wallHex);
    // nightlife walls run darker so the neon carries the street
    const k = (1 - 0.25 * style.grime) * (lot.use === 'nightlife' ? 0.55 : 1);
    wall = [wall[0] * k, wall[1] * k * 0.98, wall[2] * k * 0.95];
    const palette = buildingPalette(r, src, style);
    if (use === 'nightlife') {
      // hot pinks, reds and violets for the strip
      for (let k = 0; k < 2; k++) palette[k] = lightColor(NIGHT_PALETTE[r.int(NIGHT_PALETTE.length)] as number);
    }
    const tiers: Tier[] = [];
    // tuned scale: 0.55x .. 1.8x the district's heights
    const useH = use === 'nightlife' ? 0.75 : use === 'civic' ? 0.9 : 1;
    const c: Ctx = { r, style, tune, use, wall, palette, hmul: hmul * tuneMul(tune.scale, 1.8) * useH, structures, seed: r.next() };
    BUILDERS[arch](lot, c, tiers, archProf);
    if (tiers.length === 0) continue;
    let height = 0;
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const t of tiers) {
      height = Math.max(height, t.y1);
      for (const [x, zz] of t.poly) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        z0 = Math.min(z0, zz);
        z1 = Math.max(z1, zz);
      }
    }
    out.push({
      id: out.length,
      lot: lot.id,
      district: src.id,
      kind: src.kind,
      archetype: c.built ?? arch,
      use: lot.use,
      rect: { x0, z0, x1, z1 },
      height,
      tiers,
      style,
      culture: dominantCulture(style, r.next()),
      palette,
      seed: c.seed,
    });
  }
  return out;
}
