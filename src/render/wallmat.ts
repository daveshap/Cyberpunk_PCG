// @ts-nocheck -- TSL node graphs are dynamically typed.
/**
 * Facade walls: what each facade style is built from and the weathering every
 * wall collects. Called from the facade material with the wall's frame, its
 * window grid and the pixel footprint; returns albedo, a detail normal, specular,
 * roughness, cavity and wetness for shadeN().
 *
 * Substrates (per style, varied per building by its seed):
 *  - glass: dark spandrel glass and anodised mullions with a rounded cap,
 *  - panel: cladding panels with sealant joints, fixings, per-panel tone and bow,
 *  - grid / shop / balcony: small glazed mosaic tiles (the Hong Kong tower look),
 *    painted render with a stucco grain that peels, or brick,
 *  - metal: corrugated sheet with laps, fixings and rust,
 *  - raw: cast concrete with formwork panels or boards, tie holes, bugholes and
 *    lift lines,
 *  - lux: polished or honed stone slabs (marble, travertine or granite).
 * Fittings: downpipes beside some bay lines (a bracket at every floor, a leak
 * streak) and a ledge under each punched window.
 * Weathering (scaled by the facade's grime, never quite zero): runoff from the
 * roof edge, with lighter washed streaks beside the dark ones, streaks from every
 * sill (strongest at the sill ends), air conditioner drips, damp and splash at
 * the foot of the wall with a salt tide line, efflorescence under lift lines,
 * dirty corners, pollution mottling, sun fade on the south side and higher up,
 * patch repairs, cracks from window corners and map cracking, moss along the wet
 * streaks, and posters and graffiti at street level. Everything finer than ~2 px
 * fades to its average, so walls stay calm from the air.
 */
import { If, abs, clamp, cos, exp, float, floor, fract, length, max, min, mix, normalize, oneMinus, select, sin, smoothstep, step, vec2, vec3 } from 'three/tsl';
import { U, hash12, hash22, pin, vnoise } from './tsl';
import { bond, bumpN, cellular, desat, fbmD, fbmF, joints, lineAA, lum, streakNoise, throwUp } from './surface';

const UP = vec3(0, 1, 0);

/** Surface kinds written to `kind` (posters, patches and cracks key on them). */
const K = { glass: 0, panel: 1, tile: 2, render: 3, brick: 4, metal: 5, concrete: 6, stone: 7 };

/** Pick one of six colours by a 0..1 key. */
const pick6 = (k, c) =>
  select(k.lessThan(0.17), c[0], select(k.lessThan(0.34), c[1], select(k.lessThan(0.5), c[2], select(k.lessThan(0.67), c[3], select(k.lessThan(0.84), c[4], c[5])))));

