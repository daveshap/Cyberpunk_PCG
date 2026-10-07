/**
 * MeshBuilder: accumulates vertices with named extra attributes into typed
 * arrays and produces a BufferGeometry. Extra attributes use "current value"
 * semantics (set once, applies to every following vertex) to keep the per-vertex
 * call cheap when generating a few hundred thousand vertices at startup.
 */
import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three';

class Grow {
  data: Float32Array;
  len = 0;
  constructor(readonly size: number, cap = 1024) {
    this.data = new Float32Array(cap * size);
  }
  reserve(n: number): void {
    const need = (this.len + n) * this.size;
    if (need > this.data.length) {
      const next = new Float32Array(Math.max(need, this.data.length * 2));
      next.set(this.data);
      this.data = next;
    }
  }
  get count(): number {
    return this.len;
  }
}

export class MeshBuilder {
  private readonly pos = new Grow(3);
  private readonly nor = new Grow(3);
  private readonly uv = new Grow(2);
  private idx: Uint32Array = new Uint32Array(4096);
  private idxLen = 0;
  private readonly extras: { name: string; grow: Grow; cur: Float32Array }[] = [];
  private readonly extraMap = new Map<string, Float32Array>();
  private readonly needsUV: boolean;
  private readonly needsNor: boolean;

  constructor(extras: Record<string, number> = {}, opts: { uv?: boolean; normals?: boolean } = {}) {
    this.needsUV = opts.uv ?? true;
    this.needsNor = opts.normals ?? true;
    for (const [name, size] of Object.entries(extras)) {
      const cur = new Float32Array(size);
      this.extras.push({ name, grow: new Grow(size), cur });
      this.extraMap.set(name, cur);
    }
  }

  get vertexCount(): number {
    return this.pos.len;
  }
  get triangleCount(): number {
    return this.idxLen / 3;
  }
  get isEmpty(): boolean {
    return this.idxLen === 0;
  }

  /** Appends another builder's vertices and indices (same extras layout). */
  append(o: MeshBuilder): void {
    const base = this.pos.len;
    this.pos.reserve(o.pos.len);
    this.pos.data.set(o.pos.data.subarray(0, o.pos.len * 3), base * 3);
    this.pos.len += o.pos.len;
    if (this.needsNor) {
      this.nor.reserve(o.nor.len);
      this.nor.data.set(o.nor.data.subarray(0, o.nor.len * 3), base * 3);
      this.nor.len += o.nor.len;
    }
    if (this.needsUV) {
      this.uv.reserve(o.uv.len);
      this.uv.data.set(o.uv.data.subarray(0, o.uv.len * 2), base * 2);
      this.uv.len += o.uv.len;
    }
    for (let k = 0; k < this.extras.length; k++) {
      const e = this.extras[k]!;
      const f = o.extras[k]!;
      e.grow.reserve(f.grow.len);
      e.grow.data.set(f.grow.data.subarray(0, f.grow.len * f.grow.size), base * e.grow.size);
      e.grow.len += f.grow.len;
    }
    for (let i = 0; i < o.idxLen; i += 3) this.tri((o.idx[i] as number) + base, (o.idx[i + 1] as number) + base, (o.idx[i + 2] as number) + base);
  }

  /** Read-only view of the triangle indices (tests and tooling). */
  get indices(): Uint32Array {
    return this.idx.subarray(0, this.idxLen);
  }
  get positions(): Float32Array {
    return this.pos.data.subarray(0, this.pos.len * 3);
  }

  /** Current-value array for an extra attribute; write into it before adding vertices. */
  cur(name: string): Float32Array {
    return this.extraMap.get(name) as Float32Array;
  }

  /** Overwrite an extra attribute on every vertex added so far (and make it the current value). */
  fill(name: string, a: number, b = 0, c = 0, d = 0): void {
    this.set(name, a, b, c, d);
    const e = this.extras.find((x) => x.name === name);
    if (!e) return;
    const s = e.grow.size;
    const vals = [a, b, c, d];
    for (let i = 0; i < e.grow.len; i++) for (let k = 0; k < s; k++) e.grow.data[i * s + k] = vals[k] as number;
  }

