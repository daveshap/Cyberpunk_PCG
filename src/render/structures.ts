// @ts-nocheck -- TSL node graphs are dynamically typed (prop material); geometry code below is plain TS.
/**
 * Relief and structures: everything that gives the walls real depth and the
 * skyline real silhouettes, mostly as kit-box instances:
 *  - per facade style: balcony slabs and railings, ledges, fins (some glowing),
 *    deep ribs, gold fins and cornices, parapets on every roof,
 *  - roof kinds: pagoda hip roofs, gardens, crown spires,
 *  - one-off structures: cranes, docks, skybridges, scaffolds, unfinished frames,
 *    pools, sawtooth roofs, awnings, overhead wires and lantern strings,
 *  - elevated highways: deck, barriers with light strips, pillars, lamps.
 * Sloped pieces (roofs, awnings, wires) go into a merged "prop" mesh.
 */
import * as THREE from 'three/webgpu';
import { Fn, attribute, faceDirection, normalWorld, normalize, positionWorld, vec4, float } from 'three/tsl';
import type { Building, CitySpec, Highway, RGB, Structure, Tier, Vec2 } from '../core/types';
import { Rng, clamp, hash01 } from '../core/rng';
import { MeshBuilder, setProp } from './geometry';
import { CLS, type Inst, type KitGeom, type LodClass } from './kits';
import { U, shade } from './tsl';

export type KitSink = (geom: KitGeom, lod: LodClass, i: Inst) => void;
export type BuilderFor = (x: number, z: number) => MeshBuilder;

export const PROP2_EXTRAS = { aAlb: 4, aP: 2 };

export function makePropMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'props';
  m.fog = false;
  m.side = THREE.DoubleSide;
  m.colorNode = Fn(() => {
    const A = attribute('aAlb', 'vec4');
    const P = attribute('aP', 'vec2');
    // two-sided: light the face we are looking at (a back face would otherwise
    // see ndv = 0 and turn into a full-strength mirror)
    const n = normalize(normalWorld).mul(faceDirection);
    const lit = shade(A.xyz, n, positionWorld, P.x, float(0.6));
    return vec4(lit.add(A.xyz.mul(A.w).mul(U.neon)), 1.0);
  })();
  return m;
}

function bx(K: KitSink, lod: LodClass, x: number, y: number, z: number, rot: number, sx: number, sy: number, sz: number, col: RGB, cls: number, seed: number, emit = 0, ecol: RGB = [0, 0, 0], mode = 0): void {
  K('box', lod, { x, y, z, rot, sx, sy, sz, emit, r: col[0], g: col[1], b: col[2], cs: cls + (Math.abs(seed) % 1) * 0.999, er: ecol[0], eg: ecol[1], eb: ecol[2], mode });
}

function edges(t: Tier, poly: readonly Vec2[] = t.poly): { a: Vec2; b: Vec2; nx: number; nz: number; len: number; mx: number; mz: number; rot: number }[] {
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i] as Vec2;
    const b = poly[(i + 1) % n] as Vec2;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.8) continue;
    const nx = dz / len;
    const nz = -dx / len;
    out.push({ a, b, nx, nz, len, mx: (a[0] + b[0]) / 2, mz: (a[1] + b[1]) / 2, rot: Math.atan2(nx, nz) });
  }
  return out;
}

function mul(c: RGB, k: number): RGB {
  return [c[0] * k, c[1] * k, c[2] * k];
}

