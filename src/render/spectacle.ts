// @ts-nocheck -- TSL node graphs are dynamically typed.
/**
 * Giant holograms and light pillars (see core/spectacle.ts for placement).
 *
 * Every creature is one procedural mesh in body units (a swimmer is 1 long,
 * head at +z; a jellyfish bell is 1 across). The vertex shader does all the
 * motion: it swims the body (a travelling wave that grows toward the tail,
 * fin flutter, a pulsing bell, swaying tentacles) and then lays the body along
 * its circuit, so a 240 m serpent curves around the ring it follows. No CPU
 * work per frame: the circuit, speed and phase are vertex attributes and the
 * clock is the holograms' own uniform (HOLO_T), frozen for screenshots.
 *
 * The look is a projection, not a solid: additive, mostly see-through, with a
 * bright fresnel rim, a construction grid, pattern patches, scanlines in world
 * height, shimmer and the odd glitch band. Everything goes to the glow target
 * and is fogged per pixel, so distant ones fade into the haze.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
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
  mrt,
  normalLocal,
  normalize,
  oneMinus,
  positionLocal,
  positionWorld,
  pow,
  select,
  sign,
  sin,
  smoothstep,
  step,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { GiantHolo, HoloKind, LightPillar, Spectacle } from '../core/types';
import { MeshBuilder } from './geometry';
import { U, fogAtten, hash11, vnoise } from './tsl';

const EXTRAS = { aH: 4, aO: 4, aM: 4, aC1: 3, aC2: 3 };

/** The holograms' own clock (seconds): advanced by the city update, frozen for screenshots. */
export const HOLO_T = uniform(0);
const TAU = Math.PI * 2;

// Parts (aH.x): 0 body, 1 fin (caudal / dorsal / spine), 2 paired fin, 3 whisker or tail ribbon,
// 4 tentacle, 5 bell, 6 oral arm. aH.y: position along the part (0 root .. 1 tip). aH.z: side or index.

type V3 = [number, number, number];

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * A lofted tube along the body: rings at body positions s (0 head .. 1 tail),
 * centre z(s), half width w(s) and half height h(s). Normals from the surface.
 */
function loft(B: MeshBuilder, rings: number, seg: number, s0: number, s1: number, z: (s: number) => number, w: (s: number) => number, h: (s: number) => number, part = 0): void {
  const P = (s: number, a: number): V3 => {
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // a slightly flattened belly
    return [w(s) * ca, h(s) * sa * (sa < 0 ? 0.85 : 1), z(s)];
  };
  const grid: number[][] = [];
  for (let i = 0; i <= rings; i++) {
    const s = s0 + ((s1 - s0) * i) / rings;
    const row: number[] = [];
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * TAU;
      const p = P(s, a);
      const ds = 1e-3;
      const da = 1e-3;
      const tS = sub(P(Math.min(s1, s + ds), a), P(Math.max(s0, s - ds), a));
      const tA = sub(P(s, a + da), P(s, a - da));
      let n = norm(cross(tA, tS));
      // keep the normal pointing out of the tube
      if (n[0] * p[0] + n[1] * p[1] < 0) n = [-n[0], -n[1], -n[2]];
      if (!Number.isFinite(n[0]) || (Math.abs(p[0]) < 1e-6 && Math.abs(p[1]) < 1e-6)) n = [0, 0, z(s) > 0 ? 1 : -1];
      B.set('aH', part, (s - s0) / (s1 - s0), 0, 0);
      row.push(B.vert(p[0], p[1], p[2], n[0], n[1], n[2], s, j / seg));
    }
    grid.push(row);
  }
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < seg; j++) B.quad(grid[i]![j]!, grid[i]![j + 1]!, grid[i + 1]![j + 1]!, grid[i + 1]![j]!);
}

