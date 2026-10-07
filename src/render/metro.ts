/**
 * Elevated metro: the viaduct (deck, parapets with a line-colour light strip,
 * rails, pillars, under-deck lamps), stations (platforms, glass walls, canopy
 * with light panels, a stair tower), street-level subway kiosks, and the
 * trains, which run both ways round the loop and stop at every station.
 */
import * as THREE from 'three/webgpu';
import type { RGB } from '../core/types';
import type { MetroLine, Transit } from '../core/transit';
import { metroAt } from '../core/transit';
import { CLS, kitGeometries, makeKitMaterial, type Inst, type KitGeom, type LodClass } from './kits';

type KitSink = (geom: KitGeom, lod: LodClass, i: Inst) => void;

function bx(K: KitSink, lod: LodClass, x: number, y: number, z: number, rot: number, sx: number, sy: number, sz: number, col: RGB, cls: number, seed: number, emit = 0, ecol: RGB = [0, 0, 0], mode = 0): void {
  K('box', lod, { x, y, z, rot, sx, sy, sz, emit, r: col[0], g: col[1], b: col[2], cs: cls + (Math.abs(seed) % 1) * 0.999, er: ecol[0], eg: ecol[1], eb: ecol[2], mode });
}

const DECK_T = 1.8;
const CONCRETE: RGB = [0.13, 0.13, 0.135];

