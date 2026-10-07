// @ts-nocheck -- TSL node graphs are dynamically typed.
/**
 * Procedural surfaces: the noise, pattern and weathering building blocks the
 * city's materials are made of, and the lighting that lets their relief show.
 *
 * Comps: Night City's "multilayered" materials stack tileable surfaces (concrete,
 * painted metal, rust, dirt) through masks, and real weathering sits where water,
 * sun and hands put it: streaks run down from every ledge and sill, dirt splashes
 * up the foot of a wall, paint fades on the sunny side and wears off edges, rust
 * bleeds from fixings. Here every layer is a function of position, so nothing
 * tiles and nothing needs a texture:
 *  - value noise with analytic derivatives, so relief needs no screen-space
 *    derivatives (and no 2x2-quad blockiness), and fbm whose octaves fade to
 *    their mean below ~2 px so nothing sparkles,
 *  - cellular noise for cracks, stones and spots,
 *  - joint lines that keep their average coverage when they shrink below a pixel,
 *    so tiles, bricks, panels and pavers do not moire,
 *  - shadeN: the shared lighting with a detail normal and a cavity term.
 */
import {
  Fn,
  Loop,
  abs,
  cameraPosition,
  clamp,
  cos,
  dot,
  float,
  floor,
  fract,
  exp,
  int,
  max,
  min,
  mix,
  normalize,
  oneMinus,
  pow,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  vec2,
  vec3,
} from 'three/tsl';
import { U, groundAt, hash12, hash22, lightAt, lightAtDiffuse, skyColor, vnoise } from './tsl';
import { LLU, localDiffuse, localK } from './locallights';
import { ATLAS, glyphAtlas } from './glyphatlas';

/** Perceived brightness of a linear colour. */
export const lum = (c) => dot(c, vec3(0.3, 0.59, 0.11));

/** Move a colour toward its own grey by k. */
export const desat = (c, k) => mix(c, vec3(lum(c)), k);

// ------------------------------------------------------------------- noise
/** Value noise with analytic derivatives: vec3(value 0..1, d/dx, d/dy). */
export const vnoiseD = Fn(([p]) => {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(vec2(3.0).sub(f.mul(2.0)));
  const du = f.mul(oneMinus(f)).mul(6.0);
  const a = hash12(i);
  const b = hash12(i.add(vec2(1, 0)));
  const c = hash12(i.add(vec2(0, 1)));
  const d = hash12(i.add(vec2(1, 1)));
  const k1 = b.sub(a);
  const k2 = c.sub(a);
  const k4 = a.sub(b).sub(c).add(d);
  const v = a.add(k1.mul(u.x)).add(k2.mul(u.y)).add(k4.mul(u.x).mul(u.y));
  return vec3(v, du.x.mul(k1.add(k4.mul(u.y))), du.y.mul(k2.add(k4.mul(u.x))));
});

/**
 * Four octaves of value noise with derivatives. `fp` is the pixel footprint in
 * noise units: octaves finer than ~2 px fade to their mean and lose their slope.
 * Returns vec3(value 0..1 centred on 0.5, d/dx, d/dy).
 */
export const fbmD = Fn(([p_, fp]) => {
  const p = p_.toVar();
  const s = vec3(0).toVar();
  const a = float(0.5).toVar();
  const fr = float(1).toVar();
  Loop(4, () => {
    const w = smoothstep(0.5, 0.2, fr.mul(fp));
    const nd = vnoiseD(p);
    s.addAssign(vec3(mix(float(0.5), nd.x, w), nd.y.mul(w).mul(fr), nd.z.mul(w).mul(fr)).mul(a));
    p.assign(p.mul(2.03).add(vec2(17.1, 9.2)));
    fr.mulAssign(2.03);
    a.mulAssign(0.5);
  });
  return s.div(0.9375);
});

/** Three octaves of filtered value noise (no derivatives): 0..1 centred on 0.5. */
export const fbmF = Fn(([p_, fp]) => {
  const p = p_.toVar();
  const s = float(0).toVar();
  const a = float(0.5).toVar();
  const fr = float(1).toVar();
  Loop(3, () => {
    const w = smoothstep(0.5, 0.2, fr.mul(fp));
    s.addAssign(mix(float(0.5), vnoise(p), w).mul(a));
    p.assign(p.mul(2.07).add(vec2(5.3, 11.7)));
    fr.mulAssign(2.07);
    a.mulAssign(0.5);
  });
  return s.div(0.875);
});

