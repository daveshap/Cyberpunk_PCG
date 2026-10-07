// @ts-nocheck -- TSL node graphs are dynamically typed.
/**
 * City lights as point sprites: street and highway lamps, the promenade along
 * the sea, aviation beacons on towers, masts, stacks and cranes, the street
 * lights of the sprawl beyond the limits, and the traffic (ground cars, buses
 * and the flying lanes) as head and tail lights.
 *
 * Why sprites: a lamp a kilometre away is far smaller than a pixel. Drawn as
 * geometry it aliases away or its kit is culled, so with distance the city lost
 * its carpet of lights and only the haze was left. Each light here is a
 * camera-facing quad at least ~1 px across whose brightness drops by the area it
 * was enlarged by (flux is kept, with a little extra kept for glare), so a far
 * street reads as a string of fine points and a far district as a dense, dim
 * carpet while the air between stays dark (comps: Akira's Neo-Tokyo panoramas,
 * aerial night photos of Tokyo, Chongqing interchanges in long exposure).
 *
 * Everything moves on the GPU: ground traffic loops along its lane from a
 * per-instance start, direction, length, speed and phase, so tens of thousands
 * of lights cost no CPU time. Flying traffic reuses the CPU-updated instance
 * buffer of the hover cars (render/traffic.ts).
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  attribute,
  cameraPosition,
  cos,
  dot,
  exp,
  float,
  fract,
  max,
  mix,
  mrt,
  normalize,
  positionGeometry,
  positionPrevious,
  positionWorld,
  pow,
  select,
  sin,
  smoothstep,
  step,
  uniform,
  uv,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import type { CitySpec, Highway, Street } from '../core/types';
import { hash01 } from '../core/rng';
import { U, flicker, fogAtten } from './tsl';
import { CLS, kitGeometries, makeKitMaterial } from './kits';

/** Per-frame camera terms shared by every sprite material. */
export const SPRITE = {
  right: uniform(new THREE.Vector3(1, 0, 0)),
  up: uniform(new THREE.Vector3(0, 1, 0)),
  fwd: uniform(new THREE.Vector3(0, 0, -1)),
  /** World metres per pixel per metre of view depth. */
  pxScale: uniform(0.0018),
  /** Smallest sprite sigma, in pixels. */
  minPx: uniform(0.5),
  /** Exponent on the area factor: 1 keeps flux exactly, < 1 keeps far lights a little brighter (glare). */
  farGamma: uniform(0.45),
  /** Traffic clock (s) and the frame step, for previous positions. */
  t: uniform(0),
  dt: uniform(1 / 60),
};

/** Quad half extent in sigmas. */
const EXT = 2.6;

function additiveGlow(m: THREE.MeshBasicNodeMaterial, c): void {
  m.fog = false;
  m.transparent = true;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  m.blending = THREE.AdditiveBlending;
  m.colorNode = vec4(0, 0, 0, 0);
  m.mrtNode = mrt({ output: vec4(0, 0, 0, 0), glow: c, velocity: vec4(0, 0, 0, 0) });
}

/** View depth, sprite sigma (m) and the kept-flux factor for a light of core radius r at c. */
function spriteSize(c, r) {
  const depth = max(dot(c.sub(cameraPosition), SPRITE.fwd), float(0.5));
  const sig = max(r, SPRITE.minPx.mul(SPRITE.pxScale).mul(depth));
  const e = pow(r.div(sig), SPRITE.farGamma.mul(2.0));
  return { sig, e };
}

/** World position of this quad corner for a sprite centred at c with sigma sig. */
function corner(c, sig) {
  const g = positionGeometry;
  const ext = sig.mul(EXT);
  return c.add(SPRITE.right.mul(g.x.mul(ext))).add(SPRITE.up.mul(g.y.mul(ext)));
}

/** Gaussian sprite profile from the quad uv. */
const profile = () => {
  const q = uv().sub(0.5).mul(2.0 * EXT);
  return exp(dot(q, q).mul(-0.5));
};

/** Pull a light a little toward the camera so its own housing does not clip it. */
const pull = (c, k) => c.add(normalize(cameraPosition.sub(c)).mul(k));