// ---------------------------------------------------------------- relief
export function addRelief(b: Building, K: KitSink, propFor: BuilderFor): void {
  const r = new Rng(Math.floor(b.seed * 1e9) ^ 0x5bd1e995);
  for (const t of b.tiers) {
    const f = t.facade;
    const fh = f.floorH;
    const H = t.y1 - t.y0;
    const floors = Math.max(1, Math.floor(H / fh + 0.01));
    const base = f.base;
    const top = t.y1;
    const isTop = t.y1 >= b.height - 0.05;
    // sloped (tapered or flared) tiers: the roof is the top polygon, and wall
    // relief (ribs, balconies, fins) would not sit on the slope, so it is skipped
    const cap = t.top ?? t.poly;
    const E = edges(t);
    const seed = f.seed;
    const shopFloors = t.grounded && t.shopH > 0 ? Math.ceil(t.shopH / fh) : 0;
    // ---- parapets
    if (t.roof !== 'pagoda' && t.roof !== 'sawtooth') {
      const ph = f.style === 'glass' ? 1.4 : f.style === 'lux' ? 1.1 : 0.95;
      const pt = 0.32;
      const cls = f.style === 'glass' ? CLS.glass : CLS.concrete;
      for (const e of edges(t, cap)) bx(K, 'mid', e.mx - e.nx * pt * 0.5, top, e.mz - e.nz * pt * 0.5, e.rot, e.len + pt * 0.3, ph, pt, mul(base, 0.85), cls, seed);
    }
    switch (t.top ? 'sloped' : f.style) {
      case 'balcony': {
        const depth = 1.15;
        for (const e of E) {
          if (e.len < 5) continue;
          for (let k = Math.max(1, shopFloors); k < Math.min(floors, 80); k++) {
            const y = t.y0 + k * fh;
            bx(K, 'mid', e.mx + e.nx * (depth / 2 - 0.05), y - 0.1, e.mz + e.nz * (depth / 2 - 0.05), e.rot, e.len - 0.3, 0.2, depth, mul(base, 0.92), CLS.concrete, seed + k);
            const glassy = hash01(Math.floor(seed * 1e6), k, 3) < 0.5;
            bx(K, 'small', e.mx + e.nx * (depth - 0.06), y + 0.1, e.mz + e.nz * (depth - 0.06), e.rot, e.len - 0.3, 1.0, 0.05, glassy ? [0.3, 0.35, 0.38] : mul(base, 0.6), glassy ? CLS.glass : CLS.metal, seed + k * 0.37);
          }
        }
        break;
      }
      case 'grid':
      case 'shop':
      case 'raw': {
        const every = f.style === 'raw' ? 1 : floors > 14 ? 2 : 1;
        for (const e of E) {
          if (e.len < 3) continue;
          for (let k = Math.max(1, shopFloors); k < Math.min(floors, 60); k += every) {
            const y = t.y0 + k * fh;
            bx(K, 'small', e.mx + e.nx * 0.1, y - 0.08, e.mz + e.nz * 0.1, e.rot, e.len + 0.1, f.style === 'raw' ? 0.28 : 0.16, 0.24, mul(base, f.style === 'raw' ? 0.85 : 0.75), CLS.concrete, seed + k);
          }
        }
        break;
      }
      case 'glass': {
        const glowing = f.strips > 0.8;
        const stride = f.bayW * (glowing ? 4 : 2);
        for (const e of E) {
          const n = Math.floor(e.len / stride);
          for (let k = 1; k < n; k++) {
            const u = (k / n) * e.len;
            const tx = (e.b[0] - e.a[0]) / e.len;
            const tz = (e.b[1] - e.a[1]) / e.len;
            const x = e.a[0] + tx * u + e.nx * 0.25;
            const z = e.a[1] + tz * u + e.nz * 0.25;
            if (glowing) bx(K, 'mid', x, t.y0 + 1, z, e.rot, 0.14, H - 2, 0.5, [0.1, 0.1, 0.12], CLS.lightbox, seed + k, 0.7, mul(f.accent, 1), 0);
            else bx(K, 'mid', x, t.y0, z, e.rot, 0.12, H, 0.5, mul(base, 0.7), CLS.metal, seed + k);
          }
        }
        break;
      }
      case 'panel': {
        for (const e of E) {
          const n = Math.floor(e.len / (f.bayW * 3));
          for (let k = 1; k < n; k++) {
            const u = (k / n) * e.len;
            const tx = (e.b[0] - e.a[0]) / e.len;
            const tz = (e.b[1] - e.a[1]) / e.len;
            bx(K, 'mid', e.a[0] + tx * u + e.nx * 0.35, t.y0, e.a[1] + tz * u + e.nz * 0.35, e.rot, 0.5, H, 0.7, mul(base, 0.8), CLS.metal, seed + k);
          }
        }
        break;
      }
      case 'lux': {
        for (const e of E) {
          const n = Math.floor(e.len / (f.bayW * 2));
          for (let k = 0; k <= n; k++) {
            const u = (k / Math.max(1, n)) * e.len;
            const tx = (e.b[0] - e.a[0]) / e.len;
            const tz = (e.b[1] - e.a[1]) / e.len;
            bx(K, 'mid', e.a[0] + tx * u + e.nx * 0.18, t.y0, e.a[1] + tz * u + e.nz * 0.18, e.rot, 0.16, H, 0.36, [0.55, 0.38, 0.14], CLS.gold, seed + k);
          }
          bx(K, 'mid', e.mx + e.nx * 0.3, top - 0.6, e.mz + e.nz * 0.3, e.rot, e.len + 0.6, 0.6, 0.8, mul(base, 1.05), CLS.stone, seed);
        }
        break;
      }
      default:
        break;
    }
    // ---- roof kinds
    if (t.roof === 'pagoda') addPagoda(t, b, propFor, K, r);
    if (t.roof === 'garden' || (isTop && t.roof === 'flat' && b.style.luxury > 0.75 && r.chance(0.4))) {
      const xs = cap.map((p) => p[0]);
      const zs = cap.map((p) => p[1]);
      const x0 = Math.min(...xs) + 2;
      const x1 = Math.max(...xs) - 2;
      const z0 = Math.min(...zs) + 2;
      const z1 = Math.max(...zs) - 2;
      const n = Math.min(10, Math.floor(((x1 - x0) * (z1 - z0)) / 60));
      for (let k = 0; k < n; k++) {
        const x = x0 + (x1 - x0) * r.next();
        const z = z0 + (z1 - z0) * r.next();
        const s = r.range(0.35, 0.6);
        K('tree', 'small', { x, y: top, z, rot: r.range(0, 6.28), sx: s, sy: s, sz: s, emit: 0, r: 0.05, g: 0.1, b: 0.05, cs: CLS.foliage + r.next() * 0.99, er: 0, eg: 0, eb: 0, mode: 0 });
      }
    }
    if (isTop && t.roof === 'crown' && b.height > 120) {
      const cx = cap.reduce((a, p) => a + p[0], 0) / cap.length;
      const cz = cap.reduce((a, p) => a + p[1], 0) / cap.length;
      const h = clamp(b.height * 0.12, 12, 60);
      K('cyl', 'big', { x: cx, y: top, z: cz, rot: 0, sx: 0.8, sy: h, sz: 0.8, emit: 0, r: 0.2, g: 0.2, b: 0.22, cs: CLS.metal + 0.5, er: 0, eg: 0, eb: 0, mode: 0 });
      K('beacon', 'huge', { x: cx, y: top + h, z: cz, rot: 0, sx: 2.4, sy: 2.4, sz: 2.4, emit: 7, r: 0, g: 0, b: 0, cs: 0.3, er: 1, eg: 0.1, eb: 0.06, mode: 4 });
    }
  }
}

