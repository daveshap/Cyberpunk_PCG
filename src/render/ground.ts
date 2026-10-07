// @ts-nocheck -- TSL node graphs are dynamically typed.
/**
 * Ground: asphalt road pieces with lane markings and crosswalks, raised block
 * plates (sidewalk ring + lot ground), the land around the city, the sea and
 * the seawall. Wet patches mirror the light volume above them; rain adds ripples.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  abs,
  attribute,
  cameraPosition,
  clamp,
  cos,
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
  normalize,
  oneMinus,
  normalWorld,
  positionWorld,
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
import type { Block, CitySpec, RoadPiece, Street } from '../core/types';
import { MeshBuilder } from './geometry';
import { U, fbm3o, fresnel, hash12, hash22, keepAlpha, lightAt, pin, rainRipples, reflectedLight, shade, skyColor, vnoise, waterNormal, groundAt } from './tsl';
import { bond, cellular, desat, fbmD, fbmF, joints, lineAA, lum, shadeN, streakNoise } from './surface';

export const ROAD_EXTRAS = { aRd: 4, aRj: 4 };
export const PLATE_EXTRAS = { aP0: 4, aP1: 4, aP2: 4 };

const KIND_CODE: Record<string, number> = { highway: 0, arterial: 0, local: 1, alley: 2 };
const OPEN_CODE: Record<Block['open'], number> = { none: 0, plaza: 1, park: 2, yard: 3, rubble: 4 };

export function addRoadPiece(b: MeshBuilder, rp: RoadPiece, st: Street): void {
  const r = rp.rect;
  const axisCode = rp.axis === 'x' ? 0 : rp.axis === 'z' ? 1 : 2;
  const kc = KIND_CODE[rp.kind] ?? 1;
  b.set('aRd', axisCode, kc, rp.lanes, st.road / 2);
  b.set('aRj', (r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, (r.x1 - r.x0) / 2, (r.z1 - r.z0) / 2);
  // uv: along, across (from the street centre line); junctions use the world xz
  const uvAt = (x: number, z: number): [number, number] => (rp.axis === 'x' ? [x, z - st.pos] : rp.axis === 'z' ? [z, x - st.pos] : [x, z]);
  const p = [
    [r.x0, r.z0],
    [r.x1, r.z0],
    [r.x1, r.z1],
    [r.x0, r.z1],
  ];
  const ids = p.map(([x, z]) => {
    const [u, v] = uvAt(x as number, z as number);
    return b.vert(x as number, 0, z as number, 0, 1, 0, u, v);
  });
  // up-facing: counter-clockwise seen from above means (x0,z1)->(x1,z1)->(x1,z0) ... use reversed order
  b.quad(ids[0] as number, ids[3] as number, ids[2] as number, ids[1] as number);
}

export function addPlate(b: MeshBuilder, blk: Block, districtCode: number, seed: number, grime: number): void {
  const P = blk.plate;
  const y = 0.15;
  b.set('aP0', P.x0, P.z0, P.x1, P.z1);
  b.set('aP1', blk.walk[0], blk.walk[1], blk.walk[2], blk.walk[3]);
  b.set('aP2', OPEN_CODE[blk.open], districtCode, seed, grime);
  const top = [
    b.vert(P.x0, y, P.z0, 0, 1, 0, 0, 0),
    b.vert(P.x1, y, P.z0, 0, 1, 0, 0, 0),
    b.vert(P.x1, y, P.z1, 0, 1, 0, 0, 0),
    b.vert(P.x0, y, P.z1, 0, 1, 0, 0, 0),
  ];
  b.quad(top[0] as number, top[3] as number, top[2] as number, top[1] as number);
  // curb sides
  const side = (ax: number, az: number, bx: number, bz: number, nx: number, nz: number): void => {
    const a0 = b.vert(ax, 0, az, nx, 0, nz, 0, 0);
    const b0 = b.vert(bx, 0, bz, nx, 0, nz, 1, 0);
    const b1 = b.vert(bx, y, bz, nx, 0, nz, 1, 1);
    const a1 = b.vert(ax, y, az, nx, 0, nz, 0, 1);
    b.quad(a0, b0, b1, a1);
  };
  side(P.x1, P.z0, P.x0, P.z0, 0, -1);
  side(P.x1, P.z1, P.x1, P.z0, 1, 0);
  side(P.x0, P.z1, P.x1, P.z1, 0, 1);
  side(P.x0, P.z0, P.x0, P.z1, -1, 0);
}

/**
 * Ground response shared by roads and plates: albedo darkening when wet, a relief
 * normal (the surface's own slopes, drowned under standing water, plus rain
 * ripples), extra gloss (sealant, oil, polish) and the reflection. The light on
 * the ground comes from the fine ground map; its gradient says which way the lamp
 * or shop front is, so grain, joints and cracks catch the light from that side.
 */