// ------------------------------------------------------------------ geometry
function quads(n: number): THREE.InstancedBufferGeometry {
  const pos: number[] = [];
  const uvs: number[] = [];
  const side: number[] = [];
  const idx: number[] = [];
  for (let k = 0; k < n; k++) {
    const b = k * 4;
    pos.push(-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    side.push(k, k, k, k);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  g.setIndex(idx);
  return g;
}

// ------------------------------------------------------------ static lights
/** 12 floats per light: x y z radius | r g b - | mode phase - - */
class LightList {
  readonly data: number[] = [];
  /** `geom`: the light also exists as kit geometry, so the sprite gives way to it up close. */
  add(x: number, y: number, z: number, radius: number, r: number, g: number, b: number, mode = 0, phase = 0, geom = 0): void {
    this.data.push(x, y, z, radius, r, g, b, 0, mode, phase, geom, 0);
  }
  get count(): number {
    return this.data.length / 12;
  }
}

function makeStaticMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'lights';
  const A = attribute('iA', 'vec4');
  const B = attribute('iB', 'vec4');
  const C = attribute('iC', 'vec4');
  const centre = () => pull(A.xyz, 0.6);
  m.positionNode = Fn(() => {
    const c = centre();
    const { sig } = spriteSize(c, A.w);
    return corner(c, sig);
  })();
  const vE = varying(Fn(() => spriteSize(centre(), A.w).e)(), 'vLightE');
  const vB = varying(B, 'vLightB');
  const vC = varying(C, 'vLightC');
  const vNear = varying(
    Fn(() => {
      // where the lamp or beacon is drawn as geometry, the sprite only adds glare from ~15 m out
      const d = dot(A.xyz.sub(cameraPosition), SPRITE.fwd);
      return mix(float(1.0), smoothstep(10.0, 45.0, d).mul(0.85).add(0.15), C.z);
    })(),
    'vLightNear',
  );
  const c = Fn(() => {
    const fl = flicker(vC.y, vC.x);
    const rgb = vB.rgb.mul(profile()).mul(vE).mul(fl).mul(vNear).mul(U.neon);
    return vec4(fogAtten(rgb, positionWorld), 1.0);
  })();
  additiveGlow(m, c);
  return m;
}

// ---------------------------------------------------------------- traffic
/** One lane of cars: start, unit direction, length, speed, cars. */
interface Lane {
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
  len: number;
  speed: number;
  n: number;
  seed: number;
  /** 0 car, 1 bus / truck */
  heavy: number;
}

/**
 * Per-car instance data, 20 floats: iA x0 y z0 yaw | iB 1 1 1 emit | iC body rgb, cls |
 * iD light rgb, mode | iE len speed phase heavy
 */
function carData(lanes: Lane[]): Float32Array {
  const out: number[] = [];
  const bodies: [number, number, number][] = [
    [0.02, 0.02, 0.025],
    [0.06, 0.06, 0.065],
    [0.16, 0.16, 0.17],
    [0.12, 0.02, 0.03],
    [0.02, 0.05, 0.08],
    [0.2, 0.15, 0.03],
  ];
  for (const L of lanes) {
    const yaw = Math.atan2(L.dx, L.dz);
    for (let k = 0; k < L.n; k++) {
      const h = hash01(L.seed, k, 3);
      const phase = (k + hash01(L.seed, k, 1) * 0.55) / L.n;
      const bc = bodies[Math.floor(h * bodies.length) % bodies.length]!;
      const heavy = L.heavy > 0 ? 1 : hash01(L.seed, k, 7) < 0.06 ? 1 : 0;
      out.push(L.x, L.y, L.z, yaw, 1, 1, 1, 2.0, bc[0], bc[1], bc[2], CLS.metal + h * 0.99, 1, 0.06, 0.03, 0, L.len, L.speed, phase, heavy);
    }
  }
  return new Float32Array(out);
}

/** Where along its lane a car is at clock t (0..len), and the lane fraction. */
function laneS(E, t) {
  const f = fract(E.z.add(t.mul(E.y).div(E.x)));
  return { f, s: f.mul(E.x) };
}

function makeCarLightMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'car-lights';
  const A = attribute('iA', 'vec4');
  const E = attribute('iE', 'vec4');
  const side = attribute('aSide', 'float');
  // per corner: head (sides 0, 1) or tail (2, 3), left or right
  const frame = () => {
    const fwd = vec3(sin(A.w), 0.0, cos(A.w));
    const lat = vec3(cos(A.w), 0.0, sin(A.w).negate());
    const { f, s } = laneS(E, SPRITE.t);
    const isTail = step(1.5, side);
    const lr = select(fract(side.mul(0.5)).greaterThan(0.25), float(1.0), float(-1.0));
    const heavy = E.w;
    const halfW = mix(0.72, 1.05, heavy);
    const along = mix(mix(2.15, 5.6, heavy), mix(-2.2, -5.8, heavy), isTail);
    const y = mix(mix(0.62, 1.1, isTail), mix(0.9, 1.6, isTail), heavy);
    const base = vec3(A.x, A.y, A.z).add(fwd.mul(s));
    const c = base.add(fwd.mul(along)).add(lat.mul(lr.mul(halfW))).add(vec3(0.0, y, 0.0));
    return { c, fwd, isTail, f };
  };
  const radius = (isTail) => mix(float(0.16), float(0.13), isTail);
  m.positionNode = Fn(() => {
    const { c, isTail } = frame();
    const { sig } = spriteSize(c, radius(isTail));
    return corner(c, sig);
  })();
  const vRGB = varying(
    Fn(() => {
      const { c, fwd, isTail, f } = frame();
      const { e } = spriteSize(c, radius(isTail));
      const toCam = normalize(cameraPosition.sub(c));
      // head lights shine forward, tail lights back; a little of each shows from the side
      const facing = dot(toCam, fwd).mul(mix(float(1.0), float(-1.0), isTail));
      const aim = smoothstep(-0.25, 0.55, facing).mul(0.92).add(0.08);
      const head = vec3(1.0, 0.93, 0.82).mul(9.0);
      const tail = vec3(1.0, 0.06, 0.03).mul(4.2);
      const ends = smoothstep(0.0, 0.015, f).mul(smoothstep(1.0, 0.985, f));
      return mix(head, tail, isTail).mul(aim).mul(e).mul(ends);
    })(),
    'vCarRGB',
  );
  const c = Fn(() => vec4(fogAtten(vRGB.mul(profile()).mul(U.neon), positionWorld), 1.0))();
  additiveGlow(m, c);
  return m;
}

