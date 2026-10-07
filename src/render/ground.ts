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
  dot,
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
import { U, fbm3o, fresnel, hash12, hash22, keepAlpha, lightAt, rainRipples, reflectedLight, shade, skyColor, vnoise, waterNormal, groundAt } from './tsl';

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

/** Wet-ground response shared by roads and plates: albedo darkening, ripple normal, reflection. */
const wetSurface = Fn(([alb, wp, wetK, puddle]) => {
  const rip = rainRipples(wp.xz.mul(1.6)).mul(U.rain);
  const n = normalize(vec3(rip.x.mul(puddle.mul(0.8).add(0.2)), 1.0, rip.y.mul(puddle.mul(0.8).add(0.2))));
  const albW = alb.mul(mix(1.0, 0.45, wetK));
  const V = normalize(cameraPosition.sub(wp));
  const ndv = clamp(dot(n, V), 0.0, 1.0);
  const R = V.negate().sub(n.mul(dot(V.negate(), n).mul(2.0)));
  const F = fresnel(ndv, float(0.02)).mul(mix(0.25, 1.0, puddle)).mul(wetK);
  const k = F.mul(1.3).min(1.0);
  // reflect the light above the street and the sky; with screen-space reflections
  // on, the post pass does this instead (k travels in the alpha channel)
  const reflL = lightAt(wp.add(R.mul(10.0))).mul(0.7).add(lightAt(wp.add(R.mul(30.0))).mul(0.5));
  const reflS = skyColor(vec3(R.x, max(R.y, float(0.02)), R.z));
  // pools of light under lamps and in front of shops: the ground map is fine (3 m), so
  // the street keeps its full response to it (seen from above, lit streets are what
  // draws the city's grid at night)
  const pool = groundAt(wp).mul(albW).mul(1.15);
  const diffuse = shade(albW, n, wp, float(0.0), float(1.0)).add(pool);
  return vec4(diffuse.add(reflL.add(reflS).mul(k).mul(oneMinus(U.ssrOn))), oneMinus(k));
});