export function addMetro(t: Transit, K: KitSink): void {
  for (const m of t.metro) {
    const y = m.y;
    const hw = m.width / 2;
    // ---- deck pieces: 24 m on the straights, 6 m round the corners
    let s = 0;
    while (s < m.length - 0.01) {
      const p0 = metroAt(m, s);
      const step = Math.min(p0.straight ? 24 : 6, m.length - s);
      const q = metroAt(m, s + step / 2);
      const rot = Math.atan2(q.dx, q.dz);
      const rx = -q.dz;
      const rz = q.dx;
      const len = step + (q.straight ? 0.05 : 0.6);
      bx(K, 'huge', q.x, y - DECK_T, q.z, rot, m.width, DECK_T, len, CONCRETE, CLS.concrete, s * 0.013);
      for (const side of [-1, 1]) {
        const ox = q.x + rx * side * (hw - 0.2);
        const oz = q.z + rz * side * (hw - 0.2);
        bx(K, 'big', ox, y, oz, rot, 0.4, 1.1, len, [0.15, 0.15, 0.16], CLS.concrete, s * 0.7);
        bx(K, 'big', ox, y + 1.1, oz, rot, 0.26, 0.08, len - 0.1, [0.2, 0.2, 0.2], CLS.lightbox, s, 1.3, m.color);
      }
      for (const tc of [-2.4, 2.4])
        for (const rr of [-0.72, 0.72]) {
          const off = tc + rr;
          bx(K, 'mid', q.x + rx * off, y, q.z + rz * off, rot, 0.12, 0.16, len, [0.3, 0.3, 0.32], CLS.metal, s * 0.31);
        }
      if (q.straight) bx(K, 'big', q.x, y - DECK_T - 0.06, q.z, rot, 0.5, 0.06, len * 0.8, [0.2, 0.2, 0.2], CLS.lightbox, s, 1.2, [1, 0.72, 0.4]);
      s += step;
    }
    // ---- pillars with a capital under the deck
    for (const ps of m.pillars) {
      const p = metroAt(m, ps);
      const rot = Math.atan2(p.dx, p.dz);
      const h = y - DECK_T;
      bx(K, 'huge', p.x, 0, p.z, rot, 2.6, h - 1.4, 2.6, [0.12, 0.12, 0.125], CLS.concrete, ps * 0.11);
      bx(K, 'big', p.x, h - 1.4, p.z, rot, m.width - 1, 1.4, 3.2, [0.12, 0.12, 0.125], CLS.concrete, ps * 0.17);
    }
    // ---- stations
    for (const st of m.stations) {
      const p = metroAt(m, st.s);
      const rot = Math.atan2(p.dx, p.dz);
      const rx = -p.dz;
      const rz = p.dx;
      const L = 84;
      const at = (along: number, across: number): [number, number] => [p.x + p.dx * along + rx * across, p.z + p.dz * along + rz * across];
      for (const side of [-1, 1]) {
        const [px, pz] = at(0, side * (hw + 2.5));
        bx(K, 'huge', px, y - DECK_T, pz, rot, 5, DECK_T + 0.9, L, [0.16, 0.16, 0.17], CLS.concrete, st.s * 0.07);
        const [ex, ez] = at(0, side * (hw + 0.15));
        bx(K, 'big', ex, y + 0.9, ez, rot, 0.25, 0.04, L, [0.3, 0.3, 0.1], CLS.lightbox, st.s, 1.4, [1, 0.82, 0.2]);
        const [gx, gz] = at(0, side * (hw + 4.85));
        bx(K, 'big', gx, y + 0.9, gz, rot, 0.15, 2.6, L - 4, [0.04, 0.07, 0.09], CLS.glass, st.s * 0.3);
        for (let k = -3; k <= 3; k++) {
          const [cx, cz] = at(k * 12, side * (hw + 4.4));
          bx(K, 'mid', cx, y + 0.9, cz, rot, 0.4, 5.6, 0.4, [0.18, 0.18, 0.2], CLS.metal, k * 0.1);
        }
        // benches and a timetable screen
        for (const k of [-20, 8]) {
          const [cx, cz] = at(k, side * (hw + 3.6));
          bx(K, 'small', cx, y + 0.9, cz, rot, 0.6, 0.45, 3.2, [0.25, 0.22, 0.2], CLS.painted, k);
        }
        const [sx, sz] = at(-6, side * (hw + 3.9));
        bx(K, 'small', sx, y + 3.0, sz, rot, 0.12, 0.9, 1.8, [0.1, 0.1, 0.1], CLS.lightbox, st.s * 0.9, 2.0, [0.3, 0.8, 1]);
      }
      bx(K, 'huge', p.x, y + 6.5, p.z, rot, m.width + 11, 0.5, L + 4, [0.1, 0.1, 0.11], CLS.metal, st.s * 0.21);
      for (const k of [-30, -10, 10, 30]) {
        const [cx, cz] = at(k, 0);
        bx(K, 'big', cx, y + 6.44, cz, rot, m.width + 8, 0.05, 12, [0.2, 0.2, 0.2], CLS.lightbox, st.s + k, 2.0, [0.85, 0.92, 1]);
      }
      // stair and lift tower down to the street at one end
      const [tx, tz] = at(L / 2 - 6, hw + 8);
      bx(K, 'huge', tx, 0, tz, rot, 5, y + 1, 7, [0.14, 0.14, 0.15], CLS.concrete, st.s * 0.5);
      const [lx, lz] = at(L / 2 - 6, hw + 10.55);
      bx(K, 'big', lx, 1.0, lz, rot, 0.12, y - 1, 1.2, [0.1, 0.1, 0.1], CLS.lightbox, st.s * 0.4, 1.4, m.color);
    }
  }
  // ---- subway kiosks on the sidewalks
  for (const e of t.entrances) {
    const rot = Math.atan2(e.nx, e.nz);
    const seed = (e.x * 0.13 + e.z * 0.07) % 1;
    const rx = -e.nz;
    const rz = e.nx;
    for (const side of [-1, 1]) bx(K, 'small', e.x + rx * side * 1.7, 0.15, e.z + rz * side * 1.7, rot, 0.25, 1.1, 5, [0.16, 0.16, 0.17], CLS.concrete, seed);
    bx(K, 'small', e.x - e.nx * 2.5, 0.15, e.z - e.nz * 2.5, rot, 3.6, 1.1, 0.25, [0.16, 0.16, 0.17], CLS.concrete, seed);
    for (const side of [-1, 1]) bx(K, 'small', e.x + rx * side * 1.7 + e.nx * 2.3, 0.15, e.z + rz * side * 1.7 + e.nz * 2.3, rot, 0.14, 2.7, 0.14, [0.2, 0.2, 0.22], CLS.metal, seed);
    bx(K, 'small', e.x, 2.85, e.z, rot, 3.8, 0.22, 5.6, [0.1, 0.1, 0.11], CLS.metal, seed);
    bx(K, 'small', e.x + e.nx * 2.82, 2.3, e.z + e.nz * 2.82, rot, 3.6, 0.5, 0.12, [0.1, 0.1, 0.1], CLS.lightbox, seed, 2.6, [0.2, 0.85, 1]);
    // the stair well: a dark slab sinking into the ground
    bx(K, 'small', e.x, 0.16, e.z, rot, 3.0, 0.02, 4.2, [0.01, 0.01, 0.012], CLS.concrete, seed);
  }
}

