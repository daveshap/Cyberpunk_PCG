/**
 * Chase camera: a spring arm behind the car along the aim direction, with
 * lag, a short look-ahead, a speed FOV kick, collision-shortened arm and
 * trauma-based shake.
 */
import * as THREE from 'three/webgpu';
import type { FlightWorld } from '../core/collision';
import type { Flight } from './flight';

function damp(cur: number, target: number, halflife: number, dt: number): number {
  return target + (cur - target) * Math.pow(2, -dt / Math.max(1e-4, halflife));
}

export class ChaseCam {
  distance = 11;
  /** Vertical field of view before the speed kick (the lens; Z cycles it). */
  baseFov = 66;
  height = 2.6;
  private px = 0;
  private py = 0;
  private pz = 0;
  private tx = 0;
  private ty = 0;
  private tz = 0;
  private fov = 68;
  private init = false;
  private t = 0;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private world: FlightWorld,
  ) {}

  setWorld(w: FlightWorld): void {
    this.world = w;
    this.init = false;
  }

  zoom(steps: number): void {
    this.distance = Math.max(6, Math.min(40, this.distance * Math.pow(1.12, steps)));
  }

  update(f: Flight, dt: number): void {
    this.t += dt;
    const cp = Math.cos(f.aimPitch);
    const ax = -Math.sin(f.aimYaw) * cp;
    const ay = Math.sin(f.aimPitch);
    const az = -Math.cos(f.aimYaw) * cp;
    // desired arm end, shortened if something is in the way
    const dist = this.distance * (1 + Math.min(0.35, f.speed / 400));
    let dx = -ax * dist;
    let dy = -ay * dist + this.height;
    let dz = -az * dist;
    const len = Math.hypot(dx, dy, dz);
    const hit = this.world.raycast({ x: f.x, y: f.y + 1, z: f.z }, dx / len, dy / len, dz / len, len + 1.2);
    if (hit < len + 1.2) {
      const k = Math.max(0.15, (hit - 1.2) / len);
      dx *= k;
      dy *= k;
      dz *= k;
    }
    const wx = f.x + dx;
    const wy = Math.max(1.0, f.y + dy);
    const wz = f.z + dz;
    const lx = f.x + ax * 26 + f.vx * 0.12;
    const ly = f.y + ay * 26 + 1.2;
    const lz = f.z + az * 26 + f.vz * 0.12;
    if (!this.init) {
      this.px = wx;
      this.py = wy;
      this.pz = wz;
      this.tx = lx;
      this.ty = ly;
      this.tz = lz;
      this.init = true;
    }
    const hl = 0.05;
    this.px = damp(this.px, wx, hl, dt);
    this.py = damp(this.py, wy, hl, dt);
    this.pz = damp(this.pz, wz, hl, dt);
    this.tx = damp(this.tx, lx, 0.04, dt);
    this.ty = damp(this.ty, ly, 0.04, dt);
    this.tz = damp(this.tz, lz, 0.04, dt);
    const cam = this.camera;
    cam.position.set(this.px, this.py, this.pz);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.tx, this.ty, this.tz);
    // shake (rotation only), trauma^2
    const s = f.trauma * f.trauma;
    if (s > 0.001) {
      const n = (k: number): number => Math.sin(this.t * 37 + k) * 0.5 + Math.sin(this.t * 61 + k * 2.1) * 0.5;
      cam.rotateZ(n(1) * 0.05 * s);
      cam.rotateX(n(2) * 0.03 * s);
      cam.rotateY(n(3) * 0.03 * s);
    }
    // speed FOV kick
    const targetFov = this.baseFov * (1 + Math.min(0.27, Math.max(0, f.speed - 40) * 0.0018));
    this.fov = damp(this.fov, targetFov, 0.25, dt);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }
}
