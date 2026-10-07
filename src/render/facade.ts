// @ts-nocheck -- TSL node graphs are dynamically typed.
/**
 * The facade material: one shader for every wall in the city, branching on
 * the facade style. Each wall is a single quad; windows, recesses, rooms,
 * panels, strips and grime are all computed per pixel:
 *
 *  - the window aperture is recessed with an analytic parallax step, so reveals
 *    show at grazing angles,
 *  - each pane looks into a raymarched room box (walls, ceiling light, floor,
 *    a desk, curtains) when it is near enough to matter,
 *  - far away the pattern fades to its average so nothing shimmers,
 *  - storefronts along shop walls get their own retail interiors and shutters.
 *
 * Vertex attributes (constant per wall):
 *  aF0 (style, floorH, bayW, win)  aF1 (lit, warm, grime, seed)
 *  aF2 (base rgb, strips)           aF3 (accent rgb, wall length)
 *  aF4 (shopH, tierH, taper, 0)    uv (metres along the wall, metres above the tier base)
 *  (taper: on sloped walls, how far each corner leans in per metre of height)
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  abs,
  attribute,
  cameraPosition,
  clamp,
  dot,
  float,
  floor,
  fract,
  fwidth,
  length,
  max,
  min,
  mix,
  normalWorld,
  normalize,
  oneMinus,
  positionWorld,
  pow,
  select,
  sin,
  smoothstep,
  step,
  time,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { U, fresnel, hash12, hash13, lightAt, pin, shade, skyColor, vnoise } from './tsl';

export const STYLE_ID = { glass: 0, panel: 1, grid: 2, shop: 3, balcony: 4, metal: 5, raw: 6, lux: 7 } as const;

export const FACADE_EXTRAS = { aF0: 4, aF1: 4, aF2: 4, aF3: 4, aF4: 4 };

/** Smooth box mask on [a, b] with antialias width w. */
const span = (x, a, b, w) => smoothstep(a.sub(w), a.add(w), x).mul(oneMinus(smoothstep(b.sub(w), b.add(w), x)));

/**
 * Raymarch into a room box behind a pane. o = entry point relative to the pane
 * centre (metres, x across, y up), d = view direction (x across, y up, z into
 * the wall, z > 0). Returns the room colour (pre-lighting, with light baked in).
 */
