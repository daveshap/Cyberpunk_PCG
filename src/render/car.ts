// @ts-nocheck -- TSL node graphs are dynamically typed.
/**
 * The player's hover car, built in code: a lofted superellipse hull, a glass
 * canopy, two thruster pods, a red tail light bar across the back, a white
 * front strip and a cyan underglow. Shaded with the city lighting so it picks
 * up the neon it flies past.
 */
import * as THREE from 'three/webgpu';
import { Fn, abs, atan, attribute, cameraPosition, dot, float, floor, fract, fwidth, length, max, mix, normalWorld, normalize, oneMinus, positionGeometry, positionWorld, pow, smoothstep, step, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { MeshBuilder, addBox, addCylinder } from './geometry';
import { addPointGlow, makeTubeBuilder } from './neon';
import { U, fresnel, hash12, lightAt, shade, skyColor, vnoise } from './tsl';
import { makeHaloMaterial } from './neonmats';

const PART = { paint: 0, glass: 1, tail: 2, head: 3, thruster: 4, trim: 5 };

interface Station {
  z: number;
  hw: number;
  top: number;
  bot: number;
  n: number;
}

const HULL: Station[] = [
  { z: -2.7, hw: 0.86, top: 0.78, bot: 0.36, n: 3.2 },
  { z: -2.45, hw: 1.04, top: 0.96, bot: 0.24, n: 3.6 },
  { z: -1.3, hw: 1.1, top: 1.06, bot: 0.17, n: 3.4 },
  { z: -0.2, hw: 1.1, top: 1.08, bot: 0.15, n: 3.2 },
  { z: 1.1, hw: 1.02, top: 0.9, bot: 0.17, n: 3.3 },
  { z: 2.15, hw: 0.86, top: 0.62, bot: 0.24, n: 3.5 },
  { z: 2.72, hw: 0.5, top: 0.44, bot: 0.32, n: 2.6 },
];

const CANOPY: Station[] = [
  { z: -1.25, hw: 0.82, top: 1.08, bot: 0.8, n: 2.6 },
  { z: -0.6, hw: 0.9, top: 1.42, bot: 0.84, n: 2.4 },
  { z: 0.35, hw: 0.88, top: 1.44, bot: 0.86, n: 2.4 },
  { z: 1.25, hw: 0.78, top: 0.98, bot: 0.86, n: 2.6 },
];

function se(t: number, n: number): number {
  const s = Math.sign(t);
  return s * Math.pow(Math.abs(t), 2 / n);
}

function loft(B: MeshBuilder, st: Station[], seg: number, upperOnly = false): void {
  const rings: number[][] = [];
  for (const s of st) {
    const row: number[] = [];
    const mid = (s.top + s.bot) / 2;
    const hh = (s.top - s.bot) / 2;
    for (let i = 0; i <= seg; i++) {
      const a = upperOnly ? (i / seg) * Math.PI : (i / seg) * Math.PI * 2;
      const x = s.hw * se(Math.cos(a), s.n);
      const y = mid + hh * se(Math.sin(a), s.n);
      row.push(B.vert(x, y, s.z, 0, 0, 0, i / seg, (s.z + 2.8) / 5.6));
    }
    rings.push(row);
  }
  for (let j = 0; j < rings.length - 1; j++)
    for (let i = 0; i < seg; i++) B.quad(rings[j]![i]!, rings[j]![i + 1]!, rings[j + 1]![i + 1]!, rings[j + 1]![i]!);
  // end caps (fans)
  for (const [ri, flip] of [
    [0, true],
    [rings.length - 1, false],
  ] as const) {
    const s = st[ri]!;
    const c = B.vert(0, (s.top + s.bot) / 2, s.z, 0, 0, flip ? -1 : 1, 0.5, 0.5);
    const r = rings[ri]!;
    for (let i = 0; i < seg; i++) {
      if (flip) B.tri(c, r[i + 1]!, r[i]!);
      else B.tri(c, r[i]!, r[i + 1]!);
    }
  }
}

function buildHull(): THREE.BufferGeometry {
  const B = new MeshBuilder({ aPart: 1 });
  B.set('aPart', PART.paint);
  loft(B, HULL, 40);
  B.set('aPart', PART.glass);
  loft(B, CANOPY, 28, true);
  // thruster pods and their glowing rings
  B.set('aPart', PART.trim);
  for (const sx of [-1, 1]) {
    const g = new MeshBuilder({ aPart: 1 });
    g.set('aPart', PART.trim);
    addCylinder(g, 0, 0, 0, 0.32, 0.3, 2.3, 14, true);
    const geo = g.build();
    geo.rotateX(Math.PI / 2);
    geo.translate(sx * 1.2, 0.38, -2.05);
    appendGeo(B, geo, PART.trim);
    const ring = new MeshBuilder({ aPart: 1 });
    ring.set('aPart', PART.thruster);
    addCylinder(ring, 0, 0, 0, 0.27, 0.27, 0.06, 14, true);
    const rg = ring.build();
    rg.rotateX(Math.PI / 2);
    rg.translate(sx * 1.2, 0.38, -2.08);
    appendGeo(B, rg, PART.thruster);
  }
  // tail light bar and front strip
  B.set('aPart', PART.tail);
  addBox(B, 0, 0.62, -2.72, 1.5, 0.07, 0.04, 0);
  addBox(B, 0, 0.5, -2.71, 1.3, 0.025, 0.04, 0);
  B.set('aPart', PART.head);
  addBox(B, 0, 0.4, 2.73, 0.8, 0.05, 0.04, 0);
  for (const sx of [-1, 1]) addBox(B, sx * 0.62, 0.52, 2.45, 0.34, 0.05, 0.3, sx * 0.35);
  // underglow pads
  B.set('aPart', PART.thruster);
  for (const sz of [-1.2, 1.0]) addBox(B, 0, 0.13, sz, 1.4, 0.03, 0.5, 0);
  const geo = B.build();
  geo.computeVertexNormals();
  return geo;
}

function appendGeo(B: MeshBuilder, g: THREE.BufferGeometry, part: number): void {
  B.set('aPart', part);
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const uv = g.getAttribute('uv');
  const base = B.vertexCount;
  for (let i = 0; i < pos.count; i++) B.vert(pos.getX(i), pos.getY(i), pos.getZ(i), nor.getX(i), nor.getY(i), nor.getZ(i), uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
  const idx = g.getIndex()!;
  for (let i = 0; i < idx.count; i += 3) B.tri(base + idx.getX(i), base + idx.getX(i + 1), base + idx.getX(i + 2));
}

export class HoverCar {
  readonly group = new THREE.Group();
  readonly paint = uniform(new THREE.Color(0.035, 0.04, 0.05));
  readonly accent = uniform(new THREE.Color(1.0, 0.06, 0.08));
  readonly thrust = uniform(0.5);
  readonly brake = uniform(0);
  private readonly glow: THREE.Mesh;

  constructor() {
    const m = new THREE.MeshBasicNodeMaterial();
    m.name = 'hover-car';
    m.fog = false;
    const paint = this.paint;
    const accent = this.accent;
    const thrust = this.thrust;
    const brake = this.brake;
    m.colorNode = Fn(() => {
      const part = attribute('aPart', 'float').add(0.5).floor();
      const n = normalize(normalWorld);
      const wp = positionWorld;
      const lp = positionGeometry;
      const V = normalize(cameraPosition.sub(wp));
      const ndv = max(dot(n, V), 0.0);
      // paint with metallic flake and panel lines, an accent pinstripe down the flanks,
      // road grime low on the body and behind the pods
      const mpp = fwidth(lp.x).max(fwidth(lp.y)).max(fwidth(lp.z)).max(1e-4);
      const flake = mix(vnoise(lp.xz.mul(90.0).add(lp.y.mul(40.0))).mul(0.25).add(0.88), float(1.0), smoothstep(0.004, 0.012, mpp));
      const gap = (d) => smoothstep(mpp.add(0.006), mpp.mul(0.5), abs(d));
      const seam = max(gap(fract(lp.z.mul(0.62).add(0.12)).sub(0.5).abs().sub(0.5).mul(1.61)), gap(lp.y.sub(0.62))).mul(step(part, 0.5));
      const flank = smoothstep(0.78, 0.95, abs(lp.x));
      const stripe = smoothstep(0.016, 0.008, abs(lp.y.sub(0.74))).mul(flank).mul(step(-2.3, lp.z)).mul(step(lp.z, 2.2));
      const grime = smoothstep(0.55, 0.22, lp.y).mul(vnoise(lp.xz.mul(6.0)).mul(0.5).add(0.5)).add(smoothstep(-1.2, -2.6, lp.z).mul(smoothstep(0.75, 0.35, lp.y)).mul(0.5));
      const alb = mix(vec3(paint).mul(flake), vec3(accent).mul(0.5), stripe).mul(oneMinus(seam.mul(0.6))).mul(oneMinus(grime.mul(0.35))).add(vec3(0.012, 0.01, 0.008).mul(grime));
      const R = V.negate().sub(n.mul(dot(V.negate(), n).mul(2.0)));
      // clear coat reflects the sky, the local light and a band of city windows and
      // neon along the horizon, so the paint reads as glossy rather than grey
      const az = atan(R.z, R.x);
      const el = R.y;
      const wc = vec2(floor(az.mul(40.0)), floor(el.mul(30.0)));
      const winR = step(0.74, hash12(wc)).mul(smoothstep(0.42, 0.02, el)).mul(smoothstep(-0.25, -0.02, el));
      const winC = mix(vec3(1.0, 0.62, 0.32), vec3(0.45, 0.7, 1.0), step(0.5, hash12(wc.add(7.7))));
      const neonR = smoothstep(0.025, 0.0, abs(el.sub(0.04).sub(vnoise(vec2(az.mul(2.5), 3.0)).mul(0.12)))).mul(step(0.45, vnoise(vec2(az.mul(6.0), 9.0))));
      const local = lightAt(wp.add(R.mul(16.0)));
      const city = winC.mul(winR).mul(0.55).add(mix(vec3(1.0, 0.1, 0.5), vec3(0.1, 0.8, 1.0), vnoise(vec2(az.mul(1.3), 5.0))).mul(neonR).mul(1.4)).mul(local.dot(vec3(0.3, 0.5, 0.2)).mul(0.6).add(0.35));
      // the smooth light volume reads as matte grey on paint: keep it faint and let the
      // structured city reflection and the sky carry the clear coat
      const env = skyColor(vec3(R.x, max(R.y, 0.02), R.z)).mul(0.45).add(local.mul(0.08)).add(city);
      const F = fresnel(ndv, float(0.04));
      // grime dulls the clear coat; rain beads up on top as little bright points
      const beadC = floor(lp.xz.div(0.06));
      const beadO = fract(lp.xz.div(0.06)).sub(0.5).mul(0.06);
      const bead = step(0.7, hash12(beadC)).mul(smoothstep(0.012, 0.006, length(beadO))).mul(smoothstep(0.3, 0.7, n.y)).mul(U.rain).mul(smoothstep(0.01, 0.004, mpp));
      const coat = env.mul(F).mul(1.1).mul(oneMinus(grime.mul(0.5))).add(env.mul(bead).mul(0.6));
      const body = shade(alb, n, wp, float(0.08), float(0.6)).add(coat);
      // rim so the silhouette always reads against the city
      const rim = pow(oneMinus(ndv), 3.0).mul(0.07).mul(vec3(0.5, 0.6, 0.9));
      const glass = vec3(0.004, 0.006, 0.01).add(env.mul(fresnel(ndv, float(0.08))).mul(2.2));
      const trim = shade(vec3(0.02), n, wp, float(0.4), float(0.4));
      const tail = vec3(accent).mul(mix(3.5, 9.0, brake));
      const head = vec3(1.0, 0.95, 0.88).mul(6.0);
      const thr = vec3(0.25, 0.75, 1.0).mul(mix(1.5, 8.0, thrust));
      const isP = step(part, 0.5);
      const isG = step(0.5, part).mul(step(part, 1.5));
      const isT = step(1.5, part).mul(step(part, 2.5));
      const isH = step(2.5, part).mul(step(part, 3.5));
      const isR = step(3.5, part).mul(step(part, 4.5));
      const isK = step(4.5, part);
      const col = body.add(rim).mul(isP).add(glass.mul(isG)).add(tail.mul(isT)).add(head.mul(isH)).add(thr.mul(isR)).add(trim.mul(isK));
      return vec4(col.mul(1.0), 1.0);
    })();
    const hull = new THREE.Mesh(buildHull(), m);
    hull.name = 'hover-car';
    this.group.add(hull);
    // thruster plumes (halo quads)
    const tb = makeTubeBuilder();
    for (const sx of [-1, 1]) {
      addPointGlow(tb, sx * 1.2, 0.38, -2.4, 0.9, 0.5, [0.3, 0.8, 1.6], 0, 0, 1.6);
    }
    addPointGlow(tb, 0, 0.0, 0, 1.6, 0.25, [0.2, 0.6, 1.2], 0, 0, 1.4);
    this.glow = new THREE.Mesh(tb.build(), makeHaloMaterial());
    this.glow.renderOrder = 6;
    this.group.add(this.glow);
    void U;
  }
}