function addPagoda(t: Tier, b: Building, propFor: BuilderFor, K: KitSink, r: Rng): void {
  const xs = t.poly.map((p) => p[0]);
  const zs = t.poly.map((p) => p[1]);
  const ov = clamp(Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) * 0.08, 0.5, 1.6);
  const x0 = Math.min(...xs) - ov;
  const x1 = Math.max(...xs) + ov;
  const z0 = Math.min(...zs) - ov;
  const z1 = Math.max(...zs) + ov;
  const y = t.y1;
  const w = x1 - x0;
  const d = z1 - z0;
  const h = Math.min(w, d) * 0.32;
  const alongX = w >= d;
  const inset = Math.min(w, d) / 2;
  const B = propFor((x0 + x1) / 2, (z0 + z1) / 2);
  const tile: RGB = b.culture === 'cn' ? [0.08, 0.06, 0.05] : [0.05, 0.055, 0.06];
  setProp(B, tile[0], tile[1], tile[2], 0, 0.35);
  // ridge endpoints
  const ra: [number, number, number] = alongX ? [x0 + inset, y + h, (z0 + z1) / 2] : [(x0 + x1) / 2, y + h, z0 + inset];
  const rb: [number, number, number] = alongX ? [x1 - inset, y + h, (z0 + z1) / 2] : [(x0 + x1) / 2, y + h, z1 - inset];
  const lift = 0.5; // upturned eaves
  const c00: [number, number, number] = [x0, y + lift, z0];
  const c10: [number, number, number] = [x1, y + lift, z0];
  const c11: [number, number, number] = [x1, y + lift, z1];
  const c01: [number, number, number] = [x0, y + lift, z1];
  const tri = (p: number[], q: number[], s: number[]): void => {
    const ux = q[0]! - p[0]!;
    const uy = q[1]! - p[1]!;
    const uz = q[2]! - p[2]!;
    const vx = s[0]! - p[0]!;
    const vy = s[1]! - p[1]!;
    const vz = s[2]! - p[2]!;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const a = B.vert(p[0]!, p[1]!, p[2]!, nx, ny, nz, 0, 0);
    const bb = B.vert(q[0]!, q[1]!, q[2]!, nx, ny, nz, 0, 0);
    const c = B.vert(s[0]!, s[1]!, s[2]!, nx, ny, nz, 0, 0);
    B.tri(a, bb, c);
  };
  if (alongX) {
    tri(c00, c10, rb);
    tri(c00, rb, ra);
    tri(c11, c01, ra);
    tri(c11, ra, rb);
    tri(c01, c00, ra);
    tri(c10, c11, rb);
  } else {
    tri(c10, c11, rb);
    tri(c10, rb, ra);
    tri(c01, c00, ra);
    tri(c01, ra, rb);
    tri(c00, c10, ra);
    tri(c11, c01, rb);
  }
  // ridge trim and corner lanterns
  const trim: RGB = b.culture === 'cn' ? [0.5, 0.06, 0.03] : [0.35, 0.3, 0.2];
  const rl = Math.hypot(rb[0] - ra[0], rb[2] - ra[2]);
  bx(K, 'small', (ra[0] + rb[0]) / 2, y + h - 0.1, (ra[2] + rb[2]) / 2, alongX ? Math.PI / 2 : 0, 0.35, 0.35, rl + 0.4, trim, CLS.painted, b.seed);
  const lc: RGB = b.culture === 'cn' ? [1, 0.18, 0.06] : [1, 0.75, 0.45];
  for (const c of [c00, c10, c11, c01]) K('beacon', 'small', { x: c[0], y: c[1] - 1.1, z: c[2], rot: 0, sx: 0.7, sy: 0.9, sz: 0.7, emit: 3.5, r: 0, g: 0, b: 0, cs: 0.2, er: lc[0], eg: lc[1], eb: lc[2], mode: r.chance(0.2) ? 1 : 0 });
}

