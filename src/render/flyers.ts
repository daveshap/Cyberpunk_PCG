// @ts-nocheck -- TSL node graphs are dynamically typed.
/**
 * Flyers (routes from core/flyers.ts): ad airships with LED flanks, police
 * units with red and blue light bars, medevac flyers with teal and white
 * strobes, cargo haulers with amber markers, and the police rings over street
 * incidents. One instanced mesh per craft kind, moved on the CPU each frame
 * with the previous pose kept for TRAA; one instanced mesh of searchlight
 * cones in the glow layer.
 *
 * All liveries and markings are original: no real emblems or brands.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  abs,
  attribute,
  cameraPosition,
  cos,
  dot,
  float,
  floor,
  fract,
  max,
  mix,
  mrt,
  mx_fractal_noise_float,
  normalGeometry,
  normalize,
  oneMinus,
  positionGeometry,
  positionPrevious,
  positionWorld,
  pow,
  sin,
  smoothstep,
  step,
  time,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { FlyerKind, Flyers, FlyerRoute, Incident } from '../core/types';
import { MeshBuilder, addBox, addCylinder, addSphere } from './geometry';
import { U, fogAtten, hash12, pin, shade } from './tsl';

// parts (aPart)
const P = { body: 0, glass: 1, strobeA: 2, strobeB: 3, head: 4, stripe: 5, glow: 6, screen: 7, navRed: 8, navGreen: 9, navWhite: 10, tail: 11 };

/** Instance layout: 24 floats. */
const STRIDE = 24;
// iA x y z yaw | iB pitch roll scale seed | iC body rgb, cabin light | iD colour A rgb, strobe rate | iE colour B rgb, phase | iF stripe rgb, glow k

function mb(): MeshBuilder {
  return new MeshBuilder({ aPart: 1 });
}
function part(b: MeshBuilder, p: number): void {
  b.set('aPart', p);
}

/** A hull of revolution along z (nose at +L/2): radius profile r(t), t 0 tail .. 1 nose. */
function lathe(b: MeshBuilder, L: number, r: (t: number) => number, rings: number, seg: number, y0 = 0): void {
  const rows: number[][] = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const z = -L / 2 + L * t;
    const rr = r(t);
    const dr = (r(Math.min(1, t + 1e-3)) - r(Math.max(0, t - 1e-3))) / (2e-3 * L);
    const row: number[] = [];
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const cx = Math.cos(a);
      const cy = Math.sin(a);
      const nl = Math.hypot(1, dr) || 1;
      row.push(b.vert(cx * rr, y0 + cy * rr, z, cx / nl, cy / nl, -dr / nl, t, j / seg));
    }
    rows.push(row);
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) b.quad(rows[i]![j]!, rows[i]![j + 1]!, rows[i + 1]![j + 1]!, rows[i + 1]![j]!);
}

/** Police unit, 6 m nose to tail: a low wedge hull, canopy, roof light bar split red and blue. */
function policeGeom(): THREE.BufferGeometry {
  const b = mb();
  part(b, P.body);
  addBox(b, 0, 0.55, -0.2, 2.2, 0.7, 5.0);
  addBox(b, 0, 0.45, 2.65, 1.9, 0.5, 1.2);
  for (const sx of [-1, 1]) {
    addBox(b, sx * 1.0, 1.0, -2.45, 0.12, 0.6, 0.6);
    addCylinder(b, sx * 1.25, 0.15, -1.6, 0.36, 0.36, 0.35, 10, true);
    addCylinder(b, sx * 1.25, 0.15, 1.7, 0.36, 0.36, 0.35, 10, true);
  }
  part(b, P.glass);
  addBox(b, 0, 1.12, 0.1, 1.6, 0.48, 2.4);
  part(b, P.stripe);
  for (const sx of [-1, 1]) addBox(b, sx * 1.105, 0.62, -0.2, 0.02, 0.2, 4.4);
  part(b, P.strobeA);
  addBox(b, -0.42, 1.43, -0.1, 0.72, 0.14, 0.32);
  part(b, P.strobeB);
  addBox(b, 0.42, 1.43, -0.1, 0.72, 0.14, 0.32);
  part(b, P.head);
  for (const sx of [-1, 1]) addBox(b, sx * 0.62, 0.5, 3.26, 0.46, 0.1, 0.04);
  part(b, P.tail);
  addBox(b, 0, 0.7, -2.71, 1.9, 0.08, 0.04);
  part(b, P.glow);
  for (const sx of [-1, 1]) for (const z of [-1.6, 1.7]) addCylinder(b, sx * 1.25, 0.12, z, 0.28, 0.28, 0.04, 10, true);
  return b.build();
}