/** A flat ribbon surface from a grid of points; normals from the grid. */
function sheet(B: MeshBuilder, rows: number, cols: number, at: (t: number, v: number) => V3, part: number, side: number, sAt: (t: number, v: number) => number): void {
  const grid: number[][] = [];
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const row: number[] = [];
    for (let j = 0; j <= cols; j++) {
      const v = j / cols;
      const p = at(t, v);
      const dt = 1e-3;
      const tT = sub(at(Math.min(1, t + dt), v), at(Math.max(0, t - dt), v));
      const tV = sub(at(t, Math.min(1, v + dt)), at(t, Math.max(0, v - dt)));
      let n = norm(cross(tT, tV));
      if (!Number.isFinite(n[0])) n = [1, 0, 0];
      B.set('aH', part, t, side, 0);
      row.push(B.vert(p[0], p[1], p[2], n[0], n[1], n[2], sAt(t, v), v));
    }
    grid.push(row);
  }
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) B.quad(grid[i]![j]!, grid[i]![j + 1]!, grid[i + 1]![j + 1]!, grid[i + 1]![j]!);
}

// ------------------------------------------------------------------ species

/** Koi: a deep body, a big forked tail that trails like silk, fan fins and barbels. Head at z = +0.5. */
function koiShape(B: MeshBuilder): void {
  const zOf = (s: number): number => 0.5 - s;
  const a = (s: number): number => Math.pow(Math.min(1, s / 0.16), 0.62);
  const b = (s: number): number => 1 - 0.8 * smooth(0.3, 0.84, s);
  const W = (s: number): number => 0.08 * a(s) * b(s);
  const Hh = (s: number): number => 0.1 * a(s) * b(s);
  loft(B, 32, 18, 0, 0.84, zOf, W, Hh);
  // caudal fin: two long flowing lobes with a shallow fork
  sheet(
    B,
    14,
    12,
    (t, v) => {
      const u = v * 2 - 1;
      const reach = 0.3 * t * (1 - 0.28 * Math.pow(1 - Math.abs(u), 1.4));
      return [0, u * (0.016 + 0.19 * Math.pow(t, 0.8)), zOf(0.82) - reach];
    },
    1,
    0,
    (t) => 0.82 + 0.18 * t,
  );
  // dorsal fin along the back
  sheet(
    B,
    12,
    4,
    (t, v) => {
      const s = 0.2 + 0.44 * t;
      return [0, Hh(s) * 0.92 + v * 0.07 * Math.sin(Math.PI * Math.pow(t, 0.65)), zOf(s) - v * 0.04];
    },
    1,
    0,
    (t) => 0.2 + 0.44 * t,
  );
  // pectoral and pelvic fins: fans that sweep out, down and back from the flank
  for (const side of [-1, 1]) {
    for (const [s, len, wid] of [
      [0.19, 0.19, 0.11],
      [0.47, 0.11, 0.06],
    ] as const) {
      const root: V3 = [side * W(s) * 0.85, -Hh(s) * 0.45, zOf(s)];
      const dir = norm([side * 0.55, -0.4, -0.73]);
      const across = norm([side * 0.1, 0.3, 1]);
      sheet(
        B,
        8,
        6,
        (t, v) => {
          const spread = wid * Math.pow(t, 0.6) * (1 - 0.25 * t);
          const k = (v - 0.5) * spread;
          return [root[0] + dir[0] * len * t + across[0] * k, root[1] + dir[1] * len * t + across[1] * k, root[2] + dir[2] * len * t + across[2] * k];
        },
        2,
        side,
        () => s,
      );
    }
    // barbels at the mouth
    sheet(
      B,
      8,
      1,
      (t, v) => [side * (0.015 + 0.05 * t), -0.022 - 0.02 * t, 0.495 - 0.06 * t + (v - 0.5) * 0.006],
      3,
      side,
      () => 0.02,
    );
  }
}

