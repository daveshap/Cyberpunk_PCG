// @ts-nocheck -- TSL node graphs are dynamically typed; the CPU bake below is plain TS.
/**
 * Local lights: every sign, street lamp, barrel fire and festoon string lights the walls,
 * ground, kits and cars round it directly, with a real falloff, instead of only through
 * the coarse light volume (13 m voxels, which washes a whole street in one colour).
 *
 *  - Lights are area lights: a sign is its panel (closest point on the rectangle, Karis
 *    2013's representative point), lifted off the wall a little like neon tubes on a
 *    backing board, with an emission lobe (one-sided panels, two-sided blades, lamps
 *    that shine down, omni bulbs and fires), the windowed inverse-square falloff and a
 *    soft size so the irradiance next to a big screen stays finite.
 *  - A sign lights only the street side of the wall it hangs on (a half-space test), so
 *    it never shines through its own building.
 *  - Lookup is a world grid baked with the city (clustered shading, Olsson et al. 2012):
 *    each cell lists the lights that matter most there, in a street band (K per cell)
 *    and a high band for ad walls and rooftop signs. Data lives in float textures read
 *    with textureLoad, so it works on both backends.
 *  - Past ~700 m the coarse volume and the ground map take over again (the detail would
 *    be under a pixel there anyway).
 *  - The same list feeds the volumetric halos: each frame the lights that matter most
 *    to the view go to the haze pass (post.ts), which integrates their glow in the air.
 */
import * as THREE from 'three/webgpu';
import { Break, Fn, If, Loop, abs, clamp, dot, float, floor, fract, int, inverseSqrt, ivec2, mix, normalize, oneMinus, select, smoothstep, textureLoad, texture, uniform, uniformArray, vec3 } from 'three/tsl';
import type { CitySpec, Emitter, SignSpec } from '../core/types';
import { LV, TEX, U, flicker } from './tsl';

/** Grid cells per axis, lights per cell (street band, high band), texels per light. */
export const LL = { N: 320, K: 12, KH: 4, TPL: 5, ROW: 256, ROWS: 256, HIGH_Y: 22, LOW_TOP: 50 };
const MAX_LIGHTS = LL.ROW * LL.ROWS;