/** Medevac flyer, 9 m: a tall rounded van hull, wide windscreen, teal side band and a roof bar. */
function medevacGeom(): THREE.BufferGeometry {
  const b = mb();
  part(b, P.body);
  addBox(b, 0, 1.15, -0.5, 2.8, 1.7, 7.2);
  addBox(b, 0, 0.85, 3.4, 2.5, 1.1, 1.4);
  addSphere(b, 0, 1.05, 3.9, 1.2, 0.6, 0.6, 10, 5);
  for (const sx of [-1, 1]) {
    addCylinder(b, sx * 1.6, 0.25, -2.6, 0.5, 0.5, 0.5, 12, true);
    addCylinder(b, sx * 1.6, 0.25, 2.2, 0.5, 0.5, 0.5, 12, true);
  }
  part(b, P.glass);
  addBox(b, 0, 1.55, 3.05, 2.3, 0.7, 0.9);
  for (const sx of [-1, 1]) addBox(b, sx * 1.41, 1.5, 1.4, 0.02, 0.55, 1.6);
  part(b, P.stripe);
  for (const sx of [-1, 1]) addBox(b, sx * 1.405, 0.95, -0.5, 0.02, 0.4, 7.0);
  addBox(b, 0, 2.005, -0.8, 2.0, 0.02, 4.5);
  part(b, P.strobeA);
  addBox(b, -0.6, 2.15, 1.9, 0.9, 0.18, 0.4);
  addBox(b, 0.9, 1.9, -4.1, 0.6, 0.15, 0.06);
  part(b, P.strobeB);
  addBox(b, 0.6, 2.15, 1.9, 0.9, 0.18, 0.4);
  addBox(b, -0.9, 1.9, -4.1, 0.6, 0.15, 0.06);
  part(b, P.head);
  for (const sx of [-1, 1]) addBox(b, sx * 0.85, 0.75, 4.12, 0.5, 0.14, 0.04);
  part(b, P.glow);
  for (const sx of [-1, 1]) for (const z of [-2.6, 2.2]) addCylinder(b, sx * 1.6, 0.22, z, 0.4, 0.4, 0.04, 12, true);
  part(b, P.tail);
  addBox(b, 0, 0.6, -4.11, 2.2, 0.1, 0.04);
  return b.build();
}

/** Cargo hauler, 18 m: a cab towing a long container, amber side markers and nav lights. */
function haulerGeom(): THREE.BufferGeometry {
  const b = mb();
  part(b, P.body);
  addBox(b, 0, 1.6, 6.9, 2.7, 2.3, 3.4);
  addBox(b, 0, 1.9, -1.6, 3.0, 3.0, 13.0);
  addBox(b, 0, 0.45, 2.0, 1.2, 0.6, 14.0);
  for (const sx of [-1, 1]) for (const z of [-6.2, -1.0, 5.6]) addCylinder(b, sx * 1.75, 0.0, z, 0.6, 0.6, 0.6, 12, true);
  part(b, P.glass);
  addBox(b, 0, 2.15, 8.55, 2.3, 0.85, 0.12);
  part(b, P.stripe);
  for (const sx of [-1, 1]) addBox(b, sx * 1.505, 2.6, -1.6, 0.02, 0.35, 12.6);
  part(b, P.head);
  for (const sx of [-1, 1]) addBox(b, sx * 0.95, 1.0, 8.62, 0.5, 0.18, 0.04);
  part(b, P.glow);
  for (const sx of [-1, 1]) for (let k = 0; k < 6; k++) addBox(b, sx * 1.51, 0.55, -7.5 + k * 2.4, 0.03, 0.12, 0.35);
  for (const sx of [-1, 1]) for (const z of [-6.2, -1.0, 5.6]) addCylinder(b, sx * 1.75, -0.02, z, 0.48, 0.48, 0.04, 12, true);
  part(b, P.navRed);
  addBox(b, -1.52, 3.3, -8.0, 0.06, 0.2, 0.2);
  part(b, P.navGreen);
  addBox(b, 1.52, 3.3, -8.0, 0.06, 0.2, 0.2);
  part(b, P.tail);
  addBox(b, 0, 1.2, -8.11, 2.6, 0.15, 0.04);
  return b.build();
}