/**
 * Car bodies: the kit material (hover-car model, hovering a little over the
 * road) with a position node that runs the car along its lane. Bodies past
 * ~700 m collapse to a point: the lights carry them from there.
 */
function makeCarBodyMaterial(): THREE.MeshBasicNodeMaterial {
  const m = makeKitMaterial(false);
  m.name = 'ground-cars';
  const A = attribute('iA', 'vec4');
  const B = attribute('iB', 'vec4');
  const E = attribute('iE', 'vec4');
  const place = (pos, sc, s) => {
    const p = pos.mul(sc);
    const c = cos(A.w);
    const sn = sin(A.w);
    const fwd = vec3(sn, 0.0, c);
    return vec3(p.x.mul(c).add(p.z.mul(sn)), p.y, p.x.negate().mul(sn).add(p.z.mul(c))).add(A.xyz).add(fwd.mul(s));
  };
  m.positionNode = Fn(() => {
    const now = laneS(E, SPRITE.t);
    const before = laneS(E, SPRITE.t.sub(SPRITE.dt));
    const heavyScale = mix(vec3(1.0), vec3(1.25, 1.45, 2.4), E.w);
    const near = step(cameraPosition.sub(vec3(A.x, A.y, A.z).add(vec3(sin(A.w), 0.0, cos(A.w)).mul(now.s))).length(), 700.0);
    const ends = smoothstep(0.0, 0.01, now.f).mul(smoothstep(1.0, 0.99, now.f));
    const sc = B.xyz.mul(heavyScale).mul(near).mul(ends);
    positionPrevious.assign(place(positionGeometry, sc, before.s));
    return place(positionGeometry, sc, now.s);
  })();
  return m;
}