/** Serpent: a long flying body with a crested spine, a broad head, whiskers and swept horns. Head at z = +0.5. */
function serpentShape(B: MeshBuilder): void {
  const zOf = (s: number): number => 0.5 - s;
  const r = (s: number): number => {
    const head = 1 + 0.9 * Math.exp(-Math.pow((s - 0.035) / 0.025, 2));
    const snout = Math.pow(Math.min(1, s / 0.02), 0.6);
    return 0.022 * head * snout * (1 - 0.8 * smooth(0.5, 1.0, s));
  };
  // the head is broad and flat; the body round
  loft(B, 150, 12, 0, 1, zOf, (s) => r(s) * (s < 0.07 ? 1.15 : 1), (s) => r(s) * (s < 0.07 ? 0.78 : 1.0));
  // crest: flame-like spikes down the spine
  sheet(
    B,
    150,
    2,
    (t, v) => {
      const s = 0.07 + 0.9 * t;
      // backward-raked spikes: a sawtooth that rises sharply and falls away behind
      const f = (t * 34) % 1;
      const tooth = Math.pow(1 - f, 1.8) * smooth(0, 0.08, f);
      return [0, r(s) * 0.92 + v * (0.006 + 0.04 * tooth) * (1 - 0.6 * t), zOf(s) - v * (0.004 + 0.02 * tooth)];
    },
    1,
    0,
    (t) => 0.07 + 0.9 * t,
  );
  for (const side of [-1, 1]) {
    // long whiskers trailing back in a wave
    sheet(
      B,
      30,
      1,
      (t, v) => [side * (0.025 + 0.05 * t), -0.006 + 0.018 * Math.sin(t * 8), 0.5 - 0.015 - 0.24 * t + (v - 0.5) * 0.005],
      3,
      side,
      () => 0.01,
    );
    // horns swept back over the head
    sheet(
      B,
      8,
      1,
      (t, v) => [side * (0.016 + 0.02 * t), 0.024 + 0.045 * t, 0.475 - 0.075 * t + (v - 0.5) * 0.008 * (1 - t)],
      3,
      side,
      () => 0.035,
    );
    // frilled fins behind the jaw
    sheet(
      B,
      6,
      3,
      (t, v) => [side * (0.03 + 0.035 * t), -0.004 + (v - 0.5) * 0.03 * (1 - 0.5 * t), 0.455 - 0.03 * t],
      2,
      side,
      () => 0.045,
    );
  }
}

/** Manta: a wide flat wing with a domed body, head lobes and a whip tail. Wingspan 1 along x. */
function mantaShape(B: MeshBuilder): void {
  const lead = (u: number): number => 0.27 - 0.33 * Math.pow(Math.abs(u), 0.85);
  const trail = (u: number): number => -0.2 + 0.16 * Math.pow(Math.abs(u), 1.15);
  sheet(
    B,
    14,
    28,
    (t, v) => {
      const u = v * 2 - 1;
      const z = trail(u) + (lead(u) - trail(u)) * t;
      const dome = 0.035 * (1 - u * u) * Math.sin(Math.PI * t);
      return [u * 0.5, dome, z];
    },
    0,
    0,
    (t) => 1 - t,
  );
  // cephalic lobes
  for (const side of [-1, 1]) {
    sheet(
      B,
      5,
      2,
      (t, v) => [side * (0.05 + 0.025 * v), -0.005 - 0.02 * t, 0.27 + 0.06 * t],
      2,
      side,
      () => 0.0,
    );
  }
  // tail
  sheet(
    B,
    20,
    1,
    (t, v) => [(v - 0.5) * 0.006 * (1 - t), 0, -0.19 - 0.55 * t],
    3,
    0,
    (t) => 0.8 + 0.2 * t,
  );
}