export function makeRoadMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'road';
  m.fog = false;
  m.colorNode = Fn(() => {
    const R = attribute('aRd', 'vec4'); // axis code, kind code, lanes, half width
    const J = attribute('aRj', 'vec4'); // piece centre, half extents
    const wp = positionWorld;
    const p = wp.xz;
    const along = uv().x;
    const across = uv().y;
    const axis = R.x;
    const kind = R.y;
    const lanes = R.z;
    const hw = R.w;
    // asphalt
    const n1 = fbm3o(p.mul(0.08));
    const n2 = vnoise(p.mul(1.9));
    const alb = vec3(0.05, 0.05, 0.054).mul(mix(0.75, 1.25, n1)).mul(mix(0.9, 1.08, n2)).toVar();
    // repair patches and tyre tracks
    const patch = step(0.72, vnoise(p.mul(0.045).add(7.0)));
    alb.assign(mix(alb, alb.mul(1.35), patch.mul(0.6)));
    const track = smoothstep(0.6, 0.0, abs(abs(across).sub(hw.div(max(lanes, 1.0)).mul(0.5)))).mul(step(axis, 1.5)).mul(0.25);
    alb.mulAssign(oneMinus(track));
    // markings
    const aa = fwidth(across).max(0.002);
    const lineAt = (x, w) => smoothstep(w.add(aa), w.sub(aa), abs(across.sub(x)));
    const mark = float(0).toVar();
    const markCol = vec3(0.55).toVar();
    If(axis.lessThan(1.5), () => {
      If(kind.lessThan(0.5), () => {
        // arterial: double yellow centre, dashed lane lines, solid edges
        const yel = max(lineAt(float(0.18), float(0.07)), lineAt(float(-0.18), float(0.07)));
        mark.assign(yel);
        markCol.assign(mix(markCol, vec3(0.62, 0.42, 0.05), yel));
        const lw = hw.div(max(lanes, 1.0));
        const dash = step(fract(along.div(9.0)), 0.45);
        const li = abs(across).div(lw);
        const lane = smoothstep(0.08, 0.0, abs(fract(li).sub(0.0)).min(abs(fract(li).sub(1.0))).mul(lw).sub(0.06)).mul(dash).mul(step(lw.mul(0.9), abs(across))).mul(step(abs(across), hw.sub(0.6)));
        mark.assign(max(mark, lane));
        const edge = lineAt(hw.sub(0.45), float(0.08)).add(lineAt(hw.negate().add(0.45), float(0.08)));
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
    // worn paint
    const wear = smoothstep(0.25, 0.75, vnoise(p.mul(0.9)));
    alb.assign(mix(alb, markCol, mark.mul(mix(0.35, 0.9, wear))));
    // manholes
    const mh = floor(p.div(23.0));
    const mc = mh.add(0.5).mul(23.0).add(hash12(mh).sub(0.5).mul(10.0));
    const ring = smoothstep(0.7, 0.62, length(p.sub(mc)));
    alb.assign(mix(alb, vec3(0.05, 0.048, 0.045), ring.mul(step(0.6, hash12(mh.add(3.3))))));
    // wetness: puddles in dips, overall wet sheen in rain
    const puddle = smoothstep(0.52, 0.7, fbm3o(p.mul(0.11).add(3.0))).mul(U.wet);
    const wetK = clamp(U.wet.mul(0.55).add(puddle), 0.0, 1.0);
    return wetSurface(alb, wp, wetK, puddle);
  })();
  keepAlpha(m);
  return m;
}

export function makePlateMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'plate';
  m.fog = false;
  m.colorNode = Fn(() => {
    const P0 = attribute('aP0', 'vec4');
    const P1 = attribute('aP1', 'vec4');
    const P2 = attribute('aP2', 'vec4');
    const wp = positionWorld;
    const p = wp.xz;
    const isTop = step(0.12, wp.y);
    // distance to each plate edge
    const dX0 = p.x.sub(P0.x);
    const dX1 = P0.z.sub(p.x);
    const dZ0 = p.y.sub(P0.y);
    const dZ1 = P0.w.sub(p.y);
    const inWalk = max(max(step(dX0, P1.x), step(dX1, P1.y)), max(step(dZ0, P1.z), step(dZ1, P1.w)));
    const edgeD = min(min(dX0, dX1), min(dZ0, dZ1));
    const open = P2.x;
    const grime = P2.w;
    // sidewalk pavers
    const pv = p.div(vec2(0.6, 0.6));
    const tile = hash12(floor(pv));
    const grout = max(smoothstep(0.06, 0.0, min(fract(pv.x), oneMinus(fract(pv.x)))), smoothstep(0.06, 0.0, min(fract(pv.y), oneMinus(fract(pv.y)))));
    const walkC = vec3(0.1, 0.1, 0.105).mul(mix(0.85, 1.15, tile)).mul(oneMinus(grout.mul(0.45)));
    // kerb stone along the edge
    const kerb = smoothstep(0.32, 0.26, edgeD);
    const walk = mix(walkC, vec3(0.16, 0.16, 0.165), kerb);
    // lot ground by open kind: none (concrete), plaza (big tiles), park (grass), yard (asphalt), rubble
    const lotN = vnoise(p.mul(0.5));
    const lot = vec3(0.07, 0.07, 0.072).mul(mix(0.8, 1.2, lotN)).toVar();
    If(open.greaterThan(0.5).and(open.lessThan(1.5)), () => {
      const pq = p.div(2.4);
      const g = max(smoothstep(0.03, 0.0, min(fract(pq.x), oneMinus(fract(pq.x)))), smoothstep(0.03, 0.0, min(fract(pq.y), oneMinus(fract(pq.y)))));
      lot.assign(vec3(0.13, 0.13, 0.14).mul(mix(0.9, 1.1, hash12(floor(pq)))).mul(oneMinus(g.mul(0.5))));
    })
      .ElseIf(open.lessThan(2.5).and(open.greaterThan(1.5)), () => {
        lot.assign(mix(vec3(0.02, 0.045, 0.022), vec3(0.035, 0.07, 0.03), vnoise(p.mul(0.9))));
      })
      .ElseIf(open.lessThan(3.5).and(open.greaterThan(2.5)), () => {
        lot.assign(vec3(0.04, 0.04, 0.042).mul(mix(0.8, 1.2, lotN)));
      })
      .ElseIf(open.greaterThan(3.5), () => {
        lot.assign(mix(vec3(0.07, 0.06, 0.05), vec3(0.12, 0.1, 0.08), vnoise(p.mul(1.7))));
      });
    const alb = mix(lot, walk, inWalk).mul(oneMinus(grime.mul(0.3))).toVar();
    // curb sides: plain concrete
    alb.assign(mix(vec3(0.12, 0.12, 0.125), alb, isTop));
    const puddle = smoothstep(0.58, 0.74, fbm3o(p.mul(0.16).add(9.0))).mul(U.wet).mul(isTop);
    const wetK = clamp(U.wet.mul(0.45).add(puddle), 0.0, 1.0);
    return wetSurface(alb, wp, wetK, puddle);
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

/** Seawall: cast concrete with tide stains, a dark algae band at the waterline and a wet sheen. uv = (m along, 0..1 up). */
export function makeSeawallMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'seawall';
  m.fog = false;
  m.colorNode = Fn(() => {
    const wp = positionWorld;
    const n = normalize(normalWorld);
    const u = uv().x;
    const v = uv().y;
    const panel = smoothstep(0.04, 0.0, abs(fract(u.div(6.0)).sub(0.5)).sub(0.48).abs());
    const stain = vnoise(vec2(u.mul(0.7), v.mul(3.0)));
    const alb = vec3(0.1, 0.1, 0.095).mul(mix(0.7, 1.1, stain)).mul(oneMinus(panel.mul(0.4))).toVar();
    // algae and wet band near the waterline
    alb.assign(mix(alb, vec3(0.02, 0.03, 0.022), smoothstep(0.55, 0.15, v)));
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