// ------------------------------------------------------------ lane layout
function streetLanes(st: Street, out: Lane[], idx: number): void {
  if (st.kind !== 'arterial' && st.kind !== 'local') return;
  const len = st.hi - st.lo;
  if (len < 40) return;
  const arterial = st.kind === 'arterial';
  const off = st.road * (arterial ? 0.27 : 0.24);
  const offsets = arterial && st.road > 15 ? [off - 1.7, off + 1.7] : [off];
  const spacing = arterial ? 34 : 85;
  let li = 0;
  for (const dir of [1, -1]) {
    for (const o of offsets) {
      const seed = idx * 31 + li++ * 7 + 1;
      const n = Math.max(1, Math.round((len / spacing) * (0.6 + hash01(seed, 0, 9) * 0.8)));
      const speed = arterial ? 10 + hash01(seed, 0, 5) * 6 : 6 + hash01(seed, 0, 5) * 3;
      // right-hand traffic: +x runs on the +z side, +z on the -x side
      if (st.axis === 'x') {
        const z = st.pos + dir * o;
        out.push({ x: dir > 0 ? st.lo : st.hi, y: 0.45, z, dx: dir, dz: 0, len, speed, n, seed, heavy: 0 });
      } else {
        const x = st.pos - dir * o;
        out.push({ x, y: 0.45, z: dir > 0 ? st.lo : st.hi, dx: 0, dz: dir, len, speed, n, seed, heavy: 0 });
      }
    }
  }
}

function highwayLanes(h: Highway, out: Lane[], idx: number): void {
  const len = h.hi - h.lo;
  let li = 0;
  for (const dir of [1, -1]) {
    for (const o of [3.2, 6.6]) {
      const seed = 9001 + idx * 17 + li++;
      const n = Math.max(1, Math.round(len / 20));
      const speed = 22 + hash01(seed, 0, 5) * 8;
      if (h.axis === 'x') out.push({ x: dir > 0 ? h.lo : h.hi, y: h.y + 0.45, z: h.pos + dir * o, dx: dir, dz: 0, len, speed, n, seed, heavy: 0 });
      else out.push({ x: h.pos - dir * o, y: h.y + 0.45, z: dir > 0 ? h.lo : h.hi, dx: 0, dz: dir, len, speed, n, seed, heavy: 0 });
    }
  }
}

// --------------------------------------------------------------- promenade
/** Promenade lamp poles along the sea, every 24 m from the far west to the far east. */
export interface PromenadeLamp {
  x: number;
  z: number;
  /** Lamp head (the arm reaches back over the walk, away from the water). */
  hx: number;
  hy: number;
  hz: number;
  /** On the city front (drawn as a lamp kit too). */
  inCity: boolean;
}

export const PROMENADE_H = 6;

export function promenade(spec: CitySpec): PromenadeLamp[] {
  const { x0, step: stp, z } = spec.coast;
  const xEnd = x0 + (z.length - 1) * stp;
  const zAt = (x: number): number => (x < x0 ? (z[0] as number) : x > xEnd ? (z[z.length - 1] as number) : (z[Math.max(0, Math.min(z.length - 1, Math.round((x - x0) / stp)))] as number));
  const out: PromenadeLamp[] = [];
  const s = PROMENADE_H / 8;
  for (let x = -3400; x <= 3400; x += 24) {
    // skip the steps in the coastline (a lamp would stand in the water)
    if (Math.abs(zAt(x - 6) - zAt(x + 6)) > 0.5) continue;
    const pz = zAt(x) - 1.6;
    out.push({ x, z: pz, hx: x, hy: 0.15 + 7.62 * s, hz: pz - 1.8 * s, inCity: x >= x0 && x <= xEnd });
  }
  return out;
}

// ------------------------------------------------------------------- build
export interface CityLights {
  group: THREE.Group;
  counts: { lights: number; cars: number };
  update(camera: THREE.PerspectiveCamera, dt: number): void;
  dispose(): void;
}

const hexA = (c: readonly number[], k: number): [number, number, number] => [c[0]! * k, c[1]! * k, c[2]! * k];

