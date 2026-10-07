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
 *  - farther out, floors become ribbons of light, then a dim average with
 *    faint bands, so nothing shimmers and nothing glows flat,
 *  - storefronts along shop walls get their own retail interiors and shutters,
 *  - media towers carry LED lines on their slabs and corners.
 *
 * Vertex attributes (constant per wall):
 *  aF0 (style, floorH, bayW, win)  aF1 (lit, warm, grime, seed)
 *  aF2 (base rgb, strips)           aF3 (accent rgb, wall length)
 *  aF4 (shopH, tierH, taper, media) uv (metres along the wall, metres above the tier base)
 *  (taper: on sloped walls, how far each corner leans in per metre of height;
 *   media: 0 none, 1 LED outline, 2 the city-wide light show)
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
  exp,
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
import { bond, cellular, fbmF, joints, lineAA, nightLightDir, shadeN, streakNoise, throwUp } from './surface';
import { wallSurface } from './wallmat';
import { localDiffuse } from './locallights';

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
    const glassTint = vec3(0.55, 0.62, 0.66).toVar();
    If(style.lessThan(0.5), () => {
      // glass curtain wall
      ax0.assign(0.035);
      ax1.assign(0.965);
      ay0.assign(0.14);
      ay1.assign(0.985);
      recess.assign(0.05);
      roomKind.assign(1);
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

    // ------------------------------------------------- wall surface (wallmat.ts)
    // metres per pixel on the wall, taken here in uniform control flow
    const mpp = pin(max(fwidth(u), fwidth(v)).max(1e-4));
    const S = wallSurface({ u, v, vf, wy: wp.y, n, tng, mpp, near, base, fhE, bwE, sx0, sx1, sy0, sy1, inShop, cu, cv, fu, fv, style, seed, grime, tierH, wlen });
    const Ld = nightLightDir(n, wp);
    // light from the signs, lamps and fires near this point, once for every layer here
    const Eloc = pin(localDiffuse(wp, n), 'vec3');

    // ------------------------------------------------- windows
    const inAp = step(sx0, fu).mul(step(fu, sx1)).mul(step(sy0, fv)).mul(step(fv, sy1));
    // parallax recess: where does the ray meet the glass plane?
    const dU = vt.div(vn).mul(rec).div(bwE);
    const dV = V.y.div(vn).mul(rec).div(fhE);
    const gu = pin(fu.add(dU));
    const gv = pin(fv.add(dV));
    const hitGlass = step(sx0, gu).mul(step(gu, sx1)).mul(step(sy0, gv)).mul(step(gv, sy1));
    const revealC = mix(base, S.alb, 0.5).mul(0.45).mul(mix(0.6, 1.0, smoothstep(0.0, 0.5, gv)));

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
    // roller shutters: painted or bare slats, rust and dirt at the foot, runs from the
    // box at the top, and tags in grimy blocks
    const slat = abs(fract(gv.mul(30.0)).sub(0.5)).mul(2.0);
    const shPaint = select(h2.lessThan(0.55), vec3(0.32, 0.31, 0.3), select(h2.lessThan(0.75), vec3(0.12, 0.2, 0.16), select(h2.lessThan(0.9), vec3(0.08, 0.12, 0.2), vec3(0.3, 0.07, 0.05))));
    const shY = gv.sub(sy0).mul(fhE);
    const shX = gu.mul(bwE);
    const shRust = smoothstep(0.5, 0.0, shY.add(vnoise(vec2(shX.mul(3.0), h1.mul(9.0))).mul(0.3))).mul(grime.mul(0.8).add(0.2));
    const shRuns = smoothstep(0.5, 0.8, streakNoise(shX, sy1.sub(gv).mul(fhE), 4.0, 0.6)).mul(grime);
    const shTU = throwUp(shX.sub(0.12), shY, float(0.35).add(h3.mul(0.3)), float(0.75), h1, float(4.0), mpp);
    const shTag = shTU.x.add(shTU.y).min(1.0).mul(step(h3, grime.mul(grime).mul(0.8)));
    const shFill = mix(vec3(0.55, 0.06, 0.05), vec3(0.06, 0.38, 0.5), step(0.5, h2));
    const shutterBase = shPaint.mul(mix(0.6, 1.0, slat)).mul(oneMinus(grime.mul(0.35))).mul(oneMinus(shRuns.mul(0.3)));
    const shutterC = mix(mix(shutterBase, vec3(0.13, 0.055, 0.025), shRust.mul(0.7)), mix(vec3(0.015), shFill, shTU.x), shTag.mul(0.88));
    // shop fascia band (dark, signs sit here)
    const fascia = inShop.mul(step(0.78, fv));

    // reflection on glass: each pane sits a hair off true (more on old towers), so the
    // reflected city breaks up pane by pane instead of sliding across the facade as one mirror
    const tiltAmt = mix(0.006, 0.022, grime).mul(detail);
    const nP = normalize(n.add(tng.mul(h2.sub(0.5).mul(tiltAmt))).add(vec3(0.0, h3.sub(0.5).mul(tiltAmt), 0.0)));
    const R = V.sub(nP.mul(dot(V, nP).mul(2.0)));
    const env = skyColor(vec3(R.x, max(R.y, float(0.03)), R.z));
    const Lr = lightAt(wp.add(R.mul(18.0)));
    const spill = Lr.div(dot(Lr, vec3(0.3, 0.5, 0.2)).mul(0.6).add(1.0)).mul(0.4);
    const F = fresnel(vn, float(0.06));
    // dirty glass: a dust film that collects toward the bottom of each pane, with rain streaks
    const paneY = gv.sub(sy0).div(max(sy1.sub(sy0), float(0.05)));
    const glassDirt = clamp(grime.mul(0.6).add(0.12).mul(smoothstep(0.35, 0.75, streakNoise(u, v, 3.0, 0.3)).mul(0.6).add(smoothstep(0.4, 0.0, paneY).mul(0.5))), 0.0, 1.0);
    const refl = env.add(spill).mul(F).mul(mix(0.9, 0.5, grime)).mul(oneMinus(glassDirt.mul(0.45)));

    // compose the pane
    const pane = glassCol.mul(glassTint).add(glassEmit.mul(oneMinus(glassDirt.mul(0.2))).mul(oneMinus(boarded)).mul(oneMinus(voidWin))).add(refl).toVar();
    pane.addAssign(shade(vec3(0.06, 0.055, 0.05), n, wp, float(0.0), float(1.0), Eloc).mul(glassDirt.mul(0.5)));
    // frames: aluminium, white or dark, round each pane, a meeting rail on sliding windows
    // (homes), a transom on some, mullions across shop fronts; silhouetted against lit rooms
    const aaU = mpp.div(bwE);
    const aaW = mpp.div(fhE);
    const fU = float(0.045).div(bwE);
    const fV = float(0.045).div(fhE);
    const insideU = smoothstep(sx0.add(fU).sub(aaU), sx0.add(fU).add(aaU), gu).mul(smoothstep(sx1.sub(fU).add(aaU), sx1.sub(fU).sub(aaU), gu));
    const insideV = smoothstep(sy0.add(fV).sub(aaW), sy0.add(fV).add(aaW), gv).mul(smoothstep(sy1.sub(fV).add(aaW), sy1.sub(fV).sub(aaW), gv));
    const home = step(roomKind, 0.5).mul(oneMinus(inShop));
    const rail = smoothstep(fU.mul(0.6).add(aaU), fU.mul(0.6).sub(aaU), abs(gu.sub(sx0.add(sx1).mul(0.5)))).mul(home).mul(step(0.25, h3));
    const trY = sy0.add(sy1.sub(sy0).mul(0.74));
    const transom = smoothstep(fV.mul(0.5).add(aaW), fV.mul(0.5).sub(aaW), abs(gv.sub(trY))).mul(step(0.55, h2)).mul(oneMinus(inShop));
    const shopMull = smoothstep(float(0.03).add(mpp), float(0.03).sub(mpp), abs(fract(gu.mul(bwE).div(1.25)).sub(0.5)).mul(1.25)).mul(inShop);
    const frameK = max(max(oneMinus(insideU.mul(insideV)), rail), max(transom, shopMull)).mul(hitGlass).mul(smoothstep(0.07, 0.03, mpp)).mul(step(0.5, style)).mul(oneMinus(boarded));
    const fh3 = hash12(vec2(seed.mul(4.4), 2.9));
    const frameAlb = select(fh3.lessThan(0.5), vec3(0.17, 0.175, 0.18), select(fh3.lessThan(0.8), vec3(0.3, 0.3, 0.29), vec3(0.04, 0.036, 0.032))).mul(oneMinus(grime.mul(0.4)));
    const frameLit = shade(frameAlb, n, wp, float(0.35), float(0.4), Eloc).add(lc.mul(isLitE).mul(U.winGain).mul(0.025));
    pane.assign(mix(pane, frameLit, frameK));
    pane.assign(mix(pane, vec3(0.006), voidWin));
    // boarded windows: weathered plywood sheets with grain and screw lines
    const plyGrain = vnoise(vec2(gu.mul(bwE).mul(1.5), gv.mul(fhE).mul(28.0)).add(h1.mul(30.0)));
    const plySheet = step(0.5, fract(gu.mul(bwE).div(1.2)));
    const plyC = vec3(0.24, 0.17, 0.1).mul(mix(0.75, 1.15, plyGrain)).mul(mix(0.85, 1.05, plySheet)).mul(oneMinus(grime.mul(0.45)));
    pane.assign(mix(pane, shade(plyC, n, wp, float(0.02), float(0.9), Eloc), boarded));
    pane.assign(mix(pane, shade(shutterC, n, wp, float(0.25), float(0.6), Eloc), shutter));

    // ------------------------------------------------- compose wall + window
    // a lit window lights the wall round it a little, most of all the sill and the wall
    // below it, so the facade's stains and texture show up next to the lit rooms
    const dWx = max(max(sx0.sub(fu), fu.sub(sx1)), float(0.0)).mul(bwE);
    const dWy = max(max(sy0.sub(fv), fv.sub(sy1)), float(0.0)).mul(fhE);
    const below = step(fv, sy0);
    const winSpill = exp(length(vec2(dWx, dWy)).negate().div(mix(0.22, 0.4, below))).mul(mix(0.45, 1.0, below)).mul(oneMinus(inAp)).mul(oneMinus(inShop.mul(0.5)));
    const wallLit = shadeN(S.alb, n, S.nb, wp, S.spec, S.rough, S.cav, Ld, Eloc).add(S.alb.mul(lc).mul(isLitE).mul(U.winGain).mul(0.05).mul(winSpill).mul(oneMinus(boarded)));
    // the reveal is lit by the room behind the glass
    const recessC = shade(revealC, n, wp, float(0.02), float(1.0), Eloc).add(lc.mul(isLitE).mul(U.winGain).mul(0.05).mul(oneMinus(boarded)));
    const winMix = inAp.mul(oneMinus(fascia));
    const detailed = mix(wallLit, mix(recessC, pane, hitGlass), winMix);
    // far average: window fraction times average pane brightness
    const apArea = sx1.sub(sx0).mul(sy1.sub(sy0));
    // far away the windows average out; keep that average low so distant towers read as dark
    // masses scattered with light, not as glowing blocks
    // (the expected light colour, not this cell's: a per-cell colour here turns into blotches)
    const avgLc = select(inShop.greaterThan(0.5), vec3(0.95, 0.9, 0.8), mix(mix(coolC, warmC, warm), neutralC, 0.28).mul(0.9));
    // mid-range towers still glow with their windows; far ones fall to a dim average
    const glowK = mix(float(0.11), float(0.035), smoothstep(600.0, 1600.0, dist));
    const share = litF.mul(0.72);
    // Rows: once single windows merge sideways but floors are still a few pixels tall,
    // each floor reads as a ribbon of light whose brightness is its share of lit rooms
    // (comps: office towers at night are bands of lit and dark floors). The share
    // matches the near rule above: office windows key on mix(h1, floorKey, 0.6), so a
    // floor's expected share is clamp((share - 0.6 floorKey) / 0.4); homes vary floor to
    // floor around the mean as a handful of random rooms would.
    const rowShare = select(
      roomKind.greaterThan(0.5),
      mix(share, clamp(share.sub(floorKey.mul(0.6)).div(0.4), 0.0, 1.0), 0.75),
      share.mul(mix(0.55, 1.45, hash12(vec2(cv.add(seed.mul(17.0)), 6.3)))).min(1.0),
    );
    // floors differ in light too: cool, neutral or warm tubes, the odd tinted floor
    const fh2 = hash12(vec2(cv.mul(1.31).add(seed.mul(23.0)), 2.2));
    const rowTint = select(fh2.lessThan(0.3), vec3(0.8, 0.95, 1.12), select(fh2.lessThan(0.55), vec3(1.12, 0.96, 0.78), select(fh2.lessThan(0.93), vec3(1.0), vec3(0.85, 0.75, 1.25))));
    const aaV = fwidth(vf).max(1e-4);
    const row = smoothstep(sy0.sub(aaV), sy0.add(aaV), fv).mul(oneMinus(smoothstep(sy1.sub(aaV), sy1.add(aaV), fv)));
    // a ribbon is not a flat band: lit and dark runs along the floor (a few bays long),
    // and the ceiling lights make the top of each row brighter than the desks below
    const runs = vnoise(vec2(u.div(bwE.mul(3.5)).add(seed.mul(31.0)), cv.mul(1.7).add(seed.mul(7.0))));
    const ceilK = mix(0.5, 1.35, smoothstep(sy0, sy1, fv));
    const ribbonC = avgLc
      .mul(rowTint)
      .mul(select(inShop.greaterThan(0.5), share, rowShare))
      .mul(mix(0.2, 1.45, smoothstep(0.25, 0.75, runs)))
      .mul(ceilK)
      .mul(0.19)
      .mul(U.winGain)
      .mul(mix(1.0, 0.5, smoothstep(700.0, 1800.0, dist)));
    const avgRow = mix(wallLit, ribbonC.add(env.mul(0.06)), row.mul(sx1.sub(sx0)).mul(oneMinus(fascia)));
    // Flat: when even floors merge, pairs of floors still keep faint bands (office
    // floors switch off together) that fade to the mean below ~1.5 px per pair.
    const pairKey = hash12(vec2(floor(cv.mul(0.5)).add(seed.mul(13.0)), seed.mul(5.0).add(2.7)));
    const bandShare = select(roomKind.greaterThan(0.5), step(pairKey, share).mul(0.9).add(0.04), pairKey.mul(pairKey).mul(2.4).mul(share).min(1.0));
    const pxPair = fhE.mul(2.0).div(aaV);
    const floorShare = mix(share, mix(share, bandShare, 0.6), smoothstep(1.2, 3.0, pxPair));
    const avgPane = avgLc.mul(select(inShop.greaterThan(0.5), share, floorShare)).mul(glowK).mul(U.winGain).add(env.mul(0.06));
    const avgFlat = mix(wallLit, avgPane, apArea.mul(0.85));
    const avg = mix(avgFlat, avgRow, smoothstep(1.4, 3.2, fhE.div(aaV)));
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
      col.assign(mix(col, shade(vec3(0.6, 0.42, 0.16), n, wp, float(0.8), float(0.3), Eloc), trim.mul(detail)));
    });
    // ------------------------------------------------- LED media facades
    // (comps: Chongqing and Shanghai riverfronts, Hong Kong's harbour front) LED lines on
    // the floor slabs and corners. 'outline' towers hold a steady warm, cool or gold line;
    // 'show' towers run one city-wide programme on a shared clock, so the waterfront
    // skyline moves as one. Lines keep their light with distance: a 0.24 m strip widens
    // to ~0.7 px and dims by the same factor, so a far tower still draws its lines.
    // Derivatives are taken here, outside the branch (they need uniform control flow).
    const mppV = pin(fwidth(v).max(1e-4));
    const mppU = pin(fwidth(u).max(1e-4));
    const dCorner = pin(min(uL, uR));
    const media = F4.w;
    If(media.greaterThan(0.5), () => {
      const line = (d, half, mpp) => {
        const w = max(half, mpp.mul(0.7));
        return smoothstep(w, w.mul(0.2), d).mul(half.div(w));
      };
      // the slab nearest this pixel: the bottom of this floor or of the next one
      const lower = step(fv, 0.5);
      const slabIdx = cv.add(oneMinus(lower));
      const dSlab = min(fv, oneMinus(fv)).mul(fhE);
      const k1 = hash12(vec2(seed.mul(3.7), 1.9));
      const k2 = hash12(vec2(seed.mul(5.3), 7.7));
      // outline towers line every floor, every second or every third
      const every = floor(k1.mul(2.99)).add(1.0);
      const onEvery = step(fract(slabIdx.div(every).add(0.001)), 0.02);
      const slab = line(dSlab, float(0.12), mppV).mul(oneMinus(inShop));
      const corner = line(dCorner, float(0.18), mppU);
      const outlineC = select(k2.lessThan(0.42), vec3(1.0, 0.8, 0.52), select(k2.lessThan(0.75), vec3(0.82, 0.9, 1.0), vec3(1.0, 0.62, 0.24)));
      const breathe = mix(1.0, sin(time.mul(0.6).add(seed.mul(40.0))).mul(0.18).add(0.82), step(0.6, k1));
      const outline = outlineC.mul(slab.mul(onEvery).add(corner)).mul(breathe).mul(3.0);
      // the show: four scenes of 12 s on one clock, with a dip to dark between them
      const T = time.add(7.0);
      const scene = floor(fract(T.div(48.0)).mul(4.0));
      const lt = fract(T.div(12.0)).mul(12.0);
      const fade = smoothstep(0.0, 0.7, lt).mul(smoothstep(12.0, 11.3, lt));
      const h01 = clamp(v.div(max(tierH, float(1.0))), 0.0, 1.0);
      // 0: colour bands climbing every tower, offset along the shore
      const climbPos = fract(lt.mul(0.16).add(wp.x.mul(0.0004)));
      const climb = smoothstep(0.22, 0.0, abs(h01.sub(climbPos))).mul(0.8).add(0.22);
      const climbHue = h01.mul(0.35).add(0.52);
      // 1: a wave rolling along the skyline
      const wave = sin(wp.x.mul(0.011).sub(lt.mul(2.3))).mul(0.5).add(0.5);
      const waveHue = fract(wp.x.mul(0.00035).add(lt.mul(0.02)).add(0.85));
      // 2: a rainbow scrolling down the towers
      const rainbowHue = fract(wp.y.mul(0.0032).sub(lt.mul(0.07)).add(wp.x.mul(0.0002)));
      // 3: sparkle on the slabs and mullions (per bay up close, its average far away)
      const cell = hash12(vec2(cu.add(seed.mul(13.0)), cv.add(floor(lt.mul(5.0)).mul(7.0))));
      const sparkleNear = step(0.78, cell);
      const sparkle = mix(float(0.22), sparkleNear, smoothstep(0.6, 0.2, mppU.div(bwE)));
      const hue = select(scene.lessThan(0.5), climbHue, select(scene.lessThan(1.5), waveHue, select(scene.lessThan(2.5), rainbowHue, float(0.58))));
      const amt = select(scene.lessThan(0.5), climb, select(scene.lessThan(1.5), wave.mul(0.9).add(0.1), select(scene.lessThan(2.5), float(1.0), sparkle)));
      const rgb = clamp(abs(fract(vec3(hue, hue.add(0.6667), hue.add(0.3333))).mul(6.0).sub(3.0)).sub(1.0), 0.0, 1.0);
      const showC = mix(rgb, vec3(1.0), select(scene.greaterThan(2.5), float(0.55), float(0.12)));
      const mull = line(min(fu, oneMinus(fu)).mul(bwE), float(0.08), mppU).mul(step(2.5, scene));
      const show = showC.mul(slab.add(corner).add(mull.mul(0.7))).mul(amt).mul(fade).mul(3.6);
      col.addAssign(select(media.lessThan(1.5), outline, show).mul(U.neon));
    });

    return vec4(col, 1.0);
  })();
  return m;
}

