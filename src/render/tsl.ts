// @ts-nocheck -- TSL node graphs are dynamically typed; the pure core is type-checked strictly.
/**
 * Shared TSL building blocks: global uniforms, hashes and noise, the sky, the
 * analytic height fog (for glow layers), the light volume lookups and the
 * common lighting function every city material uses.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  Loop,
  abs,
  atan,
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  floor,
  fract,
  int,
  length,
  log,
  max,
  min,
  mix,
  normalize,
  oneMinus,
  pow,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  time,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { LLU, localDiffuse, localK } from './locallights';

export const U = {
  fogColor: uniform(new THREE.Color(0.06, 0.035, 0.09)),
  /** Base extinction per metre at ground level (main.ts sets it from the haze dial). */
  fogDensity: uniform(0.0016),
  /**
   * Height falloff (1/m): a scale height of about 220 m, so the smog wraps the towers
   * too and they fade with distance instead of standing crisp above a thin ground fog.
   */
  fogFalloff: uniform(0.0045),
  camY: uniform(60),
  rain: uniform(0.6),
  wet: uniform(1),
  /** Global emissive multiplier (neon dial). */
  neon: uniform(1),
  skyZenith: uniform(new THREE.Color(0.002, 0.003, 0.011)),
  skyHorizon: uniform(new THREE.Color(0.05, 0.025, 0.06)),
  glowA: uniform(new THREE.Color(0.55, 0.07, 0.4)),
  glowB: uniform(new THREE.Color(0.03, 0.3, 0.55)),
  ambient: uniform(new THREE.Color(0.016, 0.018, 0.031)),
  lightGain: uniform(1),
  /** Light volume placement: x0, z0, 1/width, 1/depth. */
  volRect: uniform(new THREE.Vector4(-1500, -1500, 1 / 3000, 1 / 3000)),
  /** Light volume vertical mapping: h0, 1/log(1 + Hmax/h0). */
  volY: uniform(new THREE.Vector2(10, 1 / Math.log(1 + 420 / 10))),
  /** Exposure-like scale applied to all lit (non-emissive) shading. */
  litGain: uniform(1),
  /** Detail distance for expensive facade features. */
  detailDist: uniform(420),
  /** Brightness of lit interiors seen through windows. */
  winGain: uniform(2.1),
  /** 1 when screen-space reflections run; materials then tone down their own fake reflections. */
  ssrOn: uniform(0),
  /** City land rect (x0, z0, x1, z1). */
  cityRect: uniform(new THREE.Vector4(-1400, -1400, 1400, 1400)),
  /** Drawing buffer size in pixels (updated by the post pipeline each frame). */
  res: uniform(new THREE.Vector2(1280, 720)),
  /** Debug: force every LED screen to one scene (-1 = run the programme). */
  screenScene: uniform(-1),
  /** Debug: flat white fill light on every lit surface (?fill=0.5) to inspect materials. */
  fill: uniform(0),
  /**
   * The scene camera's position, set each frame. Post passes render with their own
   * quad camera, so anything that fades with distance from the viewer reads this
   * instead of cameraPosition.
   */
  camPos: uniform(new THREE.Vector3()),
  /** Light shafts: how much light comes down from above into the haze (0 = none; the hive). */
  shaft: uniform(0),
  /** Colour of the light from above. */
  shaftColor: uniform(new THREE.Color(0.3, 0.36, 0.48)),
};

/**
 * Light textures. Allocated once at a fixed size; a city rebuild rewrites their
 * contents in place (see lightvolume.ts), so every material keeps its bindings.
 */
export const LV = { W: 256, H: 32, D: 256, G: 1024, Z: 128 };

/**
 * The light volume is a 2D atlas: one W x D tile per height layer (with a
 * one-texel gutter so bilinear filtering never bleeds between tiles), sampled
 * with a manual blend between layers. 3D textures fail to upload on some WebGPU
 * implementations; 2D atlases work everywhere. Values are RGBA8 with a
 * square-root encoding (value = sample^2 * VOL_MAX); the bake's soft knee keeps
 * every value under VOL_MAX.
 */
export const VOL_MAX = 3.2;
export const VA = { tx: 8, ty: 4, tw: LV.W + 2, th: LV.D + 2, w: 8 * (LV.W + 2), h: 4 * (LV.D + 2) };

