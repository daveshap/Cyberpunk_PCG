/**
 * Guided flight: a random tour along the arterial canyons (they are open
 * space by construction), turning at junctions, changing altitude between
 * street level and the tower tops, with pure-pursuit steering.
 */
import type { CitySpec, Street } from '../core/types';
import type { FlightWorld } from '../core/collision';
import type { Flight, FlightControls } from './flight';

interface Node {
  i: number;
  j: number;
  x: number;
  z: number;
}

export class Autopilot {
  private readonly xs: number[];
  private readonly zs: number[];
  private readonly segX = new Set<string>();
  private readonly segZ = new Set<string>();
  private path: [number, number, number][] = [];
  private cur: Node | null = null;
  private prev: Node | null = null;
  private seed = 12345;
  private seg = 0;
  targetSpeed = 52;

  constructor(
    private readonly spec: CitySpec,
    private readonly world: FlightWorld,
  ) {
    const art = spec.streets.filter((s) => s.kind === 'arterial' || s.kind === 'highway');
    this.xs = [...new Set(art.filter((s) => s.axis === 'z').map((s) => s.pos))].sort((a, b) => a - b);
    this.zs = [...new Set(art.filter((s) => s.axis === 'x').map((s) => s.pos))].sort((a, b) => a - b);
    const covers = (s: Street, a: number, b: number): boolean => s.lo <= Math.min(a, b) + 1 && s.hi >= Math.max(a, b) - 1;
    for (let j = 0; j < this.zs.length; j++)
      for (let i = 0; i < this.xs.length - 1; i++) {
        const z = this.zs[j]!;
        if (art.some((s) => s.axis === 'x' && Math.abs(s.pos - z) < 0.5 && covers(s, this.xs[i]!, this.xs[i + 1]!))) this.segX.add(i + ':' + j);
      }
    for (let i = 0; i < this.xs.length; i++)
      for (let j = 0; j < this.zs.length - 1; j++) {
        const x = this.xs[i]!;
        if (art.some((s) => s.axis === 'z' && Math.abs(s.pos - x) < 0.5 && covers(s, this.zs[j]!, this.zs[j + 1]!))) this.segZ.add(i + ':' + j);
      }
  }