const wetSurface = Fn(([alb, wp, wetK, puddle, gloss, slope]) => {
  const rip = rainRipples(wp.xz.mul(1.6)).mul(U.rain);
  const dry = oneMinus(puddle);
  const rk = puddle.mul(0.8).add(0.2);
  const n = normalize(vec3(rip.x.mul(rk).sub(slope.x.mul(dry)), 1.0, rip.y.mul(rk).sub(slope.y.mul(dry))));
  const albW = alb.mul(mix(1.0, 0.45, wetK));
  const V = normalize(cameraPosition.sub(wp));
  const ndv = clamp(dot(n, V), 0.0, 1.0);
  const R = V.negate().sub(n.mul(dot(V.negate(), n).mul(2.0)));
  const F = fresnel(ndv, float(0.02)).mul(mix(0.25, 1.0, puddle)).mul(wetK.add(gloss).min(1.0));
  const k = F.mul(1.3).min(1.0);
  // reflect the light above the street and the sky; with screen-space reflections
  // on, the post pass does this instead (k travels in the alpha channel)
  const reflL = lightAt(wp.add(R.mul(10.0))).mul(0.7).add(lightAt(wp.add(R.mul(30.0))).mul(0.5));
  const reflS = skyColor(vec3(R.x, max(R.y, float(0.02)), R.z));
  // pools of light under lamps and in front of shops: the ground map is fine (3 m), so
  // the street keeps its full response to it (seen from above, lit streets are what
  // draws the city's grid at night)
  const g0 = groundAt(wp);
  const l0 = lum(g0).add(0.002);
  const lx = lum(groundAt(wp.add(vec3(1.0, 0.0, 0.0)))).sub(l0).div(l0);
  const lz = lum(groundAt(wp.add(vec3(0.0, 0.0, 1.0)))).sub(l0).div(l0);
  const Ld = normalize(vec3(clamp(lx.mul(4.0), -2.0, 2.0), 1.0, clamp(lz.mul(4.0), -2.0, 2.0)));
  const up = vec3(0.0, 1.0, 0.0);
  const rel = clamp(dot(n, Ld).add(0.3).div(dot(up, Ld).add(0.3)), 0.3, 2.0);
  const pool = g0.mul(albW).mul(1.15).mul(rel);
  const diffuse = shadeN(albW, up, n, wp, float(0.0), float(1.0), float(1.0), Ld).add(pool);
  return vec4(diffuse.add(reflL.add(reflS).mul(k).mul(oneMinus(U.ssrOn))), oneMinus(k));
});

/**
 * Asphalt: binder and aggregate with the odd light stone, soft repair patches and
 * rectangular utility cuts with sealed edges, a crack network (sealed with tar in
 * places), oil down the lane centres and polished wheel paths, a concrete gutter
 * along the kerb that collects grit and water, drain grates, manhole covers, and
 * worn, chipped markings (cracks run through them).
 */