const room = Fn(([o, d, w, h, seed, lit, lightCol, kind]) => {
  const depth = h.mul(1.6);
  const hx = w.mul(0.5);
  const hy = h.mul(0.5);
  const tx = select(d.x.greaterThan(0.0), hx.sub(o.x), hx.negate().sub(o.x)).div(select(abs(d.x).lessThan(1e-4), float(1e-4), d.x));
  const ty = select(d.y.greaterThan(0.0), hy.sub(o.y), hy.negate().sub(o.y)).div(select(abs(d.y).lessThan(1e-4), float(1e-4), d.y));
  const tz = depth.div(max(d.z, float(1e-4)));
  const t = min(min(abs(tx), abs(ty)), tz);
  const p = o.add(d.mul(t));
  const onBack = step(tz.sub(0.001), t);
  const onY = oneMinus(onBack).mul(step(abs(ty).sub(0.001), t));
  const onCeil = onY.mul(step(0.0, d.y));
  const onFloor = onY.mul(oneMinus(step(0.0, d.y)));
  const onSide = oneMinus(onBack).mul(oneMinus(onY));
  const qz = clamp(p.z.div(depth), 0.0, 1.0);
  const qx = p.x.div(w).add(0.5);
  const qy = p.y.div(h).add(0.5);
  // palette per room
  const wallA = mix(vec3(0.42, 0.38, 0.33), vec3(0.3, 0.34, 0.38), hash12(vec2(seed, 1.7)));
  const wallC = mix(wallA, vec3(0.55, 0.5, 0.45), hash12(vec2(seed, 7.3)).mul(0.5));
  const floorC = mix(vec3(0.16, 0.11, 0.08), vec3(0.22, 0.22, 0.24), hash12(vec2(seed, 3.1)));
  // office (kind 1): pale walls, troffers; home (0): warm; shop (2): shelves
  const isOffice = step(0.5, kind).mul(step(kind, 1.5));
  const isShop = step(1.5, kind);
  const lamp = span(qx, float(0.3), float(0.7), float(0.03)).mul(span(qz, float(0.25), float(0.6), float(0.03)));
  const troffer = step(0.5, fract(qz.mul(3.0))).mul(span(fract(qx.mul(2.0)), float(0.15), float(0.85), float(0.04)));
  const ceilLight = mix(lamp, troffer, isOffice.add(isShop).min(1.0));
  const ceilC = mix(wallC.mul(0.8), lightCol.mul(5.0), ceilLight.mul(lit));
  // back wall: picture or shelves
  const shelf = step(0.82, fract(qy.mul(mix(3.0, 5.0, isShop)))).mul(isShop.add(isOffice.mul(0.4)).min(1.0));
  const goods = step(0.55, hash12(floor(vec2(qx.mul(14.0), qy.mul(5.0))).add(seed.mul(17.0)))).mul(isShop).mul(step(fract(qy.mul(5.0)), 0.75));
  const goodsC = mix(vec3(0.8, 0.3, 0.2), vec3(0.2, 0.6, 0.8), hash12(floor(vec2(qx.mul(14.0), qy.mul(5.0))).add(3.3)));
  const pic = span(qx, float(0.55), float(0.8), float(0.01)).mul(span(qy, float(0.45), float(0.7), float(0.01))).mul(oneMinus(isShop)).mul(step(0.4, hash12(vec2(seed, 9.9))));
  const tv = pic.mul(step(0.7, hash12(vec2(seed, 2.2))));
  const backC = mix(wallC, vec3(0.05), shelf.mul(0.7)).toVar();
  backC.assign(mix(backC, goodsC, goods));
  backC.assign(mix(backC, mix(vec3(0.15, 0.12, 0.1), vec3(0.1, 0.25, 0.6).mul(sin(time.mul(7.0).add(seed.mul(40.0))).mul(0.3).add(0.9)), tv), pic));
  const sideC = wallC.mul(0.85);
  let col = backC.mul(onBack).add(sideC.mul(onSide)).add(ceilC.mul(onCeil)).add(floorC.mul(onFloor));
  // a desk / counter block in front of the back wall
  const fz0 = depth.mul(mix(0.35, 0.6, hash12(vec2(seed, 5.5))));
  const fz1 = fz0.add(depth.mul(0.18));
  const fy1 = hy.negate().add(mix(0.75, 1.05, isShop));
  const tFz = fz0.div(max(d.z, float(1e-4)));
  const pf = o.add(d.mul(tFz));
  const deskHit = step(pf.y, fy1).mul(step(tFz, t)).mul(step(abs(pf.x), hx.mul(0.7)));
  const tTop = fy1.sub(o.y).div(select(abs(d.y).lessThan(1e-4), float(-1e-4), d.y));
  const pt = o.add(d.mul(tTop));
  const topHit = step(0.0, tTop).mul(step(tTop, t)).mul(step(fz0, pt.z)).mul(step(pt.z, fz1)).mul(step(abs(pt.x), hx.mul(0.7)));
  const deskC = mix(vec3(0.12, 0.09, 0.07), vec3(0.3, 0.3, 0.32), isOffice.add(isShop).min(1.0));
  col = mix(col, deskC, max(deskHit, topHit));
  // a person silhouette now and then
  const pz = depth.mul(0.45);
  const tP = pz.div(max(d.z, float(1e-4)));
  const pp = o.add(d.mul(tP));
  const px = mix(hx.negate().mul(0.5), hx.mul(0.5), hash12(vec2(seed, 8.8)));
  const bodyH = hy.negate().add(1.7);
  const person = step(tP, t).mul(step(abs(pp.x.sub(px)), 0.22)).mul(step(pp.y, bodyH)).mul(step(0.7, hash12(vec2(seed, 4.4))));
  const head = step(length(vec2(pp.x.sub(px), pp.y.sub(bodyH.add(0.12)))), 0.13).mul(step(tP, t)).mul(step(0.7, hash12(vec2(seed, 4.4))));
  col = mix(col, vec3(0.015), max(person, head));
  // depth falloff and soft corners
  const ao = mix(0.55, 1.0, smoothstep(0.0, 0.18, min(min(qx, oneMinus(qx)), min(qy, oneMinus(qy)))));
  const fall = mix(1.0, 0.45, qz);
  const lightK = mix(0.035, 1.0, lit);
  return col.mul(ao).mul(fall).mul(lightCol.mul(lightK).add(vec3(0.015, 0.017, 0.025)));
});

