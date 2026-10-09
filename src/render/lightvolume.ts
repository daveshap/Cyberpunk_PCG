/**
 * Bakes the city's emitters into the light textures on the CPU:
 *  - a 3D light volume (256 x 32 x 256, logarithmic in height) that lights
 *    facades at any altitude and colours the volumetric haze,
 *  - a 2D ground map (1024 x 1024) for crisp pools of light on the streets, and a
 *    second one without the sources drawn as local lights (signs, lamps, fires,
 *    festoons), which the shaders use near the camera (locallights.ts),
 *  - a small zone map with each district's fog tint and density.
 * The textures are allocated once (tsl.ts) and rewritten in place.
 */
import * as THREE from 'three/webgpu';
import type { CitySpec, District, Superblock } from '../core/types';
import { LV, TEX, U, VA, VOL_MAX } from './tsl';
import { LOCAL_SRC } from './locallights';

const H0 = 10;
/** Top of the light volume: the city's towers, or the hive's kilometre ones. */
const HMAX_CITY = 420;
const HMAX_HIVE = 3200;

// fast float32 -> float16 (round to nearest, no NaN handling needed for light values)
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0] as number;
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  const m = x & 0x7fffff;
  if (e <= 0) return sign;
  if (e >= 31) return sign | 0x7bff;
  const half = sign | (e << 10) | (m >>> 13);
  return half + ((m >>> 12) & 1);
}

export interface BakeResult {
  ms: number;
  rect: { x0: number; z0: number; w: number; d: number };
}