export function makeRoadMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'road';
  m.fog = false;
  m.colorNode = Fn(() => {
    const R = attribute('aRd', 'vec4'); // axis code, kind code, lanes, half width
    const J = attribute('aRj', 'vec4'); // piece centre, half extents
    const wp = positionWorld;
    const p = pin(wp.xz, 'vec2');
    const along = pin(uv().x);
    const across = pin(uv().y);
    const axis = R.x;
    const kind = R.y;
    const lanes = R.z;
    const hw = R.w;
    // pixel footprint in metres, and the markings' antialias width, in uniform control flow
    const mpp = pin(max(fwidth(p.x), fwidth(p.y)).max(1e-4));
    const aa = pin(fwidth(across).max(0.002));
    const street = step(axis, 1.5);
    // asphalt: binder and aggregate, the odd light stone
    const n1 = fbm3o(p.mul(0.08));
    const alb = vec3(0.05, 0.05, 0.054).mul(mix(0.75, 1.25, n1)).toVar();
    const grain = fbmD(p.mul(45.0), mpp.mul(45.0));
    alb.mulAssign(mix(0.86, 1.14, grain.x));
    const slope = vec2(grain.y, grain.z).mul(45.0 * 0.0015).toVar();
    const stoneK = step(0.94, hash12(floor(p.mul(55.0)))).mul(smoothstep(0.012, 0.005, mpp));
    alb.assign(mix(alb, alb.mul(1.7).add(0.01), stoneK.mul(0.6)));
    const gloss = float(0).toVar();
    // soft repair patches
    const patch = step(0.72, vnoise(p.mul(0.045).add(7.0)));
    alb.assign(mix(alb, alb.mul(1.35), patch.mul(0.6)));
    // utility cuts: newer, darker rectangles across part of the road, sealed round the edge
    const seg = floor(along.div(9.0));
    const ch = hash12(vec2(seg, J.x.add(J.y.mul(1.7)).mul(0.013)));
    const ch2 = hash12(vec2(seg.add(3.1), J.x.sub(J.y).mul(0.011)));
    const la = fract(along.div(9.0)).mul(9.0);
    const cLen = mix(1.2, 3.5, ch2);
    const c0 = mix(hw.negate(), float(0.0), ch2);
    const c1 = c0.add(mix(1.0, hw, ch));
    const dCut = max(max(float(2.0).sub(la), la.sub(cLen.add(2.0))), max(c0.sub(across), across.sub(c1)));
    const isCut = step(0.82, ch).mul(street);
    const inCut = smoothstep(aa, aa.negate(), dCut).mul(isCut);
    const cutEdge = lineAA(dCut, 0.02, mpp).mul(isCut);
    alb.assign(mix(alb, vec3(0.035, 0.035, 0.038).mul(mix(0.85, 1.1, grain.x)), inCut));
    // tyre tracks: polished wheel paths either side of the lane centre, oil down the middle
    const lw = hw.div(max(lanes, 1.0));
    const inLane = fract(abs(across).div(lw)).sub(0.5).mul(lw);
    const wz = abs(inLane).sub(0.8).div(0.3);
    const wheel = exp(wz.mul(wz).negate()).mul(street);
    alb.assign(mix(alb, alb.mul(vec3(1.12, 1.12, 1.1)), wheel.mul(0.35)));
    gloss.assign(wheel.mul(0.12));
    const oilN = fbmF(vec2(along.mul(0.35), across.mul(1.5)).add(13.0), mpp.mul(1.5));
    const oil = exp(inLane.mul(inLane).div(-0.12)).mul(smoothstep(0.55, 0.7, oilN)).mul(street);
    alb.assign(mix(alb, alb.mul(0.5), oil.mul(0.7)));
    gloss.assign(max(gloss, oil.mul(0.25)));
    // markings
    const lineAt = (x, w) => smoothstep(w.add(aa), w.sub(aa), abs(across.sub(x)));
    const mark = float(0).toVar();
    const markCol = vec3(0.55).toVar();
    If(axis.lessThan(1.5), () => {
      If(kind.lessThan(0.5), () => {
        // arterial: double yellow centre, dashed lane lines, solid edges
        const yel = max(lineAt(float(0.18), float(0.07)), lineAt(float(-0.18), float(0.07)));
        mark.assign(yel);
        markCol.assign(mix(markCol, vec3(0.62, 0.42, 0.05), yel));
        const dash = step(fract(along.div(9.0)), 0.45);
        const li = abs(across).div(lw);
        const lane = smoothstep(0.08, 0.0, abs(fract(li).sub(0.0)).min(abs(fract(li).sub(1.0))).mul(lw).sub(0.06)).mul(dash).mul(step(lw.mul(0.9), abs(across))).mul(step(abs(across), hw.sub(0.6)));
        mark.assign(max(mark, lane));
        const edge = lineAt(hw.sub(0.65), float(0.08)).add(lineAt(hw.negate().add(0.65), float(0.08)));
        mark.assign(max(mark, edge));
      }).ElseIf(kind.lessThan(1.5), () => {
        // local: dashed white centre line
        const dash = step(fract(along.div(6.0)), 0.5);
        mark.assign(lineAt(float(0.0), float(0.07)).mul(dash));
      });
    }).Else(() => {
      // junction: zebra crossings along each edge band
      const q = p.sub(J.xy);
      const dx = J.z.sub(abs(q.x));
      const dz = J.w.sub(abs(q.y));
      const band = 3.2;
      const zebraX = step(dx, band).mul(step(0.7, dx)).mul(step(0.5, fract(q.y.div(1.2))));
      const zebraZ = step(dz, band).mul(step(0.7, dz)).mul(step(0.5, fract(q.x.div(1.2))));
      mark.assign(max(zebraX, zebraZ).mul(step(kind, 1.5)));
    });
    // worn paint: thin where wheels run, chipped, grimy
    const wear = smoothstep(0.25, 0.75, vnoise(p.mul(0.9)));
    const chips = mix(smoothstep(0.38, 0.5, fbmF(p.mul(7.0), mpp.mul(7.0))), float(0.8), smoothstep(0.02, 0.06, mpp));
    alb.assign(mix(alb, markCol.mul(mix(0.75, 1.0, grain.x)), mark.mul(mix(0.3, 0.9, wear)).mul(chips).mul(oneMinus(wheel.mul(0.45)))));
    // crack network, sealed with tar in places (cracks run through the markings)
    If(mpp.lessThan(0.12), () => {
      const cw = vec2(fbm3o(p.mul(0.3)), fbm3o(p.mul(0.3).add(5.0))).sub(0.5).mul(1.2);
      const cc = cellular(p.mul(0.45).add(cw));
      const crackD = cc.y.sub(cc.x).div(0.45);
      const crackMask = smoothstep(0.45, 0.65, fbmF(p.mul(0.07).add(2.0), mpp.mul(0.07)));
      const crack = lineAA(crackD, 0.004, mpp).mul(crackMask);
      const sealZone = step(0.55, vnoise(p.mul(0.02).add(9.0)));
      const sealant = lineAA(crackD, 0.028, mpp).mul(crackMask).mul(sealZone);
      alb.assign(mix(alb, vec3(0.012, 0.012, 0.013), max(crack.mul(0.85), sealant.mul(0.9))));
      gloss.assign(max(gloss, sealant.mul(0.35)));
    });
    alb.assign(mix(alb, vec3(0.012), cutEdge.mul(0.9)));
    gloss.assign(max(gloss, cutEdge.mul(0.35)));
    // gutter: a concrete strip along the kerb that collects grit
    const gutter = smoothstep(hw.sub(0.5).sub(aa), hw.sub(0.5).add(aa), abs(across)).mul(street);
    const grit = smoothstep(0.5, 0.75, fbmF(vec2(along.mul(1.5), across.mul(9.0)), mpp.mul(9.0)));
    alb.assign(mix(alb, vec3(0.11, 0.108, 0.1).mul(mix(1.0, 0.45, grit)).mul(mix(0.9, 1.08, grain.x)), gutter));
    // drain grates by the kerb every ~35 m
    const dg = fract(along.div(35.0)).mul(35.0);
    const inGrate = step(17.0, dg).mul(step(dg, 17.9)).mul(step(hw.sub(0.48), abs(across))).mul(step(abs(across), hw.sub(0.05))).mul(street);
    const slots = mix(step(0.45, fract(dg.mul(16.0))), float(0.5), smoothstep(0.01, 0.03, mpp));
    alb.assign(mix(alb, mix(vec3(0.07, 0.065, 0.06), vec3(0.004), slots), inGrate));
    // manholes: a cast cover with a raised grid, a rusty rim
    const mh = floor(p.div(23.0));
    const mc = mh.add(0.5).mul(23.0).add(hash12(mh).sub(0.5).mul(10.0));
    const mq = p.sub(mc);
    const md = length(mq);
    const hasMh = step(0.6, hash12(mh.add(3.3)));
    const cover = smoothstep(0.62, 0.6, md).mul(hasMh);
    const studs = max(joints(mq.x, 0.1, 0.012, mpp), joints(mq.y, 0.1, 0.012, mpp));
    const rim = smoothstep(0.7, 0.62, md).mul(smoothstep(0.58, 0.62, md)).mul(hasMh);
    alb.assign(mix(alb, mix(vec3(0.045, 0.043, 0.04), vec3(0.09, 0.085, 0.08), studs), cover));
    alb.assign(mix(alb, vec3(0.12, 0.06, 0.03), rim.mul(0.7)));
    gloss.assign(max(gloss, cover.mul(0.2)));
    // wetness: puddles in dips and along the gutter, an overall wet sheen in rain
    const puddle = max(smoothstep(0.52, 0.7, fbm3o(p.mul(0.11).add(3.0))), gutter.mul(smoothstep(0.35, 0.6, vnoise(p.mul(0.6)))).mul(0.85)).mul(U.wet);
    const wetK = clamp(U.wet.mul(0.55).add(puddle), 0.0, 1.0);
    return wetSurface(alb, wp, wetK, puddle, gloss, slope);
  })();
  keepAlpha(m);
  return m;
}