  set(name: string, a: number, b = 0, c = 0, d = 0): void {
    const cur = this.extraMap.get(name) as Float32Array;
    cur[0] = a;
    if (cur.length > 1) cur[1] = b;
    if (cur.length > 2) cur[2] = c;
    if (cur.length > 3) cur[3] = d;
  }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, v = 0): number {
    const i = this.pos.len;
    this.pos.reserve(1);
    if (this.needsNor) this.nor.reserve(1);
    if (this.needsUV) this.uv.reserve(1);
    const p = this.pos.data;
    p[i * 3] = x;
    p[i * 3 + 1] = y;
    p[i * 3 + 2] = z;
    if (this.needsNor) {
      const n = this.nor.data;
      n[i * 3] = nx;
      n[i * 3 + 1] = ny;
      n[i * 3 + 2] = nz;
      this.nor.len = i + 1;
    }
    if (this.needsUV) {
      const t = this.uv.data;
      t[i * 2] = u;
      t[i * 2 + 1] = v;
      this.uv.len = i + 1;
    }
    for (const e of this.extras) {
      e.grow.reserve(1);
      const s = e.grow.size;
      const d = e.grow.data;
      for (let k = 0; k < s; k++) d[i * s + k] = e.cur[k] as number;
      e.grow.len = i + 1;
    }
    this.pos.len = i + 1;
    return i;
  }

  tri(a: number, b: number, c: number): void {
    if (this.idxLen + 3 > this.idx.length) {
      const next = new Uint32Array(this.idx.length * 2);
      next.set(this.idx);
      this.idx = next;
    }
    this.idx[this.idxLen++] = a;
    this.idx[this.idxLen++] = b;
    this.idx[this.idxLen++] = c;
  }

  /** Quad with vertices given counter-clockwise as seen from the front. */
  quad(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    const n = this.pos.len;
    g.setAttribute('position', new BufferAttribute(this.pos.data.slice(0, n * 3), 3));
    if (this.needsNor) g.setAttribute('normal', new BufferAttribute(this.nor.data.slice(0, n * 3), 3));
    if (this.needsUV) g.setAttribute('uv', new BufferAttribute(this.uv.data.slice(0, n * 2), 2));
    for (const e of this.extras) g.setAttribute(e.name, new BufferAttribute(e.grow.data.slice(0, n * e.grow.size), e.grow.size));
    g.setIndex(new BufferAttribute(this.idx.slice(0, this.idxLen), 1));
    // bounding sphere from positions
    const v = new Vector3();
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    const p = this.pos.data;
    for (let i = 0; i < n; i++) {
      v.set(p[i * 3] as number, p[i * 3 + 1] as number, p[i * 3 + 2] as number);
      min.min(v);
      max.max(v);
    }
    const c = min.clone().add(max).multiplyScalar(0.5);
    g.boundingSphere = new Sphere(c, n > 0 ? c.distanceTo(max) + 0.01 : 0);
    return g;
  }
}

/** Axis-aligned or Y-rotated box with flat normals. `emit` may be called per face. */
export function addBox(
  b: MeshBuilder,
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  rotY = 0,
  opts: { skipBottom?: boolean; skipTop?: boolean; uvScale?: number } = {},
): void {
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const P = (lx: number, ly: number, lz: number): [number, number, number] => [cx + lx * c - lz * s, cy + ly, cz + lx * s + lz * c];
  const N = (lx: number, ly: number, lz: number): [number, number, number] => [lx * c - lz * s, ly, lx * s + lz * c];
  const face = (n: [number, number, number], corners: [number, number, number][], uv: [number, number][]): void => {
    const nn = N(n[0], n[1], n[2]);
    const ids = corners.map((q, i) => {
      const p = P(q[0], q[1], q[2]);
      return b.vert(p[0], p[1], p[2], nn[0], nn[1], nn[2], (uv[i] as [number, number])[0], (uv[i] as [number, number])[1]);
    });
    b.quad(ids[0] as number, ids[1] as number, ids[2] as number, ids[3] as number);
  };
  const us = opts.uvScale ?? 1;
  // +x
  face([1, 0, 0], [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]], [[0, 0], [sz * us, 0], [sz * us, sy * us], [0, sy * us]]);
  // -x
  face([-1, 0, 0], [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]], [[0, 0], [sz * us, 0], [sz * us, sy * us], [0, sy * us]]);
  // +z
  face([0, 0, 1], [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]], [[0, 0], [sx * us, 0], [sx * us, sy * us], [0, sy * us]]);
  // -z
  face([0, 0, -1], [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]], [[0, 0], [sx * us, 0], [sx * us, sy * us], [0, sy * us]]);
  if (!opts.skipTop) face([0, 1, 0], [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]], [[0, 0], [sx * us, 0], [sx * us, sz * us], [0, sz * us]]);
  if (!opts.skipBottom) face([0, -1, 0], [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]], [[0, 0], [sx * us, 0], [sx * us, sz * us], [0, sz * us]]);
}