/** Ad airship, 120 m: a long envelope with LED flanks, cruciform tail fins, a gondola and nav lights. */
function blimpGeom(): THREE.BufferGeometry {
  const b = mb();
  const L = 120;
  const R = 17;
  const prof = (t: number): number => R * Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t))), 0.62) * (0.8 + 0.2 * t);
  part(b, P.body);
  lathe(b, L, prof, 40, 28);
  // tail fins
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const len = 20;
    const span = 15;
    addBox(b, dx * (R * 0.45 + span / 2), dy * (R * 0.45 + span / 2), -L / 2 + 14, dx ? span : 0.5, dy ? span : 0.5, len);
  }
  // gondola
  addBox(b, 0, -R - 1.6, 8, 6, 3.4, 24);
  part(b, P.glass);
  addBox(b, 0, -R - 1.4, 20.1, 4.8, 1.6, 0.2);
  for (const sx of [-1, 1]) addBox(b, sx * 3.01, -R - 1.2, 8, 0.02, 1.2, 18);
  // LED flanks: a band of the envelope on each side, slightly proud of it
  part(b, P.screen);
  for (const side of [-1, 1]) {
    const rows: number[][] = [];
    const T0 = 0.24;
    const T1 = 0.74;
    const A = 0.62; // half the band's angle around the hull
    for (let i = 0; i <= 24; i++) {
      const t = T0 + ((T1 - T0) * i) / 24;
      const z = -L / 2 + L * t;
      const rr = prof(t) + 0.35;
      const row: number[] = [];
      for (let j = 0; j <= 8; j++) {
        const a = -A + (2 * A * j) / 8;
        const x = side * Math.cos(a) * rr;
        const y = Math.sin(a) * rr;
        // uv: across the band (along the hull) and up; mirrored so text runs nose-ward on both sides
        const u = side > 0 ? (t - T0) / (T1 - T0) : 1 - (t - T0) / (T1 - T0);
        row.push(b.vert(x, y, z, side * Math.cos(a), Math.sin(a), 0, u, j / 8));
      }
      rows.push(row);
    }
    for (let i = 0; i < 24; i++)
      for (let j = 0; j < 8; j++) {
        // counter-clockwise seen from outside the hull on either flank
        if (side > 0) b.quad(rows[i]![j]!, rows[i]![j + 1]!, rows[i + 1]![j + 1]!, rows[i + 1]![j]!);
        else b.quad(rows[i]![j]!, rows[i + 1]![j]!, rows[i + 1]![j + 1]!, rows[i]![j + 1]!);
      }
  }
  // running lights along the spine and keel
  part(b, P.glow);
  for (let k = 0; k < 9; k++) {
    const t = 0.12 + k * 0.095;
    const z = -L / 2 + L * t;
    addSphere(b, 0, prof(t) + 0.2, z, 0.45, 0.45, 0.45, 6, 4);
    addSphere(b, 0, -prof(t) - 0.2, z, 0.45, 0.45, 0.45, 6, 4);
  }
  part(b, P.navRed);
  addSphere(b, -R - 0.3, 0, 4, 0.8, 0.8, 0.8, 6, 4);
  part(b, P.navGreen);
  addSphere(b, R + 0.3, 0, 4, 0.8, 0.8, 0.8, 6, 4);
  part(b, P.navWhite);
  addSphere(b, 0, 0, -L / 2 + 0.5, 0.9, 0.9, 0.9, 6, 4);
  addSphere(b, 0, R * 0.45 + 15, -L / 2 + 8, 0.7, 0.7, 0.7, 6, 4);
  return b.build();
}

// ------------------------------------------------------------------ materials

/** Rotate a local vector by roll (z), pitch (x, nose up), then yaw (local +z to (sin, cos)). */
function orient(v, yaw, pitch, roll) {
  const cr = cos(roll);
  const sr = sin(roll);
  const x1 = v.x.mul(cr).sub(v.y.mul(sr));
  const y1 = v.x.mul(sr).add(v.y.mul(cr));
  const cp = cos(pitch);
  const sp = sin(pitch);
  const y2 = y1.mul(cp).add(v.z.mul(sp));
  const z2 = y1.mul(sp).negate().add(v.z.mul(cp));
  const cy = cos(yaw);
  const sy = sin(yaw);
  return vec3(x1.mul(cy).add(z2.mul(sy)), y2, x1.negate().mul(sy).add(z2.mul(cy)));
}