/**
 * Block plates: the sidewalk ring and the lot inside it. Pavers with a tone and a
 * tilt each, grimy joints, stains, gum, the odd cracked or sunken paver, a worn
 * line where people walk, yellow tactile pads at the corners, kerb stones with
 * chipped arrises (painted on some blocks); lots of cast concrete with joints and
 * oil, plaza tiles, grass with worn paths, yards and rubble.
 */
export function makePlateMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'plate';
  m.fog = false;
  m.colorNode = Fn(() => {
    const P0 = attribute('aP0', 'vec4');
    const P1 = attribute('aP1', 'vec4');
    const P2 = attribute('aP2', 'vec4');
    const wp = positionWorld;
    const p = pin(wp.xz, 'vec2');
    const mpp = pin(max(fwidth(p.x), fwidth(p.y)).max(1e-4));
    const isTop = step(0.12, wp.y);
    // distance to each plate edge
    const dX0 = p.x.sub(P0.x);
    const dX1 = P0.z.sub(p.x);
    const dZ0 = p.y.sub(P0.y);
    const dZ1 = P0.w.sub(p.y);
    const inWalk = pin(max(max(step(dX0, P1.x), step(dX1, P1.y)), max(step(dZ0, P1.z), step(dZ1, P1.w))));
    const edgeD = pin(min(min(dX0, dX1), min(dZ0, dZ1)));
    const open = P2.x;
    const seed = P2.z;
    const grime = P2.w;
    const slope = vec2(0).toVar();
    const gloss = float(0).toVar();
    const sunk = float(0).toVar();
    // ---- sidewalk pavers
    const B = bond(p.x, p.y, 0.6, 0.6, 0.004, mpp, 0.0);
    const t1 = hash12(B.id.add(seed.mul(31.0)));
    const t2 = hash12(B.id.add(seed.mul(7.0)).add(5.1));
    const varK = smoothstep(0.3, 0.1, mpp);
    const walkC = vec3(0.1, 0.1, 0.105).mul(mix(1.0, mix(0.85, 1.15, t1), varK)).mul(mix(0.9, 1.08, fbmF(p.mul(20.0), mpp.mul(20.0)))).toVar();
    walkC.assign(mix(walkC, vec3(0.03, 0.03, 0.028), B.joint.mul(mix(0.55, 0.8, grime))));
    slope.assign(vec2(t1.sub(0.5), t2.sub(0.5)).mul(0.035).mul(varK).mul(oneMinus(B.joint)));
    // stains: drinks, oil, the dark halo under a stall
    const blot = smoothstep(0.62, 0.72, fbmF(p.mul(1.4).add(seed.mul(9.0)), mpp.mul(1.4))).mul(grime.mul(0.7).add(0.3));
    walkC.mulAssign(oneMinus(blot.mul(0.45)));
    // a worn line down the middle of the walk, where people tread
    const walkW = select(min(dX0, dX1).lessThan(min(dZ0, dZ1)), select(dX0.lessThan(dX1), P1.x, P1.y), select(dZ0.lessThan(dZ1), P1.z, P1.w));
    const tread = smoothstep(walkW.mul(0.35), float(0.0), abs(edgeD.sub(walkW.mul(0.55))));
    walkC.assign(mix(walkC, walkC.mul(1.12).add(0.004), tread.mul(0.5)));
    gloss.assign(tread.mul(0.06));
    If(mpp.lessThan(0.03), () => {
      // gum and spots, a cracked paver here and there
      const gq = p.mul(9.0);
      const gc = floor(gq);
      const gh = hash12(gc.add(seed.mul(13.0)));
      const go = fract(gq).sub(hash22(gc).mul(0.6).add(0.2)).div(9.0);
      const gum = step(mix(0.992, 0.97, grime), gh).mul(lineAA(length(go), 0.009, mpp));
      walkC.assign(mix(walkC, vec3(0.02, 0.02, 0.022), gum.mul(0.8)));
      const cracked = step(0.93, t2);
      const ang = t1.mul(3.14);
      const cf = B.f.sub(0.5).mul(0.6);
      const cd = cf.x.mul(sin(ang)).sub(cf.y.mul(cos(ang))).add(vnoise(B.f.mul(9.0).add(t1.mul(20.0))).sub(0.5).mul(0.02));
      const crack = lineAA(cd, 0.0012, mpp).mul(cracked);
      walkC.assign(mix(walkC, vec3(0.012), crack));
    });
    // sunken pavers hold water
    sunk.assign(step(t1, 0.035).mul(oneMinus(B.joint)));
    // yellow tactile pads at the corners, where the crossings are
    const corner = step(min(dX0, dX1), P1.x.max(P1.y).min(2.4)).mul(step(min(dZ0, dZ1), P1.z.max(P1.w).min(2.4))).mul(step(0.6, edgeD.add(1.0)));
    const dimple = mix(smoothstep(0.012, 0.008, length(fract(p.div(0.05)).sub(0.5)).mul(0.05)), float(0.25), smoothstep(0.01, 0.03, mpp));
    const tactile = corner.mul(step(0.45, edgeD)).mul(step(edgeD, 1.25));
    walkC.assign(mix(walkC, mix(vec3(0.5, 0.36, 0.04), vec3(0.32, 0.23, 0.03), dimple).mul(mix(0.7, 1.0, oneMinus(grime))), tactile));
    // kerb stones: 1 m units, chipped arrises, painted yellow along some blocks
    const kerb = smoothstep(0.32, 0.26, edgeD);
    const along = select(min(dX0, dX1).lessThan(min(dZ0, dZ1)), p.y, p.x);
    const kj = joints(along, 1.0, 0.003, mpp);
    const kh = hash12(vec2(floor(along), seed.mul(17.0)));
    const painted = step(0.75, hash12(vec2(seed.mul(3.3), 8.8)));
    const kerbC = mix(vec3(0.16, 0.16, 0.165).mul(mix(0.88, 1.1, kh)), vec3(0.42, 0.32, 0.04), painted.mul(smoothstep(0.3, 0.6, fbmF(p.mul(3.0), mpp.mul(3.0)))).mul(0.8)).toVar();
    kerbC.assign(mix(kerbC, vec3(0.05), kj));
    const chip = smoothstep(0.05, 0.0, edgeD).mul(smoothstep(0.6, 0.7, vnoise(p.mul(7.0))));
    kerbC.assign(mix(kerbC, kerbC.mul(0.6), chip));
    const walk = mix(walkC, kerbC, kerb);
    // ---- lot ground by open kind: none (cast concrete), plaza (big tiles), park (grass),
    // yard (asphalt), rubble
    const lotN = vnoise(p.mul(0.5));
    const lot = vec3(0.07, 0.07, 0.072).mul(mix(0.8, 1.2, lotN)).toVar();
    If(open.lessThan(0.5), () => {
      // cast slabs 4 m square: joints, a tone per slab, oil where cars stood, hairline cracks
      const S = bond(p.x, p.y, 4.0, 4.0, 0.006, mpp, 0.0);
      const sh = hash12(S.id.add(seed.mul(5.0)));
      lot.assign(vec3(0.085, 0.084, 0.082).mul(mix(0.88, 1.1, sh)).mul(mix(0.9, 1.07, fbmF(p.mul(15.0), mpp.mul(15.0)))));
      const oilL = smoothstep(0.6, 0.72, fbmF(p.mul(0.6).add(seed.mul(3.0)), mpp.mul(0.6)));
      lot.assign(mix(lot, lot.mul(0.45), oilL.mul(0.7)));
      lot.assign(mix(lot, vec3(0.02), S.joint));
      gloss.assign(max(gloss, oilL.mul(0.15)));
    })
      .ElseIf(open.lessThan(1.5), () => {
        const T = bond(p.x, p.y, 2.4, 2.4, 0.012, mpp, 0.0);
        const th = hash12(T.id.add(seed.mul(9.0)));
        lot.assign(vec3(0.13, 0.13, 0.14).mul(mix(0.9, 1.1, th)).mul(mix(0.92, 1.06, fbmF(p.mul(6.0), mpp.mul(6.0)))));
        lot.assign(mix(lot, lot.mul(0.5), T.joint));
        slope.assign(vec2(th.sub(0.5), hash12(T.id.add(2.2)).sub(0.5)).mul(0.02));
      })
      .ElseIf(open.lessThan(2.5), () => {
        const worn = smoothstep(0.62, 0.7, fbmF(p.mul(0.35).add(seed), mpp.mul(0.35)));
        lot.assign(mix(mix(vec3(0.02, 0.045, 0.022), vec3(0.035, 0.07, 0.03), vnoise(p.mul(0.9))).mul(mix(0.8, 1.15, fbmF(p.mul(8.0), mpp.mul(8.0)))), vec3(0.06, 0.05, 0.04), worn));
      })
      .ElseIf(open.lessThan(3.5), () => {
        const oilY = smoothstep(0.55, 0.7, fbmF(p.mul(0.5).add(seed.mul(7.0)), mpp.mul(0.5)));
        lot.assign(vec3(0.04, 0.04, 0.042).mul(mix(0.8, 1.2, lotN)).mul(mix(0.88, 1.1, fbmF(p.mul(40.0), mpp.mul(40.0)))).mul(oneMinus(oilY.mul(0.5))));
        gloss.assign(max(gloss, oilY.mul(0.2)));
      })
      .Else(() => {
        // rubble: broken concrete and brick, dust
        const cc = cellular(p.mul(3.0));
        const chunk = smoothstep(0.0, 0.2, cc.y.sub(cc.x));
        const ch = hash12(floor(p.mul(3.0)));
        const debris = select(ch.lessThan(0.25), vec3(0.16, 0.07, 0.05), select(ch.lessThan(0.7), vec3(0.11, 0.105, 0.1), vec3(0.06, 0.055, 0.05)));
        lot.assign(mix(vec3(0.07, 0.06, 0.05), debris.mul(mix(0.5, 1.0, chunk)), smoothstep(0.04, 0.015, mpp).mul(0.8).add(0.2)));
      });
    const alb = mix(lot, walk, inWalk).mul(oneMinus(grime.mul(0.3))).toVar();
    // curb sides: concrete, dirtier toward the road
    alb.assign(mix(vec3(0.12, 0.12, 0.125).mul(mix(0.6, 1.0, smoothstep(0.0, 0.12, wp.y))), alb, isTop));
    const puddle = max(smoothstep(0.58, 0.74, fbm3o(p.mul(0.16).add(9.0))), sunk.mul(inWalk)).mul(U.wet).mul(isTop);
    const wetK = clamp(U.wet.mul(0.45).add(puddle), 0.0, 1.0);
    return wetSurface(alb, wp, wetK, puddle, gloss, slope.mul(isTop));
  })();
  keepAlpha(m);
  return m;
}