/** Cellular noise: vec2(F1, F2), distances to the nearest two feature points (cell units). */
export const cellular = Fn(([p]) => {
  const i = floor(p);
  const f = fract(p);
  const F1 = float(8.0).toVar();
  const F2 = float(8.0).toVar();
  Loop({ start: int(-1), end: int(1), name: 'cx', condition: '<=' }, ({ cx }) => {
    Loop({ start: int(-1), end: int(1), name: 'cy', condition: '<=' }, ({ cy }) => {
      const o = vec2(cx, cy);
      const r = o.add(hash22(i.add(o))).sub(f);
      const d = dot(r, r);
      F2.assign(min(F2, max(F1, d)));
      F1.assign(min(F1, d));
    });
  });
  return vec2(sqrt(F1), sqrt(F2));
});

// ---------------------------------------------------------------- patterns
/**
 * Coverage of joint lines repeating every `period` along x (half width hw, all in
 * metres like mpp, the pixel footprint). Antialiased; when the period shrinks
 * toward 2 px the pattern fades to its mean coverage instead of moireing.
 */
export const joints = (x, period, hw, mpp) => {
  const P = float(period);
  const H = float(hw);
  const d = abs(fract(x.div(P).add(0.5)).sub(0.5)).mul(P);
  const w = max(H, mpp.mul(0.5));
  const cov = smoothstep(w.add(mpp.mul(0.5)), w.sub(mpp.mul(0.5)), d).mul(H.div(w));
  return mix(cov, H.mul(2.0).div(P), smoothstep(P.mul(0.18), P.mul(0.42), mpp));
};

/**
 * A bond of units w x h (bricks, tiles, panels, pavers, slabs) on a plane (x
 * along, y up). `shift` offsets every other row by that fraction of a unit
 * (0.5 = running bond). Returns { id (vec2 unit index), f (vec2 position in the
 * unit, 0..1), joint (0..1 coverage of the joint lines) }.
 */
export const bond = (x, y, w, h, hw, mpp, shift = 0.0) => {
  const row = floor(y.div(h));
  const xs = x.add(fract(row.mul(0.5)).mul(2.0).mul(float(shift)).mul(w));
  const id = vec2(floor(xs.div(w)), row);
  const f = vec2(fract(xs.div(w)), fract(y.div(h)));
  const joint = max(joints(xs, w, hw, mpp), joints(y, h, hw, mpp));
  return { id, f, joint };
};

/** A thin line at distance d (metres) of half width hw, antialiased, keeping its energy below a pixel. */
export const lineAA = (d, hw, mpp) => {
  const H = float(hw);
  const w = max(H, mpp.mul(0.6));
  return smoothstep(w.add(mpp.mul(0.4)), w.sub(mpp.mul(0.4)).max(0.0), abs(d)).mul(H.div(w));
};

/** Vertical streaks: noise stretched down a surface (x across, y down, metres), 0..1. */
export const streakNoise = (x, y, sx, sy) =>
  vnoise(vec2(x.mul(sx), y.mul(sy))).mul(0.65).add(vnoise(vec2(x.mul(sx * 2.7).add(3.1), y.mul(sy * 1.9).add(7.7))).mul(0.35));

/**
 * Graffiti letters (a "throw-up"): a short word of fat, slanted, wobbly Latin
 * letters taken from the sign glyph atlas. tx is metres along the piece (from its
 * left end), y metres up, yb the baseline, lh the letter height, key a 0..1 seed,
 * n the letter count. Returns vec3(fill, outline, height in the letter 0..1).
 */
export const throwUp = (tx, y, yb, lh, key, n, mpp) => {
  const atlas = glyphAtlas();
  const lw = lh.mul(0.64);
  const k = floor(tx.div(lw));
  const fx = fract(tx.div(lw));
  const fy = y.sub(yb).div(lh);
  const inside = step(0.0, fy).mul(step(fy, 1.0)).mul(step(0.0, tx)).mul(step(k, n.sub(1.0)));
  const wob = vnoise(vec2(tx.mul(2.5), y.mul(2.5)).add(key.mul(40.0))).sub(0.5).mul(0.14);
  const qx = fx.add(fy.sub(0.5).mul(0.24)).add(wob);
  const qy = fy.add(wob.mul(0.6));
  const id = floor(hash12(vec2(k, key.mul(97.0))).mul(26.0));
  const cu = id.mod(ATLAS.cells);
  const cv = floor(id.div(ATLAS.cells));
  const q = vec2(qx, qy).mul(0.84).add(0.08).clamp(0.02, 0.98);
  const d = texture(atlas, vec2(cu.add(q.x), cv.add(q.y)).div(ATLAS.cells)).level(0).r.mul(ATLAS.dmax);
  // glyph units per pixel: the cell's 5 units span about 1.2 letter heights
  const soft = max(mpp.div(lh).mul(4.2), float(0.03));
  const fill = smoothstep(soft.add(0.82), float(0.82).sub(soft), d);
  const outline = smoothstep(soft.add(1.12), float(1.12).sub(soft), d).mul(oneMinus(fill));
  return vec3(fill, outline, fy).mul(vec3(inside, inside, 1.0));
};