/** Jellyfish: a ribbed bell (1 across), a ring of tentacles and four frilled oral arms. */
function jellyShape(B: MeshBuilder): void {
  const SEG = 28;
  const RINGS = 16;
  const prof = (v: number): [number, number] => {
    if (v <= 1) return [0.5 * Math.pow(Math.sin((v * Math.PI) / 2), 0.9), 0.42 * Math.pow(Math.cos((v * Math.PI) / 2), 1.15)];
    const k = (v - 1) / 0.15;
    return [0.5 - 0.07 * k, -0.045 * k];
  };
  const grid: number[][] = [];
  for (let i = 0; i <= RINGS; i++) {
    const v = (i / RINGS) * 1.15;
    const [r, y] = prof(v);
    const [r2, y2] = prof(Math.min(1.15, v + 0.01));
    const [r1, y1] = prof(Math.max(0, v - 0.01));
    // profile tangent (dr, dy) -> outward normal (dy, -dr)
    const dr = r2 - r1;
    const dy = y2 - y1;
    const row: number[] = [];
    for (let j = 0; j <= SEG; j++) {
      const a = (j / SEG) * TAU;
      const n = norm([dy * Math.cos(a), -dr, dy * Math.sin(a)]);
      const nn: V3 = i === 0 ? [0, 1, 0] : [-n[0], -n[1], -n[2]];
      B.set('aH', 5, v / 1.15, 0, 0);
      row.push(B.vert(r * Math.cos(a), y, r * Math.sin(a), nn[0], nn[1], nn[2], v / 1.15, j / SEG));
    }
    grid.push(row);
  }
  for (let i = 0; i < RINGS; i++)
    for (let j = 0; j < SEG; j++) B.quad(grid[i]![j]!, grid[i]![j + 1]!, grid[i + 1]![j + 1]!, grid[i + 1]![j]!);
  // tentacles: crossed narrow ribbons hanging from the rim
  const N = 16;
  for (let k = 0; k < N; k++) {
    const a = (k / N) * TAU;
    const len = 1.9 + 0.9 * ((k * 0.618) % 1);
    const rx = Math.cos(a) * 0.44;
    const rz = Math.sin(a) * 0.44;
    for (const rot of [0, Math.PI / 2]) {
      const ox = Math.cos(a + rot) * 0.008;
      const oz = Math.sin(a + rot) * 0.008;
      sheet(B, 26, 1, (t, v) => [rx * (1 - 0.25 * t) + ox * (v * 2 - 1), -0.04 - len * t, rz * (1 - 0.25 * t) + oz * (v * 2 - 1)], 4, k, (t) => 0.2 + 0.8 * t);
    }
  }
  // oral arms: wider frilled ribbons from the centre
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * TAU + 0.4;
    sheet(
      B,
      22,
      3,
      (t, v) => {
        const u = v * 2 - 1;
        const frill = 1 + 0.35 * Math.sin(t * 40 + u * 2);
        return [Math.cos(a) * (0.05 + u * 0.05 * frill * (1 - 0.5 * t)), 0.02 - 1.15 * t, Math.sin(a) * (0.05 + u * 0.05 * frill * (1 - 0.5 * t)) + Math.cos(a) * 0.01 * u];
      },
      6,
      k,
      (t) => 0.3 + 0.7 * t,
    );
  }
}

const SHAPES: Record<HoloKind, (B: MeshBuilder) => void> = { koi: koiShape, serpent: serpentShape, manta: mantaShape, jelly: jellyShape };

/** One merged mesh per species: the body template is repeated per hologram with its own circuit. */
function buildSpecies(kind: HoloKind, list: readonly GiantHolo[]): THREE.BufferGeometry | null {
  if (list.length === 0) return null;
  const tpl = new MeshBuilder(EXTRAS);
  SHAPES[kind](tpl);
  const out = new MeshBuilder(EXTRAS);
  for (const h of list) {
    const one = new MeshBuilder(EXTRAS);
    // stamp the circuit attributes onto a copy of the template
    one.append(tpl);
    one.fill('aO', h.x, h.z, h.radius, h.y);
    one.fill('aM', h.speed, h.size, h.phase, h.bob);
    one.fill('aC1', h.col[0], h.col[1], h.col[2]);
    one.fill('aC2', h.col2[0], h.col2[1], h.col2[2]);
    out.append(one);
  }
  return out.build();
}

// ------------------------------------------------------------------ motion

/**
 * Place a body-unit vertex in the world. Returns [world position, world normal]
 * node builders for the given body-space position p and normal n.
 */