/** Police double flash: two short pulses per cycle. */
function strobe(t, rate, phase) {
  const f = fract(t.mul(rate).add(phase));
  // a steady base so the bar always reads red and blue, then two hard flashes
  return step(f, float(0.07)).add(step(abs(f.sub(0.17)), float(0.035))).mul(5.0).add(0.55);
}

function makeFlyerMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'flyers';
  m.fog = false;
  const iA = attribute('iA', 'vec4');
  const iB = attribute('iB', 'vec4');
  m.positionNode = Fn(() => {
    const p = orient(positionGeometry.mul(iB.z), iA.w, iB.x, iB.y).add(iA.xyz);
    const iP = attribute('iP', 'vec4');
    positionPrevious.assign(orient(positionGeometry.mul(iB.z), iP.w, iB.x, iB.y).add(iP.xyz));
    return p;
  })();
  const nW = varying(orient(normalGeometry, iA.w, iB.x, iB.y), 'vFlyN');
  const vPart = varying(attribute('aPart', 'float'), 'vFlyPart');
  const vB = varying(iB, 'vFlyB');
  const vC = varying(attribute('iC', 'vec4'), 'vFlyC');
  const vD = varying(attribute('iD', 'vec4'), 'vFlyD');
  const vE = varying(attribute('iE', 'vec4'), 'vFlyE');
  const vF = varying(attribute('iF', 'vec4'), 'vFlyF');
  m.colorNode = Fn(() => {
    const n = normalize(nW);
    const wp = positionWorld;
    const pt = floor(vPart.add(0.5));
    const t = time;
    const seed = vB.w;
    const is = (k) => step(abs(pt.sub(k)), float(0.1));
    // lit surfaces: painted body, dark glass, livery stripe
    const alb = pin(vC.rgb.mul(is(P.body)).add(vec3(0.012, 0.014, 0.02).mul(is(P.glass))).add(vF.rgb.mul(is(P.stripe))), 'vec3');
    const spec = mix(float(0.45), float(0.6), is(P.glass));
    const rough = mix(float(0.35), float(0.08), is(P.glass));
    const lit = shade(alb, n, wp, spec, rough);
    // emissive parts
    const head = vec3(1.0, 0.96, 0.9).mul(3.2).mul(is(P.head));
    const cabin = vec3(1.0, 0.85, 0.65).mul(vC.w).mul(is(P.glass));
    const sA = vD.rgb.mul(strobe(t, vD.w, vE.w)).mul(is(P.strobeA));
    const sB = vE.rgb.mul(strobe(t, vD.w, vE.w.add(0.5))).mul(is(P.strobeB));
    const stripeGlow = vF.rgb.mul(vF.w).mul(is(P.stripe));
    const glow = mix(vec3(0.45, 0.65, 1.0), vD.rgb, 0.35).mul(1.8).mul(is(P.glow));
    const blink = (ph) => pow(max(sin(t.mul(3.0).add(ph)), float(0.0)), float(8.0)).mul(4.0).add(0.15);
    const nav = vec3(1.0, 0.06, 0.04).mul(blink(seed.mul(6.28))).mul(is(P.navRed)).add(vec3(0.1, 1.0, 0.25).mul(blink(seed.mul(6.28))).mul(is(P.navGreen)));
    const white = vec3(1.0).mul(step(0.93, fract(t.mul(0.9).add(seed)))).mul(6.0).mul(is(P.navWhite));
    const tail = vec3(1.0, 0.08, 0.05).mul(1.6).mul(is(P.tail));
    // airship flanks: an LED ad loop (bands, a ticker, a pulsing mark)
    const q = uv();
    const res = vec2(180.0, 36.0);
    const cell = floor(q.mul(res));
    const fr = fract(q.mul(res));
    const led = smoothstep(0.1, 0.3, fr.x).mul(smoothstep(0.1, 0.3, fr.y)).mul(oneMinus(smoothstep(0.7, 0.9, fr.x))).mul(oneMinus(smoothstep(0.7, 0.9, fr.y))).mul(0.8).add(0.2);
    const g = cell.add(0.5).div(res);
    const scene = floor(fract(t.mul(0.05).add(seed)).mul(3.0));
    const bands = step(0.5, fract(g.x.mul(6.0).sub(t.mul(0.4)).add(g.y.mul(0.8))));
    const tick = step(0.45, hash12(vec2(floor(g.x.mul(60.0).sub(t.mul(9.0))), floor(g.y.mul(8.0))))).mul(step(g.y, 0.35)).mul(step(0.1, g.y));
    const mark = smoothstep(0.2, 0.17, abs(length2(g.sub(vec2(0.5, 0.55)).mul(vec2(5.0, 1.0))).sub(sin(t.mul(2.0)).mul(0.03).add(0.25))));
    const scr = mix(vD.rgb, vE.rgb, g.y).mul(select3(scene, bands.mul(0.9), tick.mul(1.4).add(mark.mul(0.3)), mark.mul(1.3).add(tick.mul(0.5)))).mul(led).mul(1.6).mul(is(P.screen));
    const e = head.add(cabin).add(sA).add(sB).add(stripeGlow).add(glow).add(nav).add(white).add(tail).add(scr).mul(U.neon);
    return vec4(lit.mul(oneMinus(is(P.screen))).add(e), 1.0);
  })();
  return m;
}