// ------------------------------------------------------------- structures
function catenary(B: MeshBuilder, s: number[], strands: number, width: number, col: RGB): void {
  const [x0, y0, z0, x1, y1, z1, sag] = s as [number, number, number, number, number, number, number];
  const segs = 10;
  setProp(B, col[0], col[1], col[2], 0, 0.2);
  for (let k = 0; k < strands; k++) {
    const off = (k - (strands - 1) / 2) * 0.35;
    const pts: [number, number, number][] = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      pts.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t - 4 * sag * t * (1 - t) + off * 0.3, z0 + (z1 - z0) * t + off]);
    }
    for (let i = 0; i < segs; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      // two crossed ribbons
      for (const [ox, oy, oz] of [
        [0, width, 0],
        [width, 0, width],
      ] as const) {
        const p0 = B.vert(a[0] - ox, a[1] - oy, a[2] - oz, 0, 1, 0, 0, 0);
        const p1 = B.vert(b[0] - ox, b[1] - oy, b[2] - oz, 0, 1, 0, 0, 0);
        const p2 = B.vert(b[0] + ox, b[1] + oy, b[2] + oz, 0, 1, 0, 0, 0);
        const p3 = B.vert(a[0] + ox, a[1] + oy, a[2] + oz, 0, 1, 0, 0, 0);
        B.quad(p0, p1, p2, p3);
      }
    }
  }
}