/** Land around and under the city (beyond the plates) and the seawall. */
export function makeLandMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'land';
  m.fog = false;
  m.colorNode = Fn(() => {
    const wp = positionWorld;
    const p = wp.xz;
    const n = fbm3o(p.mul(0.02));
    const alb = mix(vec3(0.03, 0.028, 0.025), vec3(0.06, 0.05, 0.04), n);
    // sparse street lights out in the sprawl, drawn as soft dots at least a pixel
    // wide (energy kept constant) so they do not sparkle in the distance
    const R = U.cityRect;
    const outside = max(max(R.x.sub(p.x), p.x.sub(R.z)), max(R.y.sub(p.y), p.y.sub(R.w)));
    const fw = max(fwidth(p.x), fwidth(p.y));
    const cell = floor(p.div(16.0));
    const ctr = cell.add(hash22(cell).mul(0.6).add(0.2)).mul(16.0);
    const r = max(float(0.45), fw.mul(1.1));
    const dotK = smoothstep(r, r.mul(0.25), length(p.sub(ctr))).mul(float(0.45).div(r).mul(float(0.45).div(r)));
    const away = smoothstep(30.0, 90.0, outside);
    const lit = step(0.93, hash12(cell)).mul(away).mul(dotK);
    const lampC = mix(vec3(1.0, 0.55, 0.22), vec3(0.75, 0.85, 1.0), step(0.6, hash12(cell.add(3.3))));
    // plus the faint sodium wash of streets seen from afar (light pollution on the ground)
    const e = lampC.mul(lit).mul(3.0).add(vec3(0.009, 0.005, 0.0024).mul(away).mul(vnoise(p.mul(0.012)).mul(0.8).add(0.4)));
    return vec4(shade(alb, vec3(0, 1, 0), wp, float(0.02), float(1.0)).add(e), 1.0);
  })();
  return m;
}