function placeOnCircuit(kind: HoloKind, p, n) {
  const H = attribute('aH', 'vec4');
  const O = attribute('aO', 'vec4'); // centre x, centre z, radius, height
  const M = attribute('aM', 'vec4'); // speed, size, phase, bob
  const part = H.x;
  const along = H.y;
  const t = HOLO_T;
  const L = M.y;
  const R = max(O.z, float(1.0));
  const dir = sign(M.x).add(step(abs(M.x), float(1e-6)));
  const phase = M.z;
  const s = uv().x;
  if (kind === 'jelly') {
    // drift on a small circle, bob, pulse the bell and sway the tentacles
    const th = phase.mul(TAU).add(M.x.mul(t).div(R));
    const pulse = pow(max(sin(t.mul(1.5).add(phase.mul(TAU))), float(0)), float(1.6));
    const isBell = step(4.5, part).mul(step(part, 5.5));
    const k = isBell.mul(along);
    const bx = p.x.mul(oneMinus(pulse.mul(0.12).mul(k)));
    const bz = p.z.mul(oneMinus(pulse.mul(0.12).mul(k)));
    const by = p.y.add(pulse.mul(0.03).mul(isBell));
    // tentacles and arms trail and sway; deeper points lag more
    const hang = step(3.5, part).mul(oneMinus(isBell));
    const depth = hang.mul(pow(along, 1.4));
    const idx = H.z;
    const swayX = sin(t.mul(0.8).add(along.mul(4.0)).add(idx.mul(1.7))).mul(0.07).mul(depth);
    const swayZ = cos(t.mul(0.63).add(along.mul(3.2)).add(idx.mul(2.3))).mul(0.06).mul(depth);
    const lift = pulse.mul(0.05).mul(depth);
    const spin = t.mul(0.05).add(phase.mul(TAU));
    const cs = cos(spin);
    const sn = sin(spin);
    const lx = bx.add(swayX);
    const lz = bz.add(swayZ);
    const rx = lx.mul(cs).sub(lz.mul(sn));
    const rz = lx.mul(sn).add(lz.mul(cs));
    const centre = vec3(O.x.add(R.mul(cos(th))), O.w.add(M.w.mul(sin(t.mul(0.21).add(phase.mul(17.0))))).add(pulse.mul(1.5)), O.y.add(R.mul(sin(th))));
    const wpos = centre.add(vec3(rx, by.add(lift), rz).mul(L));
    const nrm = vec3(n.x.mul(cs).sub(n.z.mul(sn)), n.y, n.x.mul(sn).add(n.z.mul(cs)));
    return [wpos, nrm];
  }
  // swimmers: a travelling wave down the body, then the body laid along the circuit
  const beat = kind === 'serpent' ? 1.1 : kind === 'manta' ? 1.25 : 1.6;
  const w = t.mul(beat).sub(phase.mul(TAU));
  let lateral;
  let vertical;
  if (kind === 'koi') {
    const amp = float(0.012).add(s.mul(s).mul(0.085));
    lateral = sin(s.mul(TAU * 0.9).sub(w)).mul(amp);
    // fins flutter, paired fins row, barbels drift
    const isFin = step(0.5, part).mul(step(part, 1.5));
    lateral = lateral.add(sin(s.mul(30.0).sub(w.mul(1.7)).add(p.y.mul(9.0))).mul(0.018).mul(along.mul(along)).mul(isFin));
    const isPaired = step(1.5, part).mul(step(part, 2.5));
    vertical = sin(w.mul(0.8).add(H.z)).mul(0.025).mul(along).mul(isPaired);
    const isWhisker = step(2.5, part);
    lateral = lateral.add(sin(t.mul(1.3).add(along.mul(5.0)).add(H.z)).mul(0.012).mul(along).mul(isWhisker));
  } else if (kind === 'serpent') {
    lateral = sin(s.mul(TAU * 1.6).sub(w)).mul(0.05).mul(smoothstep(0.0, 0.12, s).mul(0.85).add(0.15));
    vertical = sin(s.mul(TAU * 1.2).sub(w.mul(0.7)).add(1.0)).mul(0.065).mul(smoothstep(0.0, 0.1, s));
    const isWhisker = step(2.5, part);
    lateral = lateral.add(sin(t.mul(1.6).add(along.mul(7.0)).add(H.z)).mul(0.01).mul(along).mul(isWhisker));
  } else {
    // manta: the wing flaps in a wave from root to tip; the tail whips
    const span = abs(p.x).mul(2.0);
    vertical = sin(w.sub(span.mul(1.6))).mul(0.13).mul(pow(span, 1.6));
    const isTail = step(2.5, part);
    lateral = sin(t.mul(1.2).add(along.mul(6.0))).mul(0.03).mul(along).mul(isTail);
  }
  // arc position of this body point: the head leads in the direction of travel
  const arcHead = phase.mul(TAU).mul(R).add(M.x.mul(t));
  const arc = arcHead.add(dir.mul(p.z.sub(0.5)).mul(L));
  const th = arc.div(R);
  const T = vec3(sin(th).negate(), 0.0, cos(th)).mul(dir);
  const right = vec3(T.z.negate(), 0.0, T.x);
  const bank = float(0.16).mul(dir);
  const up = vec3(0, 1, 0).mul(cos(bank)).add(right.mul(sin(bank)));
  const rightB = right.mul(cos(bank)).sub(vec3(0, 1, 0).mul(sin(bank)));
  const bobY = M.w.mul(sin(th.mul(2.0).add(t.mul(0.17)).add(phase.mul(11.0))));
  const onRing = vec3(O.x.add(R.mul(cos(th))), O.w.add(bobY), O.y.add(R.mul(sin(th))));
  const wpos = onRing.add(rightB.mul(p.x.add(lateral).mul(L))).add(up.mul(p.y.add(vertical).mul(L)));
  const nrm = rightB.mul(n.x).add(up.mul(n.y)).add(T.mul(n.z));
  return [wpos, nrm];
}