// ------------------------------------------------------------------ relief
/** Perturb unit normal n by height slopes gu (along tangent t) and gv (along bitangent b), metres per metre. */
export const bumpN = (n, t, b, gu, gv) => normalize(n.sub(t.mul(gu)).sub(b.mul(gv)));

/**
 * Where the light on a surface most likely comes from at night: walls are lit
 * from the street below and in front (lamps, shop fronts, signs, headlights),
 * high walls from below; floors from above.
 */
export const nightLightDir = (n, p) => {
  const wallK = oneMinus(abs(n.y));
  const fromBelow = mix(float(0.15), float(-0.7), smoothstep(5.0, 28.0, p.y));
  return normalize(n.mul(0.8).add(vec3(0.0, fromBelow.mul(wallK).add(oneMinus(wallK).mul(0.6)), 0.0)));
};

/**
 * The shared lighting (shade() in tsl.ts) with a detail normal nb, a cavity term
 * and an assumed light direction Ld. The light volume is coarse and carries no
 * direction, so relief is shaded as the ratio of nb to the flat surface under Ld:
 * the overall level stays where the volume puts it, and the relief shows where
 * the light is. Reflections and Fresnel use nb.
 *
 * Near the camera the signs, lamps and fires round the point light it directly
 * (locallights.ts), each from its own direction, so relief catches each of them. A
 * material that shades several layers at one point (the facade) computes that light
 * once and passes it as Eext (then the Ld relief ratio applies to it).
 */
export const shadeN = Fn(([albedo, n, nb, p, spec, rough, cav, Ld, Eext]) => {
  const upK = nb.y.mul(0.5).add(0.5);
  const sky = vec3(U.skyHorizon).mul(0.25).add(vec3(U.ambient));
  const amb = mix(vec3(U.ambient).mul(0.6), sky, upK);
  const L = lightAtDiffuse(p.add(n.mul(2.0)));
  const ao = mix(0.55, 1.0, smoothstep(0.0, 3.0, p.y)).mul(cav);
  const Lw = L.div(dot(L, vec3(0.3, 0.5, 0.2)).mul(0.8).add(1.0));
  const rel = clamp(dot(nb, Ld).add(0.3).div(max(dot(n, Ld).add(0.3), float(0.05))), 0.3, 2.0);
  // the pools of light that shop fronts and lamps throw on the street (the fine ground
  // map) also light the first few metres of the walls and things standing round them
  const wallK = smoothstep(0.3, 0.7, oneMinus(abs(n.y)));
  const footL = groundAt(p.add(n.mul(1.2))).mul(exp(max(p.y.sub(0.5), float(0.0)).mul(-0.45))).mul(0.22).mul(wallK);
  const spillK = mix(float(0.17), LLU.spillNear, localK(p));
  const Eloc = Eext === undefined ? localDiffuse(p, nb) : Eext.mul(rel);
  const diffuse = albedo.mul(amb.add(Lw.mul(spillK).add(footL).add(U.fill).mul(rel)).mul(ao).add(Eloc.mul(cav)));
  const V = normalize(cameraPosition.sub(p));
  const ndv = clamp(dot(nb, V), 0.0, 1.0);
  const R = V.negate().sub(nb.mul(dot(V.negate(), nb).mul(2.0)));
  const env = skyColor(vec3(R.x, max(R.y, float(0.02)), R.z)).mul(oneMinus(rough).mul(0.8).add(0.2));
  const Ls = lightAt(p.add(R.mul(14.0)));
  const spill = Ls.div(dot(Ls, vec3(0.3, 0.5, 0.2)).mul(0.6).add(1.0)).mul(0.3);
  const F = float(0.04).add(max(oneMinus(rough), float(0.04)).sub(0.04).mul(pow(oneMinus(ndv), 5.0))).mul(spec);
  // cavities also hold back reflections (a crack or joint does not mirror the sky)
  return diffuse.add(env.add(spill).mul(F).mul(cav)).mul(U.litGain);
});
