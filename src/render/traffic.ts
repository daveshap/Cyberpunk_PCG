/**
 * Flying traffic: instanced cars looping along the generated lanes. Positions
 * are updated on the CPU each frame (a few thousand cars), with the previous
 * pose kept per instance so motion vectors stay correct for TRAA.
 */
import * as THREE from 'three/webgpu';
import type { AirLane } from '../core/types';
import { kitGeometries, makeKitMaterial, CLS } from './kits';

interface Car {
  lane: number;
  offset: number;
  bob: number;
}

let MAT: THREE.Material | null = null;

export class Traffic {
  readonly mesh: THREE.Mesh;
  private readonly cars: Car[] = [];
  private readonly data: Float32Array;
  private readonly prev: Float32Array;
  private readonly ib: THREE.InstancedInterleavedBuffer;
  private readonly pb: THREE.InstancedBufferAttribute;
  private readonly lanes: { x0: number; y0: number; z0: number; dx: number; dy: number; dz: number; len: number; speed: number; dir: number }[] = [];
  private t = 0;
  density = 1;

  constructor(lanes: readonly AirLane[]) {
    for (const l of lanes) {
      const a = l.pts[0]!;
      const b = l.pts[l.pts.length - 1]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const dz = b[2] - a[2];
      const len = Math.hypot(dx, dy, dz);
      this.lanes.push({ x0: a[0], y0: a[1], z0: a[2], dx: dx / len, dy: dy / len, dz: dz / len, len, speed: l.speed, dir: l.dir });
    }
    let s = 99991;
    const rnd = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    lanes.forEach((l, li) => {
      for (let k = 0; k < l.count; k++) this.cars.push({ lane: li, offset: (k + rnd() * 0.6) / l.count, bob: rnd() * 6.28 });
    });
    // interleave lanes so a lower density thins every lane evenly
    for (let i = this.cars.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = this.cars[i]!;
      this.cars[i] = this.cars[j]!;
      this.cars[j] = tmp;
    }
    const N = Math.max(1, this.cars.length);
    this.data = new Float32Array(N * 16);
    this.prev = new Float32Array(N * 4);
    const body: [number, number, number][] = [
      [0.02, 0.02, 0.025],
      [0.05, 0.05, 0.06],
      [0.12, 0.02, 0.03],
      [0.16, 0.16, 0.17],
      [0.02, 0.06, 0.08],
    ];
    this.cars.forEach((c, i) => {
      const lane = lanes[c.lane]!;
      const o = i * 16;
      const bc = body[i % body.length]!;
      this.data[o + 4] = 1;
      this.data[o + 5] = 1;
      this.data[o + 6] = 1;
      this.data[o + 7] = 2.6; // emissive gain
      this.data[o + 8] = bc[0];
      this.data[o + 9] = bc[1];
      this.data[o + 10] = bc[2];
      this.data[o + 11] = CLS.metal + ((i * 0.618) % 1) * 0.99;
      this.data[o + 12] = lane.col[0];
      this.data[o + 13] = lane.col[1];
      this.data[o + 14] = lane.col[2];
      this.data[o + 15] = 0;
    });
    const base = kitGeometries().car;
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
    g.instanceCount = this.cars.length;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    if (!MAT) MAT = makeKitMaterial(true);
    this.mesh = new THREE.Mesh(g, MAT);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'traffic';
    this.update(0);
    this.update(0);
  }

  update(dt: number): void {
    this.t += dt;
    const d = this.data;
    const n = this.cars.length;
    for (let i = 0; i < n; i++) {
      const c = this.cars[i]!;
      const L = this.lanes[c.lane]!;
      const o = i * 16;
      // previous pose
      this.prev[i * 4] = d[o]!;
      this.prev[i * 4 + 1] = d[o + 1]!;
      this.prev[i * 4 + 2] = d[o + 2]!;
      this.prev[i * 4 + 3] = d[o + 3]!;
      let s = ((c.offset * L.len + this.t * L.speed) % L.len + L.len) % L.len;
      if (L.dir < 0) s = L.len - s;
      d[o] = L.x0 + L.dx * s;
      d[o + 1] = L.y0 + L.dy * s + Math.sin(this.t * 0.9 + c.bob) * 0.35;
      d[o + 2] = L.z0 + L.dz * s;
      d[o + 3] = Math.atan2(L.dx * L.dir, L.dz * L.dir);
    }
    this.ib.needsUpdate = true;
    this.pb.needsUpdate = true;
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = Math.floor(n * Math.min(1, Math.max(0, this.density)));
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}