export function makeWaterMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'water';
  m.fog = false;
  m.colorNode = Fn(() => {
    const wp = positionWorld;
    const n = waterNormal(wp, cameraPosition);
    const V = normalize(cameraPosition.sub(wp));
    const ndv = clamp(dot(n, V), 0.0, 1.0);
    const R = V.negate().sub(n.mul(dot(V.negate(), n).mul(2.0)));
    const F = fresnel(ndv, float(0.02));
    const k = F.mul(1.1).min(1.0);
    const deep = vec3(0.003, 0.006, 0.009);
    const refl = reflectedLight(wp, R).mul(oneMinus(U.ssrOn));
    // alpha carries the screen-space reflection weight for the post pass (1 - k)
    return vec4(deep.add(refl.mul(k)), oneMinus(k));
  })();
  keepAlpha(m);
  return m;
}

/**
 * Seawall: cast concrete panels with joints, tide bands (algae dark at the
 * waterline, a barnacle crust above it), rust runs from the mooring rings and a
 * wet sheen. uv = (m along, 0..1 up).
 */
export function makeSeawallMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'seawall';
  m.fog = false;
  m.colorNode = Fn(() => {
    const wp = positionWorld;
    const n = normalize(normalWorld);
    const u = uv().x;
    const v = uv().y;
    const mpp = max(fwidth(u), fwidth(v).mul(1.6)).max(1e-4);
    const panel = joints(u, 6.0, 0.012, mpp);
    const pid = floor(u.div(6.0));
    const stain = vnoise(vec2(u.mul(0.7), v.mul(3.0)));
    const alb = vec3(0.1, 0.1, 0.095).mul(mix(0.7, 1.1, stain)).mul(mix(0.9, 1.08, hash12(vec2(pid, 3.3)))).mul(oneMinus(panel.mul(0.5))).toVar();
    alb.mulAssign(mix(0.9, 1.08, fbmF(vec2(u, v.mul(1.6)).mul(18.0), mpp.mul(18.0))));
    // rust runs down from a mooring ring every ~14 m
    const rq = fract(u.div(14.0)).sub(0.5).mul(14.0);
    const run = smoothstep(0.12, 0.02, abs(rq.add(vnoise(vec2(v.mul(6.0), pid)).sub(0.5).mul(0.08)))).mul(smoothstep(1.0, 0.4, v));
    alb.assign(mix(alb, vec3(0.14, 0.06, 0.025), run.mul(0.6)));
    // barnacle crust above the waterline, algae dark at it
    const barn = smoothstep(0.62, 0.42, v).mul(smoothstep(0.2, 0.32, v)).mul(smoothstep(0.45, 0.6, fbmF(vec2(u, v).mul(25.0), mpp.mul(25.0))));
    alb.assign(mix(alb, vec3(0.16, 0.155, 0.14), barn.mul(0.7)));
    alb.assign(mix(alb, vec3(0.02, 0.03, 0.022), smoothstep(0.55, 0.15, v.add(vnoise(vec2(u.mul(0.8), 1.0)).sub(0.5).mul(0.1)))));
    const lit = shade(alb, n, wp, mix(0.5, 0.08, v), float(0.4));
    return vec4(lit, 1.0);
  })();
  return m;
}