/** Vertical cylinder (open sides + caps) with smooth side normals. */
export function addCylinder(b: MeshBuilder, cx: number, y0: number, cz: number, r0: number, r1: number, h: number, seg = 10, caps = true): void {
  const ring0: number[] = [];
  const ring1: number[] = [];
  const slope = (r0 - r1) / h;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const cs = Math.cos(a);
    const sn = Math.sin(a);
    const l = Math.hypot(1, slope);
    ring0.push(b.vert(cx + cs * r0, y0, cz + sn * r0, cs / l, slope / l, sn / l, i / seg, 0));
    ring1.push(b.vert(cx + cs * r1, y0 + h, cz + sn * r1, cs / l, slope / l, sn / l, i / seg, 1));
  }
  for (let i = 0; i < seg; i++) b.quad(ring0[i + 1] as number, ring0[i] as number, ring1[i] as number, ring1[i + 1] as number);
  if (caps && r1 > 0.001) {
    const c = b.vert(cx, y0 + h, cz, 0, 1, 0, 0.5, 0.5);
    const ids: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      ids.push(b.vert(cx + Math.cos(a) * r1, y0 + h, cz + Math.sin(a) * r1, 0, 1, 0, 0.5, 0.5));
    }
    for (let i = 0; i < seg; i++) b.tri(c, ids[i + 1] as number, ids[i] as number);
  }
}

/** Flat quad in a plane spanned by right and up vectors, facing `n`. Centre-based. */
export function addPlaneQuad(
  b: MeshBuilder,
  cx: number,
  cy: number,
  cz: number,
  rx: number,
  ry: number,
  rz: number,
  ux: number,
  uy: number,
  uz: number,
  w: number,
  h: number,
  u0 = 0,
  v0 = 0,
  u1 = 1,
  v1 = 1,
): void {
  // normal = right x up
  let nx = ry * uz - rz * uy;
  let ny = rz * ux - rx * uz;
  let nz = rx * uy - ry * ux;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l;
  ny /= l;
  nz /= l;
  const hw = w / 2;
  const hh = h / 2;
  const a = b.vert(cx - rx * hw - ux * hh, cy - ry * hw - uy * hh, cz - rz * hw - uz * hh, nx, ny, nz, u0, v0);
  const bb = b.vert(cx + rx * hw - ux * hh, cy + ry * hw - uy * hh, cz + rz * hw - uz * hh, nx, ny, nz, u1, v0);
  const c = b.vert(cx + rx * hw + ux * hh, cy + ry * hw + uy * hh, cz + rz * hw + uz * hh, nx, ny, nz, u1, v1);
  const d = b.vert(cx - rx * hw + ux * hh, cy - ry * hw + uy * hh, cz - rz * hw + uz * hh, nx, ny, nz, u0, v1);
  b.quad(a, bb, c, d);
}

/** Low-poly sphere / ellipsoid with smooth normals. */
export function addSphere(b: MeshBuilder, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, seg = 8, rings = 5): void {
  const ids: number[][] = [];
  for (let j = 0; j <= rings; j++) {
    const phi = (j / rings) * Math.PI;
    const y = Math.cos(phi);
    const rr = Math.sin(phi);
    const row: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const th = (i / seg) * Math.PI * 2;
      const x = rr * Math.cos(th);
      const z = rr * Math.sin(th);
      row.push(b.vert(cx + x * rx, cy + y * ry, cz + z * rz, x, y, z, i / seg, j / rings));
    }
    ids.push(row);
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const top = ids[j] as number[];
      const bot = ids[j + 1] as number[];
      b.quad(bot[i + 1] as number, bot[i] as number, top[i] as number, top[i + 1] as number);
    }
  }
}

/** Convex polygon (XZ, counter-clockwise in the mathematical sense) as an up-facing fan at height y. */
export function addPolyCap(b: MeshBuilder, poly: readonly [number, number][], y: number): void {
  const ids = poly.map((p) => b.vert(p[0], y, p[1], 0, 1, 0, p[0], p[1]));
  for (let i = 1; i < ids.length - 1; i++) b.tri(ids[0] as number, ids[i + 1] as number, ids[i] as number);
}

/** Downward-facing polygon cap (the underside of an overhang). */
export function addPolyCapDown(b: MeshBuilder, poly: readonly [number, number][], y: number): void {
  const ids = poly.map((p) => b.vert(p[0], y, p[1], 0, -1, 0, p[0], p[1]));
  for (let i = 1; i < ids.length - 1; i++) b.tri(ids[0] as number, ids[i] as number, ids[i + 1] as number);
}