function length2(v) {
  return v.x.mul(v.x).add(v.y.mul(v.y)).sqrt();
}

function select3(k, a, b, c) {
  return mix(mix(a, b, step(0.5, k)), c, step(1.5, k));
}

/** Searchlight cones: apex at the craft, opening along the local -y axis (tilted and yawed per instance). */
function makeConeMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'flyer-beams';
  m.fog = false;
  m.transparent = true;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  m.blending = THREE.AdditiveBlending;
  const iA = attribute('iA', 'vec4'); // x y z yaw
  const iB = attribute('iB', 'vec4'); // tilt from straight down, length, end radius, intensity
  m.positionNode = Fn(() => {
    const p = positionGeometry; // y in [-1, 0], radius 1 at y = -1
    const s = vec3(p.x.mul(iB.z), p.y.mul(iB.y), p.z.mul(iB.z));
    return orient(s, iA.w, iB.x, float(0.0)).add(iA.xyz);
  })();
  const nW = varying(orient(normalGeometry, iA.w, iB.x, float(0.0)), 'vConeN');
  const vB = varying(iB, 'vConeB');
  const vC = varying(attribute('iC', 'vec4'), 'vConeC');
  const c = Fn(() => {
    const wp = positionWorld;
    const V = normalize(cameraPosition.sub(wp));
    const facing = pow(abs(dot(normalize(nW), V)), float(2.0));
    const v = uv().y; // 0 at the source, 1 at the end
    const along = pow(oneMinus(v), float(1.7));
    const dust = mx_fractal_noise_float(wp.mul(0.1).add(vec3(0, time.mul(-0.5), 0)), 2, 2.0, 0.5).mul(0.35).add(0.75);
    const rgb = vC.rgb.mul(vB.w).mul(facing).mul(along).mul(dust).mul(U.fogDensity.mul(900.0)).mul(U.neon);
    return vec4(fogAtten(rgb, wp), 1.0);
  })();
  m.colorNode = vec4(0, 0, 0, 0);
  m.mrtNode = mrt({ output: vec4(0, 0, 0, 0), glow: c, velocity: vec4(0, 0, 0, 0) });
  return m;
}

function coneGeom(): THREE.BufferGeometry {
  const b = new MeshBuilder({});
  const SEG = 18;
  const rows = 6;
  let prev: number[] | null = null;
  for (let k = 0; k <= rows; k++) {
    const v = k / rows;
    const ids: number[] = [];
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      const r = Math.max(0.02, v);
      ids.push(b.vert(Math.cos(a) * r, -v, Math.sin(a) * r, Math.cos(a), 0.3, Math.sin(a), i / SEG, v));
    }
    if (prev) for (let i = 0; i < SEG; i++) b.quad(prev[i]!, prev[i + 1]!, ids[i + 1]!, ids[i]!);
    prev = ids;
  }
  return b.build();
}

// ------------------------------------------------------------------ motion

interface RouteState {
  route: FlyerRoute;
  cum: number[];
  len: number;
}

