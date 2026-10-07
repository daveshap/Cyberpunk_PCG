/**
 * Flight collision: axis-aligned boxes in a uniform XZ grid. Pure and
 * deterministic, shared by the browser and the headless tests.
 */
import type { Box3, Building, Highway, Structure } from './types';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export function buildBoxes(buildings: readonly Building[], highways: readonly Highway[], structures: readonly Structure[]): Box3[] {
  const boxes: Box3[] = [];
  for (const b of buildings) {
    for (const t of b.tiers) {
      if (t.top) {
        // sloped walls: slice into bands, each boxed by the wider of its two ends
        const n = 6;
        const at = (f: number): [number, number, number, number] => {
          let x0 = Infinity;
          let z0 = Infinity;
          let x1 = -Infinity;
          let z1 = -Infinity;
          t.poly.forEach(([px, pz], i) => {
            const q = (t.top as typeof t.poly)[i] ?? [px, pz];
            const x = px + (q[0] - px) * f;
            const z = pz + (q[1] - pz) * f;
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            z0 = Math.min(z0, z);
            z1 = Math.max(z1, z);
          });
          return [x0, z0, x1, z1];
        };
        for (let k = 0; k < n; k++) {
          const a = at(k / n);
          const c = at((k + 1) / n);
          boxes.push({ x0: Math.min(a[0], c[0]), z0: Math.min(a[1], c[1]), x1: Math.max(a[2], c[2]), z1: Math.max(a[3], c[3]), y0: t.y0 + ((t.y1 - t.y0) * k) / n, y1: t.y0 + ((t.y1 - t.y0) * (k + 1)) / n });
        }
        continue;
      }
      let x0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let z1 = -Infinity;
      for (const [x, z] of t.poly) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
      }
      boxes.push({ x0, y0: t.y0, z0, x1, y1: t.y1 + (t.roof === 'pagoda' ? 2.5 : 0), z1 });
    }
  }
  for (const h of highways) {
    const hw = h.width / 2;
    const seg = 120;
    for (let p = h.lo; p < h.hi; p += seg) {
      const q = Math.min(h.hi, p + seg);
      if (h.axis === 'x') boxes.push({ x0: p, x1: q, y0: h.y - 1.2, y1: h.y + 1.2, z0: h.pos - hw, z1: h.pos + hw });
      else boxes.push({ x0: h.pos - hw, x1: h.pos + hw, y0: h.y - 1.2, y1: h.y + 1.2, z0: p, z1: q });
    }
    for (let p = h.lo + h.span / 2; p < h.hi; p += h.span) {
      if (h.axis === 'x') boxes.push({ x0: p - 1.2, x1: p + 1.2, y0: 0, y1: h.y, z0: h.pos - 2, z1: h.pos + 2 });
      else boxes.push({ x0: h.pos - 2, x1: h.pos + 2, y0: 0, y1: h.y, z0: p - 1.2, z1: p + 1.2 });
    }
  }
  for (const s of structures) {
    const p = s.p;
    if (s.kind === 'crane') {
      const [x, z, , h, boom] = p as [number, number, number, number, number];
      boxes.push({ x0: x - 9, x1: x + 9, y0: 0, y1: h, z0: z - 8, z1: z + 8 });
      boxes.push({ x0: x - 3, x1: x + 3, y0: h - 6, y1: h + 2, z0: z - 18, z1: z + boom });
    } else if (s.kind === 'bridge') {
      const [x0, y, z0, x1, , z1, w, hh] = p as [number, number, number, number, number, number, number, number];
      boxes.push({ x0: Math.min(x0, x1) - w / 2, x1: Math.max(x0, x1) + w / 2, y0: y, y1: y + hh, z0: Math.min(z0, z1) - w / 2, z1: Math.max(z0, z1) + w / 2 });
    } else if (s.kind === 'frame') {
      const [x0, z0, x1, z1, y0, y1] = p as [number, number, number, number, number, number];
      boxes.push({ x0, x1, y0, y1, z0, z1 });
    }
  }
  return boxes;
}

export interface Hit {
  /** Push-out normal. */
  nx: number;
  ny: number;
  nz: number;
  depth: number;
}

export class FlightWorld {
  private readonly cell = 40;
  private readonly grid = new Map<number, number[]>();
  readonly boxes: readonly Box3[];
  /** Highest box top (for the ceiling and autopilot). */
  readonly maxY: number;

  constructor(boxes: readonly Box3[]) {
    this.boxes = boxes;
    let m = 0;
    boxes.forEach((b, i) => {
      m = Math.max(m, b.y1);
      for (let x = Math.floor(b.x0 / this.cell); x <= Math.floor(b.x1 / this.cell); x++)
        for (let z = Math.floor(b.z0 / this.cell); z <= Math.floor(b.z1 / this.cell); z++) {
          const k = this.key(x, z);
          const arr = this.grid.get(k);
          if (arr) arr.push(i);
          else this.grid.set(k, [i]);
        }
    });
    this.maxY = m;
  }