  private rnd(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  private neighbours(n: Node): Node[] {
    const out: Node[] = [];
    const add = (i: number, j: number): void => {
      if (i < 0 || j < 0 || i >= this.xs.length || j >= this.zs.length) return;
      out.push({ i, j, x: this.xs[i]!, z: this.zs[j]! });
    };
    if (this.segX.has(n.i + ':' + n.j)) add(n.i + 1, n.j);
    if (this.segX.has(n.i - 1 + ':' + n.j)) add(n.i - 1, n.j);
    if (this.segZ.has(n.i + ':' + n.j)) add(n.i, n.j + 1);
    if (this.segZ.has(n.i + ':' + (n.j - 1))) add(n.i, n.j - 1);
    return out;
  }

  /** Start a tour from the junction nearest to (x, z). */
  start(f: Flight): void {
    let best: Node | null = null;
    let bd = Infinity;
    for (let i = 0; i < this.xs.length; i++)
      for (let j = 0; j < this.zs.length; j++) {
        const n = { i, j, x: this.xs[i]!, z: this.zs[j]! };
        if (this.neighbours(n).length === 0) continue;
        const d = Math.hypot(n.x - f.x, n.z - f.z);
        if (d < bd) {
          bd = d;
          best = n;
        }
      }
    this.cur = best;
    this.prev = null;
    this.path = best ? [[best.x, Math.max(this.nearMetro(best.x, best.z) ? 50 : 40, Math.min(110, f.y)), best.z]] : [];
    this.seg = 0;
    this.extend(8);
  }

  /** True near the metro viaduct (its deck sits at ~32-35 m over the arterials). */
  private nearMetro(x: number, z: number): boolean {
    for (const m of this.spec.transit?.metro ?? []) {
      const { x0, x1, z0, z1 } = m.rect;
      const pad = 22;
      const inX = x > x0 - pad && x < x1 + pad;
      const inZ = z > z0 - pad && z < z1 + pad;
      if (inX && (Math.abs(z - z0) < pad || Math.abs(z - z1) < pad)) return true;
      if (inZ && (Math.abs(x - x0) < pad || Math.abs(x - x1) < pad)) return true;
    }
    return false;
  }

  private altitudeFor(x: number, z: number): number {
    const tall = this.world.heightAround(x, z, 60);
    const r = this.rnd();
    // the hive: cruise one of its traffic levels (bridges keep clear of them), from the
    // dark lower canyons to high among the towers
    if (this.spec.dials.world === 'hive') return [120, 185, 260, 350, 460, 590, 740][Math.floor(r * 7)] as number;
    // usually canyon level, sometimes skim the tower tops; always over the metro
    if (r < 0.2) return Math.min(260, Math.max(90, tall * 0.7));
    const y = 28 + r * 70;
    return this.nearMetro(x, z) ? Math.max(y, 50) : y;
  }

  private extend(n: number): void {
    for (let k = 0; k < n && this.cur; k++) {
      const nb = this.neighbours(this.cur).filter((m) => !this.prev || m.i !== this.prev.i || m.j !== this.prev.j);
      if (nb.length === 0) break;
      // prefer going straight
      let next = nb[Math.floor(this.rnd() * nb.length)]!;
      if (this.prev) {
        const di = this.cur.i - this.prev.i;
        const dj = this.cur.j - this.prev.j;
        const straight = nb.find((m) => m.i - this.cur!.i === di && m.j - this.cur!.j === dj);
        if (straight && this.rnd() < 0.55) next = straight;
      }
      const y = this.altitudeFor(next.x, next.z);
      // intermediate point at mid-block so altitude changes happen between junctions
      const last = this.path[this.path.length - 1]!;
      this.path.push([(last[0] + next.x) / 2, (last[1] + y) / 2, (last[2] + next.z) / 2]);
      this.path.push([next.x, y, next.z]);
      this.prev = this.cur;
      this.cur = next;
    }
  }

  /** Writes controls that fly the car along the path. */
  drive(f: Flight, dt: number, out: FlightControls): void {
    if (this.path.length < 2) {
      this.start(f);
      if (this.path.length < 2) return;
    }
    // advance the segment pointer to the closest upcoming segment
    while (this.seg < this.path.length - 2) {
      const b = this.path[this.seg + 1]!;
      if (Math.hypot(b[0] - f.x, b[2] - f.z) < 35) this.seg++;
      else break;
    }
    if (this.path.length - this.seg < 8) this.extend(6);
    if (this.seg > 40) {
      this.path.splice(0, this.seg);
      this.seg = 0;
    }
    // look-ahead target along the polyline
    const L = Math.max(30, Math.min(110, f.speed * 1.3));
    let remain = L;
    let tx = f.x;
    let ty = f.y;
    let tz = f.z;
    let px = f.x;
    let py = f.y;
    let pz = f.z;
    for (let i = this.seg + 1; i < this.path.length; i++) {
      const q = this.path[i]!;
      const d = Math.hypot(q[0] - px, q[1] - py, q[2] - pz);
      if (d >= remain) {
        const t = remain / Math.max(d, 1e-3);
        tx = px + (q[0] - px) * t;
        ty = py + (q[1] - py) * t;
        tz = pz + (q[2] - pz) * t;
        remain = 0;
        break;
      }
      remain -= d;
      px = q[0];
      py = q[1];
      pz = q[2];
      tx = px;
      ty = py;
      tz = pz;
    }
    const dx = tx - f.x;
    const dy = ty - f.y;
    const dz = tz - f.z;
    const hd = Math.hypot(dx, dz);
    const wantYaw = Math.atan2(-dx, -dz);
    const wantPitch = Math.atan2(dy, Math.max(hd, 1));
    let d = wantYaw - f.aimYaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    f.aimYaw += d * Math.min(1, dt * 2.2);
    f.aimPitch += (Math.max(-0.5, Math.min(0.5, wantPitch)) - f.aimPitch) * Math.min(1, dt * 2.2);
    // slow into sharp turns
    const turnAhead = Math.abs(d);
    const target = this.targetSpeed * (1 - Math.min(0.55, turnAhead * 0.6));
    out.x = 0;
    out.z = Math.max(-1, Math.min(1, (ty - f.y) * 0.05));
    out.y = f.speed < target ? 1 : f.speed > target + 8 ? -0.4 : 0;
    out.boost = false;
    out.lookX = 0;
    out.lookY = 0;
  }
}