function routeState(r: FlyerRoute): RouteState {
  const cum = [0];
  const n = r.pts.length;
  for (let i = 0; i < n; i++) {
    const a = r.pts[i]!;
    const b = r.pts[(i + 1) % n]!;
    cum.push(cum[i]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  return { route: r, cum, len: cum[n]! };
}

function pointAt(st: RouteState, s: number): [number, number, number] {
  const L = st.len;
  const d = ((s % L) + L) % L;
  const n = st.route.pts.length;
  let i = 0;
  while (i < n - 1 && st.cum[i + 1]! < d) i++;
  const a = st.route.pts[i]!;
  const b = st.route.pts[(i + 1) % n]!;
  const seg = st.cum[i + 1]! - st.cum[i]!;
  const t = seg > 0 ? (d - st.cum[i]!) / seg : 0;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

interface Craft {
  kind: FlyerKind;
  st?: RouteState;
  offset: number;
  incident?: Incident;
  slot: number;
  seed: number;
  /** Index in its kind's instance buffer. */
  idx: number;
  /** Searchlight cone index or -1. */
  cone: number;
  yaw: number;
}

const LIVERY: Record<FlyerKind, { body: [number, number, number]; a: [number, number, number]; b: [number, number, number]; stripe: [number, number, number]; rate: number; cabin: number; glowK: number; scale: number }> = {
  police: { body: [0.018, 0.022, 0.045], a: [1.0, 0.04, 0.06], b: [0.08, 0.25, 1.0], stripe: [0.75, 0.78, 0.85], rate: 1.6, cabin: 0.15, glowK: 0.25, scale: 1.25 },
  medevac: { body: [0.62, 0.64, 0.66], a: [0.1, 1.0, 0.85], b: [1.0, 1.0, 1.0], stripe: [0.02, 0.45, 0.42], rate: 1.1, cabin: 0.4, glowK: 0.8, scale: 1.2 },
  hauler: { body: [0.12, 0.1, 0.08], a: [1.0, 0.55, 0.1], b: [1.0, 0.55, 0.1], stripe: [0.55, 0.4, 0.05], rate: 0.0, cabin: 0.5, glowK: 0.5, scale: 1.0 },
  blimp: { body: [0.06, 0.065, 0.075], a: [1.0, 0.25, 0.7], b: [0.2, 0.85, 1.0], stripe: [0.3, 0.3, 0.32], rate: 0.0, cabin: 1.0, glowK: 0.0, scale: 1.0 },
};

const GEOMS: Record<FlyerKind, () => THREE.BufferGeometry> = { police: policeGeom, medevac: medevacGeom, hauler: haulerGeom, blimp: blimpGeom };

class KindBatch {
  readonly mesh: THREE.Mesh;
  readonly data: Float32Array;
  readonly prev: Float32Array;
  private readonly ib: THREE.InstancedInterleavedBuffer;
  private readonly pb: THREE.InstancedBufferAttribute;
  constructor(kind: FlyerKind, count: number, mat: THREE.Material) {
    this.data = new Float32Array(Math.max(1, count) * STRIDE);
    this.prev = new Float32Array(Math.max(1, count) * 4);
    const base = GEOMS[kind]();
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    for (const name of ['position', 'normal', 'uv', 'aPart']) g.setAttribute(name, base.getAttribute(name));
    this.ib = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.ib.setUsage(THREE.DynamicDrawUsage);
    ['iA', 'iB', 'iC', 'iD', 'iE', 'iF'].forEach((n, k) => g.setAttribute(n, new THREE.InterleavedBufferAttribute(this.ib, 4, k * 4)));
    this.pb = new THREE.InstancedBufferAttribute(this.prev, 4);
    this.pb.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iP', this.pb);
    g.instanceCount = count;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'flyers-' + kind;
  }
  flush(): void {
    this.ib.needsUpdate = true;
    this.pb.needsUpdate = true;
  }
}

export class FlyersRender {
  readonly group = new THREE.Group();
  private readonly crafts: Craft[] = [];
  private readonly batches = new Map<FlyerKind, KindBatch>();
  private readonly cones: THREE.Mesh;
  private readonly coneData: Float32Array;
  private readonly coneIb: THREE.InstancedInterleavedBuffer;
  private t = 0;

  constructor(f: Flyers) {
    this.group.name = 'flyers';
    const mat = makeFlyerMaterial();
    const counts: Record<FlyerKind, number> = { police: 0, medevac: 0, hauler: 0, blimp: 0 };
    let cones = 0;
    for (const r of f.routes) {
      const st = routeState(r);
      for (let k = 0; k < r.count; k++) {
        const kind = r.kind;
        const hasCone = kind === 'police' || kind === 'medevac' || kind === 'blimp';
        this.crafts.push({ kind, st, offset: k / r.count + r.seed * 0.37, slot: k, seed: (r.seed * 7.31 + k * 0.618) % 1, idx: counts[kind]++, cone: hasCone ? cones++ : -1, yaw: 0 });
      }
    }
    for (const inc of f.incidents) {
      for (let k = 0; k < inc.units; k++) this.crafts.push({ kind: 'police', incident: inc, offset: k / inc.units, slot: k, seed: (inc.seed * 5.7 + k * 0.381) % 1, idx: counts.police++, cone: cones++, yaw: 0 });
    }
    for (const kind of Object.keys(counts) as FlyerKind[]) {
      if (counts[kind] === 0) continue;
      const kb = new KindBatch(kind, counts[kind], mat);
      this.batches.set(kind, kb);
      this.group.add(kb.mesh);
    }
    // static per-instance data
    for (const c of this.crafts) {
      const kb = this.batches.get(c.kind)!;
      const o = c.idx * STRIDE;
      const lv = LIVERY[c.kind];
      const d = kb.data;
      d[o + 4] = 0;
      d[o + 5] = 0;
      d[o + 6] = lv.scale;
      d[o + 7] = c.seed;
      d.set([...lv.body, lv.cabin], o + 8);
      // airships get their own ad colours
      const a = c.kind === 'blimp' ? AD_PAIRS[Math.floor(c.seed * AD_PAIRS.length) % AD_PAIRS.length]![0] : lv.a;
      const b2 = c.kind === 'blimp' ? AD_PAIRS[Math.floor(c.seed * AD_PAIRS.length) % AD_PAIRS.length]![1] : lv.b;
      d.set([...a, lv.rate], o + 12);
      d.set([...b2, c.seed], o + 16);
      d.set([...lv.stripe, lv.glowK], o + 20);
    }
    // searchlight cones
    const cg = coneGeom();
    const g = new THREE.InstancedBufferGeometry();
    g.index = cg.index;
    for (const name of ['position', 'normal', 'uv']) g.setAttribute(name, cg.getAttribute(name));
    this.coneData = new Float32Array(Math.max(1, cones) * 12);
    this.coneIb = new THREE.InstancedInterleavedBuffer(this.coneData, 12, 1);
    this.coneIb.setUsage(THREE.DynamicDrawUsage);
    ['iA', 'iB', 'iC'].forEach((n, k) => g.setAttribute(n, new THREE.InterleavedBufferAttribute(this.coneIb, 4, k * 4)));
    g.instanceCount = cones;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.cones = new THREE.Mesh(g, makeConeMaterial());
    this.cones.frustumCulled = false;
    this.cones.renderOrder = 6;
    this.cones.name = 'flyer-beams';
    if (cones > 0) this.group.add(this.cones);
    this.update(0);
    this.update(0);
  }

  /** Current position and heading of the i-th craft of a kind (screenshots, HUD). */
  pose(kind: FlyerKind, i: number): number[] | null {
    const c = this.crafts.filter((x) => x.kind === kind)[i];
    if (!c) return null;
    const d = this.batches.get(kind)!.data;
    const o = c.idx * STRIDE;
    return [d[o]!, d[o + 1]!, d[o + 2]!, d[o + 3]!];
  }

  update(dt: number): void {
    this.t += dt;
    const t = this.t;
    for (const c of this.crafts) {
      const kb = this.batches.get(c.kind)!;
      const d = kb.data;
      const o = c.idx * STRIDE;
      kb.prev[c.idx * 4] = d[o]!;
      kb.prev[c.idx * 4 + 1] = d[o + 1]!;
      kb.prev[c.idx * 4 + 2] = d[o + 2]!;
      kb.prev[c.idx * 4 + 3] = d[o + 3]!;
      let x: number;
      let y: number;
      let z: number;
      let yaw: number;
      let roll = 0;
      let pitch = 0;
      let target: [number, number, number] | null = null;
      if (c.incident) {
        // hover in a slow ring, nose toward the scene, lights on it
        const inc = c.incident;
        const a = t * 0.12 + c.offset * Math.PI * 2;
        x = inc.x + Math.cos(a) * inc.radius;
        z = inc.z + Math.sin(a) * inc.radius;
        y = inc.y + Math.sin(t * 0.7 + c.seed * 9) * 0.8;
        yaw = Math.atan2(inc.x - x, inc.z - z);
        roll = Math.sin(t * 0.5 + c.seed * 5) * 0.03;
        target = [inc.x + Math.sin(t * 0.37 + c.seed * 11) * 5, 0, inc.z + Math.cos(t * 0.29 + c.seed * 7) * 5];
      } else {
        const st = c.st!;
        const sp = st.route.speed;
        const s = c.offset * st.len + t * sp;
        const look = Math.min(40, st.len * 0.02) * Math.sign(sp || 1);
        const p = pointAt(st, s);
        const ahead = pointAt(st, s + look);
        const behind = pointAt(st, s - look);
        x = p[0];
        y = p[1] + Math.sin(t * 0.6 + c.seed * 9) * (c.kind === 'blimp' ? 2.5 : 0.6);
        z = p[2];
        // smooth the heading through corners (chord between a point behind and one ahead)
        x = (ahead[0] + behind[0] + p[0] * 2) / 4;
        z = (ahead[2] + behind[2] + p[2] * 2) / 4;
        yaw = Math.atan2(ahead[0] - behind[0], ahead[2] - behind[2]);
        // bank into the turn
        const h0 = Math.atan2(p[0] - behind[0], p[2] - behind[2]);
        const h1 = Math.atan2(ahead[0] - p[0], ahead[2] - p[2]);
        let dh = h1 - h0;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        roll = Math.max(-0.45, Math.min(0.45, -dh * (c.kind === 'blimp' ? 0.6 : 1.6)));
        pitch = c.kind === 'blimp' ? Math.sin(t * 0.13 + c.seed * 4) * 0.02 : -0.05;
      }
      d[o] = x;
      d[o + 1] = y;
      d[o + 2] = z;
      d[o + 3] = yaw;
      d[o + 4] = pitch;
      d[o + 5] = roll;
      if (dt === 0 && this.t === 0) {
        kb.prev[c.idx * 4] = x;
        kb.prev[c.idx * 4 + 1] = y;
        kb.prev[c.idx * 4 + 2] = z;
        kb.prev[c.idx * 4 + 3] = yaw;
      }
      // searchlight
      if (c.cone >= 0) {
        const q = c.cone * 12;
        const cd = this.coneData;
        let cyaw = yaw;
        let tilt: number;
        let len: number;
        let rad: number;
        let k: number;
        let col: [number, number, number];
        if (target) {
          const dx = target[0] - x;
          const dy = target[1] - y;
          const dz = target[2] - z;
          const hz = Math.hypot(dx, dz);
          cyaw = Math.atan2(dx, dz);
          tilt = Math.atan2(hz, -dy);
          len = Math.hypot(dx, dy, dz) * 1.04;
          rad = len * 0.09;
          k = 0.55;
          col = [0.85, 0.92, 1.0];
        } else if (c.kind === 'police') {
          cyaw = yaw + Math.sin(t * 0.45 + c.seed * 6) * 0.7;
          tilt = 0.45 + Math.sin(t * 0.7 + c.seed * 3) * 0.2;
          len = 150;
          rad = 14;
          k = 0.4;
          col = [0.85, 0.92, 1.0];
        } else if (c.kind === 'medevac') {
          tilt = 0.55;
          len = 110;
          rad = 11;
          k = 0.35;
          col = [0.75, 1.0, 0.95];
        } else {
          // airship: a broad slow floodlight sweeping the city below
          cyaw = yaw + Math.sin(t * 0.08 + c.seed * 6) * 1.2;
          tilt = 0.32;
          len = 320;
          rad = 34;
          k = 0.18;
          col = [1.0, 0.92, 0.8];
        }
        const sc = LIVERY[c.kind].scale;
        const ox = c.kind === 'blimp' ? Math.sin(yaw) * 8 : 0;
        const oz = c.kind === 'blimp' ? Math.cos(yaw) * 8 : 0;
        const oy = c.kind === 'blimp' ? -20 : 0.1 * sc;
        cd.set([x + ox, y + oy, z + oz, cyaw, tilt, len, rad, k, col[0], col[1], col[2], 0], q);
      }
    }
    for (const kb of this.batches.values()) kb.flush();
    this.coneIb.needsUpdate = true;
  }

  dispose(): void {
    for (const kb of this.batches.values()) kb.mesh.geometry.dispose();
    this.cones.geometry.dispose();
  }
}

/** Airship ad colour pairs. */
const AD_PAIRS: [[number, number, number], [number, number, number]][] = [
  [
    [1.0, 0.25, 0.7],
    [0.2, 0.85, 1.0],
  ],
  [
    [1.0, 0.75, 0.15],
    [1.0, 0.2, 0.25],
  ],
  [
    [0.35, 1.0, 0.6],
    [0.3, 0.45, 1.0],
  ],
  [
    [0.9, 0.9, 1.0],
    [0.8, 0.3, 1.0],
  ],
];