export function makeFacadeMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'facade';
  m.fog = false;
  m.colorNode = Fn(() => {
    const F0 = attribute('aF0', 'vec4');
    const F1 = attribute('aF1', 'vec4');
    const F2 = attribute('aF2', 'vec4');
    const F3 = attribute('aF3', 'vec4');
    const F4 = attribute('aF4', 'vec4');
    const style = F0.x;
    const fh = F0.y;
    const bw = F0.z;
    const win = F0.w;
    const litF = F1.x;
    const warm = F1.y;
    const grime = F1.z;
    const seed = F1.w;
    const base = F2.rgb;
    const strips = F2.w;
    const accent = F3.rgb;
    const wlen = F3.w;
    const shopH = F4.x;
    const tierH = F4.y;
    const wp = positionWorld;
    const n = normalize(normalWorld);
    // horizontal tangent along the wall (normalised: sloped walls tilt n)
    const tng = normalize(vec3(n.z.negate(), 0.0, n.x).add(vec3(1e-5, 0.0, 0.0)));
    const taper = F4.z; // sloped walls: corner inset per metre of height
    const u = uv().x;
    const v = uv().y;
    const toCam = cameraPosition.sub(wp);
    const dist = length(toCam);
    const V = toCam.div(dist).negate(); // camera -> point
    const vt = dot(V, tng);
    const vn = max(dot(V, n.negate()), float(0.06));

    // ---------------------------------------------------------- style table
    const ax0 = float(0.1).toVar();
    const ax1 = float(0.9).toVar();
    const ay0 = float(0.25).toVar();
    const ay1 = float(0.85).toVar();
    const recess = float(0.2).toVar();
    const roomKind = float(0).toVar(); // 0 home, 1 office, 2 shop
    const wallSpec = float(0.05).toVar();
    const glassTint = vec3(0.55, 0.62, 0.66).toVar();
    If(style.lessThan(0.5), () => {
      // glass curtain wall
      ax0.assign(0.035);
      ax1.assign(0.965);
      ay0.assign(0.14);
      ay1.assign(0.985);
      recess.assign(0.05);
      roomKind.assign(1);
      wallSpec.assign(0.3);
      glassTint.assign(vec3(0.45, 0.6, 0.68));
    })
      .ElseIf(style.lessThan(1.5), () => {
        // monolithic panels with slits
        ax0.assign(float(0.5).sub(win.mul(0.5)));
        ax1.assign(float(0.5).add(win.mul(0.5)));
        ay0.assign(0.06);
        ay1.assign(0.94);
        recess.assign(0.3);
        roomKind.assign(1);
        wallSpec.assign(0.18);
      })
      .ElseIf(style.lessThan(3.5), () => {
        // punched windows (grid / shop upper floors)
        const jitter = hash12(vec2(floor(u.div(bw)), seed.mul(31.0))).sub(0.5).mul(0.12).mul(step(2.5, style));
        ax0.assign(float(0.5).sub(win.mul(0.5)).add(jitter));
        ax1.assign(float(0.5).add(win.mul(0.5)).add(jitter));
        ay0.assign(0.3);
        ay1.assign(0.84);
        recess.assign(0.22);
      })
      .ElseIf(style.lessThan(4.5), () => {
        // balconies: wide doors behind a deep loggia
        ax0.assign(0.1);
        ax1.assign(0.9);
        ay0.assign(0.04);
        ay1.assign(0.86);
        recess.assign(0.9);
      })
      .ElseIf(style.lessThan(5.5), () => {
        // corrugated metal with high strip windows
        ax0.assign(0.06);
        ax1.assign(0.94);
        ay0.assign(0.72);
        ay1.assign(0.86);
        recess.assign(0.08);
        roomKind.assign(1);
        wallSpec.assign(0.25);
      })
      .ElseIf(style.lessThan(6.5), () => {
        ax0.assign(0.22);
        ax1.assign(0.78);
        ay0.assign(0.24);
        ay1.assign(0.86);
        recess.assign(0.3);
      })
      .Else(() => {
        // luxury: tall windows, stone and gold
        ax0.assign(0.16);
        ax1.assign(0.84);
        ay0.assign(0.06);
        ay1.assign(0.94);
        recess.assign(0.32);
        wallSpec.assign(0.2);
        glassTint.assign(vec3(0.7, 0.62, 0.5));
      });

    // ----------------------------------------------------------- shop band
    const inShop = step(0.01, shopH).mul(step(v, shopH));
    const vf = select(inShop.greaterThan(0.5), v, v.sub(shopH.mul(step(0.01, shopH))));
    const fhE = select(inShop.greaterThan(0.5), shopH, fh);
    const bwE = select(inShop.greaterThan(0.5), bw.mul(1.3), bw);
    const cellU = u.div(bwE);
    const cellV = vf.div(fhE);
    // pinned: the near (raymarched rooms) and far branches below both read these
    const cu = pin(floor(cellU));
    const cv = pin(floor(cellV));
    const fu = pin(fract(cellU));
    const fv = pin(fract(cellV));
    const cellId = pin(vec2(cu.add(seed.mul(173.0)), cv.add(floor(wp.y.div(1000.0)).add(seed.mul(57.0)))), 'vec2');
    const h1 = pin(hash12(cellId));
    const h2 = pin(hash12(cellId.add(19.19)));
    const h3 = pin(hash12(cellId.add(71.7)));

    // shop aperture overrides: big glazing above a stall riser, dark fascia band on top
    const sx0 = select(inShop.greaterThan(0.5), float(0.04), ax0);
    const sx1 = select(inShop.greaterThan(0.5), float(0.96), ax1);
    const sy0 = select(inShop.greaterThan(0.5), float(0.08), ay0);
    const sy1 = select(inShop.greaterThan(0.5), float(0.74), ay1);
    const rec = select(inShop.greaterThan(0.5), float(0.25), recess);

    // ------------------------------------------------- level of detail (pixels per cell)
    const pxCell = min(bwE, fhE).div(max(fwidth(u).add(fwidth(vf)), float(1e-4)));
    const detail = smoothstep(1.0, 3.0, pxCell);
    const near = step(dist, U.detailDist);

    // ------------------------------------------------- wall material
    const wallN = vnoise(vec2(u.mul(0.35).add(seed.mul(40.0)), wp.y.mul(0.35)));
    const wallC = base.mul(mix(0.85, 1.12, wallN)).toVar();
    // panel seams on panel/glass/lux, formwork on raw, ribs on metal
    const seamU = smoothstep(0.012, 0.0, min(fu, oneMinus(fu)).mul(bwE)).mul(detail);
    const seamV = smoothstep(0.02, 0.0, min(fv, oneMinus(fv)).mul(fhE)).mul(detail);
    wallC.mulAssign(oneMinus(max(seamU, seamV).mul(0.45)));
    If(style.greaterThan(4.5).and(style.lessThan(5.5)), () => {
      const rib = abs(fract(u.mul(3.3)).sub(0.5)).mul(2.0);
      wallC.mulAssign(mix(0.62, 1.08, smoothstep(0.2, 0.9, rib).mul(detail).add(oneMinus(detail).mul(0.6))));
    });
    // spandrel on curtain walls: darker, glossy
    If(style.lessThan(0.5), () => {
      wallC.assign(base.mul(mix(0.35, 0.65, step(0.5, fv))));
    });
    // gravity grime: streaks under windows and dirt near the base
    const streakN = vnoise(vec2(u.mul(1.6).add(seed.mul(13.0)), wp.y.mul(0.07)));
    const underWin = step(sx0, fu).mul(step(fu, sx1)).mul(step(fv, sy0));
    const streak = smoothstep(0.35, 0.9, streakN).mul(grime).mul(mix(0.5, 1.0, underWin));
    const baseDirt = smoothstep(4.0, 0.0, wp.y).mul(0.4).add(smoothstep(tierH.sub(3.0), tierH, v).mul(0.25));
    const dirtK = clamp(streak.mul(0.55).add(baseDirt.mul(grime.add(0.3))), 0.0, 0.85);
    wallC.mulAssign(oneMinus(dirtK));
    wallC.assign(mix(wallC, wallC.mul(vec3(0.95, 0.88, 0.78)), grime.mul(0.5)));
    // wet sheen low on the walls in rain
    const wet = U.wet.mul(smoothstep(12.0, 0.0, wp.y)).mul(0.6);

    // ------------------------------------------------- windows
    const inAp = step(sx0, fu).mul(step(fu, sx1)).mul(step(sy0, fv)).mul(step(fv, sy1));
    // parallax recess: where does the ray meet the glass plane?
    const dU = vt.div(vn).mul(rec).div(bwE);
    const dV = V.y.div(vn).mul(rec).div(fhE);
    const gu = pin(fu.add(dU));
    const gv = pin(fv.add(dV));
    const hitGlass = step(sx0, gu).mul(step(gu, sx1)).mul(step(sy0, gv)).mul(step(gv, sy1));
    const revealC = base.mul(0.42).mul(mix(0.6, 1.0, smoothstep(0.0, 0.5, gv)));

    // lit state: whole floors of offices go dark together; homes are random
    const floorKey = hash12(vec2(cv.add(seed.mul(91.0)), seed.mul(3.0)));
    const litRoll = select(roomKind.greaterThan(0.5), mix(h1, floorKey, 0.6), h1);
    const isLit = step(litRoll, litF.mul(0.72)); // late at night: fewer rooms lit than the facade's daytime occupancy
    const coolC = vec3(0.62, 0.78, 1.0);
    const warmC = vec3(1.0, 0.68, 0.38);
    const neutralC = vec3(1.0, 0.88, 0.72);
    const hN = pin(hash12(cellId.add(5.17)));
    const lc0 = mix(mix(coolC, warmC, step(h2, warm)), neutralC, step(0.72, hN));
    // the odd tinted room: LED strips, an aquarium, a screen glowing in the dark
    const tintC = mix(vec3(0.75, 0.3, 1.0), vec3(0.25, 0.55, 1.0), step(0.5, h1));
    const lightCol = mix(lc0, tintC, step(0.94, hN)).mul(mix(0.55, 1.25, h3));
    const lightColShop = mix(vec3(0.9, 0.95, 1.0), vec3(1.0, 0.85, 0.6), step(0.5, h2));
    const lc = pin(select(inShop.greaterThan(0.5), lightColShop, lightCol), 'vec3');
    const isLitE = pin(select(inShop.greaterThan(0.5), step(grime.mul(0.5), h2), isLit));
    // dead / boarded windows on raw
    const boarded = step(5.5, style).mul(step(style, 6.5)).mul(step(0.72, h3));
    const voidWin = step(5.5, style).mul(step(style, 6.5)).mul(step(h3, 0.25)).mul(oneMinus(isLitE));

    const glassCol = vec3(0).toVar();
    const glassEmit = vec3(0).toVar();
    If(near.greaterThan(0.5).and(detail.greaterThan(0.02)), () => {
      const o = vec3(gu.sub(0.5).mul(bwE), gv.sub(0.5).mul(fhE), 0.0);
      const d = normalize(vec3(vt, V.y, vn));
      const rk = select(inShop.greaterThan(0.5), float(2.0), roomKind);
      const r = room(o, d, bwE, fhE, h1.mul(97.0).add(h2), isLitE, lc, rk);
      glassEmit.assign(r.mul(isLitE).mul(U.winGain));
      glassCol.assign(r.mul(oneMinus(isLitE)));
    }).Else(() => {
      glassEmit.assign(lc.mul(isLitE).mul(0.26).mul(U.winGain));
    });
    // curtains / blinds on homes
    const curtain = step(roomKind, 0.5).mul(step(0.55, h2)).mul(oneMinus(inShop));
    const blindBand = smoothstep(0.0, 0.08, abs(fract(gv.mul(18.0)).sub(0.5))).mul(roomKind.greaterThan(0.5).select(step(0.6, h3), float(0)));
    // curtains drawn in from both sides, backlit fabric with folds; the gap shows the room
    const cw = h3.mul(0.34).add(0.1);
    const inCurtain = step(gu, cw).add(step(oneMinus(cw), gu)).min(1.0);
    const folds = sin(gu.mul(52.0).add(h1.mul(6.0))).mul(0.22).add(0.78);
    const curtainC = lc.mul(isLitE).mul(U.winGain).mul(0.3).mul(folds).mul(vec3(1.0, 0.86, 0.72));
    glassEmit.assign(mix(glassEmit, curtainC, curtain.mul(inCurtain)));
    glassEmit.mulAssign(oneMinus(blindBand.mul(0.6)));

    // shutters on some shop units (more with grime)
    const shutter = inShop.mul(step(h1, grime.mul(0.45).add(0.06)));
    const shutterC = vec3(0.32, 0.31, 0.3).mul(mix(0.6, 1.0, abs(fract(gv.mul(30.0)).sub(0.5)).mul(2.0))).mul(oneMinus(grime.mul(0.5)));
    // shop fascia band (dark, signs sit here)
    const fascia = inShop.mul(step(0.78, fv));

    // reflection on glass
    const R = V.sub(n.mul(dot(V, n).mul(2.0)));
    const env = skyColor(vec3(R.x, max(R.y, float(0.03)), R.z));
    const spill = lightAt(wp.add(R.mul(18.0))).mul(0.4);
    const F = fresnel(vn, float(0.06));
    const refl = env.add(spill).mul(F).mul(mix(0.9, 0.5, grime));

    // compose the pane
    const pane = glassCol.mul(glassTint).add(glassEmit.mul(oneMinus(boarded)).mul(oneMinus(voidWin))).add(refl).toVar();
    pane.assign(mix(pane, vec3(0.006), voidWin));
    pane.assign(mix(pane, base.mul(vec3(0.9, 0.7, 0.45)).mul(0.6).mul(shade(vec3(1), n, wp, float(0), float(1))), boarded));
    pane.assign(mix(pane, shade(shutterC, n, wp, float(0.25), float(0.6)), shutter));

    // ------------------------------------------------- compose wall + window
    const wallLit = shade(wallC, n, wp, wallSpec.add(wet), mix(0.7, 0.3, wet));
    const recessC = shade(revealC, n, wp, float(0.02), float(1.0));
    const winMix = inAp.mul(oneMinus(fascia));
    const detailed = mix(wallLit, mix(recessC, pane, hitGlass), winMix);
    // far average: window fraction times average pane brightness
    const apArea = sx1.sub(sx0).mul(sy1.sub(sy0));
    // far away the windows average out; keep that average low so distant towers read as dark
    // masses scattered with light, not as glowing blocks
    // (the expected light colour, not this cell's: a per-cell colour here turns into blotches)
    const avgLc = select(inShop.greaterThan(0.5), vec3(0.95, 0.9, 0.8), mix(mix(coolC, warmC, warm), neutralC, 0.28).mul(0.9));
    // mid-range towers still glow with their windows; far ones fall to a dim average
    const glowK = mix(float(0.15), float(0.04), smoothstep(600.0, 1600.0, dist));
    const avgPane = avgLc.mul(litF.mul(0.72)).mul(glowK).mul(U.winGain).add(env.mul(0.06));
    const avg = mix(wallLit, avgPane, apArea.mul(0.85));
    const col = mix(avg, detailed, detail).toVar();

    // ------------------------------------------------- emissive strips
    // corner lines widen on big walls so a 300 m pyramid ridge still reads from afar
    const stripW = clamp(wlen.mul(0.004), 0.12, 1.0);
    // corner lines follow the corners, which lean inward on tapered tiers
    const uL = u.sub(taper.mul(v));
    const uR = wlen.sub(taper.mul(v)).sub(u);
    const cornerStrip = max(smoothstep(stripW.mul(2.0), float(0.0), uL), smoothstep(stripW.mul(2.0), float(0.0), uR)).mul(step(0.45, strips));
    // light lines only on the odd mechanical floor, not every slab
    const floorStrip = smoothstep(0.035, 0.0, abs(fv.sub(0.0)).min(abs(fv.sub(1.0)))).mul(step(0.62, strips)).mul(step(0.86, hash12(vec2(cv.mul(1.37).add(3.1), seed.mul(7.7))))).mul(oneMinus(inShop));
    const crown = smoothstep(1.4, 0.0, tierH.sub(v)).mul(step(0.3, strips));
    const colStrip = smoothstep(0.03, 0.0, abs(fu.sub(0.5))).mul(step(0.8, strips)).mul(step(0.84, hash12(vec2(cu.mul(1.13).add(0.7), seed.mul(5.0))))).mul(step(style, 1.5));
    const stripK = max(max(cornerStrip, floorStrip.mul(0.7)), max(crown, colStrip)).mul(strips);
    col.addAssign(accent.mul(stripK).mul(2.4).mul(U.neon));
    // architectural wash: uplight at the foot and a soft glow under the crown of
    // corporate and luxury towers (glass, panel, lux)
    const washable = step(style, 1.5).add(step(6.5, style)).min(1.0);
    const upWash = smoothstep(26.0, 0.0, wp.y.sub(shopH)).mul(step(shopH, v)).mul(0.22);
    const crownWash = smoothstep(tierH.sub(22.0), tierH, v).mul(step(30.0, tierH)).mul(0.3);
    col.addAssign(accent.mul(upWash.add(crownWash)).mul(washable).mul(strips.mul(0.8).add(0.2)).mul(oneMinus(winMix.mul(hitGlass).mul(0.6))).mul(U.neon));

    // gold trims on lux
    If(style.greaterThan(6.5), () => {
      const trim = oneMinus(inAp).mul(step(sx0.sub(0.04), fu).mul(step(fu, sx1.add(0.04))).mul(step(sy0.sub(0.04), fv)).mul(step(fv, sy1.add(0.04))));
      col.assign(mix(col, shade(vec3(0.6, 0.42, 0.16), n, wp, float(0.8), float(0.3)), trim.mul(detail)));
    });
    return vec4(col, 1.0);
  })();
  return m;
}