function floatTex(w: number, h: number, red: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(new Float32Array(w * h * (red ? 1 : 4)), w, h, red ? THREE.RedFormat : THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** Allocated once at a fixed size; a rebuild rewrites them in place (like the light volume). */
export const LTEX = {
  data: floatTex(LL.ROW * LL.TPL, LL.ROWS, false),
  low: floatTex(LL.N * LL.K, LL.N, true),
  high: floatTex(LL.N * LL.KH, LL.N, true),
};
const T_DATA = texture(LTEX.data);
const T_LOW = texture(LTEX.low);
const T_HIGH = texture(LTEX.high);

export const LLU = {
  /** Grid placement: x0, z0, cells per metre (x), cells per metre (z). */
  rect: uniform(new THREE.Vector4(-1500, -1500, LL.N / 3000, LL.N / 3000)),
  /** Overall strength of the local lights. */
  gain: uniform(0.8),
  /** Camera distance where local lights hand over to the coarse volume. */
  near: uniform(520),
  far: uniform(760),
  /** Share of the coarse light volume that still lights surfaces near the camera (bounce, window glow). */
  spillNear: uniform(0.08),
  /** How many lights glow in the haze each frame (0 turns the halos off; at most HALO_N). Read on the CPU. */
  halos: { value: 40 },
};

/** How much of the local light applies at a point (1 near the camera, 0 past `far`). */
export const localK = (p) => oneMinus(smoothstep(LLU.near, LLU.far, U.camPos.sub(p).length()));

const fetch = (id, k) => {
  const row = floor(id.div(LL.ROW));
  const col = id.sub(row.mul(LL.ROW)).mul(LL.TPL).add(k);
  return textureLoad(T_DATA, ivec2(int(col), int(row)));
};

/** Adds one light's irradiance at p (normal nb) to E. */
function addLight(E, id, p, nb) {
  const T0 = fetch(id, 0);
  const d = p.sub(T0.xyz);
  const d2 = dot(d, d);
  const R2 = T0.w.mul(T0.w);
  If(d2.lessThan(R2), () => {
    // the street side of the host wall only; tested first, so a light on the far side
    // of a building costs no more than this
    const T4 = fetch(id, 4); // host wall plane: nx, nz, offset
    const sw = p.x.mul(T4.x).add(p.z.mul(T4.y)).sub(T4.z);
    If(sw.greaterThan(-0.12), () => {
      const wallK = smoothstep(-0.12, 0.12, sw);
      const T1 = fetch(id, 1); // power rgb, soft size squared
      const T2 = fetch(id, 2); // emission axis, lobe kind (0 omni, 1 one-sided, -1 two-sided)
      const T3 = fetch(id, 3); // half width, half height, flicker (mode + phase), unused
      // closest point on the panel (vertical rectangle across the axis)
      const ax = T2.xyz;
      const tv = normalize(vec3(ax.z, 0.0, ax.x.negate()).add(vec3(1e-4, 0.0, 0.0)));
      const cp = T0.xyz.add(tv.mul(clamp(dot(d, tv), T3.x.negate(), T3.x))).add(vec3(0.0, clamp(d.y, T3.y.negate(), T3.y), 0.0));
      const lv = cp.sub(p);
      const dl2 = dot(lv, lv).max(1e-4);
      const l = lv.mul(inverseSqrt(dl2));
      const f = dot(ax, l).negate();
      const lobe = select(T2.w.lessThan(-0.5), abs(f).mul(0.8).add(0.2), mix(float(1.0), clamp(f, 0.0, 1.0).mul(0.8).add(0.2), T2.w));
      const x = d2.div(R2);
      const win = oneMinus(x.mul(x)).max(0.0);
      const cosr = dot(nb, l).max(0.0);
      // most lights are steady: only the buzzing, faulty and fire ones pay for flicker()
      const fl = float(1.0).toVar();
      If(T3.z.greaterThanEqual(1.0), () => {
        fl.assign(flicker(fract(T3.z), floor(T3.z)));
      });
      E.addAssign(T1.rgb.mul(lobe.mul(win.mul(win)).mul(wallK).mul(cosr).mul(fl).div(dl2.add(T1.w))));
    });
  });
}

/** Irradiance from the local lights at p for the (detail) normal nb. */
export const localLight = Fn(([p, nb]) => {
  const E = vec3(0).toVar();
  const c = vec3(p.x.sub(LLU.rect.x).mul(LLU.rect.z), 0.0, p.z.sub(LLU.rect.y).mul(LLU.rect.w));
  If(c.x.greaterThanEqual(0.0).and(c.x.lessThan(LL.N)).and(c.z.greaterThanEqual(0.0)).and(c.z.lessThan(LL.N)), () => {
    const cx = int(floor(c.x));
    const cz = int(floor(c.z));
    Loop(LL.KH, ({ i }) => {
      const id = textureLoad(T_HIGH, ivec2(cx.mul(LL.KH).add(i), cz)).r;
      If(id.lessThan(0.0), () => {
        Break();
      });
      addLight(E, id, p, nb);
    });
    If(p.y.lessThan(LL.LOW_TOP), () => {
      Loop(LL.K, ({ i }) => {
        const id = textureLoad(T_LOW, ivec2(cx.mul(LL.K).add(i), cz)).r;
        If(id.lessThan(0.0), () => {
          Break();
        });
        addLight(E, id, p, nb);
      });
    });
  });
  return E;
});

/**
 * What shading code adds: the local irradiance at p for normal n, faded out with the
 * distance from the camera (the coarse light volume carries the light past that).
 */
export const localDiffuse = Fn(([p, n]) => {
  const k = localK(p);
  const E = vec3(0).toVar();
  If(k.greaterThan(0.001), () => {
    E.assign(localLight(p.add(n.mul(0.04)), n).mul(k.mul(LLU.gain)));
  });
  return E;
});

// ------------------------------------------------------------------ halos (post)
/** Lights handed to the haze pass each frame. */
export const HALO_N = 40;
const v4 = (): THREE.Vector4[] => Array.from({ length: HALO_N }, () => new THREE.Vector4());
export const HALO = {
  /** centre xyz, soft radius */
  a: uniformArray(v4(), 'vec4'),
  /** power rgb (already faded by rank), flicker (mode + phase) */
  b: uniformArray(v4(), 'vec4'),
  /** host wall plane nx, nz, offset (0, 0, -1: none), halo radius */
  c: uniformArray(v4(), 'vec4'),
  count: uniform(0),
};

/** CPU copy of the light list for the per-frame halo selection. */
interface LightSet {
  n: number;
  pos: Float32Array; // x y z
  col: Float32Array; // r g b power
  lum: Float32Array; // luminous power
  /** district haze density at the light (the zone map's alpha, 0..2) */
  zone: Float32Array;
  rs: Float32Array; // soft radius
  hr: Float32Array; // halo radius
  wall: Float32Array; // nx nz offset
  flick: Float32Array;
}
let SET: LightSet | null = null;

// ------------------------------------------------------------------ CPU bake
interface L {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  /** axis */
  ax: number;
  ay: number;
  az: number;
  lobe: number;
  hw: number;
  hh: number;
  /** soft size squared */
  s2: number;
  flick: number;
  wnx: number;
  wnz: number;
  wd: number;
  range: number;
  lum: number;
}

const pale = (c: readonly number[], k: number): [number, number, number] => [(c[0]! * 0.55 + 0.45) * k, (c[1]! * 0.55 + 0.45) * k, (c[2]! * 0.55 + 0.45) * k];

/** Light output of a sign: brightness times lit area (tubes cover part of a panel, a lightbox all of it). */
function signLight(s: SignSpec): L | null {
  if (s.flicker === 3) return null;
  const area = Math.max(0.2, s.w * s.h);
  const big = s.kind === 'screen' || (s.program ?? 0) > 0;
  // (an ad wall is mostly dark background round a few bright shapes)
  const cover = big ? 0.045 : s.kind === 'screen' ? 0.3 : s.kind === 'holo' ? 0.25 : s.lightbox ? 0.8 : s.kind === 'marquee' ? 0.5 : 0.32;
  // tubes and panels are about this bright on screen (signs.ts), times the share lit
  const k = s.intensity * cover * 0.6 * (s.flicker === 2 ? 0.7 : 1);
  // a screen shows changing pictures: its light is their average, paler than its accent colours
  const c: [number, number, number] = s.kind === 'screen' ? pale([(s.col[0] + s.col2[0]) * 0.5, (s.col[1] + s.col2[1]) * 0.5, (s.col[2] + s.col2[2]) * 0.5], 1) : s.lightbox ? pale(s.col, 1) : [s.col[0], s.col[1], s.col[2]];
  const P = k * area;
  const lum = P * (c[0] * 0.3 + c[1] * 0.55 + c[2] * 0.15);
  if (lum < 0.02) return null;
  const twoSided = s.twoSided || s.kind === 'holo';
  // neon stands off its board and the board off the wall: lift the light a little in front
  const lift = twoSided ? 0 : s.depth / 2 + 0.25 + 0.06 * Math.sqrt(area);
  const hasWall = s.wnx !== 0 || s.wnz !== 0;
  // the wall plane sits a little inside the wall face, so the wall itself is lit
  const wx = s.x - s.wnx * (s.arm + s.depth / 2);
  const wz = s.z - s.wnz * (s.arm + s.depth / 2);
  const range = big ? Math.min(70, 3 * Math.sqrt(P) + 15) : Math.min(30, Math.max(6, 3.2 * Math.sqrt(P) + 3));
  return {
    x: s.x + s.nx * lift,
    y: s.y,
    z: s.z + s.nz * lift,
    r: c[0] * P,
    g: c[1] * P,
    b: c[2] * P,
    ax: s.nx,
    ay: 0,
    az: s.nz,
    lobe: twoSided ? -1 : 1,
    hw: s.w / 2,
    hh: s.h / 2,
    s2: area / Math.PI,
    flick: (s.flicker === 1 ? 1 : s.flicker === 2 ? 2 : 0) + (s.seed % 1) * 0.99,
    wnx: hasWall ? s.wnx : 0,
    wnz: hasWall ? s.wnz : 0,
    wd: hasWall ? s.wnx * wx + s.wnz * wz - 0.25 : -1,
    range,
    lum,
  };
}

function pointLight(e: Emitter): L | null {
  const kind = e.src;
  const P = kind === 'lamp' ? 20 : kind === 'fire' ? 9 : 3;
  const r = e.r * P;
  const g = e.g * P;
  const b = e.b * P;
  const lum = r * 0.3 + g * 0.55 + b * 0.15;
  if (lum < 0.02) return null;
  return {
    x: e.x,
    y: e.y,
    z: e.z,
    r,
    g,
    b,
    ax: 0,
    ay: kind === 'lamp' ? -1 : 0,
    az: 0,
    lobe: kind === 'lamp' ? 1 : 0,
    hw: kind === 'festoon' ? 3 : 0.2,
    hh: 0.2,
    s2: kind === 'fire' ? 0.4 : 0.6,
    flick: kind === 'fire' ? 1 + ((e.x * 0.37 + e.z * 0.11) % 1 + 1) % 1 * 0.99 : 0,
    wnx: 0,
    wnz: 0,
    wd: -1,
    range: Math.min(28, Math.max(6, 3.4 * Math.sqrt(lum) + 4)),
    lum,
  };
}

/** Emitters drawn as local lights (also left out of the near ground map). */
export const LOCAL_SRC = new Set(['sign', 'lamp', 'fire', 'festoon']);

export interface LocalBake {
  lights: number;
  ms: number;
}

export function bakeLocalLights(spec: CitySpec, rect: { x0: number; z0: number; w: number; d: number }): LocalBake {
  const t0 = performance.now();
  const list: L[] = [];
  for (const s of spec.signs) {
    const l = signLight(s);
    if (l) list.push(l);
  }
  for (const e of spec.emitters) {
    if (e.src === 'lamp' || e.src === 'fire' || e.src === 'festoon') {
      const l = pointLight(e);
      if (l) list.push(l);
    }
  }
  // brightest first, so a capped list keeps what matters
  list.sort((a, b) => b.lum - a.lum);
  if (list.length > MAX_LIGHTS) list.length = MAX_LIGHTS;
  const n = list.length;

  // ---- light data
  const D = LTEX.data.image.data as Float32Array;
  D.fill(0);
  list.forEach((l, i) => {
    const row = Math.floor(i / LL.ROW);
    const o = (row * LL.ROW * LL.TPL + (i % LL.ROW) * LL.TPL) * 4;
    D.set([l.x, l.y, l.z, l.range, l.r, l.g, l.b, l.s2, l.ax, l.ay, l.az, l.lobe, l.hw, l.hh, l.flick, 0, l.wnx, l.wnz, l.wd, 0], o);
  });
  LTEX.data.needsUpdate = true;

  // ---- grids: per cell, the K lights with the most light there
  const N = LL.N;
  const size = Math.max(rect.w, rect.d);
  const cs = size / N;
  LLU.rect.value.set(rect.x0, rect.z0, 1 / cs, 1 / cs);
  const fill = (tex: THREE.DataTexture, K: number, high: boolean): void => {
    const ids = new Int32Array(N * N * K).fill(-1);
    const sc = new Float32Array(N * N * K);
    for (let i = 0; i < n; i++) {
      const l = list[i]!;
      if ((l.y >= LL.HIGH_Y) !== high) continue;
      const R = l.range;
      const i0 = Math.max(0, Math.floor((l.x - R - rect.x0) / cs));
      const i1 = Math.min(N - 1, Math.floor((l.x + R - rect.x0) / cs));
      const j0 = Math.max(0, Math.floor((l.z - R - rect.z0) / cs));
      const j1 = Math.min(N - 1, Math.floor((l.z + R - rect.z0) / cs));
      for (let j = j0; j <= j1; j++) {
        const cz0 = rect.z0 + j * cs;
        const dz = l.z < cz0 ? cz0 - l.z : l.z > cz0 + cs ? l.z - cz0 - cs : 0;
        for (let ii = i0; ii <= i1; ii++) {
          const cx0 = rect.x0 + ii * cs;
          const dx = l.x < cx0 ? cx0 - l.x : l.x > cx0 + cs ? l.x - cx0 - cs : 0;
          const dd = dx * dx + dz * dz;
          if (dd > R * R) continue;
          const s = l.lum / (dd + l.s2 + 1);
          const base = (j * N + ii) * K;
          let m = 0;
          for (let k = 1; k < K; k++) if (sc[base + k]! < sc[base + m]!) m = k;
          if (ids[base + m]! < 0 || s > sc[base + m]!) {
            ids[base + m] = i;
            sc[base + m] = s;
          }
        }
      }
    }
    const out = tex.image.data as Float32Array;
    const tmp: [number, number][] = [];
    for (let c = 0; c < N * N; c++) {
      tmp.length = 0;
      for (let k = 0; k < K; k++) if (ids[c * K + k]! >= 0) tmp.push([ids[c * K + k]!, sc[c * K + k]!]);
      tmp.sort((a, b) => b[1] - a[1]);
      const j = Math.floor(c / N);
      const i = c % N;
      for (let k = 0; k < K; k++) out[j * N * K + i * K + k] = k < tmp.length ? tmp[k]![0] : -1;
    }
    tex.needsUpdate = true;
  };
  fill(LTEX.low, LL.K, false);
  fill(LTEX.high, LL.KH, true);

  // ---- CPU copy for the halos
  SET = {
    n,
    pos: new Float32Array(n * 3),
    col: new Float32Array(n * 3),
    lum: new Float32Array(n),
    zone: new Float32Array(n),
    rs: new Float32Array(n),
    hr: new Float32Array(n),
    wall: new Float32Array(n * 3),
    flick: new Float32Array(n),
  };
  const zd = TEX.zone.image.data as Uint8Array;
  const Z = LV.Z;
  list.forEach((l, i) => {
    const zi = Math.min(Z - 1, Math.max(0, Math.floor(((l.x - rect.x0) / rect.w) * Z)));
    const zj = Math.min(Z - 1, Math.max(0, Math.floor(((l.z - rect.z0) / rect.d) * Z)));
    SET!.zone[i] = (zd[(zj * Z + zi) * 4 + 3] as number) / 127.5;
    SET!.pos.set([l.x, l.y, l.z], i * 3);
    SET!.col.set([l.r, l.g, l.b], i * 3);
    SET!.lum[i] = l.lum;
    SET!.rs[i] = Math.sqrt(l.s2) + 0.3;
    // the glow reaches a few metres round a sign or lamp, tens of metres round an ad wall
    SET!.hr[i] = Math.max(SET!.rs[i]! * 1.4, Math.min(8, 0.7 * Math.sqrt(l.lum) + 1));
    SET!.wall.set([l.wnx, l.wnz, l.wd], i * 3);
    SET!.flick[i] = l.flick;
  });
  return { lights: n, ms: performance.now() - t0 };
}

const _f = new THREE.Frustum();
const _m = new THREE.Matrix4();
const _s = new THREE.Sphere();
const best: { i: number; s: number }[] = [];

/**
 * Picks the lights whose glow in the air matters most to this view and hands them to
 * the haze pass. Lights near the cut fade instead of popping.
 */
export function updateHalos(camera: THREE.PerspectiveCamera): void {
  const S = SET;
  const cap = Math.max(0, Math.min(HALO_N, Math.round(LLU.halos.value)));
  if (!S || cap === 0) {
    HALO.count.value = 0;
    return;
  }
  camera.updateMatrixWorld();
  _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _f.setFromProjectionMatrix(_m);
  const cx = camera.position.x;
  const cy = camera.position.y;
  const cz = camera.position.z;
  best.length = 0;
  let minS = 0;
  for (let i = 0; i < S.n; i++) {
    const dx = S.pos[i * 3]! - cx;
    const dy = S.pos[i * 3 + 1]! - cy;
    const dz = S.pos[i * 3 + 2]! - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    const s = S.lum[i]! / Math.max(d2, 64);
    if (best.length >= cap && s <= minS) continue;
    _s.center.set(S.pos[i * 3]!, S.pos[i * 3 + 1]!, S.pos[i * 3 + 2]!);
    _s.radius = 10 + S.rs[i]! * 4;
    if (!_f.intersectsSphere(_s)) continue;
    best.push({ i, s });
    if (best.length > cap * 2) {
      best.sort((a, b) => b.s - a.s);
      best.length = cap + 1;
      minS = best[cap]!.s;
    }
  }
  best.sort((a, b) => b.s - a.s);
  const cut = best.length > cap ? best[cap]!.s : 0;
  const n = Math.min(cap, best.length);
  const A = HALO.a.array as THREE.Vector4[];
  const B = HALO.b.array as THREE.Vector4[];
  const C = HALO.c.array as THREE.Vector4[];
  const falloff = U.fogFalloff.value as number;
  for (let k = 0; k < n; k++) {
    const { i, s } = best[k]!;
    // fade the last few in and out as they cross the cut
    const fade = cut > 0 ? Math.min(1, Math.max(0, (s / cut - 1) / 0.6)) : 1;
    // a halo is something you see from across the street: right next to a light, its
    // glow fades out instead of veiling the whole view
    const dx = S.pos[i * 3]! - cx;
    const dy = S.pos[i * 3 + 1]! - cy;
    const dz = S.pos[i * 3 + 2]! - cz;
    const dc = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const nearK = Math.min(1, Math.max(0, (dc - 4) / 22));
    // the air's density at the light (district haze, thinning with height); a big
    // screen's glow is spread over its size, so it gets less per unit of power
    const rs = S.rs[i]!;
    const air = S.zone[i]! * 2 * Math.exp(-Math.max(0, S.pos[i * 3 + 1]!) * falloff);
    const k2 = (fade * nearK * nearK * (3 - 2 * nearK) * air) / (1 + rs * 0.25);
    A[k]!.set(S.pos[i * 3]!, S.pos[i * 3 + 1]!, S.pos[i * 3 + 2]!, rs);
    B[k]!.set(S.col[i * 3]! * k2, S.col[i * 3 + 1]! * k2, S.col[i * 3 + 2]! * k2, S.flick[i]!);
    C[k]!.set(S.wall[i * 3]!, S.wall[i * 3 + 1]!, S.wall[i * 3 + 2]!, S.hr[i]!);
  }
  HALO.count.value = n;
}
