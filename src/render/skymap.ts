// @ts-nocheck -- TSL node graphs are dynamically typed.
/**
 * Light shafts. A height map of everything that stands (tier tops, bridges, the sprawl's
 * blocks) lets the haze tell whether a point in the air sees the sky. In the hive, light
 * comes down from the upper levels and the cloud deck over them; the towers and bridges
 * cut it into shafts that fall slantwise down the canyons, and the depths stay dark.
 *
 * The map is a half-float texture (filterable everywhere, so shaft edges come out soft),
 * baked on the CPU with the city. Points outside it count as covered.
 */
import * as THREE from 'three/webgpu';
import { Fn, float, select, smoothstep, texture, uniform, vec2 } from 'three/tsl';
import type { CitySpec } from '../core/types';

const N = 1024;

function makeTex(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint16Array(N * N), N, N, THREE.RedFormat, THREE.HalfFloatType);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export const SKYMAP = {
  tex: makeTex(),
  /** x0, z0, 1/width, 1/depth of the map. */
  rect: uniform(new THREE.Vector4(-1800, -1800, 1 / 3600, 1 / 3600)),
  /** Direction toward the light (up and a little aslant, so shafts fall diagonally). */
  dir: uniform(new THREE.Vector3(0.62, 0.58, 0.53).normalize()),
};
const T = texture(SKYMAP.tex);

// fast float32 -> float16
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 127 + 15;
  const m = x & 0x7fffff;
  if (e <= 0) return sign;
  if (e >= 31) return sign | 0x7bff;
  return (sign | (e << 10) | (m >>> 13)) + ((m >>> 12) & 1);
}

/** Bake the height map: the tallest thing over every texel, in metres. */
export function bakeSkymap(spec: CitySpec): number {
  const t0 = performance.now();
  const margin = 420;
  const x0 = spec.bounds.x0 - margin;
  const z0 = spec.bounds.z0 - margin;
  const W = spec.bounds.x1 - spec.bounds.x0 + margin * 2;
  const D = spec.bounds.z1 - spec.bounds.z0 + margin * 2;
  SKYMAP.rect.value.set(x0, z0, 1 / W, 1 / D);
  const h = new Float32Array(N * N);
  const fill = (ax0: number, az0: number, ax1: number, az1: number, top: number): void => {
    const i0 = Math.max(0, Math.floor(((ax0 - x0) / W) * N));
    const i1 = Math.min(N - 1, Math.floor(((ax1 - x0) / W) * N));
    const j0 = Math.max(0, Math.floor(((az0 - z0) / D) * N));
    const j1 = Math.min(N - 1, Math.floor(((az1 - z0) / D) * N));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * N + i;
        if (top > h[k]) h[k] = top;
      }
  };
  for (const b of spec.buildings)
    for (const t of b.tiers) {
      let bx0 = Infinity;
      let bz0 = Infinity;
      let bx1 = -Infinity;
      let bz1 = -Infinity;
      for (const p of t.top ? [...t.poly, ...t.top] : t.poly) {
        bx0 = Math.min(bx0, p[0]);
        bx1 = Math.max(bx1, p[0]);
        bz0 = Math.min(bz0, p[1]);
        bz1 = Math.max(bz1, p[1]);
      }
      fill(bx0, bz0, bx1, bz1, t.y1);
    }
  for (const s of spec.structures) {
    if (s.kind !== 'bridge') continue;
    const [ax, y, az, bx, , bz, w, hh] = s.p;
    fill(Math.min(ax, bx) - w / 2, Math.min(az, bz) - w / 2, Math.max(ax, bx) + w / 2, Math.max(az, bz) + w / 2, y + hh);
  }
  for (const o of spec.outskirts) fill(o.rect.x0, o.rect.z0, o.rect.x1, o.rect.z1, o.h);
  const data = SKYMAP.tex.image.data as Uint16Array;
  for (let k = 0; k < N * N; k++) data[k] = toHalf(h[k]);
  SKYMAP.tex.needsUpdate = true;
  return performance.now() - t0;
}

/**
 * How much of the sky light reaches a point in the air: tested where it stands and at three
 * points up toward the light (out to 620 m, so a tall tower casts its shadow across the
 * canyons beside it), each softened over a few metres.
 */
export const skyVisibility = Fn(([p]) => {
  const R = SKYMAP.rect;
  const uvAt = (q) => vec2(q.x.sub(R.x), q.z.sub(R.y)).mul(R.zw);
  const q1 = p.add(SKYMAP.dir.mul(60.0));
  const q2 = p.add(SKYMAP.dir.mul(220.0));
  const q3 = p.add(SKYMAP.dir.mul(620.0));
  const u0 = uvAt(p);
  const v0 = smoothstep(-6.0, 6.0, p.y.sub(T.sample(u0).r));
  const v1 = smoothstep(-10.0, 10.0, q1.y.sub(T.sample(uvAt(q1)).r));
  const v2 = smoothstep(-22.0, 22.0, q2.y.sub(T.sample(uvAt(q2)).r));
  const v3 = smoothstep(-45.0, 45.0, q3.y.sub(T.sample(uvAt(q3)).r));
  const inside = u0.x.greaterThan(0.0).and(u0.x.lessThan(1.0)).and(u0.y.greaterThan(0.0)).and(u0.y.lessThan(1.0));
  return select(inside, v0.mul(v1).mul(v2).mul(v3), float(0.0));
});
