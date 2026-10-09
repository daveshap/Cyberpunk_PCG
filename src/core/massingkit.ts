/**
 * Shared pieces of the massing grammars: the builder context, facade descriptions,
 * tier constructors and small polygon helpers. Used by the archetype builders in
 * massing.ts and the shaped towers in forms.ts.
 */
import type { Archetype, Facade, FacadeStyle, LandUse, Lot, RGB, Rect, RoofKind, Structure, Style, DistrictTune, Tier, Vec2 } from './types';
import { regularPoly } from './geom2d';
import { Rng, clamp, lerp } from './rng';

export interface Ctx {
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
  /** Building for the hive: kilometre-scale towers on whole blocks. */
  hive?: boolean;
}

export const FLOOR_H: Record<FacadeStyle, number> = { glass: 4.0, panel: 4.2, grid: 3.3, shop: 3.4, balcony: 3.0, metal: 6.0, raw: 3.2, lux: 3.8 };
export const BAY_W: Record<FacadeStyle, [number, number]> = {
  glass: [1.4, 2.0],
  panel: [2.6, 4.2],
  grid: [2.4, 3.4],
  shop: [2.6, 4.0],
  balcony: [3.0, 4.2],
  metal: [4.0, 7.0],
  raw: [2.8, 3.8],
  lux: [2.2, 3.2],
};

export function rectPoly(r: Rect): Vec2[] {
  return [
    [r.x0, r.z0],
    [r.x1, r.z0],
    [r.x1, r.z1],
    [r.x0, r.z1],
  ];
}

export function inset(r: Rect, d: number): Rect {
  return { x0: r.x0 + d, x1: r.x1 - d, z0: r.z0 + d, z1: r.z1 - d };
}

export function insetSides(r: Rect, l: number, rr: number, t: number, b: number): Rect {
  return { x0: r.x0 + l, x1: r.x1 - rr, z0: r.z0 + t, z1: r.z1 - b };
}

export function ok(r: Rect, min = 3): boolean {
  return r.x1 - r.x0 >= min && r.z1 - r.z0 >= min;
}

export function rw(r: Rect): number {
  return r.x1 - r.x0;
}
export function rd(r: Rect): number {
  return r.z1 - r.z0;
}

/** Edges of `poly` that face a street side of the lot (within `maxDist` of it). */
export function frontEdges(poly: readonly Vec2[], lot: Lot, maxDist: number): number[] {
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

export function mix3(a: RGB, b: RGB, t: number): RGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function makeFacade(c: Ctx, style: FacadeStyle, o: Partial<Facade> = {}): Facade {
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
  // a kilometre wall of windows reads as noise if half of them burn: the hive sleeps more
  if (c.hive) lit *= 0.6;
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

export function tier(poly: Vec2[], y0: number, y1: number, facade: Facade, roof: RoofKind, grounded: boolean, shopEdges: number[] = [], shopH = 0): Tier {
  return { poly, y0, y1, facade, roof, grounded, shopEdges, shopH };
}

export function pickHeight(c: Ctx, range: [number, number], skew = 1.6): number {
  const t = Math.pow(c.r.next(), skew);
  return lerp(range[0], range[1], t) * c.hmul;
}

export function snapFloors(h: number, fh: number): number {
  return Math.max(fh, Math.round(h / fh) * fh);
}

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

export function squarePoly(cx: number, cz: number, half: number, rot = 0): Vec2[] {
  return regularPoly(cx, cz, half * Math.SQRT2, 4, Math.PI / 4 + rot);
}

export function tapered(poly: Vec2[], top: Vec2[], y0: number, y1: number, facade: Facade, roof: RoofKind, under = false): Tier {
  const t = tier(poly, y0, y1, facade, roof, false);
  t.top = top;
  if (under) t.under = true;
  return t;
}

export function over(t: Tier): Tier {
  t.under = true;
  return t;
}