function makeVol(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(VA.w * VA.h * 4), VA.w, VA.h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
function makeMap(n: number, half: boolean): THREE.DataTexture {
  const t = half ? new THREE.DataTexture(new Uint16Array(n * n * 4), n, n, THREE.RGBAFormat, THREE.HalfFloatType) : new THREE.DataTexture(new Uint8Array(n * n * 4), n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export const TEX = {
  vol: makeVol(),
  /** Every street-level emitter: the pools of light seen from afar. */
  ground: makeMap(LV.G, true),
  /**
   * The same without the emitters drawn as local lights (signs, lamps, fires,
   * festoons): near the camera those light the ground themselves (locallights.ts).
   */
  groundNear: makeMap(LV.G, true),
  zone: makeMap(LV.Z, false),
};

export const T = {
  vol: texture(TEX.vol),
  ground: texture(TEX.ground),
  groundNear: texture(TEX.groundNear),
  zone: texture(TEX.zone),
};

// ---------------------------------------------------------------- hashes
/**
 * Assign a value to a variable at this point of the shader and return the
 * variable. TSL emits a shared expression where it is first used; when that is
 * inside one branch of an If, the other branches (and code after the If) read
 * it unset. Pin anything that several branches share before the If.
 */
export function pin(n, type = 'float') {
  const v = (type === 'vec2' ? vec2(0) : type === 'vec3' ? vec3(0) : type === 'vec4' ? vec4(0) : float(0)).toVar();
  v.assign(n);
  return v;
}

export const hash11 = Fn(([p_]) => {
  const p = fract(p_.mul(0.1031)).toVar();
  p.mulAssign(p.add(33.33));
  p.mulAssign(p.add(p));
  return fract(p);
});

export const hash12 = Fn(([p_]) => {
  const p3 = fract(vec3(p_.x, p_.y, p_.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

export const hash22 = Fn(([p_]) => {
  const p3 = fract(vec3(p_.x, p_.y, p_.x).mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.xx.add(p3.yz).mul(p3.zy));
});

export const hash13 = Fn(([p_]) => {
  const p3 = fract(p_.mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.zyx.add(31.32)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

// ------------------------------------------------------------------- noise
/** 2D value noise, 0..1. */
export const vnoise = Fn(([p]) => {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(vec2(3).sub(f.mul(2)));
  const a = hash12(i);
  const b = hash12(i.add(vec2(1, 0)));
  const c = hash12(i.add(vec2(0, 1)));
  const d = hash12(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

export const fbm2 = Fn(([p_]) => {
  const p = p_.toVar();
  const s = float(0).toVar();
  const a = float(0.5).toVar();
  Loop(4, () => {
    s.addAssign(vnoise(p).mul(a));
    p.assign(p.mul(2.03).add(vec2(17.1, 9.2)));
    a.mulAssign(0.5);
  });
  return s;
});

/** 3-octave fbm, cheaper. */
export const fbm3o = Fn(([p_]) => {
  const p = p_.toVar();
  const s = float(0).toVar();
  const a = float(0.5).toVar();
  Loop(3, () => {
    s.addAssign(vnoise(p).mul(a));
    p.assign(p.mul(2.07).add(vec2(5.3, 11.7)));
    a.mulAssign(0.5);
  });
  return s.div(0.875);
});

// ---------------------------------------------------------------------- sky
/** Night sky colour for a unit world direction; also the environment glass and water reflect. */
export const skyColor = Fn(([dir]) => {
  const y = dir.y;
  const t = clamp(y, 0, 1);
  const inv = oneMinus(t);
  // A city night sky is dark: light pollution is a thin, dim band low on the
  // horizon, far below the brightness of any window or sign (comps: night photos of
  // Chongqing and Hong Kong, Akira's Neo-Tokyo). It must also sit at or under the
  // brightness the far haze settles to, or the horizon reads as a glowing wall.
  const col = mix(vec3(U.skyZenith), vec3(U.skyHorizon).mul(0.38), pow(inv, 4.0)).toVar();
  const az = atan(dir.z, dir.x);
  const side = sin(az.add(0.7)).mul(0.5).add(0.5);
  const glowRaw = mix(vec3(U.glowA), vec3(U.glowB), side);
  // keep the district hue but not its full saturation: smog glow is muddy, not neon
  const glow = mix(vec3(dot(glowRaw, vec3(0.3, 0.5, 0.2))), glowRaw, 0.7);
  col.addAssign(glow.mul(pow(inv, 12.0)).mul(0.05));
  col.addAssign(glow.mul(pow(inv, 3.0)).mul(0.004));
  // low cloud deck lit from below by the city
  const cp = dir.xz.div(t.add(0.18)).mul(0.75);
  const cn = fbm2(cp.add(vec2(time.mul(0.004), time.mul(0.0015))));
  const cov = smoothstep(0.4, 0.78, cn).mul(smoothstep(0.02, 0.2, y));
  const cloudCol = glow.mul(0.022).add(vec3(0.0035, 0.0035, 0.006)).mul(mix(1.5, 0.35, t));
  col.assign(mix(col, cloudCol.add(col.mul(0.35)), cov.mul(0.85)));
  // a few stars through the gaps, high up (light pollution hides the rest)
  const sc = floor(dir.xz.div(t.add(0.05)).mul(220.0));
  const star = step(0.9982, hash12(sc)).mul(smoothstep(0.35, 0.7, y)).mul(oneMinus(cov));
  col.addAssign(vec3(0.5, 0.55, 0.7).mul(star).mul(0.4));
  return col;
});

const LAYERS = [
  { dist: 4200, hMax: 260, haze: 0.55, cols: 260, seed: 3.0 },
  { dist: 6000, hMax: 420, haze: 0.72, cols: 300, seed: 11.0 },
  { dist: 8500, hMax: 640, haze: 0.86, cols: 340, seed: 23.0 },
];

/**
 * Distant skyline silhouettes at three distances around the horizon, drawn into
 * the sky dome and into reflections. `camY` is the viewer's height.
 */
export const skyline = Fn(([dir, base, camY]) => {
  const col = base.toVar();
  const horiz = length(dir.xz).max(0.0001);
  const tanE = dir.y.div(horiz);
  const az = atan(dir.z, dir.x);
  for (let li = LAYERS.length - 1; li >= 0; li--) {
    const L = LAYERS[li];
    const u = az.div(6.2831853).add(0.5).mul(L.cols);
    const cell = floor(u);
    const fu = fract(u);
    const h = hash11(cell.add(L.seed));
    const h2 = hash11(cell.add(L.seed * 3.1 + 5.0));
    const heightM = float(0.12).add(h.mul(h).mul(0.88)).mul(L.hMax);
    // world height of this direction at the layer distance, relative to the camera
    const worldY = tanE.mul(L.dist).add(camY);
    const inside = step(worldY, heightM).mul(step(0.05, fu)).mul(step(fu, 0.95));
    // windows are far below a pixel out here: shade each building with soft bands of
    // lit floors instead of individual windows, so the horizon does not sparkle
    const band = vnoise(vec2(cell.mul(2.3).add(L.seed), worldY.div(16.0)));
    const litK = smoothstep(0.45, 0.85, band).mul(0.75).add(0.1).mul(smoothstep(0.0, 0.25, fu).mul(smoothstep(1.0, 0.75, fu)).mul(0.5).add(0.5));
    const warm = mix(vec3(1.0, 0.6, 0.3), vec3(0.45, 0.7, 1.0), step(0.5, h2));
    const win = warm.mul(litK).mul(oneMinus(L.haze)).mul(0.16);
    const tip = smoothstep(8.0, 0.0, heightM.sub(worldY)).mul(step(0.92, h2)).mul(step(0.45, fract(time.mul(0.6).add(h2.mul(7.0)))));
    const sil = mix(vec3(U.fogColor).mul(0.12), vec3(U.fogColor).mul(0.38), L.haze);
    const layerCol = sil.add(win).add(vec3(1.0, 0.1, 0.1).mul(tip).mul(0.8));
    col.assign(mix(col, layerCol, inside));
  }
  return col;
});

// ---------------------------------------------------------------------- fog
/** Transmittance of the analytic exponential height fog from the camera to `wpos`. */
export const fogTransmittance = Fn(([wpos]) => {
  const toP = wpos.sub(cameraPosition);
  const dist = length(toP).max(0.001);
  const dy = toP.y.div(dist);
  const b = U.fogFalloff;
  const x = dist.mul(dy).mul(b);
  const denom = b.mul(dy);
  const safe = select(abs(denom).lessThan(1e-6), float(1e-6), denom);
  const term = select(abs(x).lessThan(1e-3), dist, oneMinus(exp(x.negate())).div(safe));
  const camH = max(U.camY, float(0));
  const tau = U.fogDensity.mul(exp(camH.mul(b).negate())).mul(term);
  return clamp(exp(tau.negate().max(-60)), 0, 1);
});

/** Attenuate a purely emissive layer (blended over the scene) by the fog. */
export const fogAtten = Fn(([col, wpos]) => {
  return col.mul(fogTransmittance(wpos));
});

/**
 * Attenuation for point lights (lamps, beacons, traffic). A point of light is far
 * brighter than the walls round it, so through haze it fades to a dim point but stays
 * visible long after the walls are gone (comps: night photos of hazy cities). With the
 * haze as thick as it is, plain extinction would put out the far city's lights; the
 * softened curve keeps them about where they were under the old, thinner haze.
 */
export const pointAtten = Fn(([col, wpos]) => {
  return col.mul(pow(fogTransmittance(wpos), 0.6));
});

// -------------------------------------------------------------- light volume
/** Normalised (u, w, v) coordinates of a world position in the light volume. */
export const volCoord = Fn(([p]) => {
  const u = p.x.sub(U.volRect.x).mul(U.volRect.z);
  const v = p.z.sub(U.volRect.y).mul(U.volRect.w);
  const w = log(float(1).add(max(p.y, float(0)).div(U.volY.x))).mul(U.volY.y);
  return vec3(u, w, v);
});

/** Trilinear lookup in the layered light atlas at normalised (u, w, v). */
const volSample = Fn(([c]) => {
  const layer = clamp(c.y.mul(LV.H).sub(0.5), 0.0, LV.H - 1);
  const k0 = floor(layer);
  const k1 = min(k0.add(1.0), float(LV.H - 1));
  const f = layer.sub(k0);
  const inTile = vec2(clamp(c.x, 0.0, 1.0).mul(LV.W).add(1.0), clamp(c.z, 0.0, 1.0).mul(LV.D).add(1.0));
  const at = (k) => vec2(k.mod(VA.tx).mul(VA.tw), floor(k.div(VA.tx)).mul(VA.th)).add(inTile).div(vec2(VA.w, VA.h));
  const a = T.vol.sample(at(k0)).rgb;
  const b = T.vol.sample(at(k1)).rgb;
  const e = mix(a, b, f);
  return e.mul(e).mul(VOL_MAX);
});

/**
 * The ground light map at uv for a point p: near the camera without the sources the
 * local lights draw themselves, the full map farther out where those fade.
 */
const groundMap = (uvG, p) => mix(T.groundNear.sample(uvG).rgb, T.ground.sample(uvG).rgb, oneMinus(localK(p)));

/** The baked city light at p: the light volume, plus the ground map (`ground(uv)`) near the ground. */
const cityLight = (p, ground) => {
  const c = volCoord(p);
  const vol = volSample(c);
  // fine detail near the ground from the 2D map, fading with height
  const g = ground(vec2(c.x, c.z)).mul(exp(max(p.y, float(0)).mul(-0.16)));
  // nothing outside the baked rectangle (the textures clamp to their edge texels)
  const inside = smoothstep(0.0, 0.02, c.x).mul(smoothstep(1.0, 0.98, c.x)).mul(smoothstep(0.0, 0.02, c.z)).mul(smoothstep(1.0, 0.98, c.z));
  return vol.add(g).mul(U.lightGain).mul(inside);
};

/**
 * Coloured light from the city's emitters at a world position (linear RGB): what
 * reflections, specular and the glow layers see.
 */
export const lightAt = Fn(([p]) => cityLight(p, (uvG) => T.ground.sample(uvG).rgb));

/**
 * The same for diffuse lighting on surfaces: near the camera the ground map leaves out
 * the signs, lamps, fires and festoons, which light surfaces themselves there as local
 * lights (locallights.ts), so their light counts once.
 */
export const lightAtDiffuse = Fn(([p]) => cityLight(p, (uvG) => groundMap(uvG, p)));

/**
 * Light for the haze at p, with the ground map's share scaled by k. Near the camera a
 * street's own signs and lamps glow in the air as halos (post.ts), and the ground map
 * is little else at street level, so the haze fades its coarse copy of them out there.
 */
export const hazeLight = Fn(([p, k]) => cityLight(p, (uvG) => T.ground.sample(uvG).rgb.mul(k)));

/**
 * Street-level light from the fine 2D ground map only (lamp and shop-front pools),
 * for surfaces on the ground. Walls take the coarse volume through shade().
 */
export const groundAt = Fn(([p]) => {
  const c = volCoord(p);
  const inside = smoothstep(0.0, 0.02, c.x).mul(smoothstep(1.0, 0.98, c.x)).mul(smoothstep(0.0, 0.02, c.z)).mul(smoothstep(1.0, 0.98, c.z));
  return groundMap(vec2(c.x, c.z), p).mul(U.lightGain).mul(inside);
});

/** District fog tint (rgb) and density factor (a) at a world position. */
export const zoneAt = Fn(([p]) => {
  const c = vec2(p.x.sub(U.volRect.x).mul(U.volRect.z), p.z.sub(U.volRect.y).mul(U.volRect.w));
  return T.zone.sample(c);
});

// ------------------------------------------------------------------ lighting
export const fresnel = Fn(([ndv, f0]) => {
  const k = pow(oneMinus(clamp(ndv, 0, 1)), 5.0);
  return f0.add(oneMinus(f0).mul(k));
});

/**
 * Shared lighting: hemispheric ambient + light-volume spill for diffuse, a sky
 * and spill reflection for specular. `spec` is the specular weight (0 matte,
 * 1 polished), `rough` blurs the reflection toward the ambient.
 */
export const shade = Fn(([albedo, n, p, spec, rough, Eext]) => {
  const up = n.y.mul(0.5).add(0.5);
  const sky = vec3(U.skyHorizon).mul(0.25).add(vec3(U.ambient));
  const amb = mix(vec3(U.ambient).mul(0.6), sky, up);
  const L = lightAtDiffuse(p.add(n.mul(2.0)));
  const ao = mix(0.55, 1.0, smoothstep(0.0, 3.0, p.y));
  // walls are lit by the signs and lamps near them, not washed by them: the light
  // volume is coarse (13 m voxels), so its spill is kept low and knee'd (a packed
  // sign street must not flood whole facades) and the contrast comes from the
  // emitters themselves (comps: Tokyo and Hong Kong side streets at night). Near the
  // camera the signs and lamps light the surface directly (local lights), so the
  // coarse spill backs off there to what is left: bounce light and the window glow.
  const Lw = L.div(dot(L, vec3(0.3, 0.5, 0.2)).mul(0.8).add(1.0));
  const E = Eext ?? localDiffuse(p, n);
  const spillK = mix(float(0.17), LLU.spillNear, localK(p));
  const diffuse = albedo.mul(amb.add(Lw.mul(spillK)).add(U.fill).mul(ao).add(E));
  const V = normalize(cameraPosition.sub(p));
  const ndv = clamp(dot(n, V), 0.0, 1.0);
  const R = V.negate().sub(n.mul(dot(V.negate(), n).mul(2.0)));
  const env = skyColor(vec3(R.x, max(R.y, float(0.02)), R.z)).mul(oneMinus(rough).mul(0.8).add(0.2));
  const Ls = lightAt(p.add(R.mul(14.0)));
  const spill = Ls.div(dot(Ls, vec3(0.3, 0.5, 0.2)).mul(0.6).add(1.0)).mul(0.3);
  // roughness-aware Fresnel (Lagarde): rough concrete and tile do not turn into
  // mirrors at grazing angles, which is what washed whole sign streets out
  const F = float(0.04).add(max(oneMinus(rough), float(0.04)).sub(0.04).mul(pow(oneMinus(ndv), 5.0))).mul(spec);
  return diffuse.add(env.add(spill).mul(F)).mul(U.litGain);
});

// ------------------------------------------------------------------- water
/**
 * Harbour water normal. Waves are built in a view-aligned frame so they mostly
 * tilt the normal toward / away from the viewer, which stretches reflections into
 * vertical streaks the way water at night does. Shared by the water material and
 * the screen-space reflection pass.
 */
export const waterNormal = Fn(([wp, camPos]) => {
  const p = wp.xz;
  const t = time;
  const toCam = camPos.sub(wp);
  const dist = length(toCam);
  const fwd = normalize(vec2(toCam.x, toCam.z).negate().add(vec2(1e-4, 0.0)));
  const side = vec2(fwd.y.negate(), fwd.x);
  const swell = vnoise(p.mul(0.035).add(vec2(t.mul(0.04), t.mul(0.025))));
  const chop = vnoise(vec2(dot(p, fwd).mul(0.55), dot(p, side).mul(0.06)).add(vec2(t.mul(0.35), t.mul(0.05))));
  const fine = vnoise(vec2(dot(p, fwd).mul(1.9), dot(p, side).mul(0.25)).sub(vec2(t.mul(0.6), 0.0)));
  const far = smoothstep(900.0, 120.0, dist);
  const along = swell.sub(0.5).mul(0.05).add(chop.sub(0.5).mul(0.14).mul(far.mul(0.6).add(0.4))).add(fine.sub(0.5).mul(0.08).mul(far));
  const across = swell.sub(0.5).mul(0.04).add(chop.sub(0.5).mul(0.025));
  const rip = rainRipples(p.mul(0.9)).mul(U.rain).mul(far);
  const nxz = fwd.mul(along).add(side.mul(across)).add(rip.xy.mul(0.25));
  return normalize(vec3(nxz.x, 1.0, nxz.y));
});

/**
 * Light reflected along a mirrored ray R from a surface point: the sky, plus the
 * city light the ray passes 4, 14 and 40 m above the surface. The fallback for
 * reflections that screen space cannot resolve.
 */
export const reflectedLight = Fn(([wp, R]) => {
  const Ry = max(R.y, float(0.015));
  const dirR = vec3(R.x, Ry, R.z);
  const sky = skyline(dirR, skyColor(dirR), wp.y);
  const at = (h) => lightAt(wp.add(R.mul(float(h).div(Ry).min(900.0))));
  return sky.add(at(4.0).mul(0.22)).add(at(14.0).mul(0.15)).add(at(40.0).mul(0.1));
});

/**
 * Opaque materials get alpha forced to 1. Ground and water carry their reflection
 * weight in the output alpha for the post pass, so they use a blend mode that
 * simply overwrites (One, Zero), which keeps the alpha they write.
 */
export function keepAlpha(m: THREE.Material): void {
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.ZeroFactor;
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.ZeroFactor;
}

// ------------------------------------------------------------------- flicker
/** 0 steady, 1 buzz, 2 faulty (drops out), 3 dead, 4 aviation beacon, 5 chase. */
export const flicker = Fn(([phase, mode]) => {
  const t = time;
  const buzz = float(0.86).add(sin(t.mul(23.0).add(phase.mul(40.0))).mul(0.06)).add(sin(t.mul(3.1).add(phase.mul(9.0))).mul(0.08));
  const slot = floor(t.mul(6.0).add(phase.mul(50.0)));
  const r = hash11(slot.add(phase.mul(97.0)));
  const broken = select(r.greaterThan(0.7), float(0.05), float(1.0));
  const beacon = pow(max(sin(t.mul(2.4).add(phase.mul(6.283))), float(0)), 10.0).mul(1.8).add(0.03);
  const m = mode;
  return select(m.lessThan(0.5), float(1.0), select(m.lessThan(1.5), buzz, select(m.lessThan(2.5), broken, select(m.lessThan(3.5), float(0.02), beacon))));
});

/** Rain ripple normal for wet ground (adapted from Threejs-Punk, MIT; credits rocksdanister/rain). */
export const rainRipples = Fn(([uvCoord]) => {
  const p0 = floor(uvCoord);
  const t = time.mul(3.0);
  const circles = vec2(0).toVar();
  Loop({ start: int(-1), end: int(1), name: 'i', condition: '<=' }, ({ i }) => {
    Loop({ start: int(-1), end: int(1), name: 'j', condition: '<=' }, ({ j }) => {
      const pi = p0.add(vec2(i, j));
      const p = pi.add(hash22(pi));
      const tt = fract(float(0.3).mul(t).add(hash12(pi)));
      const v = p.sub(uvCoord);
      const d = length(v).sub(float(2).mul(tt));
      const h = float(0.001);
      const d1 = d.sub(h);
      const d2 = d.add(h);
      const p1 = sin(float(31).mul(d1)).mul(smoothstep(-0.6, -0.3, d1)).mul(smoothstep(0, -0.3, d1));
      const p2 = sin(float(31).mul(d2)).mul(smoothstep(-0.6, -0.3, d2)).mul(smoothstep(0, -0.3, d2));
      const fade = oneMinus(tt).mul(oneMinus(tt));
      const deriv = p2.sub(p1).div(h.mul(2)).mul(fade);
      circles.addAssign(normalize(v).mul(deriv).mul(0.5));
    });
  });
  circles.divAssign(9.0);
  const z = sqrt(max(oneMinus(dot(circles, circles)), float(0)));
  return vec3(circles, z);
});

export { vec4, min, step };
