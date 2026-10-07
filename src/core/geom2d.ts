/** Small 2D geometry helpers (XZ plane). Pure functions, no allocation tricks. */
import type { Rect, Vec2 } from './types';

export function rectW(r: Rect): number {
  return r.x1 - r.x0;
}
export function rectD(r: Rect): number {
  return r.z1 - r.z0;
}
export function rectCx(r: Rect): number {
  return (r.x0 + r.x1) / 2;
}
export function rectCz(r: Rect): number {
  return (r.z0 + r.z1) / 2;
}

export function rectPoly(r: Rect): Vec2[] {
  return [
    [r.x0, r.z0],
    [r.x1, r.z0],
    [r.x1, r.z1],
    [r.x0, r.z1],
  ];
}

export function insetRect(r: Rect, xmin: number, xmax: number, zmin: number, zmax: number): Rect {
  return { x0: r.x0 + xmin, x1: r.x1 - xmax, z0: r.z0 + zmin, z1: r.z1 - zmax };
}

export function rectsOverlap(a: Rect, b: Rect, eps = 0): boolean {
  return a.x0 < b.x1 - eps && a.x1 > b.x0 + eps && a.z0 < b.z1 - eps && a.z1 > b.z0 + eps;
}

export function rectContains(outer: Rect, inner: Rect, eps = 1e-6): boolean {
  return inner.x0 >= outer.x0 - eps && inner.x1 <= outer.x1 + eps && inner.z0 >= outer.z0 - eps && inner.z1 <= outer.z1 + eps;
}

export function pointInRect(r: Rect, x: number, z: number): boolean {
  return x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
}

/** Shoelace area, positive when counter-clockwise (x right, z up). */
export function polyArea(p: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, z0] = p[i] as Vec2;
    const [x1, z1] = p[(i + 1) % p.length] as Vec2;
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

export function ensureCCW(p: Vec2[]): Vec2[] {
  return polyArea(p) < 0 ? p.slice().reverse() : p;
}

export function polyBounds(p: readonly Vec2[]): Rect {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const [x, z] of p) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { x0, z0, x1, z1 };
}

/** Regular n-gon, counter-clockwise. */
export function regularPoly(cx: number, cz: number, radius: number, n: number, rot = 0): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(a) * radius, cz + Math.sin(a) * radius]);
  }
  return out;
}

/** Rectangle of half sizes (hw, hd) rotated by rot around (cx, cz). */
export function rotatedRect(cx: number, cz: number, hw: number, hd: number, rot: number): Vec2[] {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const pts: Vec2[] = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ];
  return pts.map(([x, z]) => [cx + x * c - z * s, cz + x * s + z * c] as Vec2);
}

/** Rect with the chosen corners cut by `c` metres. Corner order: (x0,z0) (x1,z0) (x1,z1) (x0,z1). */
export function chamferRect(r: Rect, c: number, corners: [boolean, boolean, boolean, boolean]): Vec2[] {
  const out: Vec2[] = [];
  const { x0, z0, x1, z1 } = r;
  // corner 0 (x0,z0)
  if (corners[0]) out.push([x0, z0 + c], [x0 + c, z0]);
  else out.push([x0, z0]);
  // corner 1 (x1,z0)
  if (corners[1]) out.push([x1 - c, z0], [x1, z0 + c]);
  else out.push([x1, z0]);
  // corner 2 (x1,z1)
  if (corners[2]) out.push([x1, z1 - c], [x1 - c, z1]);
  else out.push([x1, z1]);
  // corner 3 (x0,z1)
  if (corners[3]) out.push([x0 + c, z1], [x0, z1 - c]);
  else out.push([x0, z1]);
  return out;
}

export function pointInConvex(p: readonly Vec2[], x: number, z: number): boolean {
  // polygon is counter-clockwise: point is inside if it is left of every edge
  for (let i = 0; i < p.length; i++) {
    const [x0, z0] = p[i] as Vec2;
    const [x1, z1] = p[(i + 1) % p.length] as Vec2;
    if ((x1 - x0) * (z - z0) - (z1 - z0) * (x - x0) < -1e-9) return false;
  }
  return true;
}

/** Outward unit normal of edge i of a counter-clockwise polygon. */
export function edgeNormal(p: readonly Vec2[], i: number): Vec2 {
  const [x0, z0] = p[i] as Vec2;
  const [x1, z1] = p[(i + 1) % p.length] as Vec2;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz) || 1;
  return [dz / len, -dx / len];
}

export function edgeLength(p: readonly Vec2[], i: number): number {
  const [x0, z0] = p[i] as Vec2;
  const [x1, z1] = p[(i + 1) % p.length] as Vec2;
  return Math.hypot(x1 - x0, z1 - z0);
}

export function snap(v: number, step: number): number {
  return Math.round(v / step) * step;
}