export function bakeLights(spec: CitySpec, gain = 1): BakeResult {
  const t0 = performance.now();
  const margin = 260;
  const x0 = spec.bounds.x0 - margin;
  const z0 = spec.bounds.z0 - margin;
  const W = spec.bounds.x1 - spec.bounds.x0 + margin * 2;
  const D = spec.bounds.z1 - spec.bounds.z0 + margin * 2;
  U.volRect.value.set(x0, z0, 1 / W, 1 / D);
  const HMAX = spec.dials.world === 'hive' ? HMAX_HIVE : HMAX_CITY;
  const logDen = Math.log(1 + HMAX / H0);
  U.volY.value.set(H0, 1 / logDen);

  const NX = LV.W;
  const NY = LV.H;
  const NZ = LV.D;
  const cw = W / NX;
  const cd = D / NZ;
  const layerY: number[] = [];
  for (let k = 0; k < NY; k++) layerY.push(H0 * (Math.exp(((k + 0.5) / NY) * logDen) - 1));
  const acc = new Float32Array(NX * NY * NZ * 3);

  // ground map
  const G = LV.G;
  const gw = W / G;
  const gd = D / G;
  const gacc = new Float32Array(G * G * 3);
  const gaccN = new Float32Array(G * G * 3);

  for (const e of spec.emitters) {
    const r = e.radius;
    const r2 = r * r;
    // ---- volume
    const i0 = Math.max(0, Math.floor((e.x - r - x0) / cw));
    const i1 = Math.min(NX - 1, Math.floor((e.x + r - x0) / cw));
    const j0 = Math.max(0, Math.floor((e.z - r - z0) / cd));
    const j1 = Math.min(NZ - 1, Math.floor((e.z + r - z0) / cd));
    for (let k = 0; k < NY; k++) {
      const dy = (layerY[k] as number) - e.y;
      // layers get thick higher up: widen the vertical reach with the layer spacing
      const reach = r + (k > 0 ? ((layerY[k] as number) - (layerY[k - 1] as number)) * 0.5 : 0);
      if (Math.abs(dy) > reach) continue;
      const dy2 = Math.max(0, dy * dy - (reach - r) * (reach - r));
      for (let j = j0; j <= j1; j++) {
        const dz = z0 + (j + 0.5) * cd - e.z;
        const dz2 = dz * dz;
        for (let i = i0; i <= i1; i++) {
          const dx = x0 + (i + 0.5) * cw - e.x;
          const d2 = dx * dx + dz2 + dy2;
          if (d2 >= r2) continue;
          const f = 1 - d2 / r2;
          const w = f * f;
          const idx = ((k * NZ + j) * NX + i) * 3;
          acc[idx] = (acc[idx] as number) + e.r * w;
          acc[idx + 1] = (acc[idx + 1] as number) + e.g * w;
          acc[idx + 2] = (acc[idx + 2] as number) + e.b * w;
        }
      }
    }
    // ---- ground map (street level emitters only)
    if (e.y < 16) {
      const local = e.src !== undefined && LOCAL_SRC.has(e.src);
      const gr = r * 0.9;
      const gr2 = gr * gr;
      const k = Math.exp(-e.y * 0.08);
      const a0 = Math.max(0, Math.floor((e.x - gr - x0) / gw));
      const a1 = Math.min(G - 1, Math.floor((e.x + gr - x0) / gw));
      const b0 = Math.max(0, Math.floor((e.z - gr - z0) / gd));
      const b1 = Math.min(G - 1, Math.floor((e.z + gr - z0) / gd));
      for (let j = b0; j <= b1; j++) {
        const dz = z0 + (j + 0.5) * gd - e.z;
        for (let i = a0; i <= a1; i++) {
          const dx = x0 + (i + 0.5) * gw - e.x;
          const d2 = dx * dx + dz * dz;
          if (d2 >= gr2) continue;
          const f = 1 - d2 / gr2;
          const w = f * f * k;
          const idx = (j * G + i) * 3;
          gacc[idx] = (gacc[idx] as number) + e.r * w;
          gacc[idx + 1] = (gacc[idx + 1] as number) + e.g * w;
          gacc[idx + 2] = (gacc[idx + 2] as number) + e.b * w;
          if (!local) {
            gaccN[idx] = (gaccN[idx] as number) + e.r * w;
            gaccN[idx + 1] = (gaccN[idx + 1] as number) + e.g * w;
            gaccN[idx + 2] = (gaccN[idx + 2] as number) + e.b * w;
          }
        }
      }
    }
  }

  // soften: two binomial 3-tap passes per layer and axis (a 5-tap [1 4 6 4 1] blur),
  // so 13 m voxels read as smooth light rather than blotches on the facades
  const tmp = new Float32Array(NX * 3);
  const col = new Float32Array(NZ * 3);
  for (let pass = 0; pass < 2; pass++) {
  for (let k = 0; k < NY; k++) {
    for (let j = 0; j < NZ; j++) {
      const row = (k * NZ + j) * NX * 3;
      for (let i = 0; i < NX; i++) {
        for (let c = 0; c < 3; c++) {
          const m = acc[row + i * 3 + c] as number;
          const l = i > 0 ? (acc[row + (i - 1) * 3 + c] as number) : m;
          const rr = i < NX - 1 ? (acc[row + (i + 1) * 3 + c] as number) : m;
          tmp[i * 3 + c] = m * 0.5 + (l + rr) * 0.25;
        }
      }
      acc.set(tmp, row);
    }
  }
  for (let k = 0; k < NY; k++) {
    for (let i = 0; i < NX; i++) {
      for (let j = 0; j < NZ; j++) {
        const idx = ((k * NZ + j) * NX + i) * 3;
        for (let c = 0; c < 3; c++) {
          const m = acc[idx + c] as number;
          const u = j > 0 ? (acc[((k * NZ + j - 1) * NX + i) * 3 + c] as number) : m;
          const d = j < NZ - 1 ? (acc[((k * NZ + j + 1) * NX + i) * 3 + c] as number) : m;
          col[j * 3 + c] = m * 0.5 + (u + d) * 0.25;
        }
      }
      for (let j = 0; j < NZ; j++) {
        const idx = ((k * NZ + j) * NX + i) * 3;
        acc[idx] = col[j * 3] as number;
        acc[idx + 1] = col[j * 3 + 1] as number;
        acc[idx + 2] = col[j * 3 + 2] as number;
      }
    }
  }
  }

  // write half floats (soft-clamped so a pile of signs does not blow out)
  // soft knee: a packed neon strip saturates around 1.8 instead of blowing out the walls
  const soft = (v: number): number => (v * gain) / (1 + v * gain * 0.55);
  // layered atlas: tile k holds height layer k (x across, z down) inside a
  // one-texel gutter that repeats the edge texels
  const vol = TEX.vol.image.data as Uint8Array;
  const enc = (v: number): number => Math.round(Math.sqrt(Math.min(1, soft(v) / VOL_MAX)) * 255);
  for (let k = 0; k < NY; k++) {
    const ox = (k % VA.tx) * VA.tw;
    const oy = Math.floor(k / VA.tx) * VA.th;
    for (let y = 0; y < VA.th; y++) {
      const j = Math.min(NZ - 1, Math.max(0, y - 1));
      for (let x = 0; x < VA.tw; x++) {
        const i = Math.min(NX - 1, Math.max(0, x - 1));
        const m = ((k * NZ + j) * NX + i) * 3;
        const o = ((oy + y) * VA.w + ox + x) * 4;
        vol[o] = enc(acc[m] as number);
        vol[o + 1] = enc(acc[m + 1] as number);
        vol[o + 2] = enc(acc[m + 2] as number);
        vol[o + 3] = 255;
      }
    }
  }
  TEX.vol.needsUpdate = true;
  const gdata = TEX.ground.image.data as Uint16Array;
  for (let n = 0, m = 0; n < G * G; n++, m += 3) {
    gdata[n * 4] = toHalf(soft(gacc[m] as number));
    gdata[n * 4 + 1] = toHalf(soft(gacc[m + 1] as number));
    gdata[n * 4 + 2] = toHalf(soft(gacc[m + 2] as number));
    gdata[n * 4 + 3] = 0x3c00;
  }
  TEX.ground.needsUpdate = true;
  const gnear = TEX.groundNear.image.data as Uint16Array;
  for (let n = 0, m = 0; n < G * G; n++, m += 3) {
    gnear[n * 4] = toHalf(soft(gaccN[m] as number));
    gnear[n * 4 + 1] = toHalf(soft(gaccN[m + 1] as number));
    gnear[n * 4 + 2] = toHalf(soft(gaccN[m + 2] as number));
    gnear[n * 4 + 3] = 0x3c00;
  }
  TEX.groundNear.needsUpdate = true;

  // ---- zone map: fog tint and density per district, box-blurred across borders
  const Z = LV.Z;
  const zr = new Float32Array(Z * Z * 4);
  const cols = spec.superblocks.length ? Math.max(...spec.superblocks.map((s) => s.i)) + 1 : 1;
  const sbAt = (x: number, zz: number): Superblock | undefined => {
    // superblock lookup by scanning the grid lines implied by the superblock rects
    for (const s of spec.superblocks) {
      const R = s.rect;
      if (x >= R.x0 - 20 && x <= R.x1 + 20 && zz >= R.z0 - 20 && zz <= R.z1 + 20) return s;
    }
    return undefined;
  };
  void cols;
  for (let j = 0; j < Z; j++) {
    for (let i = 0; i < Z; i++) {
      const x = x0 + ((i + 0.5) / Z) * W;
      const zz = z0 + ((j + 0.5) / Z) * D;
      const s = sbAt(x, zz);
      // outside the districts (the sea, the sprawl) the air is cleaner than in the streets:
      // the skyline across the water stays clear while the districts' own haze closes in
      let tint: [number, number, number] = [0.05, 0.06, 0.09];
      let dens = 0.5;
      if (s && s.district >= 0) {
        const d = spec.districts[s.district] as District;
        tint = d.fog.tint;
        dens = d.fog.density;
      }
      const o = (j * Z + i) * 4;
      zr[o] = tint[0];
      zr[o + 1] = tint[1];
      zr[o + 2] = tint[2];
      zr[o + 3] = dens;
    }
  }
  const zb = new Float32Array(Z * Z * 4);
  const R = 3;
  for (let j = 0; j < Z; j++) {
    for (let i = 0; i < Z; i++) {
      const sum = [0, 0, 0, 0];
      let n = 0;
      for (let b = -R; b <= R; b++) {
        for (let a = -R; a <= R; a++) {
          const ii = Math.min(Z - 1, Math.max(0, i + a));
          const jj = Math.min(Z - 1, Math.max(0, j + b));
          const o = (jj * Z + ii) * 4;
          for (let c = 0; c < 4; c++) sum[c] = (sum[c] as number) + (zr[o + c] as number);
          n++;
        }
      }
      const o = (j * Z + i) * 4;
      for (let c = 0; c < 4; c++) zb[o + c] = (sum[c] as number) / n;
    }
  }
  const zd = TEX.zone.image.data as Uint8Array;
  for (let n = 0; n < Z * Z; n++) {
    // tint stored in sRGB-ish sqrt space for precision, density in alpha (0..2 -> 0..255)
    zd[n * 4] = Math.round(Math.sqrt(Math.min(1, zb[n * 4] as number)) * 255);
    zd[n * 4 + 1] = Math.round(Math.sqrt(Math.min(1, zb[n * 4 + 1] as number)) * 255);
    zd[n * 4 + 2] = Math.round(Math.sqrt(Math.min(1, zb[n * 4 + 2] as number)) * 255);
    zd[n * 4 + 3] = Math.round(Math.min(2, zb[n * 4 + 3] as number) * 127.5);
  }
  TEX.zone.needsUpdate = true;
  void THREE;
  return { ms: performance.now() - t0, rect: { x0, z0, w: W, d: D } };
}