// ------------------------------------------------------------------ trains
const CAR_LEN = 18;
const CAR_GAP = 1.2;
const CARS = 5;
const VMAX = 22;
const ACC = 1.1;
const DWELL = 9;

interface Train {
  line: number;
  s: number;
  v: number;
  dwell: number;
  dir: 1 | -1;
  next: number;
}

let TRAIN_MAT: THREE.Material | null = null;

/** Instances per car: body, window band, roof. Per train: head light, tail light. */
const PER_CAR = 3;
const PER_TRAIN = CARS * PER_CAR + 2;

export class MetroTrains {
  readonly mesh: THREE.Mesh;
  private readonly trains: Train[] = [];
  private readonly lines: readonly MetroLine[];
  private readonly data: Float32Array;
  private readonly prev: Float32Array;
  private readonly ib: THREE.InstancedInterleavedBuffer;
  private readonly pb: THREE.InstancedBufferAttribute;

  constructor(t: Transit) {
    this.lines = t.metro;
    t.metro.forEach((m, li) => {
      const n = Math.max(1, m.stations.length);
      for (const dir of [1, -1] as const) {
        for (let k = 0; k < 2; k++) {
          const s = ((k + (dir > 0 ? 0.1 : 0.6)) / 2) * m.length;
          // first stop ahead of the train
          let next = 0;
          let best = Infinity;
          m.stations.forEach((st, i) => {
            const d = this.dist(m, s, this.stopS(m, st.s, dir), dir);
            if (d < best) {
              best = d;
              next = i;
            }
          });
          this.trains.push({ line: li, s, v: VMAX * 0.8, dwell: 0, dir, next: next % n });
        }
      }
    });
    const N = Math.max(1, this.trains.length * PER_TRAIN);
    this.data = new Float32Array(N * 16);
    this.prev = new Float32Array(N * 4);
    const base = kitGeometries().box;
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    for (const name of ['position', 'normal', 'uv', 'aPart']) g.setAttribute(name, base.getAttribute(name));
    this.ib = new THREE.InstancedInterleavedBuffer(this.data, 16, 1);
    this.ib.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iA', new THREE.InterleavedBufferAttribute(this.ib, 4, 0));
    g.setAttribute('iB', new THREE.InterleavedBufferAttribute(this.ib, 4, 4));
    g.setAttribute('iC', new THREE.InterleavedBufferAttribute(this.ib, 4, 8));
    g.setAttribute('iD', new THREE.InterleavedBufferAttribute(this.ib, 4, 12));
    this.pb = new THREE.InstancedBufferAttribute(this.prev, 4);
    this.pb.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iP', this.pb);
    g.instanceCount = this.trains.length * PER_TRAIN;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    if (!TRAIN_MAT) TRAIN_MAT = makeKitMaterial(true);
    this.mesh = new THREE.Mesh(g, TRAIN_MAT);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'metro-trains';
    this.mesh.visible = this.trains.length > 0;
    // static per-instance looks
    this.trains.forEach((tr, ti) => {
      const m = this.lines[tr.line] as MetroLine;
      for (let c = 0; c < CARS; c++) {
        const o = (ti * PER_TRAIN + c * PER_CAR) * 16;
        this.look(o, 3.0, 3.3, CAR_LEN, 0, [0.16, 0.17, 0.19], CLS.metal, [0, 0, 0]);
        this.look(o + 16, 3.06, 0.95, CAR_LEN - 1.2, 2.2, [0.1, 0.1, 0.1], CLS.lightbox, c % 2 ? [1, 0.9, 0.75] : [0.85, 0.92, 1]);
        this.look(o + 32, 2.5, 0.3, CAR_LEN - 0.6, 1.2, [0.12, 0.12, 0.13], CLS.metal, m.color);
      }
      const o = (ti * PER_TRAIN + CARS * PER_CAR) * 16;
      this.look(o, 2.2, 0.35, 0.12, 4.5, [0.1, 0.1, 0.1], CLS.lightbox, [1, 0.95, 0.85]);
      this.look(o + 16, 2.2, 0.3, 0.12, 3.5, [0.1, 0.1, 0.1], CLS.lightbox, [1, 0.08, 0.05]);
    });
    this.update(0);
    this.update(0);
  }