/** Ground geometry for the whole city: roads (one mesh per chunk is built by the caller), land, sea, seawall. */
export function buildLandAndSea(spec: CitySpec): { land: THREE.BufferGeometry; sea: THREE.BufferGeometry; wall: THREE.BufferGeometry } {
  const B = spec.bounds;
  const far = 9000;
  const land = new MeshBuilder({}, { uv: true, normals: true });
  const wall = new MeshBuilder({}, { uv: true, normals: true });
  const up = (x0: number, z0: number, x1: number, z1: number, y: number, target: MeshBuilder): void => {
    const a = target.vert(x0, y, z0, 0, 1, 0, 0, 0);
    const b = target.vert(x1, y, z0, 0, 1, 0, 0, 0);
    const c = target.vert(x1, y, z1, 0, 1, 0, 0, 0);
    const d = target.vert(x0, y, z1, 0, 1, 0, 0, 0);
    target.quad(a, d, c, b);
  };
  // coast columns from the sampled coastline
  const xs: number[] = [];
  const zs: number[] = [];
  const { x0, step, z } = spec.coast;
  for (let i = 0; i < z.length; i++) {
    xs.push(x0 + i * step);
    zs.push(z[i] as number);
  }
  // land strips: north of the coast inside the bounds, and everything beyond the bounds to the north/east/west
  for (let i = 0; i < xs.length - 1; i++) up(xs[i] as number, B.z0, xs[i + 1] as number, zs[i] as number, -0.05, land);
  up(-far, -far, far, B.z0, -0.05, land);
  up(-far, B.z0, B.x0, zs[0] as number, -0.05, land);
  up(B.x1, B.z0, far, zs[zs.length - 1] as number, -0.05, land);
  // seawall faces along the coast steps
  const seaY = -1.6;
  for (let i = 0; i < xs.length - 1; i++) {
    const zz = zs[i] as number;
    const xa = xs[i] as number;
    const xb = xs[i + 1] as number;
    const a = wall.vert(xa, seaY, zz, 0, 0, 1, 0, 0);
    const b = wall.vert(xb, seaY, zz, 0, 0, 1, 1, 0);
    const c = wall.vert(xb, 0, zz, 0, 0, 1, 1, 1);
    const d = wall.vert(xa, 0, zz, 0, 0, 1, 0, 1);
    wall.quad(a, b, c, d);
    const zn = zs[i + 1] as number;
    if (Math.abs(zn - zz) > 0.5) {
      // a step in the coast: the longer column's side faces the sea of the shorter one
      const za = Math.min(zz, zn);
      const zb = Math.max(zz, zn);
      const nx = zn > zz ? -1 : 1;
      const p0 = wall.vert(xb, seaY, za, nx, 0, 0, 0, 0);
      const p1 = wall.vert(xb, seaY, zb, nx, 0, 0, 1, 0);
      const p2 = wall.vert(xb, 0, zb, nx, 0, 0, 1, 1);
      const p3 = wall.vert(xb, 0, za, nx, 0, 0, 0, 1);
      if (nx < 0) wall.quad(p0, p1, p2, p3);
      else wall.quad(p1, p0, p3, p2);
    }
  }
  const sea = new MeshBuilder({}, { uv: true, normals: true });
  up(-far, B.z0, far, far, seaY, sea);
  return { land: land.build(), sea: sea.build(), wall: wall.build() };
}

void sin;
void select;