export function addStructure(s: Structure, K: KitSink, propFor: BuilderFor): void {
  const p = s.p;
  const seed = s.seed;
  switch (s.kind) {
    case 'crane': {
      const [x, z, rot, h, boom] = p as [number, number, number, number, number];
      const c = Math.cos(rot);
      const sn = Math.sin(rot);
      const L = (lx: number, lz: number): [number, number] => [x + lx * c + lz * sn, z - lx * sn + lz * c];
      // gantry legs and portal beams
      for (const [lx, lz] of [
        [-9, -7],
        [9, -7],
        [-9, 7],
        [9, 7],
      ] as const) {
        const [px, pz] = L(lx, lz);
        bx(K, 'big', px, 0, pz, rot, 1.4, h - 6, 1.4, s.col, CLS.metal, seed);
      }
      for (const lz of [-7, 7]) {
        const [px, pz] = L(0, lz);
        bx(K, 'big', px, h - 7, pz, rot, 19.4, 1.6, 1.4, s.col, CLS.metal, seed);
      }
      for (const lx of [-9, 9]) {
        const [px, pz] = L(lx, 0);
        bx(K, 'big', px, h - 7, pz, rot, 1.4, 1.6, 15.4, s.col, CLS.metal, seed);
        const [qx, qz] = L(lx, 0);
        bx(K, 'big', qx, 14, qz, rot, 1.0, 1.0, 14.4, s.col, CLS.metal, seed);
      }
      // machinery house and boom over the water
      const [hx, hz] = L(0, 0);
      bx(K, 'big', hx, h - 5.6, hz, rot, 12, 5, 10, [0.22, 0.21, 0.2], CLS.metal, seed, 0.6, [1, 0.8, 0.5]);
      const [bx0, bz0] = L(0, (boom - 22) / 2);
      bx(K, 'huge', bx0, h - 1.4, bz0, rot, 3, 2.4, boom + 22, s.col, CLS.metal, seed);
      const [tx, tz] = L(0, boom);
      K('beacon', 'huge', { x: tx, y: h + 1.4, z: tz, rot: 0, sx: 1.2, sy: 1.2, sz: 1.2, emit: 6, r: 0, g: 0, b: 0, cs: 0.1, er: s.col2[0], eg: s.col2[1], eb: s.col2[2], mode: 4 });
      // floodlights under the boom
      for (let k = 0; k < 3; k++) {
        const [fx, fz] = L(0, boom * (0.3 + k * 0.3));
        bx(K, 'mid', fx, h - 3.2, fz, rot, 1.6, 0.4, 1.0, [0.3, 0.3, 0.3], CLS.lightbox, seed + k, 2.5, [1, 0.85, 0.6]);
      }
      break;
    }
    case 'dock': {
      const [x0, z0, x1, z1, y] = p as [number, number, number, number, number];
      bx(K, 'huge', (x0 + x1) / 2, -2.2, (z0 + z1) / 2, 0, x1 - x0, y + 2.2, z1 - z0, s.col, CLS.concrete, seed);
      for (let x = x0 + 6; x < x1 - 4; x += 14) K('cyl', 'small', { x, y, z: z1 - 1.2, rot: 0, sx: 0.35, sy: 0.7, sz: 0.35, emit: 0, r: 0.25, g: 0.22, b: 0.18, cs: CLS.metal + 0.3, er: 0, eg: 0, eb: 0, mode: 0 });
      for (let x = x0 + 20; x < x1 - 10; x += 40) {
        K('lamp', 'mid', { x, y, z: z0 + 3, rot: 0, sx: 1.4, sy: 1.4, sz: 1.4, emit: 3, r: 0.15, g: 0.15, b: 0.16, cs: CLS.metal + 0.5, er: s.col2[0], eg: s.col2[1], eb: s.col2[2], mode: 0 });
      }
      break;
    }
    case 'bridge': {
      const [x0, y, z0, x1, , z1, w, h] = p as [number, number, number, number, number, number, number, number];
      const len = Math.hypot(x1 - x0, z1 - z0);
      const rot = Math.atan2(x1 - x0, z1 - z0);
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      bx(K, 'big', cx, y, cz, rot, w, h, len + 0.6, mul(s.col, 0.8), CLS.concrete, seed);
      // window band both sides
      const nx = Math.cos(rot);
      const nz = -Math.sin(rot);
      for (const sd of [-1, 1]) bx(K, 'big', cx + nx * sd * (w / 2 + 0.02), y + h * 0.35, cz + nz * sd * (w / 2 + 0.02), rot, 0.06, h * 0.4, len - 0.4, [0.2, 0.2, 0.2], CLS.lightbox, seed + sd, 1.2, mul(s.col2, 0.8));
      break;
    }
    case 'scaffold': {
      const [ax, az, bxx, bz, y0, y1, depth] = p as [number, number, number, number, number, number, number];
      const len = Math.hypot(bxx - ax, bz - az);
      const tx = (bxx - ax) / len;
      const tz = (bz - az) / len;
      const nx = tz;
      const nz = -tx;
      const rot = Math.atan2(nx, nz);
      const pole: RGB = s.col;
      for (let u = 0; u <= len; u += 2.4) {
        for (const dd of [0.3, depth]) bx(K, 'small', ax + tx * u + nx * dd, y0, az + tz * u + nz * dd, rot, 0.06, y1 - y0, 0.06, pole, CLS.metal, seed + u);
      }
      for (let y = y0 + 2; y < y1; y += 2) {
        bx(K, 'small', (ax + bxx) / 2 + nx * (depth / 2 + 0.15), y, (az + bz) / 2 + nz * (depth / 2 + 0.15), rot, len, 0.06, depth, [0.32, 0.25, 0.16], CLS.painted, seed + y);
      }
      // tarps over part of it
      const tarp: RGB = s.col2;
      const nT = Math.max(1, Math.floor(len / 6));
      for (let k = 0; k < nT; k++) {
        if (hash01(Math.floor(seed * 1e6), k, 1) < 0.5) continue;
        const u = ((k + 0.5) / nT) * len;
        bx(K, 'small', ax + tx * u + nx * (depth + 0.08), y0 + (y1 - y0) * 0.3, az + tz * u + nz * (depth + 0.08), rot, len / nT - 0.2, (y1 - y0) * 0.5, 0.04, mul(tarp, 0.5), CLS.painted, seed + k);
      }
      break;
    }
    case 'frame': {
      const [x0, z0, x1, z1, y0, y1, fh] = p as [number, number, number, number, number, number, number];
      const col: RGB = s.col;
      const w = x1 - x0;
      const d = z1 - z0;
      const nx = Math.max(1, Math.round(w / 6));
      const nz = Math.max(1, Math.round(d / 6));
      const levels = Math.max(1, Math.round((y1 - y0) / fh));
      const sd = Math.floor(seed * 1e6);
      for (let i = 0; i <= nx; i++)
        for (let j = 0; j <= nz; j++) {
          if (i > 0 && i < nx && j > 0 && j < nz) continue;
          const hh = (y1 - y0) * (hash01(sd, i, j) < 0.25 ? hash01(sd, j, i) * 0.8 + 0.2 : 1);
          bx(K, 'mid', x0 + (w * i) / nx, y0, z0 + (d * j) / nz, 0, 0.55, hh, 0.55, col, CLS.concrete, seed + i + j);
          if (hh >= y1 - y0 - 0.1) bx(K, 'small', x0 + (w * i) / nx, y1, z0 + (d * j) / nz, 0, 0.05, 1.4, 0.05, s.col2, CLS.rust, seed);
        }
      for (let l = 1; l <= levels; l++) {
        if (hash01(sd, l, 99) < 0.2) continue;
        const cut = hash01(sd, l, 7) < 0.4 ? 0.5 + hash01(sd, l, 8) * 0.4 : 1;
        bx(K, 'mid', x0 + (w * cut) / 2, y0 + l * fh - 0.3, (z0 + z1) / 2, 0, w * cut, 0.3, d, col, CLS.concrete, seed + l);
      }
      break;
    }
    case 'pool': {
      const [x0, z0, x1, z1, y] = p as [number, number, number, number, number];
      bx(K, 'mid', (x0 + x1) / 2, y, (z0 + z1) / 2, 0, x1 - x0, 0.12, z1 - z0, s.col, CLS.water, seed, 0.9, s.col2);
      break;
    }
    case 'pond': {
      // a dark park pond with a low stone rim
      const [x0, z0, x1, z1, y] = p as [number, number, number, number, number];
      bx(K, 'mid', (x0 + x1) / 2, y - 0.1, (z0 + z1) / 2, 0, x1 - x0, 0.12, z1 - z0, [0.004, 0.007, 0.01], CLS.glass, seed);
      for (const [cx, cz, sx, sz] of [
        [(x0 + x1) / 2, z0, x1 - x0 + 0.8, 0.4],
        [(x0 + x1) / 2, z1, x1 - x0 + 0.8, 0.4],
        [x0, (z0 + z1) / 2, 0.4, z1 - z0],
        [x1, (z0 + z1) / 2, 0.4, z1 - z0],
      ] as const)
        bx(K, 'small', cx, y - 0.1, cz, 0, sx, 0.35, sz, [0.18, 0.17, 0.16], CLS.stone, seed);
      break;
    }
    case 'sawtooth': {
      const [x0, z0, x1, z1, y, tooth, axis] = p as [number, number, number, number, number, number, number];
      const B = propFor((x0 + x1) / 2, (z0 + z1) / 2);
      const alongX = axis === 0;
      const L0 = alongX ? z0 : x0;
      const L1 = alongX ? z1 : x1;
      const h = tooth * 0.45;
      for (let q = L0; q < L1 - 0.5; q += tooth) {
        const q1 = Math.min(L1, q + tooth);
        // sloped roof panel and a glazed vertical face
        setProp(B, s.col[0] * 0.8, s.col[1] * 0.8, s.col[2] * 0.8, 0, 0.3);
        const P = (a: number, yy: number, bb: number): [number, number, number] => (alongX ? [a, yy, bb] : [bb, yy, a]);
        const A0 = alongX ? x0 : z0;
        const A1 = alongX ? x1 : z1;
        const s0 = P(A0, y, q);
        const s1 = P(A1, y, q);
        const s2 = P(A1, y + h, q1);
        const s3 = P(A0, y + h, q1);
        const n1 = alongX ? [0, 0.9, -0.43] : [-0.43, 0.9, 0];
        const ia = B.vert(s0[0], s0[1], s0[2], n1[0]!, n1[1]!, n1[2]!, 0, 0);
        const ib = B.vert(s1[0], s1[1], s1[2], n1[0]!, n1[1]!, n1[2]!, 0, 0);
        const ic = B.vert(s2[0], s2[1], s2[2], n1[0]!, n1[1]!, n1[2]!, 0, 0);
        const id = B.vert(s3[0], s3[1], s3[2], n1[0]!, n1[1]!, n1[2]!, 0, 0);
        B.quad(ia, ib, ic, id);
        setProp(B, s.col2[0] * 0.2, s.col2[1] * 0.2, s.col2[2] * 0.2, 0.55, 0.6);
        const g0 = P(A0, y, q1);
        const g1 = P(A1, y, q1);
        const n2 = alongX ? [0, 0, 1] : [1, 0, 0];
        const ja = B.vert(g0[0], g0[1], g0[2], n2[0]!, n2[1]!, n2[2]!, 0, 0);
        const jb = B.vert(g1[0], g1[1], g1[2], n2[0]!, n2[1]!, n2[2]!, 0, 0);
        const jc = B.vert(s2[0], s2[1], s2[2], n2[0]!, n2[1]!, n2[2]!, 0, 0);
        const jd = B.vert(s3[0], s3[1], s3[2], n2[0]!, n2[1]!, n2[2]!, 0, 0);
        B.quad(ja, jb, jc, jd);
      }
      break;
    }
    case 'awning': {
      const [ax, az, bxx, bz, y, depth] = p as [number, number, number, number, number, number];
      const len = Math.hypot(bxx - ax, bz - az);
      if (len < 0.5) break;
      const tx = (bxx - ax) / len;
      const tz = (bz - az) / len;
      const nx = tz;
      const nz = -tx;
      const B = propFor((ax + bxx) / 2, (az + bz) / 2);
      setProp(B, s.col[0] * 0.35, s.col[1] * 0.35, s.col[2] * 0.35, 0.15, 0.1);
      const drop = depth * 0.45;
      const v0 = B.vert(ax, y, az, nx * 0.4, 0.9, nz * 0.4, 0, 0);
      const v1 = B.vert(bxx, y, bz, nx * 0.4, 0.9, nz * 0.4, 0, 0);
      const v2 = B.vert(bxx + nx * depth, y - drop, bz + nz * depth, nx * 0.4, 0.9, nz * 0.4, 0, 0);
      const v3 = B.vert(ax + nx * depth, y - drop, az + nz * depth, nx * 0.4, 0.9, nz * 0.4, 0, 0);
      B.quad(v0, v3, v2, v1);
      break;
    }
    case 'wires': {
      const B = propFor((p[0]! + p[3]!) / 2, (p[2]! + p[5]!) / 2);
      catenary(B, p, Math.round(p[7] ?? 3), 0.025, s.col);
      break;
    }
    case 'laundry': {
      // a sagging line with clothes pegged along it (shirts, towels, sheets)
      const [x0, y0, z0, x1, y1, z1, sag, nC] = p as [number, number, number, number, number, number, number, number];
      const B = propFor((x0 + x1) / 2, (z0 + z1) / 2);
      catenary(B, [x0, y0, z0, x1, y1, z1, sag], 1, 0.012, [0.05, 0.05, 0.05]);
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.5) break;
      const tx = (x1 - x0) / len;
      const tz = (z1 - z0) / len;
      const nx = tz;
      const nz = -tx;
      const n = Math.max(1, Math.round(nC));
      const iseed = Math.floor(seed * 1e6);
      for (let i = 0; i < n; i++) {
        if (hash01(iseed, i, 1) < 0.2) continue;
        const t0 = (i + 0.15 + hash01(iseed, i, 2) * 0.2) / n;
        const t1 = Math.min(1, t0 + (0.45 + hash01(iseed, i, 3) * 0.35) / n);
        const ya = y0 + (y1 - y0) * t0 - 4 * sag * t0 * (1 - t0);
        const yb = y0 + (y1 - y0) * t1 - 4 * sag * t1 * (1 - t1);
        const drop = 0.45 + hash01(iseed, i, 4) * 0.7;
        const k = hash01(iseed, i, 5);
        const c = k < 0.4 ? s.col : k < 0.75 ? s.col2 : ([0.62, 0.6, 0.56] as RGB);
        setProp(B, c[0], c[1], c[2], 0, 0.05);
        const ax = x0 + (x1 - x0) * t0;
        const az = z0 + (z1 - z0) * t0;
        const bx2 = x0 + (x1 - x0) * t1;
        const bz2 = z0 + (z1 - z0) * t1;
        // a slight swing out from the wall at the hem
        const sw = 0.08 + hash01(iseed, i, 6) * 0.12;
        const v0 = B.vert(ax, ya, az, nx, 0, nz, 0, 0);
        const v1 = B.vert(bx2, yb, bz2, nx, 0, nz, 1, 0);
        const v2 = B.vert(bx2 + nx * sw, yb - drop, bz2 + nz * sw, nx, 0, nz, 1, 1);
        const v3 = B.vert(ax + nx * sw, ya - drop, az + nz * sw, nx, 0, nz, 0, 1);
        B.quad(v0, v1, v2, v3);
      }
      break;
    }
    case 'cables': {
      const B = propFor((p[0]! + p[3]!) / 2, (p[2]! + p[5]!) / 2);
      catenary(B, p, 1, 0.02, [0.02, 0.02, 0.02]);
      const [x0, y0, z0, x1, y1, z1, sag] = p as [number, number, number, number, number, number, number];
      const len = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.max(2, Math.floor(len / 1.1));
      for (let i = 1; i < n; i++) {
        const t = i / n;
        const x = x0 + (x1 - x0) * t;
        const yy = y0 + (y1 - y0) * t - 4 * sag * t * (1 - t);
        const z = z0 + (z1 - z0) * t;
        K('beacon', 'small', { x, y: yy - 0.35, z, rot: 0, sx: 0.24, sy: 0.3, sz: 0.24, emit: 0.85, r: 0, g: 0, b: 0, cs: 0.4, er: s.col[0], eg: s.col[1], eb: s.col[2], mode: hash01(Math.floor(seed * 1e6), i, 5) < 0.08 ? 1 : 0 });
      }
      break;
    }
    default:
      break;
  }
}