function makeHoloMaterial(kind: HoloKind): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'giant-holo-' + kind;
  m.fog = false;
  m.transparent = true;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  m.blending = THREE.AdditiveBlending;
  const placed = placeOnCircuit(kind, positionLocal, normalLocal);
  m.positionNode = placed[0];
  const vN = varying(placed[1]);
  const c = Fn(() => {
    const H = attribute('aH', 'vec4');
    const M = attribute('aM', 'vec4');
    const c1 = attribute('aC1', 'vec3');
    const c2 = attribute('aC2', 'vec3');
    const part = H.x;
    const s = uv().x;
    const a = uv().y;
    const wp = positionWorld;
    const toCam = cameraPosition.sub(wp);
    const dist = length(toCam);
    const V = toCam.div(dist);
    const N = normalize(vN);
    const ndv = abs(dot(N, V));
    const rim = pow(oneMinus(ndv), 2.4);
    const t = HOLO_T;
    const seed = M.z;
    // pattern: koi get blotches, the serpent scales and a belly stripe, the manta spots, jellies radial ribs
    let pat;
    let contour = float(0);
    let eye = float(0);
    if (kind === 'koi') {
      // kohaku-style patches: a faint tint inside, a glowing contour at the edge
      const nP = vnoise(vec2(s.mul(6.0).add(seed.mul(31.0)), a.mul(3.0)));
      pat = smoothstep(0.54, 0.6, nP).mul(step(part, 0.5));
      contour = oneMinus(smoothstep(0.0, fwidth(nP).mul(1.5).add(0.004), abs(nP.sub(0.56)))).mul(step(part, 0.5));
      const d1 = length(vec2(s.sub(0.075).mul(55.0), a.sub(0.05).mul(30.0)));
      const d2 = length(vec2(s.sub(0.075).mul(55.0), a.sub(0.45).mul(30.0)));
      eye = smoothstep(1.0, 0.4, min(d1, d2)).mul(step(part, 0.5));
    }
    else if (kind === 'serpent') pat = max(smoothstep(0.8, 0.95, abs(fract(s.mul(70.0)).sub(0.5)).mul(2.0)).mul(0.35), smoothstep(0.16, 0.08, abs(a.sub(0.75))));
    else if (kind === 'manta') pat = smoothstep(0.55, 0.7, vnoise(vec2(s.mul(14.0), a.mul(26.0)).add(seed.mul(9.0))));
    else pat = smoothstep(0.7, 0.95, abs(fract(a.mul(14.0)).sub(0.5)).mul(2.0));
    const base = mix(c1, c2, pat.mul(0.9));
    // construction grid on the body, streaks along the fins; it fades where it would alias
    const gs = s.mul(kind === 'serpent' ? 120.0 : 26.0);
    const ga = a.mul(kind === 'jelly' ? 28.0 : 10.0);
    const wS = fwidth(gs).add(1e-4);
    const wA = fwidth(ga).add(1e-4);
    const lineS = smoothstep(wS.mul(1.2), float(0.0), abs(fract(gs).sub(0.5)).sub(0.5).abs());
    const lineA = smoothstep(wA.mul(1.2), float(0.0), abs(fract(ga).sub(0.5)).sub(0.5).abs());
    const gridK = oneMinus(smoothstep(0.2, 0.5, max(wS, wA)));
    const grid = max(lineS, lineA).mul(gridK);
    const isBody = step(part, 0.5).add(step(4.5, part).mul(step(part, 5.5)));
    const isSheet = oneMinus(isBody).add(kind === 'manta' ? step(part, 0.5) : float(0)).min(1.0);
    // a projection is mostly empty: a faint fill, a hot rim, glowing edges on fins and wings
    const fill = select(isBody.greaterThan(0.5), float(kind === 'jelly' ? 0.06 : 0.03), float(0.07));
    const ev = min(min(a, oneMinus(a)), oneMinus(H.y));
    const edge = smoothstep(fwidth(ev).mul(2.0).add(0.04), float(0.0), ev).mul(isSheet);
    // tentacles, whiskers and fin tips fade toward their ends
    const tipFade = select(part.greaterThan(2.5).and(part.lessThan(4.5).or(part.greaterThan(5.5))), oneMinus(smoothstep(0.5, 1.0, H.y)).mul(0.8).add(0.2), float(1.0));
    // hard scan bands in world height, a slow shimmer, the odd glitch band
    const band = fract(wp.y.mul(0.22).sub(t.mul(0.6)));
    const scan = float(0.45).add(smoothstep(0.15, 0.35, band).mul(oneMinus(smoothstep(0.75, 0.95, band))).mul(0.55));
    const shimmer = float(0.8).add(vnoise(wp.xz.mul(0.04).add(vec2(t.mul(0.21), t.mul(-0.13)))).mul(0.4));
    const glitch = step(0.93, hash11(floor(t.mul(3.0)).add(seed.mul(97.0)))).mul(step(0.55, fract(wp.y.mul(0.03).add(t.mul(0.9)))));
    const breathe = float(0.9).add(sin(t.mul(0.5).add(seed.mul(40.0))).mul(0.1));
    // fin rays fan out along fins and tails
    const fr = a.mul(10.0);
    const rays = oneMinus(smoothstep(0.0, fwidth(fr).mul(1.5).add(0.02), abs(fract(fr).sub(0.5)).sub(0.5).abs())).mul(step(0.5, part).mul(step(part, 2.5)));
    const k = fill.add(rim.mul(2.2)).add(grid.mul(0.25)).add(pat.mul(0.12)).add(edge.mul(1.2)).add(rays.mul(0.35));
    const lit = base.mul(k).add(c2.mul(contour.mul(0.9))).add(mix(c1, vec3(1.0), 0.5).mul(eye.mul(3.0)));
    const rgb = lit.mul(scan).mul(shimmer).mul(oneMinus(glitch.mul(0.65))).mul(tipFade).mul(breathe).mul(1.35).mul(U.neon);
    return vec4(fogAtten(rgb, wp), 1.0);
  })();
  m.colorNode = vec4(0, 0, 0, 0);
  m.mrtNode = mrt({ output: vec4(0, 0, 0, 0), glow: c, velocity: vec4(0, 0, 0, 0) });
  return m;
}