/** Roof material: concrete, gravel and grime, with helipads, gardens and crown lights by roof kind (aR.x). */
export function makeRoofMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'roof';
  m.fog = false;
  m.colorNode = Fn(() => {
    const R = attribute('aR', 'vec4'); // kind, grime, seed, size
    const C = attribute('aRc', 'vec4'); // accent rgb, strips
    const B = attribute('aRb', 'vec4'); // centre x, centre z, half extent, base brightness
    const wp = positionWorld;
    const kind = R.x;
    // kind 4 is a soffit (the underside of an overhang) and faces down
    const n = vec3(0, oneMinus(step(3.5, kind).mul(2.0)), 0);
    const ed = uv().x; // metres to the nearest edge of the cap
    const p = wp.xz;
    const nz = vnoise(p.mul(0.4).add(R.z.mul(50.0)));
    const fine = vnoise(p.mul(3.1));
    const alb = vec3(0.13, 0.13, 0.14).mul(B.w).mul(mix(0.75, 1.15, nz)).mul(mix(0.9, 1.05, fine)).toVar();
    alb.mulAssign(oneMinus(R.y.mul(smoothstep(0.4, 0.8, vnoise(p.mul(0.15))).mul(0.5))));
    const e = vec3(0).toVar();
    const q = p.sub(B.xy);
    const r = length(q);
    // helipad: dark pad, white ring and H, edge lights
    If(kind.greaterThan(0.5).and(kind.lessThan(1.5)), () => {
      const pr = B.z.mul(0.8);
      const pad = step(r, pr);
      alb.assign(mix(alb, vec3(0.05, 0.055, 0.06), pad));
      const ring = smoothstep(0.25, 0.0, abs(r.sub(pr.mul(0.82))));
      const hx = step(abs(q.x), pr.mul(0.28)).mul(step(abs(q.y), pr.mul(0.32)));
      const hcut = step(pr.mul(0.08), abs(q.x)).mul(step(pr.mul(0.18), abs(q.x))).mul(step(pr.mul(0.06), abs(q.y)));
      const hmark = hx.mul(oneMinus(hcut.mul(0.0))).mul(step(pr.mul(0.18), abs(q.x)).add(step(abs(q.y), pr.mul(0.05))).min(1.0));
      alb.assign(mix(alb, vec3(0.7), max(ring, hmark).mul(pad)));
      const dots = step(0.7, fract(atan2_(q).mul(4.0))).mul(smoothstep(0.35, 0.0, abs(r.sub(pr))));
      e.addAssign(C.rgb.mul(dots).mul(4.0).mul(sin(time.mul(3.0)).mul(0.4).add(0.8)));
    })
      .ElseIf(kind.greaterThan(1.5).and(kind.lessThan(2.5)), () => {
        // garden: grass, hedges, path
        const g = vnoise(p.mul(1.3));
        alb.assign(mix(vec3(0.02, 0.05, 0.025), vec3(0.04, 0.08, 0.035), g));
        const path = smoothstep(0.6, 0.45, abs(fract(q.x.mul(0.08)).sub(0.5)));
        alb.assign(mix(alb, vec3(0.2, 0.18, 0.15), path.mul(0.6)));
        e.addAssign(vec3(1.0, 0.8, 0.5).mul(step(0.985, hash12(floor(p.mul(0.5))))).mul(1.5));
      })
      .ElseIf(kind.greaterThan(2.5).and(kind.lessThan(3.5)), () => {
        // crown: dark deck with accent edge glow
        alb.assign(vec3(0.04, 0.045, 0.05));
        const edge = smoothstep(1.5, 0.0, ed);
        e.addAssign(C.rgb.mul(edge).mul(C.w).mul(3.0));
      })
      .ElseIf(kind.greaterThan(3.5), () => {
        // soffit: dark coffered concrete, an accent light line set in from the
        // edge and a grid of warm downlights (some dead in grimy districts)
        // patterns finer than a pixel fade to their average far away
        const far = smoothstep(0.06, 0.25, fwidth(p.x).add(fwidth(p.y)));
        const g3 = abs(fract(p.div(3.0)).sub(0.5));
        const rib = mix(smoothstep(0.42, 0.47, max(g3.x, g3.y)), float(0.12), far);
        alb.assign(vec3(0.03, 0.03, 0.034).mul(mix(1.0, 1.6, rib)).mul(mix(0.85, 1.1, nz)));
        const line = smoothstep(0.2, 0.0, abs(ed.sub(1.2)));
        e.addAssign(C.rgb.mul(line).mul(C.w).mul(3.2));
        const cellP = p.div(4.5);
        const cd = length(fract(cellP).sub(0.5)).mul(4.5);
        const alive = step(R.y.mul(0.55), hash12(floor(cellP).add(R.z.mul(91.0))));
        const spot = smoothstep(0.34, 0.16, cd);
        const dl = mix(spot, float(0.016), far).mul(step(2.4, ed)).mul(alive);
        e.addAssign(vec3(1.0, 0.8, 0.58).mul(dl).mul(3.0));
      });
    const wetK = U.wet.mul(smoothstep(0.55, 0.75, vnoise(p.mul(0.25))));
    const lit = shade(alb.mul(oneMinus(wetK.mul(0.4))), n, wp, wetK.mul(0.7).add(0.02), mix(0.9, 0.2, wetK));
    return vec4(lit.add(e.mul(U.neon)), 1.0);
  })();
  return m;
}

// atan2 helper for angular patterns
const atan2_ = (q) => {
  // cheap pseudo-angle in [0, 1)
  const a = q.y.div(abs(q.x).add(abs(q.y)).max(1e-4));
  return select(q.x.lessThan(0.0), float(2.0).sub(a), a).add(4.0).mod(4.0).div(4.0);
};

void pow;
void hash13;
void clamp;