export function buildCityLights(spec: CitySpec, flying?: THREE.InstancedBufferGeometry): CityLights {
  const group = new THREE.Group();
  group.name = 'lights';
  const L = new LightList();

  // street lamps: the head sits at the end of the arm (kit authored 8 m tall, arm toward +z)
  for (const k of spec.kits) {
    if (k.kind === 'lamp') {
      const s = k.sy / 8;
      const fx = Math.sin(k.rot);
      const fz = Math.cos(k.rot);
      const [r, g, b] = hexA(k.col, 3.6);
      L.add(k.x + fx * 1.8 * s, k.y + 7.62 * s, k.z + fz * 1.8 * s, 0.32, r, g, b, 0, 0, 1);
    } else if (k.kind === 'beacon') {
      // same phase as the kit sphere so the two blink together
      const [r, g, b] = hexA(k.col, 6.0);
      L.add(k.x, k.y + k.sx * 2 * 0.5, k.z, 0.28, r, g, b, 4, (k.seed % 1) * 0.999 * 13, 1);
    } else if (k.kind === 'antenna' && k.sy > 8) {
      L.add(k.x, k.y + k.sy + 0.3, k.z, 0.22, 4.5, 0.25, 0.15, hash01(Math.floor(k.seed * 1e6), 1, 2) < 0.5 ? 0 : 4, (k.seed * 7.3) % 13);
    } else if (k.kind === 'stack') {
      L.add(k.x, k.y + k.sy + 0.5, k.z, 0.4, 6, 0.35, 0.2, 4, (k.seed * 3.1) % 13);
    }
  }
  // cranes: a beacon on the machinery house and one at the boom tip
  for (const s of spec.structures) {
    if (s.kind !== 'crane') continue;
    const [x, z, rot, h, boom] = s.p as number[];
    const c = Math.cos(rot!);
    const sn = Math.sin(rot!);
    L.add(x!, h! - 0.4, z!, 0.3, 6, 0.3, 0.18, 4, 1.3);
    L.add(x! + boom! * sn, h! + 0.6, z! + boom! * c, 0.3, 6, 0.3, 0.18, 4, 4.1);
  }
  // highway lamps (both shoulders, as baked in highwayEmitters)
  for (const h of spec.highways) {
    for (let a = h.lo + 20; a < h.hi; a += 46) {
      for (const sd of [-1, 1]) {
        const x = h.axis === 'x' ? a : h.pos + sd * (h.width / 2 - 2);
        const z = h.axis === 'x' ? h.pos + sd * (h.width / 2 - 2) : a;
        L.add(x, h.y + 7, z, 0.34, 5.2, 3.0, 1.3, 0, 0, 1);
      }
    }
  }
  // the sprawl: street lights along its grid of streets (sodium or white per street,
  // staggered sides), aviation lights on its towers
  const G = spec.outskirtsGrid;
  const sprawlLanes: Lane[] = [];
  {
    const shoreW = G.coastWest - 8;
    const shoreE = G.coastEast - 8;
    let lineId = 0;
    const along = (axis: 'x' | 'z', pos: number, a: number, b: number): void => {
      const id = lineId++;
      if (b - a < 40) return;
      const sodium = hash01(id, 3, 21) < 0.64;
      const k = 6.5;
      const rgb: [number, number, number] = sodium ? [1 * k, 0.55 * k, 0.2 * k] : [0.8 * k, 0.88 * k, 1 * k];
      let n = 0;
      for (let t = a + 16; t < b - 8; t += 36, n++) {
        if (hash01(id, n, 22) < 0.07) continue; // the odd dead lamp
        const sd = n % 2 ? 7.5 : -7.5;
        if (axis === 'z') L.add(pos + sd, 7, t, 0.32, rgb[0], rgb[1], rgb[2], 0, 0);
        else L.add(t, 7, pos + sd, 0.32, rgb[0], rgb[1], rgb[2], 0, 0);
      }
      // every third street is a through road with traffic
      if (id % 3 === 0) {
        const st = { kind: 'arterial', axis, pos, lo: a, hi: b, road: 14 } as unknown as Street;
        streetLanes(st, sprawlLanes, 5000 + id);
      }
    };
    for (const x of G.xs) {
      if (x <= G.extent.x0 + 1 || x >= G.extent.x1 - 1) continue;
      const inside = x > G.inner.x0 + 1 && x < G.inner.x1 - 1;
      const zEnd = inside ? G.inner.z0 : x <= G.inner.x0 + 1 ? shoreW : shoreE;
      along('z', x, G.extent.z0, zEnd);
    }
    for (const z of G.zs) {
      if (z <= G.extent.z0 + 1 || z >= G.extent.z1 - 1) continue;
      if (z < G.inner.z0 - 1) along('x', z, G.extent.x0, G.extent.x1);
      else {
        if (z < shoreW) along('x', z, G.extent.x0, G.inner.x0);
        if (z < shoreE) along('x', z, G.inner.x1, G.extent.x1);
      }
    }
  }
  spec.outskirts.forEach((o, i) => {
    if (o.h > 55) {
      const R = o.rect;
      const cx = (R.x0 + R.x1) / 2;
      const cz = (R.z0 + R.z1) / 2;
      L.add(cx, o.h + 1.5, cz, 0.3, 5.5, 0.3, 0.16, hash01(i, 0, 13) < 0.5 ? 0 : 4, hash01(i, 0, 14) * 13);
    }
  });
  // the promenade along the sea: lamps every 24 m (poles and arms are kits on the city front)
  for (const p of promenade(spec)) L.add(p.hx, p.hy, p.hz, 0.32, 5, 3.6, 2.2, 0, 0, p.inCity ? 1 : 0);

  const lightCount = L.count;
  const sg = quads(1);
  const arr = new Float32Array(L.data);
  const ib = new THREE.InstancedInterleavedBuffer(arr, 12, 1);
  sg.setAttribute('iA', new THREE.InterleavedBufferAttribute(ib, 4, 0));
  sg.setAttribute('iB', new THREE.InterleavedBufferAttribute(ib, 4, 4));
  sg.setAttribute('iC', new THREE.InterleavedBufferAttribute(ib, 4, 8));
  sg.instanceCount = lightCount;
  sg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  const staticMesh = new THREE.Mesh(sg, makeStaticMaterial());
  staticMesh.name = 'lights:static';
  staticMesh.frustumCulled = false;
  staticMesh.renderOrder = 6;
  group.add(staticMesh);

  // ground traffic: the city's lanes first, then the sprawl's, so the bodies can be split
  const lanes: Lane[] = [];
  spec.streets.forEach((st, i) => streetLanes(st, lanes, i));
  spec.highways.forEach((h, i) => highwayLanes(h, lanes, i));
  const nCore = lanes.reduce((a, l) => a + l.n, 0);
  lanes.push(...sprawlLanes);
  const cars = carData(lanes);
  const nCars = cars.length / 20;
  const attach = (g: THREE.InstancedBufferGeometry, data: Float32Array): void => {
    const cb = new THREE.InstancedInterleavedBuffer(data, 20, 1);
    g.setAttribute('iA', new THREE.InterleavedBufferAttribute(cb, 4, 0));
    g.setAttribute('iB', new THREE.InterleavedBufferAttribute(cb, 4, 4));
    g.setAttribute('iC', new THREE.InterleavedBufferAttribute(cb, 4, 8));
    g.setAttribute('iD', new THREE.InterleavedBufferAttribute(cb, 4, 12));
    g.setAttribute('iE', new THREE.InterleavedBufferAttribute(cb, 4, 16));
    g.instanceCount = data.length / 20;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  };
  const lg = quads(4);
  attach(lg, cars);
  const carLights = new THREE.Mesh(lg, makeCarLightMaterial());
  carLights.name = 'lights:cars';
  carLights.frustumCulled = false;
  carLights.renderOrder = 6;
  group.add(carLights);

  // bodies: one mesh for the city, one for the sprawl, which only draws when the
  // camera is near the edge (bodies past ~700 m collapse anyway; this skips their vertices)
  const base = kitGeometries().car;
  const bodyMat = makeCarBodyMaterial();
  const bodyMesh = (data: Float32Array, name: string): THREE.Mesh => {
    const bg = new THREE.InstancedBufferGeometry();
    bg.index = base.index;
    for (const n of ['position', 'normal', 'uv', 'aPart']) bg.setAttribute(n, base.getAttribute(n));
    attach(bg, data);
    const m = new THREE.Mesh(bg, bodyMat);
    m.name = name;
    m.frustumCulled = false;
    group.add(m);
    return m;
  };
  const coreBodies = bodyMesh(cars.subarray(0, nCore * 20), 'ground-cars');
  const sprawlBodies = nCars > nCore ? bodyMesh(cars.subarray(nCore * 20), 'ground-cars:sprawl') : null;
  const B = spec.bounds;
  const edge = 760;

  // flying traffic: head and tail lights on the hover cars' own instance buffer
  let flyLights: THREE.Mesh | null = null;
  if (flying) {
    const fg = quads(4);
    for (const name of ['iA', 'iD']) fg.setAttribute(name, flying.getAttribute(name));
    fg.instanceCount = flying.instanceCount;
    fg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    flyLights = new THREE.Mesh(fg, makeFlyLightMaterial());
    flyLights.name = 'lights:flying';
    flyLights.frustumCulled = false;
    flyLights.renderOrder = 6;
    group.add(flyLights);
  }

  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  return {
    group,
    counts: { lights: lightCount, cars: nCars },
    update(camera: THREE.PerspectiveCamera, dt: number): void {
      SPRITE.t.value += dt;
      SPRITE.dt.value = Math.max(1e-4, dt);
      const e = camera.matrixWorld.elements;
      right.set(e[0]!, e[1]!, e[2]!).normalize();
      up.set(e[4]!, e[5]!, e[6]!).normalize();
      fwd.set(-e[8]!, -e[9]!, -e[10]!).normalize();
      (SPRITE.right.value as THREE.Vector3).copy(right);
      (SPRITE.up.value as THREE.Vector3).copy(up);
      (SPRITE.fwd.value as THREE.Vector3).copy(fwd);
      const h = (camera as THREE.PerspectiveCamera).fov ? 2 * Math.tan(((camera.fov * Math.PI) / 180) / 2) : 1.3;
      const resY = Math.max(1, (U.res.value as THREE.Vector2).y);
      SPRITE.pxScale.value = h / resY;
      if (flyLights && flying) (flyLights.geometry as THREE.InstancedBufferGeometry).instanceCount = flying.instanceCount;
      if (sprawlBodies) {
        const p = camera.position;
        sprawlBodies.visible = p.x < B.x0 + edge || p.x > B.x1 - edge || p.z < B.z0 + edge || p.z > B.z1 - edge;
      }
    },
    dispose(): void {
      sg.dispose();
      lg.dispose();
      coreBodies.geometry.dispose();
      if (sprawlBodies) sprawlBodies.geometry.dispose();
      if (flyLights) flyLights.geometry.dispose();
    },
  };
}