  private key(x: number, z: number): number {
    return (x + 2048) * 4096 + (z + 2048);
  }

  near(x0: number, z0: number, x1: number, z1: number, out: number[] = []): number[] {
    out.length = 0;
    const seen = new Set<number>();
    for (let x = Math.floor(x0 / this.cell); x <= Math.floor(x1 / this.cell); x++)
      for (let z = Math.floor(z0 / this.cell); z <= Math.floor(z1 / this.cell); z++) {
        for (const i of this.grid.get(this.key(x, z)) ?? []) {
          if (!seen.has(i)) {
            seen.add(i);
            out.push(i);
          }
        }
      }
    return out;
  }

  /**
   * Push a sphere out of every box it overlaps. Returns the deepest contact,
   * or null when free. `p` is modified in place.
   */
  resolveSphere(p: Vec3Like, radius: number, groundY = 0): Hit | null {
    let deepest: Hit | null = null;
    for (let iter = 0; iter < 4; iter++) {
      let any = false;
      for (const i of this.near(p.x - radius, p.z - radius, p.x + radius, p.z + radius)) {
        const b = this.boxes[i] as Box3;
        const cx = Math.max(b.x0, Math.min(p.x, b.x1));
        const cy = Math.max(b.y0, Math.min(p.y, b.y1));
        const cz = Math.max(b.z0, Math.min(p.z, b.z1));
        let dx = p.x - cx;
        let dy = p.y - cy;
        let dz = p.z - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= radius * radius) continue;
        let depth: number;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          dx /= d;
          dy /= d;
          dz /= d;
          depth = radius - d;
        } else {
          // centre inside the box: leave through the nearest face
          const faces = [p.x - b.x0, b.x1 - p.x, p.y - b.y0, b.y1 - p.y, p.z - b.z0, b.z1 - p.z];
          let m = 0;
          for (let k = 1; k < 6; k++) if ((faces[k] as number) < (faces[m] as number)) m = k;
          dx = m === 0 ? -1 : m === 1 ? 1 : 0;
          dy = m === 2 ? -1 : m === 3 ? 1 : 0;
          dz = m === 4 ? -1 : m === 5 ? 1 : 0;
          depth = (faces[m] as number) + radius;
        }
        p.x += dx * depth;
        p.y += dy * depth;
        p.z += dz * depth;
        any = true;
        if (!deepest || depth > deepest.depth) deepest = { nx: dx, ny: dy, nz: dz, depth };
      }
      if (p.y < groundY + radius) {
        const depth = groundY + radius - p.y;
        p.y = groundY + radius;
        any = true;
        if (!deepest || depth > deepest.depth) deepest = { nx: 0, ny: 1, nz: 0, depth };
      }
      if (!any) break;
    }
    return deepest;
  }

  /** True if a sphere overlaps any box. */
  blocked(p: Vec3Like, radius: number): boolean {
    for (const i of this.near(p.x - radius, p.z - radius, p.x + radius, p.z + radius)) {
      const b = this.boxes[i] as Box3;
      const cx = Math.max(b.x0, Math.min(p.x, b.x1));
      const cy = Math.max(b.y0, Math.min(p.y, b.y1));
      const cz = Math.max(b.z0, Math.min(p.z, b.z1));
      if ((p.x - cx) ** 2 + (p.y - cy) ** 2 + (p.z - cz) ** 2 < radius * radius) return true;
    }
    return false;
  }

  /** Distance along a ray to the first box (slab test), or maxDist. */
  raycast(o: Vec3Like, dx: number, dy: number, dz: number, maxDist: number): number {
    let best = maxDist;
    const ex = o.x + dx * maxDist;
    const ez = o.z + dz * maxDist;
    for (const i of this.near(Math.min(o.x, ex), Math.min(o.z, ez), Math.max(o.x, ex), Math.max(o.z, ez))) {
      const b = this.boxes[i] as Box3;
      let t0 = 0;
      let t1 = best;
      const slab = (oo: number, d: number, lo: number, hi: number): boolean => {
        if (Math.abs(d) < 1e-9) return oo >= lo && oo <= hi;
        let a = (lo - oo) / d;
        let c = (hi - oo) / d;
        if (a > c) [a, c] = [c, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, c);
        return t0 <= t1;
      };
      if (slab(o.x, dx, b.x0, b.x1) && slab(o.y, dy, b.y0, b.y1) && slab(o.z, dz, b.z0, b.z1)) best = Math.min(best, t0);
    }
    if (dy < 0) best = Math.min(best, o.y / -dy);
    return best;
  }

  /** Tallest box top within a square around (x, z). */
  heightAround(x: number, z: number, r: number): number {
    let h = 0;
    for (const i of this.near(x - r, z - r, x + r, z + r)) {
      const b = this.boxes[i] as Box3;
      if (b.x1 < x - r || b.x0 > x + r || b.z1 < z - r || b.z0 > z + r) continue;
      h = Math.max(h, b.y1);
    }
    return h;
  }
}
