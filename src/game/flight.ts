/**
 * Arcade hover-car flight with mouse aim: the mouse sets where you want to go,
 * the car turns toward it at a limited rate, thrusts along its heading and
 * carves (lateral velocity is damped harder than forward). Collisions push the
 * car out of buildings and kill the inward velocity.
 */
import type { FlightWorld } from '../core/collision';

export interface FlightControls {
  /** -1..1 strafe right */
  x: number;
  /** -1..1 throttle forward / brake */
  y: number;
  /** -1..1 climb */
  z: number;
  boost: boolean;
  /** Mouse deltas in pixels (manual) */
  lookX: number;
  lookY: number;
}

const ACC = 24;
const BOOST = 2.6;
const BRAKE = 30;
const STRAFE = 20;
const CLIMB = 20;
const DRAG_F = 0.26;
const DRAG_LAT = 2.4;
const DRAG_V = 1.6;
const MAX_SPEED = 175;
const RADIUS = 2.6;
const SENS = 0.0021;

export class Flight {
  x = 0;
  y = 60;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  /** Heading (car). */
  yaw = 0;
  pitch = 0;
  /** Visual attitude. */
  roll = 0;
  visPitch = 0;
  /** Where the player aims (camera). */
  aimYaw = 0;
  aimPitch = 0;
  speed = 0;
  throttleVis = 0.4;
  braking = 0;
  /** Camera shake trauma 0..1. */
  trauma = 0;
  lastHit = 0;
  ceiling = 900;
  private yawRate = 0;

  constructor(private world: FlightWorld) {}

  setWorld(w: FlightWorld): void {
    this.world = w;
  }

  teleport(x: number, y: number, z: number, yaw: number, pitch = 0): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.yaw = this.aimYaw = yaw;
    this.pitch = this.aimPitch = pitch;
    this.vx = this.vy = this.vz = 0;
    this.roll = 0;
    // start with some forward speed so the city flows
    const f = this.forward();
    this.vx = f[0] * 30;
    this.vy = f[1] * 30;
    this.vz = f[2] * 30;
  }

  forward(yaw = this.yaw, pitch = this.pitch): [number, number, number] {
    const cp = Math.cos(pitch);
    return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
  }

  update(dt: number, c: FlightControls): void {
    if (dt <= 0) return;
    // ---- aim
    this.aimYaw -= c.lookX * SENS;
    this.aimPitch = Math.max(-1.2, Math.min(1.2, this.aimPitch - c.lookY * SENS));
    // ---- heading follows aim with a limited turn rate
    let dy = this.aimYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const turn = 2.4;
    const yawStep = Math.max(-turn * dt, Math.min(turn * dt, dy * Math.min(1, dt * 5)));
    this.yaw += yawStep;
    this.yawRate = this.yawRate + (yawStep / dt - this.yawRate) * Math.min(1, dt * 6);
    const dp = this.aimPitch - this.pitch;
    this.pitch += Math.max(-1.8 * dt, Math.min(1.8 * dt, dp * Math.min(1, dt * 5)));

    // ---- forces
    const f = this.forward();
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    let ax = 0;
    let ay = 0;
    let az = 0;
    const fwdSpeed = this.vx * f[0] + this.vy * f[1] + this.vz * f[2];
    if (c.y > 0) {
      const k = ACC * c.y * (c.boost ? BOOST : 1);
      ax += f[0] * k;
      ay += f[1] * k;
      az += f[2] * k;
    } else if (c.y < 0) {
      const k = fwdSpeed > 2 ? BRAKE : ACC * 0.4;
      ax += f[0] * k * c.y;
      ay += f[1] * k * c.y;
      az += f[2] * k * c.y;
    }
    ax += rx * STRAFE * c.x;
    az += rz * STRAFE * c.x;
    ay += CLIMB * c.z;
    this.vx += ax * dt;
    this.vy += ay * dt;
    this.vz += az * dt;

    // ---- anisotropic damping: carve through turns
    const vf = this.vx * f[0] + this.vy * f[1] + this.vz * f[2];
    let lx = this.vx - f[0] * vf;
    let ly = this.vy - f[1] * vf;
    let lz = this.vz - f[2] * vf;
    const kf = Math.exp(-DRAG_F * dt);
    const kl = Math.exp(-DRAG_LAT * dt);
    const kv = Math.exp(-DRAG_V * dt);
    lx *= kl;
    lz *= kl;
    ly *= c.z === 0 ? kv : kl;
    this.vx = f[0] * vf * kf + lx;
    this.vy = f[1] * vf * kf + ly;
    this.vz = f[2] * vf * kf + lz;
    let sp = Math.hypot(this.vx, this.vy, this.vz);
    const cap = c.boost ? MAX_SPEED : MAX_SPEED * 0.55;
    if (sp > cap) {
      const k = 1 - Math.min(1, dt * 1.5) * (1 - cap / sp);
      this.vx *= k;
      this.vy *= k;
      this.vz *= k;
      sp = Math.hypot(this.vx, this.vy, this.vz);
    }

    // ---- integrate with sub-steps and collision
    const steps = Math.max(1, Math.ceil((sp * dt) / 1.5));
    const p = { x: this.x, y: this.y, z: this.z };
    let hitDepth = 0;
    let hn: [number, number, number] | null = null;
    for (let i = 0; i < steps; i++) {
      p.x += (this.vx * dt) / steps;
      p.y += (this.vy * dt) / steps;
      p.z += (this.vz * dt) / steps;
      const h = this.world.resolveSphere(p, RADIUS, 1.2);
      if (h && h.depth > hitDepth) {
        hitDepth = h.depth;
        hn = [h.nx, h.ny, h.nz];
      }
    }
    if (p.y > this.ceiling) {
      p.y = this.ceiling;
      if (this.vy > 0) this.vy = 0;
    }
    if (hn) {
      const vn = this.vx * hn[0] + this.vy * hn[1] + this.vz * hn[2];
      if (vn < 0) {
        this.vx -= hn[0] * vn * 1.25;
        this.vy -= hn[1] * vn * 1.25;
        this.vz -= hn[2] * vn * 1.25;
        const impact = -vn;
        if (hn[1] < 0.9) {
          this.vx *= 0.82;
          this.vz *= 0.82;
        }
        this.trauma = Math.min(1, this.trauma + impact / 45);
        this.lastHit = impact;
      }
    }
    this.x = p.x;
    this.y = p.y;
    this.z = p.z;
    this.speed = Math.hypot(this.vx, this.vy, this.vz);

    // ---- visual attitude
    const rollTarget = Math.max(-0.85, Math.min(0.85, -this.yawRate * 0.42 * Math.min(1, this.speed / 30) + c.x * 0.32));
    this.roll += (rollTarget - this.roll) * Math.min(1, dt * 4);
    const vpTarget = this.pitch * 0.7 + Math.max(-0.3, Math.min(0.3, this.vy * 0.012));
    this.visPitch += (vpTarget - this.visPitch) * Math.min(1, dt * 5);
    this.throttleVis += ((c.y > 0 ? (c.boost ? 1 : 0.65) : 0.25) - this.throttleVis) * Math.min(1, dt * 3);
    this.braking += ((c.y < 0 ? 1 : 0) - this.braking) * Math.min(1, dt * 8);
    this.trauma = Math.max(0, this.trauma - dt * 0.9);
  }
}