// ------------------------------------------------------------------ light pillars

const PILLAR_H = 2600;

function buildPillars(list: readonly LightPillar[]): THREE.BufferGeometry | null {
  if (list.length === 0) return null;
  const B = new MeshBuilder({ aP: 4, aPc: 4 });
  const SEG = 18;
  for (const p of list) {
    // one hull a few core radii wide; the shader makes a hot core and a soft falloff across it
    B.set('aP', p.x, p.z, p.y0, p.radius * 2.6);
    B.set('aPc', p.col[0] * p.intensity, p.col[1] * p.intensity, p.col[2] * p.intensity, 0);
    const ring = (v: number): number[] => {
      const ids: number[] = [];
      for (let i = 0; i <= SEG; i++) {
        const a = (i / SEG) * TAU;
        ids.push(B.vert(Math.cos(a), v, Math.sin(a), Math.cos(a), 0, Math.sin(a), i / SEG, v));
      }
      return ids;
    };
    const rows = 14;
    let prev = ring(0);
    for (let k = 1; k <= rows; k++) {
      const v = Math.pow(k / rows, 1.6);
      const cur = ring(v);
      for (let i = 0; i < SEG; i++) B.quad(prev[i]!, prev[i + 1]!, cur[i + 1]!, cur[i]!);
      prev = cur;
    }
  }
  return B.build();
}

function makePillarMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'light-pillar';
  m.fog = false;
  m.transparent = true;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  m.blending = THREE.AdditiveBlending;
  const P = attribute('aP', 'vec4');
  const v = uv().y;
  // the column widens a little with height, as a beam does in haze
  const rad = P.w.mul(float(1.0).add(v.mul(1.2)));
  m.positionNode = vec3(P.x.add(positionLocal.x.mul(rad)), P.z.add(v.mul(PILLAR_H)), P.y.add(positionLocal.z.mul(rad)));
  const c = Fn(() => {
    const Pc = attribute('aPc', 'vec4');
    const wp = positionWorld;
    const toCam = cameraPosition.sub(wp);
    // facing: the column is brightest along its axis as seen from the camera
    const d = normalize(vec2(toCam.x, toCam.z));
    const nrm = normalize(vec2(wp.x.sub(P.x), wp.z.sub(P.y)));
    const facing = abs(dot(d, nrm));
    // a hot core along the axis and a soft glow falling off to nothing at the hull's silhouette
    const prof = pow(facing, float(9.0)).mul(1.6).add(pow(facing, float(2.5)).mul(0.22));
    const h = wp.y.sub(P.z);
    const fade = exp(h.div(-900.0)).mul(smoothstep(0.0, 25.0, h));
    const flow = float(0.85).add(sin(h.mul(0.045).sub(HOLO_T.mul(5.0))).mul(0.1)).add(sin(h.mul(0.011).sub(HOLO_T.mul(1.7))).mul(0.05));
    const rgb = Pc.rgb.mul(prof).mul(fade).mul(flow).mul(2.2).mul(U.neon);
    return vec4(fogAtten(rgb, wp), 1.0);
  })();
  m.colorNode = vec4(0, 0, 0, 0);
  m.mrtNode = mrt({ output: vec4(0, 0, 0, 0), glow: c, velocity: vec4(0, 0, 0, 0) });
  return m;
}

// ------------------------------------------------------------------ assembly

export interface SpectacleRender {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  update(dt: number): void;
  dispose(): void;
}

/** Freeze the hologram clock at t seconds (screenshots), or let it run again with null. */
let frozenAt: number | null = null;
export function freezeHolograms(t: number | null): void {
  frozenAt = t;
  if (t !== null) HOLO_T.value = t;
}

/**
 * Where a hologram's head is at clock time t (a CPU mirror of the vertex
 * shader): [x, y, z, heading x, heading z]. Jellyfish return the bell centre.
 */
export function holoHead(h: GiantHolo, t: number): [number, number, number, number, number] {
  const R = Math.max(1, h.radius);
  const dir = h.speed < 0 ? -1 : 1;
  if (h.kind === 'jelly') {
    const th = h.phase * TAU + (h.speed * t) / R;
    return [h.x + R * Math.cos(th), h.y + h.bob * Math.sin(t * 0.21 + h.phase * 17), h.z + R * Math.sin(th), -Math.sin(th) * dir, Math.cos(th) * dir];
  }
  const th = (h.phase * TAU * R + h.speed * t) / R;
  const bob = h.bob * Math.sin(th * 2 + t * 0.17 + h.phase * 11);
  return [h.x + R * Math.cos(th), h.y + bob, h.z + R * Math.sin(th), -Math.sin(th) * dir, Math.cos(th) * dir];
}

export function buildSpectacle(sp: Spectacle): SpectacleRender {
  const group = new THREE.Group();
  group.name = 'spectacle';
  const meshes: THREE.Mesh[] = [];
  const kinds: HoloKind[] = ['koi', 'serpent', 'manta', 'jelly'];
  for (const kind of kinds) {
    const geo = buildSpecies(
      kind,
      sp.holos.filter((h) => h.kind === kind),
    );
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, makeHoloMaterial(kind));
    mesh.name = 'holo-' + kind;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 7;
    group.add(mesh);
    meshes.push(mesh);
  }
  const pg = buildPillars(sp.pillars);
  if (pg) {
    const mesh = new THREE.Mesh(pg, makePillarMaterial());
    mesh.name = 'pillars';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 6;
    group.add(mesh);
    meshes.push(mesh);
  }
  return {
    group,
    meshes,
    update(dt: number): void {
      if (frozenAt === null) HOLO_T.value += dt;
    },
    dispose(): void {
      // geometry goes with the city root; the materials are ours
      for (const m of meshes) (m.material as THREE.Material).dispose();
    },
  };
}

void clamp;
void min;
void exp;