export function wallSurface(c) {
  // pin every input the branches share (TSL emits an expression where it is first used)
  const u = pin(c.u);
  const v = pin(c.v);
  const vf = pin(c.vf);
  const wy = pin(c.wy);
  const n = pin(c.n, 'vec3');
  const tng = pin(c.tng, 'vec3');
  const mpp = pin(c.mpp);
  const near = pin(c.near);
  const base = pin(c.base, 'vec3');
  const fhE = pin(c.fhE);
  const bwE = pin(c.bwE);
  const sx0 = pin(c.sx0);
  const sx1 = pin(c.sx1);
  const sy0 = pin(c.sy0);
  const sy1 = pin(c.sy1);
  const inShop = pin(c.inShop);
  const { cu, cv, fu, fv, style, seed, grime, tierH, wlen } = c;

  const alb = vec3(0).toVar();
  const gu = float(0).toVar();
  const gv = float(0).toVar();
  const tilt = vec2(0).toVar();
  const spec = float(0.05).toVar();
  const rough = float(0.85).toVar();
  const cav = float(1).toVar();
  const paint = float(0).toVar();
  const porous = float(1).toVar();
  const rustK = float(0).toVar();
  const kind = float(K.render).toVar();
  alb.assign(base);

  // per-building variants
  const hF = pin(hash12(vec2(seed.mul(71.3), 4.1)));
  const hC = pin(hash12(vec2(seed.mul(13.7), 8.3)));
  const hS = pin(hash12(vec2(seed.mul(29.1), 2.6)));
  const P = pin(vec2(u, v), 'vec2');

  // ------------------------------------------------------------- weathering masks
  const g = grime;
  // runoff from the roof edge: long streaks, darkest near the top
  const dTop = max(tierH.sub(v), float(0.0));
  const runL = mix(6.0, 24.0, hash12(vec2(seed.mul(3.3), 1.1)));
  const runN = streakNoise(u, dTop, 0.9, 0.03);
  const runFine = mix(streakNoise(u.add(7.0), dTop, 4.0, 0.12), float(0.5), smoothstep(0.04, 0.12, mpp));
  const run = pin(exp(dTop.negate().div(runL)).mul(smoothstep(0.38, 0.85, runN.mul(0.7).add(runFine.mul(0.3)))).add(smoothstep(1.0, 0.0, dTop).mul(0.35)));

  // sill streaks: from the window above (over the lintel) and this window (down the spandrel),
  // strongest at the sill ends where water runs off
  const hasSills = step(0.5, style).mul(oneMinus(inShop));
  const belowSill = step(fv, sy0);
  const overLintel = step(sy1, fv);
  const dS = select(belowSill.greaterThan(0.5), sy0.sub(fv), float(1.0).add(sy0).sub(fv)).mul(fhE);
  const srcV = cv.add(overLintel);
  const wh = hash12(vec2(cu.add(seed.mul(41.0)), srcV.add(seed.mul(17.0))));
  const wh2 = hash12(vec2(cu.add(seed.mul(13.0)), srcV.add(seed.mul(29.0))).add(2.2));
  const xw = fu.sub(sx0).div(max(sx1.sub(sx0), float(0.05)));
  const env = smoothstep(-0.1, 0.04, xw).mul(smoothstep(1.1, 0.96, xw));
  const ends = exp(xw.mul(xw).div(-0.006)).add(exp(oneMinus(xw).mul(oneMinus(xw)).div(-0.006)));
  // thin streaks (~9 cm) with ragged edges that narrow as they run down
  const sL = mix(0.5, 2.4, wh2).mul(g.add(0.5));
  const sNm = streakNoise(u, dS, 11.0, 0.6).mul(0.8).add(vnoise(vec2(u.mul(31.0), dS.mul(1.2))).mul(0.2));
  const sN = mix(smoothstep(float(0.5).add(dS.div(sL).mul(0.12)), 0.8, sNm), float(0.22), smoothstep(0.03, 0.09, mpp));
  const sillRaw = exp(dS.negate().div(sL)).mul(sN.mul(0.75).add(ends.mul(0.6))).mul(env).mul(step(0.3, wh)).mul(max(belowSill, overLintel)).mul(hasSills);
  const sill = pin(mix(sillRaw, g.mul(0.08).add(0.03).mul(hasSills), smoothstep(0.15, 0.45, mpp)));
  // an air conditioner's drip off one side of the sill: a narrow rusty stain
  const acOn = step(wh2, 0.3).mul(hasSills);
  const acX = select(wh.greaterThan(0.6), sx0.add(0.1), sx1.sub(0.1));
  const acD = abs(fu.sub(acX)).mul(bwE).add(vnoise(vec2(dS.mul(4.0), cu)).sub(0.5).mul(0.05));
  const drip = smoothstep(0.06, 0.015, acD).mul(exp(max(dS.sub(0.6), float(0.0)).negate().div(1.4))).mul(step(0.6, dS)).mul(acOn).mul(max(belowSill, overLintel)).mul(smoothstep(0.05, 0.02, mpp));

  // damp and splash at the foot of the wall, with a salt tide line on porous walls
  const bandH = mix(0.3, 1.2, hash12(vec2(seed.mul(7.7), 3.3))).mul(g.mul(0.8).add(0.4));
  const edge = bandH.mul(vnoise(vec2(u.mul(1.4), seed.mul(9.0))).mul(0.5).add(0.75));
  const damp = pin(smoothstep(edge.add(0.06), edge.sub(0.06), wy));
  const tz = pin(wy.sub(edge).div(0.035));
  const splash = smoothstep(0.45, 0.0, wy).mul(mix(smoothstep(0.55, 0.8, fbmF(vec2(u, wy).mul(14.0), mpp.mul(14.0))), float(0.3), smoothstep(0.01, 0.04, mpp)));

  // dirty corners: water runs down the building's edges
  const dEdge = min(u, wlen.sub(u));
  const corner = exp(dEdge.negate().div(0.5)).mul(streakNoise(u.mul(3.0), v, 2.0, 0.1).mul(0.6).add(0.4));

  // ------------------------------------------------------------- substrates
  If(style.lessThan(0.5), () => {
    // curtain wall: dark spandrel glass between anodised mullions with a rounded cap
    const dm = min(fu, oneMinus(fu)).mul(bwE);
    const mw = max(bwE.mul(0.035), float(0.05));
    const mull = smoothstep(mw.add(mpp), mw.sub(mpp), dm);
    const capK = smoothstep(0.08, 0.025, mpp);
    gu.assign(clamp(dm.div(mw), 0.0, 1.0).mul(0.5).mul(select(fu.lessThan(0.5), float(-1.0), float(1.0))).mul(mull).mul(capK));
    const ph = hash12(vec2(cu, cv).add(seed.mul(37.0)));
    const ph2 = hash12(vec2(cu, cv).add(seed.mul(11.0)).add(2.1));
    const metal = mix(base, vec3(0.08, 0.085, 0.09), 0.6).mul(1.15);
    alb.assign(mix(base.mul(0.4).mul(mix(0.9, 1.1, ph)), metal, mull));
    tilt.assign(vec2(ph.sub(0.5), ph2.sub(0.5)).mul(0.018).mul(oneMinus(mull)));
    spec.assign(mix(0.55, 0.4, mull));
    rough.assign(mix(0.07, 0.32, mull));
    paint.assign(mull.mul(0.3));
    porous.assign(0.2);
    kind.assign(K.glass);
  })
    .ElseIf(style.lessThan(1.5), () => {
      // cladding panels, one bay by one floor: sealant joints, fixings near the corners,
      // a tone and a slight bow per panel (oil canning)
      const ph = hash12(vec2(cu, cv).add(seed.mul(41.0)));
      const ph2 = hash12(vec2(cu, cv).add(seed.mul(17.0)).add(5.5));
      alb.assign(base.mul(mix(0.84, 1.14, ph)).mul(vec3(1.0, mix(0.98, 1.02, ph2), mix(0.97, 1.03, ph2))));
      tilt.assign(vec2(ph.sub(0.5).mul(0.02).add(fu.sub(0.5).mul(0.024).mul(ph2)), ph2.sub(0.5).mul(0.02).add(fv.sub(0.5).mul(0.016))));
      const joint = max(joints(u, bwE, 0.007, mpp), joints(vf, fhE, 0.007, mpp));
      alb.assign(mix(alb, base.mul(0.35), joint));
      cav.assign(mix(1.0, 0.45, joint));
      const dU = min(fu, oneMinus(fu)).mul(bwE).sub(0.12);
      const dV = min(fv, oneMinus(fv)).mul(fhE).sub(0.12);
      const fix = lineAA(length(vec2(dU, dV)), 0.009, mpp).mul(smoothstep(0.03, 0.008, mpp));
      alb.assign(mix(alb, base.mul(1.4).add(0.02), fix));
      // a dirt wash runs down from each panel's top joint
      const below = oneMinus(fv).mul(fhE);
      const wash = exp(below.negate().div(0.7)).mul(smoothstep(0.35, 0.8, streakNoise(u, below, 3.0, 0.4))).mul(grime.mul(0.7).add(0.15));
      alb.mulAssign(oneMinus(wash.mul(0.35)));
      spec.assign(0.2);
      rough.assign(0.38);
      paint.assign(0.6);
      porous.assign(0.35);
      kind.assign(K.panel);
    })
    .ElseIf(style.lessThan(4.5), () => {
      If(hF.lessThan(0.36), () => {
        // glazed mosaic tiles: pastel or the building's colour, grout lines, mismatched
        // repairs, missing tiles, a floor band on some, a slightly different tilt per tile
        const strip = step(0.72, hS);
        const tw = mix(mix(0.048, 0.098, hS.mul(1.39).min(1.0)), 0.195, strip);
        const th = mix(tw, 0.048, strip);
        const B = bond(u, v, tw, th, 0.0028, mpp, strip.mul(0.5));
        const pal = pick6(hC, [vec3(0.55, 0.53, 0.48), vec3(0.4, 0.46, 0.5), vec3(0.52, 0.45, 0.36), vec3(0.55, 0.43, 0.41), vec3(0.42, 0.48, 0.42), vec3(0.5, 0.5, 0.52)]);
        const tileBase = mix(base, pal.mul(lum(base).div(lum(pal)).mul(1.15)), 0.6);
        const t1 = hash12(B.id.add(seed.mul(53.0)));
        const t2 = hash12(B.id.add(seed.mul(19.0)).add(3.3));
        const varK = smoothstep(tw.mul(0.5), tw.mul(0.22), mpp);
        const tileC = tileBase.mul(mix(1.0, mix(0.88, 1.1, t1), varK)).toVar();
        // a band of darker tiles along each floor slab on some buildings
        const bandOn = step(0.55, hash12(vec2(seed.mul(8.8), 1.9)));
        const band = smoothstep(0.0, 0.01, fv).mul(smoothstep(0.1, 0.09, fv)).mul(bandOn).mul(oneMinus(inShop));
        tileC.assign(mix(tileC, tileBase.mul(vec3(0.55, 0.5, 0.48)), band));
        // repairs in mismatched tiles, missing tiles in grimy blocks
        const blk = floor(P.div(0.6));
        const repair = step(0.975, hash12(blk.add(seed.mul(7.0)))).mul(varK);
        tileC.assign(mix(tileC, tileBase.mul(vec3(0.85, 0.9, 1.0)), repair));
        const missing = smoothstep(0.76, 0.78, vnoise(P.mul(1.7).add(seed.mul(9.0)))).mul(grime.mul(grime)).mul(0.8);
        const grout = base.mul(0.55).mul(oneMinus(grime.mul(0.35)));
        alb.assign(mix(mix(tileC, grout, B.joint), vec3(lum(base)).mul(0.7), missing));
        cav.assign(mix(mix(1.0, 0.6, B.joint), 0.75, missing));
        tilt.assign(vec2(t1.sub(0.5), t2.sub(0.5)).mul(0.07).mul(varK).mul(oneMinus(missing)));
        spec.assign(mix(mix(0.3, 0.03, B.joint), 0.02, missing));
        rough.assign(mix(mix(0.2, 0.9, B.joint), 0.95, missing));
        paint.assign(0.35);
        porous.assign(0.5);
        kind.assign(K.tile);
      })
        .ElseIf(hF.lessThan(0.82), () => {
          // painted render: mottled paint over a stucco grain, peeling where it is grimy
          const mot = fbmF(P.mul(0.6).add(seed.mul(9.0)), mpp.mul(0.6));
          alb.assign(base.mul(mix(0.9, 1.08, mot)));
          If(near.greaterThan(0.5), () => {
            const st = fbmD(P.mul(22.0), mpp.mul(22.0));
            gu.assign(st.y.mul(22.0 * 0.0018));
            gv.assign(st.z.mul(22.0 * 0.0018));
            alb.mulAssign(mix(0.94, 1.05, st.x));
            // paint peels where it stays wet: under sills, in the damp band, down runoff streaks
            const pz = clamp(damp.mul(1.2).add(sill.mul(1.6)).add(run.mul(0.4)), 0.0, 1.0).mul(grime);
            const pn = fbmF(P.mul(2.6).add(seed.mul(3.0)), mpp.mul(2.6));
            const thr = mix(0.9, 0.6, pz);
            const flakeK = smoothstep(0.03, 0.012, mpp);
            const peel = smoothstep(thr, thr.add(0.01), pn).mul(flakeK);
            const lip = smoothstep(0.012, 0.0, abs(pn.sub(thr))).mul(flakeK).mul(step(0.0, pz.sub(0.05)));
            alb.assign(mix(alb, desat(base, 0.85).mul(1.1).add(0.03), peel));
            cav.assign(mix(cav, 0.65, lip));
          });
          spec.assign(0.05);
          rough.assign(0.88);
          paint.assign(1.0);
          porous.assign(0.8);
          kind.assign(K.render);
        })
        .Else(() => {
          // brick in running bond: a tone per brick, dark clinkers, recessed mortar
          const B = bond(u, v, 0.225, 0.075, 0.005, mpp, 0.5);
          const b1 = hash12(B.id.add(seed.mul(7.0)));
          const b2 = hash12(B.id.add(seed.mul(3.0)).add(9.1));
          const red = mix(vec3(0.2, 0.085, 0.055), vec3(0.3, 0.16, 0.1), hC);
          const brickBase = mix(red, base, 0.25);
          const varK = smoothstep(0.11, 0.045, mpp);
          const brick = brickBase.mul(mix(1.0, mix(0.72, 1.22, b1).mul(mix(1.0, 0.55, step(b2, 0.07))), varK));
          const mortar = vec3(0.3, 0.29, 0.27).mul(oneMinus(grime.mul(0.45)));
          alb.assign(mix(brick, mortar, B.joint));
          cav.assign(mix(1.0, 0.55, B.joint));
          tilt.assign(vec2(b1.sub(0.5), b2.sub(0.5)).mul(0.05).mul(varK));
          spec.assign(0.03);
          rough.assign(0.95);
          porous.assign(1.0);
          kind.assign(K.brick);
        });
    })
    .ElseIf(style.lessThan(5.5), () => {
      // corrugated sheet: a 0.2 m profile, sheets 0.86 m wide lapped every 3 m, fixings in
      // the valleys along the laps and girts, rust at the foot, the laps and under fixings
      const lam = 0.2;
      const ph = u.div(lam).mul(6.2831853);
      const ribK = smoothstep(lam * 0.45, lam * 0.18, mpp);
      gu.assign(cos(ph).mul(0.55).mul(ribK));
      cav.assign(mix(float(0.86), mix(0.7, 1.0, sin(ph).mul(0.5).add(0.5)), ribK));
      const sheet = floor(u.div(0.86));
      const sh = hash12(vec2(sheet, seed.mul(13.0)));
      alb.assign(base.mul(mix(0.9, 1.1, sh)).mul(mix(1.0, 0.75, step(0.9, sh))));
      const lapV = joints(v, 3.0, 0.006, mpp);
      const lapU = joints(u, 0.86, 0.003, mpp);
      const rowD = abs(fract(v.div(1.5).add(0.5)).sub(0.5)).mul(1.5);
      const colD = abs(fract(u.div(lam)).sub(0.75)).mul(lam);
      const fix = lineAA(length(vec2(colD, rowD)), 0.007, mpp).mul(smoothstep(0.03, 0.01, mpp));
      const foot = smoothstep(mix(0.3, 1.2, sh).mul(vnoise(vec2(u.mul(2.5), seed.mul(7.0))).mul(0.6).add(0.7)), 0.0, v);
      const bloom = smoothstep(0.7, 0.76, fbmF(P.mul(4.0).add(seed.mul(5.0)), mpp.mul(4.0))).mul(grime);
      const dRow = oneMinus(fract(v.div(1.5))).mul(1.5);
      const col = vec2(floor(u.div(lam)), floor(v.div(1.5)));
      const runCol = smoothstep(0.012, 0.004, colD);
      const runs = exp(dRow.negate().div(mix(0.3, 1.2, hash12(col.add(seed))))).mul(runCol).mul(step(0.55, hash12(col.add(7.7)))).mul(smoothstep(0.04, 0.015, mpp));
      const rust = clamp(foot.mul(0.8).add(lapV.mul(3.0)).add(bloom).add(runs.mul(0.9)), 0.0, 1.0).mul(grime.mul(0.8).add(0.2));
      const rustC = mix(vec3(0.09, 0.04, 0.018), vec3(0.2, 0.085, 0.032), vnoise(P.mul(7.0))).mul(mix(0.75, 1.15, fbmF(P.mul(30.0), mpp.mul(30.0))));
      alb.assign(mix(alb, rustC, rust));
      alb.assign(mix(alb, base.mul(0.35), max(lapV, lapU).mul(0.6)));
      alb.assign(mix(alb, vec3(0.3, 0.29, 0.27), fix.mul(0.7)));
      spec.assign(mix(0.25, 0.02, rust));
      rough.assign(mix(0.45, 0.95, rust));
      paint.assign(oneMinus(rust));
      porous.assign(mix(0.35, 0.9, rust));
      rustK.assign(1.0);
      kind.assign(K.metal);
    })
    .ElseIf(style.lessThan(6.5), () => {
      // cast concrete: formwork panels (or boards), tie holes, bugholes, aggregate,
      // lift lines at each pour, the odd honeycombed patch
      const conc = pin(desat(base, 0.55).mul(1.05), 'vec3');
      const boards = step(0.72, hS);
      const pw = mix(1.2, 0.9, step(0.36, hS));
      const panel = bond(u, v, pw, pw.mul(2.0), 0.003, mpp, 0.0);
      const row = floor(v.div(0.14));
      const bx = u.add(hash12(vec2(row, seed.mul(3.0))).mul(2.4));
      const boardId = vec2(floor(bx.div(2.4)), row);
      const boardJ = max(joints(bx, 2.4, 0.002, mpp), joints(v, 0.14, 0.0015, mpp));
      const id = select(boards.greaterThan(0.5), boardId, panel.id);
      const joint = mix(panel.joint, boardJ, boards);
      const p1 = hash12(id.add(seed.mul(19.0)));
      const varK = smoothstep(0.5, 0.15, mpp);
      alb.assign(conc.mul(mix(1.0, mix(0.88, 1.1, p1), varK)).mul(vec3(1.0, 1.0, mix(0.97, 1.03, p1))));
      // board grain
      alb.mulAssign(mix(1.0, mix(0.95, 1.04, vnoise(vec2(bx.mul(0.7), v.mul(35.0)))), boards.mul(smoothstep(0.03, 0.012, mpp))));
      alb.assign(mix(alb, conc.mul(0.55), joint));
      cav.assign(mix(1.0, 0.7, joint));
      // lift lines at each floor slab, and a slightly different tone per lift
      const lift = joints(vf, fhE, 0.012, mpp);
      alb.mulAssign(mix(0.95, 1.05, hash12(vec2(cv, seed.mul(23.0)))));
      alb.assign(mix(alb, conc.mul(0.5), lift));
      // tie holes on a half-panel grid, half of them plugged with mortar cones
      const hs = pw.mul(0.5);
      const tq = fract(P.div(hs)).sub(0.5).mul(hs);
      const hole = lineAA(length(tq), 0.013, mpp).mul(oneMinus(boards)).mul(smoothstep(0.04, 0.012, mpp));
      const plug = step(0.5, hash12(floor(P.div(hs)).add(seed.mul(31.0))));
      alb.assign(mix(alb, mix(conc.mul(0.22), conc.mul(1.15), plug), hole));
      cav.assign(mix(cav, mix(0.35, 0.9, plug), hole));
      // honeycombing at the bottom of some lifts
      const hc = step(0.93, hash12(vec2(floor(u.div(2.0)), cv).add(seed.mul(5.0)))).mul(smoothstep(0.35, 0.0, fv)).mul(smoothstep(0.5, 0.62, vnoise(P.mul(3.0))));
      alb.assign(mix(alb, conc.mul(0.45), hc.mul(0.8)));
      cav.assign(mix(cav, 0.6, hc));
      If(near.greaterThan(0.5), () => {
        // aggregate grain and bugholes
        const ag = fbmD(P.mul(40.0).add(seed.mul(7.0)), mpp.mul(40.0));
        alb.mulAssign(mix(0.92, 1.06, ag.x));
        gu.assign(ag.y.mul(40.0 * 0.0007));
        gv.assign(ag.z.mul(40.0 * 0.0007));
        const bq = P.div(0.025);
        const bc = floor(bq);
        const bh = hash12(bc.add(seed.mul(77.0)));
        const bo = fract(bq).sub(hash22(bc).mul(0.5).add(0.25)).mul(0.025);
        const bug = step(0.965, bh).mul(lineAA(length(bo), mix(0.0018, 0.005, bh.sub(0.965).mul(28.0)), mpp)).mul(smoothstep(0.012, 0.004, mpp));
        alb.assign(mix(alb, conc.mul(0.25), bug));
        cav.assign(mix(cav, 0.4, bug));
      });
      spec.assign(0.03);
      rough.assign(0.95);
      porous.assign(1.0);
      kind.assign(K.concrete);
    })
    .Else(() => {
      // stone slabs: marble veins, travertine bands and pits, or granite speckle; a tone and
      // a hair of tilt per slab, polished or honed
      const small = step(hS, 0.4);
      const sw = mix(1.2, 0.9, small);
      const B = bond(u, v, sw, sw.mul(0.5), 0.0018, mpp, step(0.7, hS).mul(0.5));
      const s1 = hash12(B.id.add(seed.mul(23.0)));
      const s2 = hash12(B.id.add(seed.mul(61.0)).add(1.7));
      const stone = pin(base.mul(mix(0.93, 1.07, s1)).mul(vec3(1.0, mix(0.98, 1.02, s2), mix(0.97, 1.03, s2))), 'vec3');
      const q = pin(P.mul(0.9).add(B.id.mul(3.7)), 'vec2');
      alb.assign(stone);
      If(hC.lessThan(0.45), () => {
        const w = fbmF(q.mul(0.8), mpp.mul(0.72));
        const vn = fbmF(q.add(vec2(w.mul(2.0), w.mul(1.3))), mpp.mul(0.9));
        const vein = smoothstep(0.03, 0.0, abs(vn.sub(0.5))).mul(smoothstep(0.04, 0.01, mpp));
        alb.assign(mix(stone, stone.mul(vec3(0.6, 0.58, 0.54)), vein.mul(0.75)));
      })
        .ElseIf(hC.lessThan(0.75), () => {
          const bands = vnoise(vec2(q.x.mul(0.25), q.y.mul(7.0)));
          const pc = floor(vec2(q.x.mul(60.0), q.y.mul(150.0)));
          const pit = step(0.955, hash12(pc)).mul(smoothstep(0.012, 0.004, mpp));
          alb.assign(stone.mul(mix(0.9, 1.08, bands)).mul(oneMinus(pit.mul(0.6))));
          cav.assign(oneMinus(pit.mul(0.5)));
        })
        .Else(() => {
          const gc = floor(q.mul(110.0));
          const gr = hash12(gc);
          const grainK = smoothstep(0.01, 0.004, mpp);
          alb.assign(stone.mul(mix(1.0, select(gr.lessThan(0.18), float(0.45), select(gr.greaterThan(0.9), float(1.35), float(1.0))), grainK)));
        });
      alb.assign(mix(alb, base.mul(0.5), B.joint));
      cav.assign(mix(cav, 0.6, B.joint));
      tilt.assign(vec2(s1.sub(0.5), s2.sub(0.5)).mul(0.014));
      const honed = step(0.6, hash12(vec2(seed.mul(5.0), 9.0)));
      spec.assign(mix(0.32, 0.18, honed));
      rough.assign(mix(0.14, 0.38, honed));
      porous.assign(0.45);
      kind.assign(K.stone);
    });

  // ------------------------------------------------------------- downpipes
  // drain pipes and risers run the full height of homes and shophouses beside some bay
  // lines: a round pipe (PVC, cast iron or rusty), a bracket at every floor, a leak streak
  const pipeOn = pin(step(1.5, style).mul(step(style, 4.5)).add(step(5.5, style).mul(step(style, 6.5))));
  const pk = floor(u.div(bwE).add(0.5));
  const ph1 = hash12(vec2(pk, seed.mul(7.3)).add(3.3));
  const ph2 = hash12(vec2(pk, seed.mul(2.9)).add(8.1));
  const pr = mix(0.045, 0.08, ph2);
  const pd = u.sub(pk.mul(bwE)).sub(mix(0.14, 0.24, ph1));
  const hasPipe = pin(step(ph1, mix(0.12, 0.3, grime)).mul(pipeOn).mul(step(1.0, wlen.sub(abs(u.sub(wlen.mul(0.5))).mul(2.0)))));
  const pipeK = pin(lineAA(pd, pr, mpp).mul(hasPipe));
  const ax = clamp(pd.div(pr), -0.95, 0.95);
  const pipeC = select(ph2.lessThan(0.45), vec3(0.3, 0.29, 0.27), select(ph2.lessThan(0.8), vec3(0.045, 0.045, 0.05), vec3(0.11, 0.055, 0.03)));
  const bracket = joints(vf, fhE, 0.03, mpp).mul(pipeK);
  alb.assign(mix(alb, mix(pipeC.mul(mix(0.85, 1.1, vnoise(vec2(pk, v.mul(0.8))))), pipeC.mul(0.6), bracket), pipeK));
  tilt.assign(mix(tilt, vec2(ax.mul(0.9), 0.0), pipeK.mul(smoothstep(pr.mul(0.6), pr.mul(0.25), mpp))));
  spec.assign(mix(spec, select(ph2.lessThan(0.45), float(0.25), float(0.12)), pipeK));
  rough.assign(mix(rough, float(0.45), pipeK));
  cav.assign(mix(cav, mix(1.0, 0.7, abs(ax)), pipeK));
  // a wet, dirty streak beside the pipe where the joints leak
  const leak = smoothstep(0.3, 0.0, abs(pd.sub(pr).sub(0.08))).mul(smoothstep(0.45, 0.75, streakNoise(u, v, 6.0, 0.25))).mul(hasPipe).mul(oneMinus(pipeK)).mul(grime);
  alb.assign(mix(alb, alb.mul(0.55), leak.mul(0.6)));

  // ------------------------------------------------------------- window sills
  // a stone or concrete ledge under each punched window, with its shadow below
  const punched = pin(step(1.5, style).mul(oneMinus(step(4.5, style).mul(step(style, 5.5)))).mul(oneMinus(inShop)));
  const sillH = float(0.07).div(fhE);
  const sillX = smoothstep(sx0.sub(0.06), sx0.sub(0.04), fu).mul(smoothstep(sx1.add(0.06), sx1.add(0.04), fu));
  const aaV = mpp.div(fhE);
  const ledge = smoothstep(sy0.sub(sillH).sub(aaV), sy0.sub(sillH).add(aaV), fv).mul(step(fv, sy0)).mul(sillX).mul(punched);
  const ledgeShadow = smoothstep(sy0.sub(sillH).sub(float(0.05).div(fhE)), sy0.sub(sillH), fv).mul(step(fv, sy0.sub(sillH))).mul(sillX).mul(punched);
  alb.assign(mix(alb, desat(base, 0.5).mul(1.3).add(0.015), ledge));
  cav.assign(mix(cav, 0.55, ledgeShadow.mul(smoothstep(0.06, 0.02, mpp))));

  // ------------------------------------------------------------- weathering
  const tide = exp(tz.mul(tz).negate()).mul(porous).mul(g).mul(smoothstep(0.06, 0.02, mpp));
  const wK = g.mul(0.85).add(0.15);
  const isPaint = paint;
  const posterable = step(1.5, kind).mul(oneMinus(step(6.5, kind)));

  // patch repairs on the spandrel below a window: fresh paint, or a cement patch on concrete
  const pc = hash12(vec2(cu.add(seed.mul(5.0)), cv.add(seed.mul(9.0))).add(4.4));
  const canPatch = step(2.5, kind).mul(step(kind, 3.5)).add(step(5.5, kind).mul(step(kind, 6.5)));
  const hasPatch = step(pc, g.mul(0.12).add(0.04)).mul(canPatch).mul(oneMinus(inShop));
  const pa = hash12(vec2(cu, cv).add(seed.mul(3.1)).add(1.3)).mul(0.5);
  const pb = pa.add(0.25).add(hash12(vec2(cu, cv).add(seed.mul(8.3)).add(6.1)).mul(0.45)).min(0.98);
  const rag = vnoise(P.mul(6.0)).sub(0.5).mul(0.05);
  const inPatch = pin(smoothstep(pa.add(rag), pa.add(rag).add(0.01), fu).mul(smoothstep(pb.add(rag), pb.add(rag).sub(0.01), fu)).mul(step(0.03, fv)).mul(step(fv, sy0.sub(0.03).add(rag))).mul(hasPatch));
  const patchC = select(kind.lessThan(4.0), alb.mul(vec3(1.08, 1.04, 0.99)).add(base.mul(0.04)), desat(base, 0.8).mul(1.22).add(0.01));
  alb.assign(mix(alb, patchC, inPatch.mul(0.9)));

  // pollution mottling at the scale of floors
  const mot = fbmF(vec2(u.mul(0.14), v.mul(0.035)).add(seed.mul(11.0)), mpp.mul(0.14));
  alb.mulAssign(oneMinus(smoothstep(0.45, 0.85, mot).mul(0.14).mul(g).mul(porous.mul(0.6).add(0.4))));

  const fresh = oneMinus(inPatch.mul(0.75));
  const dirt = clamp(run.mul(0.75).add(sill.mul(1.0)).add(corner.mul(0.3)).add(damp.mul(0.35)).add(splash.mul(0.25)), 0.0, 1.0).mul(wK).mul(porous.mul(0.7).add(0.3)).mul(fresh);
  const dirtC = mix(vec3(0.62, 0.56, 0.48), vec3(0.62, 0.4, 0.24), rustK);
  alb.assign(mix(alb, alb.mul(dirtC).mul(0.45), dirt));
  // washed streaks: where runoff keeps a band of wall clean it reads lighter than the dirt
  // round it (the other half of how rain marks a facade)
  const washN = streakNoise(u.add(11.0), dTop, 1.6, 0.04);
  const wash = exp(dTop.negate().div(runL.mul(1.4))).mul(smoothstep(0.62, 0.85, washN)).mul(porous).mul(g.mul(0.8).add(0.2)).mul(fresh);
  alb.assign(mix(alb, alb.mul(1.35).add(base.mul(0.08)), wash.mul(0.6)));
  // efflorescence: white salt runs under the lift lines and joints of concrete and brick
  const effOn = step(3.5, kind).mul(step(kind, 4.5)).add(step(5.5, kind).mul(step(kind, 6.5)));
  const dLift = oneMinus(fv).mul(fhE);
  const eff = exp(dLift.negate().div(0.6)).mul(smoothstep(0.6, 0.85, streakNoise(u.add(5.0), dLift, 3.0, 0.8))).mul(effOn).mul(g).mul(smoothstep(0.1, 0.04, mpp));
  alb.assign(mix(alb, vec3(lum(alb)).mul(1.8).add(0.07), eff.mul(0.5)));
  alb.assign(mix(alb, alb.mul(vec3(0.62, 0.42, 0.3)), drip.mul(0.7)));
  alb.assign(mix(alb, alb.mul(vec3(0.82, 0.9, 0.78)), damp.mul(0.45).mul(g)));
  alb.assign(mix(alb, vec3(lum(alb)).mul(1.6).add(0.06), tide.mul(0.35)));

  // sun fade: paint and glaze lose colour on the south side and higher up
  const sunK = smoothstep(-0.4, 0.9, n.z).mul(0.7).add(0.3).mul(smoothstep(0.0, 30.0, v).mul(0.5).add(0.5)).mul(hash12(vec2(seed.mul(2.9), 6.1)).mul(0.8).add(0.2)).mul(isPaint).mul(fresh);
  alb.assign(mix(alb, desat(alb, 0.65).mul(1.18).add(0.008), sunK.mul(0.5)));

  // moss where it stays damp on rough walls in grimy blocks
  const mossN = mix(streakNoise(u.add(3.0), v, 2.2, 0.08), float(0.5), smoothstep(0.08, 0.25, mpp));
  const moss = clamp(damp.mul(0.7).add(run.mul(0.35)), 0.0, 1.0).mul(smoothstep(0.5, 0.8, mossN)).mul(g.mul(g)).mul(porous).mul(oneMinus(isPaint.mul(0.6)));
  alb.assign(mix(alb, vec3(0.025, 0.04, 0.022), moss.mul(0.45)));

  // ------------------------------------------------------------- up close
  const crackable = step(1.5, kind).mul(oneMinus(step(4.5, kind).mul(step(kind, 5.5))));
  const streetK = smoothstep(3.1, 2.6, wy).mul(smoothstep(0.15, 0.4, wy)).mul(step(abs(wy.sub(v)), 0.6));
  If(near.greaterThan(0.5).and(mpp.lessThan(0.035)), () => {
    // cracks from window corners (settlement) and map cracking in grimy render and concrete
    const qx = fu.mul(bwE);
    const qy = fv.mul(fhE);
    const ck = hash12(vec2(cu.add(seed.mul(9.1)), cv.add(seed.mul(3.7))));
    const cLen = mix(0.4, 1.3, ck);
    const cornerCrack = (px, py, dx, dy) => {
      const rx = qx.sub(px);
      const ry = qy.sub(py);
      const t = rx.mul(dx).add(ry.mul(dy));
      const wig = vnoise(vec2(t.mul(9.0), ck.mul(50.0))).sub(0.5).mul(0.05).mul(t.div(cLen).add(0.3));
      const perp = rx.mul(dy).sub(ry.mul(dx)).add(wig);
      return lineAA(perp, mix(0.0012, 0.0004, clamp(t.div(cLen), 0.0, 1.0)), mpp).mul(step(0.0, t)).mul(step(t, cLen));
    };
    const cA = cornerCrack(sx0.mul(bwE), sy0.mul(fhE), -0.5, -0.866).mul(step(0.75, ck));
    const cB = cornerCrack(sx1.mul(bwE), sy0.mul(fhE), 0.5, -0.866).mul(step(ck, 0.2));
    const cc = cellular(P.mul(2.6).add(vec2(vnoise(P.mul(4.0)), vnoise(P.mul(4.0).add(5.0))).mul(0.35)));
    const mapMask = smoothstep(0.55, 0.75, fbmF(P.mul(0.35).add(seed.mul(4.0)), mpp.mul(0.35))).mul(g);
    const mapCrack = lineAA(cc.y.sub(cc.x).div(2.6), 0.0006, mpp).mul(mapMask);
    const crack = clamp(max(max(cA, cB).mul(hasSills).mul(punched.add(step(5.5, style)).min(1.0)), mapCrack), 0.0, 1.0).mul(crackable);
    alb.assign(mix(alb, alb.mul(0.3), crack));
    cav.assign(mix(cav, 0.4, crack));

    // posters at street level on grounded walls: a ground colour, a headline bar, lines of
    // "text", one big shape; faded, some torn
    const slot = floor(u.div(0.95));
    const ps = hash12(vec2(slot, seed.mul(61.0)));
    const ps2 = hash12(vec2(slot, seed.mul(17.0)).add(3.7));
    const cluster = smoothstep(0.35, 0.6, vnoise(vec2(u.mul(0.18), seed.mul(13.0))));
    const pw = mix(0.42, 0.62, ps2);
    const phh = pw.mul(mix(1.3, 1.5, ps));
    const x0 = slot.mul(0.95).add(ps2.mul(float(0.9).sub(pw))).add(0.02);
    const y0 = mix(0.95, 1.35, ps);
    const lx = u.sub(x0).div(pw);
    const ly = wy.sub(y0).div(phh);
    const prag = vnoise(vec2(u, wy).mul(23.0)).sub(0.5).mul(0.05);
    const inP = step(0.0, lx.add(prag)).mul(step(lx.sub(prag), 1.0)).mul(step(0.0, ly.add(prag))).mul(step(ly.sub(prag), 1.0));
    const tear = smoothstep(0.55, 0.6, fbmF(vec2(u, wy).mul(3.0).add(slot), mpp.mul(3.0))).mul(step(0.5, ps2)).mul(smoothstep(0.6, 0.2, ly));
    const has = step(ps, g.mul(0.55).add(0.1)).mul(cluster).mul(posterable).mul(streetK);
    const vis = inP.mul(oneMinus(tear)).mul(has);
    const grounds = [vec3(0.6, 0.58, 0.5), vec3(0.62, 0.48, 0.08), vec3(0.45, 0.05, 0.04), vec3(0.035, 0.035, 0.04), vec3(0.08, 0.35, 0.42), vec3(0.62, 0.22, 0.38)];
    const ground = pick6(ps, grounds);
    const accentC = pick6(fract(ps.add(0.43)), grounds);
    const head = step(0.78, ly).mul(step(ly, 0.92)).mul(step(0.08, lx)).mul(step(lx, 0.92));
    const textLen = hash12(vec2(floor(ly.mul(16.0)), slot.add(seed.mul(9.0))));
    const text = step(0.5, fract(ly.mul(16.0))).mul(step(ly, 0.45)).mul(step(0.08, ly)).mul(step(0.08, lx)).mul(step(lx, textLen.mul(0.8).add(0.12)));
    const shape = smoothstep(0.21, 0.19, length(vec2(lx.sub(0.5), ly.sub(0.62).mul(1.4)))).mul(step(0.4, ps));
    const design = mix(mix(ground, accentC, shape), vec3(0.02), max(head, text.mul(0.85)));
    const posterC = mix(design, desat(design, 0.45).mul(0.8).add(0.02), ps2.mul(0.7));
    alb.assign(mix(alb, posterC, vis));
    cav.assign(mix(cav, 1.0, vis));
    gu.assign(mix(gu, float(0.0), vis));
    gv.assign(mix(gv, float(0.0), vis));
    tilt.assign(mix(tilt, vec2(0.0), vis));
    spec.assign(mix(spec, float(0.04), vis));
    rough.assign(mix(rough, float(0.9), vis));

    // graffiti: a throw-up of fat letters (fill and outline) in grimy blocks on concrete,
    // render, metal and tile, never over a poster
    const gz = floor(u.div(4.5));
    const gh = hash12(vec2(gz, seed.mul(5.0)).add(8.8));
    const gh2 = hash12(vec2(gz, seed.mul(9.0)).add(1.3));
    const gx = fract(u.div(4.5)).mul(4.5);
    const lh = mix(0.55, 1.0, gh2);
    const nL = floor(mix(3.0, 5.99, gh));
    const tu = throwUp(gx.sub(0.3), wy, mix(0.5, 0.8, gh), lh, gh2, nL, mpp);
    const gHas = step(gh, g.mul(g).mul(0.7)).mul(step(1.5, kind)).mul(oneMinus(step(3.5, kind).mul(step(kind, 4.5)))).mul(oneMinus(step(6.5, kind))).mul(streetK).mul(oneMinus(vis));
    const sprays = [vec3(0.55, 0.06, 0.05), vec3(0.06, 0.38, 0.5), vec3(0.6, 0.2, 0.42), vec3(0.6, 0.48, 0.05), vec3(0.12, 0.42, 0.12), vec3(0.5, 0.5, 0.5)];
    const fillC = mix(pick6(gh2, sprays), pick6(fract(gh2.add(0.37)), sprays), tu.z.mul(step(0.5, gh)));
    const lineC = select(gh2.lessThan(0.6), vec3(0.015), vec3(0.6, 0.6, 0.58));
    const faded = mix(1.0, 0.65, gh);
    alb.assign(mix(alb, fillC.mul(faded), tu.x.mul(gHas).mul(0.9)));
    alb.assign(mix(alb, lineC, tu.y.mul(gHas).mul(0.9)));
    spec.assign(mix(spec, float(0.12), tu.x.mul(gHas)));
  });

  // ------------------------------------------------------------- wet
  const wetK = pin(clamp(U.wet.mul(smoothstep(12.0, 0.0, wy).mul(0.45).add(run.mul(0.5)).add(sill.mul(0.4)).add(damp.mul(0.6))), 0.0, 1.0));
  alb.mulAssign(oneMinus(wetK.mul(0.3).mul(porous)));
  spec.assign(spec.add(wetK.mul(0.3)));
  rough.assign(mix(rough, float(0.18), wetK.mul(0.75)));

  // detail normal: relief slopes, then the per-unit tilt
  const nb = bumpN(n, tng, UP, gu, gv);
  const nT = normalize(nb.add(tng.mul(tilt.x)).add(UP.mul(tilt.y)));
  return { alb, nb: nT, spec, rough, cav, wet: wetK, kind, run, sill };
}