  private look(o: number, sx: number, sy: number, sz: number, emit: number, col: RGB, cls: number, ecol: RGB): void {
    const d = this.data;
    d[o + 4] = sx;
    d[o + 5] = sy;
    d[o + 6] = sz;
    d[o + 7] = emit;
    d[o + 8] = col[0];
    d[o + 9] = col[1];
    d[o + 10] = col[2];
    d[o + 11] = cls + 0.5;
    d[o + 12] = ecol[0];
    d[o + 13] = ecol[1];
    d[o + 14] = ecol[2];
    d[o + 15] = 0;
  }

  private stopS(m: MetroLine, stationS: number, dir: 1 | -1): number {
    // the middle car stops at the platform centre
    return stationS + dir * 2 * (CAR_LEN + CAR_GAP);
  }

  private dist(m: MetroLine, s: number, target: number, dir: 1 | -1): number {
    const L = m.length;
    return dir > 0 ? (((target - s) % L) + L) % L : (((s - target) % L) + L) % L;
  }

  private place(i: number, x: number, y: number, z: number, rot: number): void {
    const o = i * 16;
    const d = this.data;
    this.prev[i * 4] = d[o]!;
    this.prev[i * 4 + 1] = d[o + 1]!;
    this.prev[i * 4 + 2] = d[o + 2]!;
    this.prev[i * 4 + 3] = d[o + 3]!;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = rot;
  }

  update(dt: number): void {
    this.trains.forEach((tr, ti) => {
      const m = this.lines[tr.line] as MetroLine;
      const st = m.stations[tr.next];
      if (dt > 0) {
        if (tr.dwell > 0) {
          tr.dwell -= dt;
          if (tr.dwell <= 0 && m.stations.length) tr.next = (((tr.next + tr.dir) % m.stations.length) + m.stations.length) % m.stations.length;
        } else {
          const d = st ? this.dist(m, tr.s, this.stopS(m, st.s, tr.dir), tr.dir) : Infinity;
          const target = Math.min(VMAX, Math.sqrt(2 * ACC * Math.max(0, d - 0.3)));
          tr.v += Math.max(-ACC * 1.6 * dt, Math.min(ACC * dt, target - tr.v));
          const ds = Math.min(tr.v * dt, d);
          tr.s = (((tr.s + tr.dir * ds) % m.length) + m.length) % m.length;
          if (st && d - ds < 0.5 && tr.v < 1.2) {
            tr.v = 0;
            tr.dwell = DWELL;
          }
        }
      }
      // cars trail the head along the loop on their own track
      const track = tr.dir > 0 ? -2.4 : 2.4;
      for (let c = 0; c < CARS; c++) {
        const sc = tr.s - tr.dir * c * (CAR_LEN + CAR_GAP);
        const p = metroAt(m, sc);
        const hx = p.dx * tr.dir;
        const hz = p.dz * tr.dir;
        const rot = Math.atan2(hx, hz);
        const x = p.x - p.dz * track;
        const z = p.z + p.dx * track;
        const base = ti * PER_TRAIN + c * PER_CAR;
        this.place(base, x, m.y + 0.35, z, rot);
        this.place(base + 1, x, m.y + 1.85, z, rot);
        this.place(base + 2, x, m.y + 3.62, z, rot);
        if (c === 0) this.place(ti * PER_TRAIN + CARS * PER_CAR, x + hx * (CAR_LEN / 2 + 0.08), m.y + 0.9, z + hz * (CAR_LEN / 2 + 0.08), rot);
        if (c === CARS - 1) this.place(ti * PER_TRAIN + CARS * PER_CAR + 1, x - hx * (CAR_LEN / 2 + 0.08), m.y + 0.9, z - hz * (CAR_LEN / 2 + 0.08), rot);
      }
    });
    this.ib.needsUpdate = true;
    this.pb.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}