// --------------------------------------------------------------- highways
export function addHighway(h: Highway, K: KitSink): void {
  const seg = 40;
  const hw = h.width / 2;
  const deckCol: RGB = [0.11, 0.11, 0.115];
  const rot = h.axis === 'x' ? Math.PI / 2 : 0;
  const P = (along: number, across: number): [number, number] => (h.axis === 'x' ? [along, h.pos + across] : [h.pos + across, along]);
  for (let a = h.lo; a < h.hi - 1; a += seg) {
    const b = Math.min(h.hi, a + seg);
    const mid = (a + b) / 2;
    const len = b - a;
    const [cx, cz] = P(mid, 0);
    bx(K, 'huge', cx, h.y - 1.3, cz, rot, h.width, 1.3, len + 0.05, deckCol, CLS.concrete, mid * 0.01);
    for (const sd of [-1, 1]) {
      const [bx0, bz0] = P(mid, sd * (hw - 0.25));
      bx(K, 'big', bx0, h.y, bz0, rot, 0.5, 1.1, len + 0.05, [0.16, 0.16, 0.17], CLS.concrete, mid);
      bx(K, 'big', bx0, h.y + 1.1, bz0, rot, 0.3, 0.1, len - 0.3, [0.2, 0.2, 0.2], CLS.lightbox, mid, 1.8, sd > 0 ? [1, 0.55, 0.15] : [0.8, 0.9, 1], 0);
    }
  }
  for (let a = h.lo + h.span / 2; a < h.hi; a += h.span) {
    const [cx, cz] = P(a, 0);
    bx(K, 'huge', cx, 0, cz, rot, 3, h.y - 1.3, 2.4, [0.12, 0.12, 0.125], CLS.concrete, a);
    bx(K, 'big', cx, h.y - 3.2, cz, rot, h.width * 0.8, 1.9, 2.6, [0.12, 0.12, 0.125], CLS.concrete, a);
    // under-deck light
    bx(K, 'mid', cx, h.y - 3.3, cz, rot, 4, 0.1, 0.8, [0.2, 0.2, 0.2], CLS.lightbox, a, 2.4, [1, 0.7, 0.4]);
  }
  for (let a = h.lo + 20; a < h.hi; a += 46) {
    for (const sd of [-1, 1]) {
      const [lx, lz] = P(a, sd * (hw - 0.4));
      K('lamp', 'mid', { x: lx, y: h.y, z: lz, rot: h.axis === 'x' ? (sd > 0 ? Math.PI : 0) : sd > 0 ? -Math.PI / 2 : Math.PI / 2, sx: 1.1, sy: 1.1, sz: 1.1, emit: 3.2, r: 0.12, g: 0.12, b: 0.13, cs: CLS.metal + 0.5, er: 1, eg: 0.62, eb: 0.3, mode: 0 });
    }
  }
}

export function highwayEmitters(h: Highway, out: CitySpec['emitters']): void {
  for (let a = h.lo + 20; a < h.hi; a += 46) {
    for (const sd of [-1, 1]) {
      const x = h.axis === 'x' ? a : h.pos + sd * (h.width / 2 - 2);
      const z = h.axis === 'x' ? h.pos + sd * (h.width / 2 - 2) : a;
      out.push({ x, y: h.y + 7, z, r: 1.4, g: 0.85, b: 0.4, radius: 22 });
    }
  }
}