/** Flying cars (4.6 m, nose toward +z): white heads in front, the lane colour behind. */
function makeFlyLightMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'fly-lights';
  const A = attribute('iA', 'vec4');
  const D = attribute('iD', 'vec4');
  const side = attribute('aSide', 'float');
  const frame = () => {
    const fwd = vec3(sin(A.w), 0.0, cos(A.w));
    const lat = vec3(cos(A.w), 0.0, sin(A.w).negate());
    const isTail = step(1.5, side);
    const lr = select(fract(side.mul(0.5)).greaterThan(0.25), float(1.0), float(-1.0));
    const c = A.xyz.add(fwd.mul(mix(2.3, -2.35, isTail))).add(lat.mul(lr.mul(0.85))).add(vec3(0.0, 0.25, 0.0));
    return { c, fwd, isTail };
  };
  m.positionNode = Fn(() => {
    const { c } = frame();
    const { sig } = spriteSize(c, float(0.2));
    return corner(c, sig);
  })();
  const vRGB = varying(
    Fn(() => {
      const { c, fwd, isTail } = frame();
      const { e } = spriteSize(c, float(0.2));
      const toCam = normalize(cameraPosition.sub(c));
      const facing = dot(toCam, fwd).mul(mix(float(1.0), float(-1.0), isTail));
      const aim = smoothstep(-0.3, 0.5, facing).mul(0.85).add(0.15);
      const head = vec3(0.92, 0.95, 1.0).mul(7.0);
      const tail = D.rgb.mul(4.5);
      return mix(head, tail, isTail).mul(aim).mul(e);
    })(),
    'vFlyRGB',
  );
  const c = Fn(() => vec4(fogAtten(vRGB.mul(profile()).mul(U.neon), positionWorld), 1.0))();
  additiveGlow(m, c);
  return m;
}
