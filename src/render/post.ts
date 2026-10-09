// @ts-nocheck -- TSL node graphs are dynamically typed.
/**
 * Post pipeline:
 *   scene pass (MRT: output, glow, velocity)
 *   -> volumetric haze: a jittered raymarch through height fog, 3D noise and
 *      the city light volume, at reduced resolution with a depth-aware upsample;
 *      plus the analytic in-scatter halos of the nearest bright local lights
 *      (closed-form single scattering per light, clipped by depth and the
 *      light's wall; see locallights.ts)
 *   -> + glow layer (neon, halos, steam, rain; already fogged per pixel)
 *   -> TRAA (temporal AA, also resolves the fog jitter)
 *   -> bloom -> grade -> chromatic aberration -> vignette -> film grain -> tone map.
 */
import * as THREE from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  exp,
  float,
  getScreenPosition,
  getViewPosition,
  int,
  interleavedGradientNoise,
  length,
  luminance,
  max,
  min,
  mix,
  mrt,
  normalize,
  oneMinus,
  output,
  pass,
  rtt,
  saturation,
  screenCoordinate,
  screenUV,
  select,
  smoothstep,
  step,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
  velocity,
  abs,
  dot,
  floor,
  fract,
  pow,
  time,
  atan,
  clamp,
  inverseSqrt,
} from 'three/tsl';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { ao as gtao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { film } from 'three/addons/tsl/display/FilmNode.js';
import { edgeChromaticAberration } from './chromatic';
import { U, flicker, hazeLight, lightAt, rainRipples, reflectedLight, skyColor, waterNormal, zoneAt } from './tsl';
import { HALO, HALO_N, LLU } from './locallights';
import { SKYMAP, skyVisibility } from './skymap';

/**
 * Tileable 3D value noise (two octaves), stored as a 2D atlas of 64 slices
 * (8 x 8 tiles of 64 x 64 with a wrapped one-texel gutter) and sampled with a
 * manual blend between slices: 3D textures do not upload on every WebGPU
 * implementation, 2D atlases do.
 */
const NS = 64;
const NT = 8;
const NTW = NS + 2;
function makeNoiseAtlas(): THREE.DataTexture {
  const size = NS;
  const lattice = (n: number, seed: number): Float32Array => {
    const a = new Float32Array(n * n * n);
    let s = seed >>> 0;
    for (let i = 0; i < a.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      a[i] = s / 4294967296;
    }
    return a;
  };
  const octave = (x: number, y: number, z: number, n: number, L: Float32Array): number => {
    const fx = (x / size) * n;
    const fy = (y / size) * n;
    const fz = (z / size) * n;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const ty = fy - iy;
    const tz = fz - iz;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const sz = tz * tz * (3 - 2 * tz);
    const at = (a: number, b: number, c: number): number => L[(a % n) + (b % n) * n + (c % n) * n * n]!;
    let v = 0;
    for (let k = 0; k < 8; k++) {
      const dx = k & 1;
      const dy = (k >> 1) & 1;
      const dz = (k >> 2) & 1;
      const w = (dx ? sx : 1 - sx) * (dy ? sy : 1 - sy) * (dz ? sz : 1 - sz);
      v += w * at(ix + dx, iy + dy, iz + dz);
    }
    return v;
  };
  const L1 = lattice(8, 17);
  const L2 = lattice(16, 91);
  const L3 = lattice(32, 7);
  const vol = new Float32Array(size * size * size);
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) vol[(z * size + y) * size + x] = octave(x, y, z, 8, L1) * 0.55 + octave(x, y, z, 16, L2) * 0.3 + octave(x, y, z, 32, L3) * 0.15;
  const W = NT * NTW;
  const data = new Uint8Array(W * W);
  for (let z = 0; z < size; z++) {
    const ox = (z % NT) * NTW;
    const oy = Math.floor(z / NT) * NTW;
    for (let y = 0; y < NTW; y++) {
      const sy = (y - 1 + size) % size;
      for (let x = 0; x < NTW; x++) {
        const sx = (x - 1 + size) % size;
        data[(oy + y) * W + ox + x] = Math.round(Math.min(1, Math.max(0, vol[(z * size + sy) * size + sx]!)) * 255);
      }
    }
  }
  const t = new THREE.DataTexture(data, W, W, THREE.RedFormat, THREE.UnsignedByteType);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.unpackAlignment = 1;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** Repeating 3D noise lookup in the atlas (p in noise periods). */
function noiseSampler(tex: THREE.DataTexture) {
  const node = texture(tex);
  return Fn(([p]) => {
    const q = fract(p);
    const layer = q.z.mul(NS).sub(0.5);
    const k0 = floor(layer);
    const f = layer.sub(k0);
    const a0 = k0.add(NS).mod(NS);
    const a1 = k0.add(NS + 1).mod(NS);
    const inTile = q.xy.mul(NS).add(1.0);
    const at = (k) => vec2(k.mod(NT).mul(NTW), floor(k.div(NT)).mul(NTW)).add(inTile).div(NT * NTW);
    return mix(node.sample(at(a0)).r, node.sample(at(a1)).r, f);
  });
}

const applyContrast = Fn(([color, amount]) => {
  const l = luminance(color);
  return mix(vec3(l), color, amount).max(0.0);
});

export interface PostOptions {
  traa: boolean;
  fogScale: number;
  fogSteps: number;
  bloom: boolean;
  /** Screen-space reflections on wet ground and water (null = off). */
  ssr: { steps: number; scale: number } | null;
  /** Ground-truth ambient occlusion (null = off): resolution scale and samples per pixel. */
  ao: { scale: number; samples: number } | null;
}

export interface PostHandle {
  pipeline: THREE.RenderPipeline;
  render: () => void;
  u: Record<string, { value: unknown }>;
  frame: () => void;
}

export function createPost(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, opts: PostOptions): PostHandle {
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera, { samples: 0 });
  scenePass.setMRT(mrt({ output, glow: vec4(0, 0, 0, 0), velocity }));
  const color = scenePass.getTextureNode('output');
  const glow = scenePass.getTextureNode('glow');
  const depth = scenePass.getTextureNode('depth');
  const vel = scenePass.getTextureNode('velocity');

  const camWorld = uniform(camera.matrixWorld);
  const camProjInv = uniform(camera.projectionMatrixInverse);
  const camPos = uniform(new THREE.Vector3());
  const frameJ = uniform(0);
  const maxDist = uniform(4500);
  // Night air is dark: the haze only glows where city light actually is (the light
  // volume), and otherwise just eats contrast with distance. Long rays converge to the
  // ambient terms below, so they must stay under the brightness of the dark walls and
  // the night sky, or distance piles up into a glowing wall (the "N64 horizon"). The
  // district tint and horizon glow are kept as faint ambients so the murk keeps its hue.
  const scatter = uniform(0.06);
  const fogAmb = uniform(0.01);
  /** How much of the horizon sky colour the haze takes on (light pollution). */
  const skyAmb = uniform(0.012);
  const noiseAmt = uniform(0.75);
  /** Halo strength: how much the air glows round signs and lamps (humid city air). */
  const haloGain = uniform(16);
  /** Forward scattering of the halos (0 even, toward 1 a light you look toward glows more). */
  const haloG = uniform(0.5);
  const fogOn = uniform(1);
  const res = uniform(new THREE.Vector2(1920, 1080));
  const noise3 = noiseSampler(makeNoiseAtlas());

  const steps = opts.fogSteps;
  const haze = Fn(() => {
    const d = depth.sample(screenUV).r;
    const vp = getViewPosition(screenUV, d, camProjInv);
    const wpos = camWorld.mul(vec4(vp, 1.0)).xyz;
    const ray = wpos.sub(camPos);
    const rlen = length(ray).max(0.001);
    const dir = ray.div(rlen);
    const tMax = min(rlen, maxDist);
    // faint horizon colour in this direction (the murk's ambient)
    const horizon = skyColor(normalize(vec3(dir.x, 0.05, dir.z))).toVar();
    const jit = fract(interleavedGradientNoise(screenCoordinate.xy).add(frameJ.mul(0.618034)));
    const T = float(1).toVar();
    const acc = vec3(0).toVar();
    const tPrev = float(0).toVar();
    // looking toward the light from above, its shafts glow more (forward scattering)
    const shaftPhase = mix(0.55, 1.8, smoothstep(0.1, 0.95, dot(dir, SKYMAP.dir))).toVar();
    Loop(steps, ({ i }) => {
      // toVar: TSL emits expressions where they are first used, so pin the step length
      // before tPrev is overwritten
      const k = float(i).add(jit).div(steps);
      const t = tMax.mul(k.mul(k)).toVar();
      const dt = t.sub(tPrev).max(0.0).toVar();
      tPrev.assign(t);
      const p = camPos.add(dir.mul(t));
      const z = zoneAt(p);
      const tint = z.rgb.mul(z.rgb);
      const h = max(p.y, 0.0);
      const n = noise3(p.mul(vec3(0.0042, 0.009, 0.0042)).add(vec3(time.mul(0.004), time.mul(-0.002), time.mul(0.003))));
      const n2 = noise3(p.mul(vec3(0.013, 0.02, 0.013)).sub(vec3(time.mul(0.009), 0, 0)));
      const nn = mix(1.0, n.mul(0.7).add(n2.mul(0.6)).add(0.1), noiseAmt);
      const dens = U.fogDensity.mul(z.a.mul(2.0)).mul(exp(h.mul(U.fogFalloff).negate())).mul(nn.mul(nn).mul(1.25));
      // (t is this sample's distance from the camera)
      const Lr = hazeLight(p, smoothstep(LLU.near, LLU.far, t));
      // soft-saturate very bright pockets (a packed neon strip) so the haze glows, not whites out
      const Lsat = Lr.div(dot(Lr, vec3(0.3, 0.5, 0.2)).mul(0.25).add(1.0));
      // light shafts: light from above, cut by the towers and bridges over this point
      const shaftL = vec3(0).toVar();
      If(U.shaft.greaterThan(0.0), () => {
        shaftL.assign(vec3(U.shaftColor).mul(skyVisibility(p)).mul(U.shaft).mul(shaftPhase));
      });
      const Ls = Lsat.mul(scatter).add(tint.mul(fogAmb)).add(horizon.mul(skyAmb)).add(vec3(U.fogColor).mul(0.008)).add(shaftL);
      const a = exp(dens.mul(dt).negate());
      acc.addAssign(Ls.mul(T).mul(a.oneMinus()));
      T.mulAssign(a);
    });
    // beyond the marched range: analytic height fog to the surface (or the far plane),
    // so distant ground sinks into the dark murk instead of ending at an edge
    const zEnd = zoneAt(camPos.add(dir.mul(tMax)));
    const tintEnd = zEnd.rgb.mul(zEnd.rgb);
    const b = U.fogFalloff;
    const dyb = dir.y.mul(b);
    const safe = select(abs(dyb).lessThan(1e-6), float(1e-6), dyb);
    const h0 = exp(max(camPos.y, 0.0).mul(b).negate());
    const tEnd = min(rlen, float(30000.0));
    const span = select(abs(dyb).lessThan(1e-6), max(tEnd.sub(tMax), 0.0), exp(dyb.mul(tMax).negate()).sub(exp(dyb.mul(tEnd).negate())).div(safe));
    const tauTail = U.fogDensity.mul(zEnd.a.mul(2.0)).mul(h0).mul(max(span, 0.0)).mul(0.8);
    const aTail = exp(tauTail.negate().max(-40.0));
    acc.addAssign(tintEnd.mul(fogAmb).add(horizon.mul(skyAmb)).add(vec3(U.fogColor).mul(0.008)).mul(T).mul(aTail.oneMinus()));
    T.mulAssign(aTail);

    // ---- halos: the glow of the brightest lights near the view in the air round them.
    // Single scattering from each light integrates in closed form along the ray (Sun et
    // al. 2005): with h the light's distance from the ray and s the distance along it
    // from the closest point, the integral of (1 + g cos)/(h^2 + s^2) is
    // atan(s/h)/h + g/sqrt(h^2 + s^2) (g > 0 scatters forward, so a light you look
    // toward glows more). The kernel used is the difference of two of those, one
    // softened by the light's size a and one by its halo radius R: it falls off as
    // 1/r^2 in between and much faster past R, so a halo stays round its light instead
    // of tinting the whole street. The ray ends at the surface it hits, and a sign only
    // lights the street side of its wall, so walls cut halos where they should.
    const tVis = min(rlen, float(20000.0));
    const glowAir = vec3(0).toVar();
    Loop(HALO_N, ({ i }) => {
      If(float(i).greaterThanEqual(HALO.count), () => {
        Break();
      });
      const A = HALO.a.element(i);
      const C = HALO.c.element(i);
      const oc = A.xyz.sub(camPos);
      const t0 = dot(oc, dir);
      const hh = dot(oc, oc).sub(t0.mul(t0)).max(0.0);
      // the visible part of the ray: up to the surface it hits, on the light's side of its wall
      const s0 = camPos.x.mul(C.x).add(camPos.z.mul(C.y)).sub(C.z);
      const ds = dir.x.mul(C.x).add(dir.z.mul(C.y));
      const tc = s0.negate().div(select(abs(ds).lessThan(1e-5), float(1e-5), ds));
      const front = s0.greaterThanEqual(0.0);
      const ta = select(front, float(0.0), select(ds.greaterThan(0.0), tc.max(0.0), tVis));
      const tb = select(front.and(ds.lessThan(0.0)), tc.min(tVis), tVis);
      // the closest that part comes to the light: past four halo radii the glow is under
      // a percent of its peak, so the work is skipped there (and faded out from three
      // radii, so the cut never shows). Most rays pass near only a few of the lights.
      const tm = clamp(t0, ta, tb);
      const dm2 = hh.add(t0.sub(tm).mul(t0.sub(tm)));
      const R2 = C.w.mul(C.w);
      If(dm2.lessThan(R2.mul(16.0)).and(tb.greaterThan(ta)), () => {
        const B = HALO.b.element(i);
        const h2 = hh.add(A.w.mul(A.w));
        const hi = inverseSqrt(h2);
        const H2 = hh.add(R2);
        const Hi = inverseSqrt(H2);
        const sa = ta.sub(t0);
        const sb = tb.sub(t0);
        const F = (s, q2, qi) => atan(s.mul(qi)).mul(qi).add(haloG.mul(inverseSqrt(q2.add(s.mul(s)))));
        const Fa = F(sa, h2, hi).sub(F(sa, H2, Hi));
        const Fb = F(sb, h2, hi).sub(F(sb, H2, Hi));
        const edge = oneMinus(smoothstep(R2.mul(9.0), R2.mul(16.0), dm2));
        // dimmed by the haze between the camera and the light
        const pm = camPos.add(dir.mul(tm));
        const Tm = exp(U.fogDensity.mul(2.4).mul(exp(max(pm.y.add(camPos.y).mul(0.5), 0.0).mul(U.fogFalloff).negate())).mul(tm).negate());
        const fl = float(1.0).toVar();
        If(B.w.greaterThanEqual(1.0), () => {
          fl.assign(flicker(fract(B.w), floor(B.w)));
        });
        glowAir.addAssign(B.rgb.mul(Fb.sub(Fa).max(0.0).mul(Tm).mul(fl).mul(edge)));
      });
    });
    acc.addAssign(glowAir.mul(U.fogDensity).mul(haloGain).mul(U.rain.mul(0.6).add(0.7)).mul(1.0 / (4.0 * Math.PI)));
    const dbgMode = new URLSearchParams(location.search).get('hdbg');
    if (dbgMode === 'tmax') return vec4(vec3(tMax.div(3000.0)), 0.0);
    if (dbgMode === 'zone') return vec4(zoneAt(camPos.add(dir.mul(200.0))).rgb, 0.0);
    if (dbgMode === 'light') return vec4(lightAt(camPos.add(dir.mul(tMax.mul(0.5)))).mul(0.25), 0.0);
    if (dbgMode === 'sky') return vec4(vec3(skyVisibility(camPos.add(dir.mul(min(tMax.mul(0.5), float(150.0)))))), 0.0);
    return vec4(acc, T);
  });

  const hazeTex = rtt(haze(), null, null, { type: THREE.HalfFloatType, resolutionScale: opts.fogScale });
  // depth-aware 4-tap upsample
  const upsample = Fn(() => {
    const uv = screenUV;
    const d0 = depth.sample(uv).r;
    const texel = vec2(1.0).div(res.mul(opts.fogScale));
    const s = vec4(0).toVar();
    const wsum = float(0).toVar();
    for (const [ox, oy] of [
      [-0.5, -0.5],
      [0.5, -0.5],
      [-0.5, 0.5],
      [0.5, 0.5],
    ]) {
      const q = uv.add(vec2(ox, oy).mul(texel));
      const dq = depth.sample(q).r;
      const w = float(1).div(abs(dq.sub(d0)).mul(400.0).add(0.02));
      s.addAssign(hazeTex.sample(q).mul(w));
      wsum.addAssign(w);
    }
    return s.div(wsum);
  });
  const fog = opts.fogScale >= 0.99 ? hazeTex.sample(screenUV) : upsample();
  const fogT = mix(1.0, fog.a, fogOn);
  const fogC = fog.rgb.mul(fogOn);

  // ---------------------------------------------------------------- reflections
  // Wet ground and water write their reflection weight k as (1 - alpha). For those
  // pixels a ray is marched along the mirrored view direction in world space with
  // growing steps, projected to the screen and tested against the depth buffer; a hit
  // returns the (hazed) scene colour plus the neon glow layer there. Misses fall back
  // to the sky and the light volume. A per-pixel jitter of the normal, resolved by
  // TRAA, stretches the reflections into streaks the way wet asphalt does.
  let reflected = vec3(0);
  U.ssrOn.value = opts.ssr ? 1 : 0;
  if (opts.ssr) {
    const camView = uniform(camera.matrixWorldInverse);
    const camProj = uniform(camera.projectionMatrix);
    const N = opts.ssr.steps;
    const growth = Math.pow(2600 / 0.8, 1 / N) * 0.985;
    const ssrPass = Fn(() => {
      const c = color.sample(screenUV);
      const k = oneMinus(c.a);
      const out = vec4(0).toVar();
      If(k.greaterThan(0.004), () => {
        const d = depth.sample(screenUV).r;
        const vp = getViewPosition(screenUV, d, camProjInv);
        const wp = camWorld.mul(vec4(vp, 1.0)).xyz.toVar();
        const V = normalize(wp.sub(camPos)).toVar();
        const ign = interleavedGradientNoise(screenCoordinate.xy);
        const j1 = fract(ign.add(frameJ.mul(0.618034))).sub(0.5);
        const j2 = fract(ign.mul(7.13).add(frameJ.mul(0.414214))).sub(0.5);
        const fwd = normalize(vec2(V.x, V.z).add(vec2(1e-4, 0.0)));
        const side = vec2(fwd.y.negate(), fwd.x);
        const n = vec3(0, 1, 0).toVar();
        If(wp.y.lessThan(-0.8), () => {
          const wn = waterNormal(wp, camPos);
          n.assign(normalize(wn.add(vec3(fwd.x.mul(j1).mul(0.03), 0.0, fwd.y.mul(j1).mul(0.03)))));
        }).Else(() => {
          const rip = rainRipples(wp.xz.mul(1.6)).mul(U.rain);
          // puddles (high k) are near mirrors, damp asphalt is rough
          const rough = mix(0.11, 0.012, smoothstep(0.12, 0.6, k));
          const jit = fwd.mul(j1.mul(rough.mul(2.0))).add(side.mul(j2.mul(rough.mul(0.45))));
          n.assign(normalize(vec3(rip.x.mul(0.35).add(jit.x), 1.0, rip.y.mul(0.35).add(jit.y))));
        });
        const R0 = V.sub(n.mul(dot(V, n).mul(2.0)));
        const R = normalize(vec3(R0.x, max(R0.y, float(0.004)), R0.z)).toVar();
        const p0 = wp.add(vec3(0.0, 0.05, 0.0));
        const t = float(0.8).toVar();
        const tPrev = float(0.0).toVar();
        const hit = float(0.0).toVar();
        const huv = vec2(0.5).toVar();
        Loop(N, () => {
          const pv = camView.mul(vec4(p0.add(R.mul(t)), 1.0)).xyz;
          If(pv.z.greaterThan(-1.0), () => {
            Break();
          });
          const suv = getScreenPosition(pv, camProj);
          If(suv.x.lessThan(0.0).or(suv.x.greaterThan(1.0)).or(suv.y.lessThan(0.0)).or(suv.y.greaterThan(1.0)), () => {
            Break();
          });
          const sz = getViewPosition(suv, depth.sample(suv).r, camProjInv).z;
          const diff = sz.sub(pv.z);
          const thick = t.sub(tPrev).mul(1.5).add(1.5);
          If(diff.greaterThan(0.0).and(diff.lessThan(thick)), () => {
            hit.assign(1.0);
            huv.assign(suv);
            Break();
          });
          tPrev.assign(t);
          t.assign(t.mul(growth).add(0.35));
        });
        If(hit.greaterThan(0.5), () => {
          // bisect toward the surface crossing
          const a = tPrev.toVar();
          const b = t.toVar();
          Loop(4, () => {
            const mid = a.add(b).mul(0.5);
            const pv = camView.mul(vec4(p0.add(R.mul(mid)), 1.0)).xyz;
            const suv = getScreenPosition(pv, camProj);
            const sz = getViewPosition(suv, depth.sample(suv).r, camProjInv).z;
            If(sz.sub(pv.z).greaterThan(0.0), () => {
              b.assign(mid);
              huv.assign(suv);
            }).Else(() => {
              a.assign(mid);
            });
          });
        });
        const edge = smoothstep(0.0, 0.07, min(min(huv.x, oneMinus(huv.x)), min(huv.y, oneMinus(huv.y))));
        const hz = hazeTex.sample(huv);
        const hitC = color.sample(huv).rgb.mul(mix(1.0, hz.a, fogOn)).add(hz.rgb.mul(fogOn)).add(glow.sample(huv).rgb);
        const fb = reflectedLight(wp, R);
        out.assign(vec4(mix(fb, hitC, hit.mul(edge)), 1.0));
      });
      return out;
    });
    const ssrTex = rtt(ssrPass(), null, null, { type: THREE.HalfFloatType, resolutionScale: opts.ssr.scale });
    const ssrScale = opts.ssr.scale;
    // depth-aware upsample that only trusts taps where reflections were computed
    const ssrUp = Fn(() => {
      const uv = screenUV;
      const d0 = depth.sample(uv).r;
      const texel = vec2(1.0).div(res.mul(ssrScale));
      const s = vec3(0).toVar();
      const wsum = float(0).toVar();
      for (const [ox, oy] of [
        [-0.5, -0.5],
        [0.5, -0.5],
        [-0.5, 0.5],
        [0.5, 0.5],
      ]) {
        const q = uv.add(vec2(ox, oy).mul(texel));
        const dq = depth.sample(q).r;
        const sm = ssrTex.sample(q);
        const w = sm.a.mul(float(1).div(abs(dq.sub(d0)).mul(400.0).add(0.02)));
        s.addAssign(sm.rgb.mul(w));
        wsum.addAssign(w);
      }
      return s.div(wsum.max(1e-5));
    });
    reflected = (ssrScale >= 0.99 ? ssrTex.sample(screenUV).rgb : ssrUp()).mul(oneMinus(color.a).max(0.0));
  }
  // ---------------------------------------------------------------- ambient occlusion
  // Ground-truth AO (Jimenez et al. 2016) from the depth buffer: creases, setbacks, the
  // foot of every wall and everything bolted onto one darken, so stacked and cluttered
  // forms read as solid instead of flat. It darkens the light that falls on surfaces,
  // not what glows: bright pixels (windows, signs, screens) are mostly emissive and keep
  // their light. TRAA resolves the AO's per-frame rotation into a smooth result.
  const aoStrength = uniform(opts.ao ? 0.85 : 0);
  let lit = color.rgb;
  let aoNode: ReturnType<typeof gtao> | null = null;
  if (opts.ao) {
    aoNode = gtao(depth, null, camera);
    aoNode.resolutionScale = opts.ao.scale;
    aoNode.samples.value = opts.ao.samples;
    aoNode.radius.value = 3.0;
    aoNode.thickness.value = 2.5;
    aoNode.scale.value = 1.15;
    aoNode.useTemporalFiltering = opts.traa;
    const aoTex = aoNode.getTextureNode();
    const aoV = aoTex.sample(screenUV).r;
    const sky = step(0.9999, depth.sample(screenUV).r);
    const glowing = smoothstep(0.35, 1.6, luminance(color.rgb));
    const k = mix(float(1.0), aoV, aoStrength.mul(oneMinus(glowing)).mul(oneMinus(sky)));
    lit = color.rgb.mul(k);
  }
  const composed = vec4(lit.add(reflected).mul(fogT).add(fogC).add(glow.rgb), 1.0);

  const dbg = new URLSearchParams(location.search).get('debug');
  if (dbg === 'fog') {
    pipeline.outputNode = vec4(fog.rgb.mul(4.0).add(vec3(fog.a.mul(0.25))), 1.0);
    return { pipeline, render: () => pipeline.render(), frame: () => {
      renderer.getDrawingBufferSize(res.value);
      (U.res.value as THREE.Vector2).copy(res.value);
      camera.updateMatrixWorld();
      camPos.value.setFromMatrixPosition(camera.matrixWorld);
    }, u: {} };
  }
  if (dbg === 'depth') {
    // raw view distance / 3000 m, no tone mapping (for depth-binned measurements)
    const vpD = getViewPosition(screenUV, depth.sample(screenUV).r, camProjInv);
    pipeline.outputNode = vec4(vec3(length(vpD).div(3000.0)), 1.0);
    pipeline.outputColorTransform = false;
    return { pipeline, render: () => pipeline.render(), frame: () => camera.updateMatrixWorld(), u: {} };
  }
  const aa = opts.traa ? traa(composed, depth, vel, camera) : composed;

  // bright signs glow round themselves (comps: night photos, where a lit sign carries a
  // soft halo of glare); a soft knee lets lightboxes and tubes just over the threshold
  // join in gradually instead of popping
  const bloomNode = bloom(aa, 0.75, 0.45, 0.82);
  bloomNode.smoothWidth.value = 0.12;
  const bloomOn = uniform(opts.bloom ? 1 : 0);
  const tint = uniform(new THREE.Vector3(1.0, 0.97, 1.03));
  // blacks stay black (comps: Akira's inky night, film-like density); a hair of cool lift only
  const lift = uniform(new THREE.Vector3(0.0, 0.0003, 0.0009));
  const sat = uniform(1.1);
  const contrast = uniform(1.08);
  const chroma = uniform(0.12);
  const vigInt = uniform(0.6);
  const grain = uniform(0.08);

  const hdr = aa.rgb.add(bloomNode.rgb.mul(bloomOn));
  let graded = hdr.mul(tint).add(lift);
  graded = saturation(graded, sat);
  graded = applyContrast(graded, contrast);
  const gradedOut = vec4(graded, 1.0);
  const ca = edgeChromaticAberration(gradedOut, chroma, float(3.5), vec2(0.5, 0.5));
  const withCA = mix(gradedOut, ca, step(float(0.001), chroma));
  const vd = length(screenUV.sub(vec2(0.5, 0.5))).mul(1.5);
  const vig = float(1).sub(smoothstep(0.55, 1.0, vd).mul(vigInt));
  pipeline.outputNode = film(vec4(withCA.rgb.mul(vig), 1.0), grain);

  let frameN = 0;
  return {
    pipeline,
    render: () => pipeline.render(),
    frame: () => {
      renderer.getDrawingBufferSize(res.value);
      (U.res.value as THREE.Vector2).copy(res.value);
      camera.updateMatrixWorld();
      camPos.value.setFromMatrixPosition(camera.matrixWorld);
      frameN = (frameN + 1) % 1024;
      frameJ.value = frameN;
    },
    u: { res, maxDist, scatter, fogAmb, skyAmb, noiseAmt, fogOn, haloGain, haloG, aoStrength, ...(aoNode ? { aoRadius: aoNode.radius, aoThickness: aoNode.thickness, aoScale: aoNode.scale } : {}), bloomOn, bloomStrength: bloomNode.strength, bloomRadius: bloomNode.radius, bloomThreshold: bloomNode.threshold, bloomKnee: bloomNode.smoothWidth, tint, lift, sat, contrast, chroma, vigInt, grain },
  };
}

void int;
void pow;