/**
 * Roof or soffit cap of a convex polygon as a fan around its centroid, with
 * uv.x = distance to the nearest edge in metres (exact inside each fan
 * triangle), so edge lights and parapet glows follow any footprint shape.
 */
export function addRoofCap(b: MeshBuilder, poly: readonly [number, number][], y: number, down = false): void {
  const n = poly.length;
  if (n < 3) return;
  let cx = 0;
  let cz = 0;
  for (const p of poly) {
    cx += p[0];
    cz += p[1];
  }
  cx /= n;
  cz /= n;
  const ny = down ? -1 : 1;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const q = poly[(i + 1) % n]!;
    const ex = q[0] - a[0];
    const ez = q[1] - a[1];
    const len = Math.hypot(ex, ez);
    if (len < 1e-4) continue;
    const d = Math.abs((cx - a[0]) * ez - (cz - a[1]) * ex) / len;
    const ic = b.vert(cx, y, cz, 0, ny, 0, d, 1);
    const ia = b.vert(a[0], y, a[1], 0, ny, 0, 0, 0);
    const iq = b.vert(q[0], y, q[1], 0, ny, 0, 0, 0);
    if (down) b.tri(ic, ia, iq);
    else b.tri(ic, iq, ia);
  }
}

/**
 * Sloped wall between the bottom edge a->q at y0 and the top edge a2->q2 at y1
 * (a tapered or flared tier). uv stays metric: u along the bottom edge (so the top
 * corners land where they really are and windows keep their size), v = height
 * above y0. Returns the average along-edge inset per metre of height.
 */
export function addSlopedWall(b: MeshBuilder, a: readonly [number, number], q: readonly [number, number], a2: readonly [number, number], q2: readonly [number, number], y0: number, y1: number, nx: number, nz: number): number {
  const len = Math.hypot(q[0] - a[0], q[1] - a[1]) || 1;
  const tx = (q[0] - a[0]) / len;
  const tz = (q[1] - a[1]) / len;
  const ua2 = (a2[0] - a[0]) * tx + (a2[1] - a[1]) * tz;
  const uq2 = (q2[0] - a[0]) * tx + (q2[1] - a[1]) * tz;
  // face normal from the slant: outward horizontal normal tilted by the inset
  const h = y1 - y0;
  const midIn = ((a2[0] + q2[0]) / 2 - (a[0] + q[0]) / 2) * nx + ((a2[1] + q2[1]) / 2 - (a[1] + q[1]) / 2) * nz;
  const inward = -midIn;
  const nl = Math.hypot(h, inward) || 1;
  const fx = (nx * h) / nl;
  const fy = inward / nl;
  const fz = (nz * h) / nl;
  const p0 = b.vert(q[0], y0, q[1], fx, fy, fz, len, 0);
  const p1 = b.vert(a[0], y0, a[1], fx, fy, fz, 0, 0);
  const p2 = b.vert(a2[0], y1, a2[1], fx, fy, fz, ua2, h);
  const p3 = b.vert(q2[0], y1, q2[1], fx, fy, fz, uq2, h);
  b.quad(p0, p1, p2, p3);
  return h > 0 ? (ua2 + (len - uq2)) / 2 / h : 0;
}

/** Vertical wall quad along the polygon edge a->b (outward normal n), spanning y0..y1. uv = (metres along from a, y - yUv0). */
export function addWall(b: MeshBuilder, ax: number, az: number, bx: number, bz: number, y0: number, y1: number, nx: number, nz: number, uvY0 = 0): number {
  const len = Math.hypot(bx - ax, bz - az);
  // seen from outside the edge runs right-to-left, so the counter-clockwise order starts at b
  const p0 = b.vert(bx, y0, bz, nx, 0, nz, len, y0 - uvY0);
  const p1 = b.vert(ax, y0, az, nx, 0, nz, 0, y0 - uvY0);
  const p2 = b.vert(ax, y1, az, nx, 0, nz, 0, y1 - uvY0);
  const p3 = b.vert(bx, y1, bz, nx, 0, nz, len, y1 - uvY0);
  b.quad(p0, p1, p2, p3);
  return len;
}

/** Sets the current prop-material attributes: albedo (or emissive colour), emissive gain, specular, twinkle. */
export function setProp(b: MeshBuilder, r: number, g: number, bl: number, emissive = 0, spec = 0.25, twinkle = 0): void {
  b.set('aAlb', r, g, bl, emissive);
  b.set('aP', spec, twinkle);
}

export const PROP_EXTRAS = { aAlb: 4, aP: 2 };