/**
 * Roof material. Flat roofs are one of four finishes per building: bitumen membrane
 * laid in strips with lapped seams and patches, gravel ballast scoured down to the
 * membrane in places, concrete pavers on pedestals, or a pale coating that shows
 * every stain. All of them collect dirt along the parapet, dry rings where water
 * ponds (puddles in the rain), dirt round the drains, moss and soot in grimy
 * blocks. Helipads, gardens, crowns and soffits (aR.x) sit on top of that.
 */
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
    const grime = R.y;
    const seed = R.z;
    // kind 4 is a soffit (the underside of an overhang) and faces down
    const n = vec3(0, oneMinus(step(3.5, kind).mul(2.0)), 0);
    const ed = pin(uv().x); // metres to the nearest edge of the cap
    const p = pin(wp.xz, 'vec2');
    // metres per pixel on the roof, taken here in uniform control flow
    const mpp = pin(max(fwidth(p.x), fwidth(p.y)).max(1e-4));
    const q = pin(p.sub(B.xy), 'vec2');
    const r = length(q);
    const rf = pin(hash12(vec2(seed.mul(53.0), 7.1)));
    const rd = pin(hash12(vec2(seed.mul(17.0), 2.3)));
    const bright = B.w;
    const alb = vec3(0).toVar();
    const gx = float(0).toVar();
    const gz = float(0).toVar();
    const spec = float(0.05).toVar();
    const rough = float(0.85).toVar();
    const cav = float(1).toVar();
    const membraneC = vec3(0.05, 0.05, 0.052).mul(bright);
    If(rf.lessThan(0.3), () => {
      // bitumen membrane in 1 m strips with a lapped seam bead, granules, patches, blisters
      const across = select(rd.lessThan(0.5), p.y, p.x);
      const along = select(rd.lessThan(0.5), p.x, p.y);
      const strip = floor(across);
      const s1 = hash12(vec2(strip, seed.mul(9.0)));
      alb.assign(membraneC.mul(mix(0.8, 1.25, s1)));
      const seamD = fract(across).sub(0.08);
      const seam = lineAA(seamD, 0.014, mpp);
      alb.assign(mix(alb, alb.mul(1.5).add(0.006), seam));
      const beadK = smoothstep(0.05, 0.015, mpp);
      const slope = seamD.div(0.02).clamp(-1.0, 1.0).mul(-0.4).mul(seam).mul(beadK);
      gx.assign(select(rd.lessThan(0.5), float(0.0), slope));
      gz.assign(select(rd.lessThan(0.5), slope, float(0.0)));
      alb.mulAssign(mix(0.88, 1.12, fbmF(p.mul(30.0), mpp.mul(30.0))));
      // patches: newer, blacker rectangles
      const pc = vec2(floor(along.div(2.5)), strip);
      const patch = step(0.9, hash12(pc.add(seed.mul(5.0)))).mul(step(0.15, fract(along.div(2.5)))).mul(step(fract(along.div(2.5)), 0.8));
      alb.assign(mix(alb, membraneC.mul(0.7), patch));
      // blisters
      const bl = cellular(p.mul(0.9).add(seed.mul(7.0)));
      const blister = smoothstep(0.14, 0.05, bl.x).mul(step(0.6, vnoise(p.mul(0.25)))).mul(grime);
      alb.assign(mix(alb, alb.mul(1.15), blister.mul(0.5)));
      spec.assign(0.08);
      rough.assign(0.6);
    })
      .ElseIf(rf.lessThan(0.55), () => {
        // gravel ballast, scoured down to the membrane in places
        const cc = cellular(p.mul(22.0));
        const tone = vnoise(p.mul(22.0).add(3.3));
        const stoneK = smoothstep(0.03, 0.01, mpp);
        const pebble = smoothstep(0.0, 0.3, cc.y.sub(cc.x));
        const gravel = mix(vec3(0.085, 0.085, 0.08), vec3(0.21, 0.2, 0.19), tone).mul(mix(0.45, 1.0, pebble)).mul(bright);
        alb.assign(mix(vec3(0.13, 0.128, 0.122).mul(bright), gravel, stoneK));
        cav.assign(mix(float(0.85), mix(0.6, 1.0, pebble), stoneK));
        const scour = smoothstep(0.7, 0.78, fbmF(p.mul(0.5).add(seed.mul(3.0)), mpp.mul(0.5))).mul(0.7);
        alb.assign(mix(alb, membraneC, scour));
        cav.assign(mix(cav, 1.0, scour));
        spec.assign(0.02);
        rough.assign(0.95);
      })
      .ElseIf(rf.lessThan(0.8), () => {
        // concrete pavers on pedestals: a tone and a tilt per paver, dark open joints
        const Bd = bond(p.x, p.y, 0.6, 0.6, 0.008, mpp, 0.0);
        const t1 = hash12(Bd.id.add(seed.mul(11.0)));
        const t2 = hash12(Bd.id.add(seed.mul(29.0)).add(4.4));
        const varK = smoothstep(0.3, 0.12, mpp);
        alb.assign(vec3(0.16, 0.155, 0.15).mul(bright).mul(mix(1.0, mix(0.82, 1.15, t1), varK)));
        alb.mulAssign(mix(0.92, 1.06, fbmF(p.mul(12.0), mpp.mul(12.0))));
        alb.assign(mix(alb, vec3(0.02, 0.022, 0.02), Bd.joint));
        cav.assign(mix(1.0, 0.4, Bd.joint));
        gx.assign(t1.sub(0.5).mul(0.03).mul(varK));
        gz.assign(t2.sub(0.5).mul(0.03).mul(varK));
        spec.assign(0.04);
        rough.assign(0.85);
      })
      .Else(() => {
        // pale coating: shows every stain; seams every 3 m
        alb.assign(vec3(0.36, 0.36, 0.35).mul(bright).mul(mix(0.92, 1.05, fbmF(p.mul(0.8).add(seed), mpp.mul(0.8)))));
        const seam = max(joints(p.x, 3.0, 0.01, mpp), joints(p.y, 3.0, 0.01, mpp));
        alb.assign(mix(alb, alb.mul(0.7), seam));
        spec.assign(0.08);
        rough.assign(0.6);
      });

    // ---- weathering: dirt along the parapet, dry rings round ponding, drains, moss, soot
    const wK = grime.mul(0.8).add(0.25);
    const edgeK = smoothstep(1.1, 0.0, ed).mul(0.55).add(smoothstep(0.25, 0.0, ed).mul(0.35)).mul(vnoise(p.mul(1.7)).mul(0.6).add(0.6));
    const pondN = fbmF(p.mul(0.11).add(seed.mul(13.0)), mpp.mul(0.11));
    const pond = pin(smoothstep(0.6, 0.68, pondN));
    const rings = smoothstep(0.55, 0.62, pondN).mul(sin(pondN.mul(170.0)).mul(0.5).add(0.5)).mul(smoothstep(0.08, 0.03, mpp)).mul(oneMinus(pond));
    // drains near two opposite corners of the cap
    const hx = B.z.mul(0.7);
    const dq = vec2(abs(q.x).sub(hx), abs(q.y).sub(hx));
    const dd = length(dq);
    const drainSide = step(0.0, q.x.mul(q.y).mul(select(rd.lessThan(0.5), float(1.0), float(-1.0))));
    const drain = smoothstep(0.14, 0.1, dd).mul(drainSide);
    const halo = smoothstep(1.4, 0.0, dd).mul(drainSide);
    const soot = smoothstep(0.62, 0.8, fbmF(p.mul(0.3).add(seed.mul(17.0)), mpp.mul(0.3))).mul(grime);
    const dirt = clamp(edgeK.mul(0.6).add(pond.mul(0.2)).add(rings.mul(0.2)).add(halo.mul(0.45)).add(soot.mul(0.2)), 0.0, 1.0).mul(wK);
    alb.assign(mix(alb, alb.mul(vec3(0.58, 0.54, 0.48)), dirt));
    alb.assign(mix(alb, vec3(0.008), drain));
    const moss = clamp(edgeK.add(pond.mul(0.8)).add(halo.mul(0.6)), 0.0, 1.0).mul(smoothstep(0.45, 0.7, fbmF(p.mul(0.9).add(seed.mul(2.0)), mpp.mul(0.9)))).mul(grime.mul(grime));
    alb.assign(mix(alb, vec3(0.022, 0.038, 0.02), moss.mul(0.45)));
    alb.mulAssign(mix(0.92, 1.06, vnoise(p.mul(0.4).add(seed.mul(50.0)))));

    const e = vec3(0).toVar();
    // helipad: dark pad, worn white ring and H, tyre scuffs, edge lights
    If(kind.greaterThan(0.5).and(kind.lessThan(1.5)), () => {
      const pr = B.z.mul(0.8);
      const pad = step(r, pr);
      alb.assign(mix(alb, vec3(0.05, 0.055, 0.06).mul(mix(0.85, 1.1, vnoise(p.mul(2.0)))), pad));
      const ring = smoothstep(0.25, 0.0, abs(r.sub(pr.mul(0.82))));
      const hx2 = step(abs(q.x), pr.mul(0.28)).mul(step(abs(q.y), pr.mul(0.32)));
      const hmark = hx2.mul(step(pr.mul(0.18), abs(q.x)).add(step(abs(q.y), pr.mul(0.05))).min(1.0));
      const wear = smoothstep(0.35, 0.65, fbmF(p.mul(1.6), mpp.mul(1.6)));
      alb.assign(mix(alb, vec3(0.62), max(ring, hmark).mul(pad).mul(mix(0.45, 1.0, wear))));
      const scuff = smoothstep(0.03, 0.0, abs(fract(atan2_(q).mul(9.0).add(r.mul(0.05))).sub(0.5)).mul(0.2)).mul(smoothstep(pr.mul(0.5), pr.mul(0.2), r)).mul(0.5);
      alb.assign(mix(alb, vec3(0.015), scuff.mul(pad)));
      const dots = step(0.7, fract(atan2_(q).mul(4.0))).mul(smoothstep(0.35, 0.0, abs(r.sub(pr))));
      e.addAssign(C.rgb.mul(dots).mul(4.0).mul(sin(time.mul(3.0)).mul(0.4).add(0.8)));
    })
      .ElseIf(kind.greaterThan(1.5).and(kind.lessThan(2.5)), () => {
        // garden: grass, hedges, path
        const g = vnoise(p.mul(1.3));
        alb.assign(mix(vec3(0.02, 0.05, 0.025), vec3(0.04, 0.08, 0.035), g).mul(mix(0.85, 1.15, fbmF(p.mul(7.0), mpp.mul(7.0)))));
        const path = smoothstep(0.6, 0.45, abs(fract(q.x.mul(0.08)).sub(0.5)));
        alb.assign(mix(alb, vec3(0.2, 0.18, 0.15), path.mul(0.6)));
        e.addAssign(vec3(1.0, 0.8, 0.5).mul(step(0.985, hash12(floor(p.mul(0.5))))).mul(1.5));
        spec.assign(0.02);
        rough.assign(0.95);
      })
      .ElseIf(kind.greaterThan(2.5).and(kind.lessThan(3.5)), () => {
        // crown: dark deck with accent edge glow
        alb.assign(vec3(0.04, 0.045, 0.05).mul(mix(0.8, 1.1, vnoise(p.mul(0.7)))));
        const edge = smoothstep(1.5, 0.0, ed);
        e.addAssign(C.rgb.mul(edge).mul(C.w).mul(3.0));
      })
      .ElseIf(kind.greaterThan(3.5), () => {
        // soffit: dark coffered concrete with water stains, an accent light line set in from
        // the edge and a grid of warm downlights (some dead in grimy districts)
        // patterns finer than a pixel fade to their average far away
        const far = smoothstep(0.06, 0.25, mpp.mul(2.0));
        const g3 = abs(fract(p.div(3.0)).sub(0.5));
        const rib = mix(smoothstep(0.42, 0.47, max(g3.x, g3.y)), float(0.12), far);
        const stain = smoothstep(0.55, 0.75, fbmF(p.mul(0.4).add(seed.mul(9.0)), mpp.mul(0.4))).mul(grime.mul(0.6).add(0.2));
        alb.assign(vec3(0.03, 0.03, 0.034).mul(mix(1.0, 1.6, rib)).mul(mix(0.85, 1.1, vnoise(p.mul(0.4)))).mul(oneMinus(stain.mul(0.4))));
        gx.assign(0.0);
        gz.assign(0.0);
        const line = smoothstep(0.2, 0.0, abs(ed.sub(1.2)));
        e.addAssign(C.rgb.mul(line).mul(C.w).mul(3.2));
        const cellP = p.div(4.5);
        const cd = length(fract(cellP).sub(0.5)).mul(4.5);
        const alive = step(grime.mul(0.55), hash12(floor(cellP).add(seed.mul(91.0))));
        const spot = smoothstep(0.34, 0.16, cd);
        const dl = mix(spot, float(0.016), far).mul(step(2.4, ed)).mul(alive);
        e.addAssign(vec3(1.0, 0.8, 0.58).mul(dl).mul(3.0));
      });

    // rain: the whole roof darkens and shines, ponds turn into puddles
    const wetK = U.wet.mul(pond.mul(0.85).add(0.15));
    alb.mulAssign(oneMinus(wetK.mul(0.35)));
    spec.assign(mix(spec, float(0.9), U.wet.mul(pond)).add(U.wet.mul(0.06)));
    rough.assign(mix(rough, float(0.05), U.wet.mul(pond)));
    const nb = normalize(vec3(gx.negate(), 1.0, gz.negate()).mul(n.y));
    const lit = shadeN(alb, n, nb, wp, spec, rough, cav, nightLightDir(n, wp));
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
