/**
 * Emitters for neon geometry. A neon tube (or a glow halo) is a padded quad that
 * carries its own local coordinates; the fragment shader turns them into a
 * capsule distance field (see matprops.ts), so every stroke is one quad.
 */
import { MeshBuilder } from './geometry';

export const TUBE_EXTRAS = { aT: 3, aW: 4, aCol: 3 };

export function makeTubeBuilder(): MeshBuilder {
  return new MeshBuilder(TUBE_EXTRAS, { uv: false, normals: false });
}

export type RGB = readonly [number, number, number];

/**
 * Padded quad around the capsule a->b lying in the plane with unit normal n.
 * `radius` is the tube core radius (tubes) or the glow radius (halos); the quad
 * extends `radius * padK` beyond the axis on every side.
 */
export function addCapsule(
  b: MeshBuilder,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  nx: number,
  ny: number,
  nz: number,
  radius: number,
  gain: number,
  col: RGB,
  phase: number,
  mode: number,
  padK = 6,
): void {
  let ex = bx - ax;
  let ey = by - ay;
  let ez = bz - az;
  const L = Math.hypot(ex, ey, ez);
  if (L > 1e-6) {
    ex /= L;
    ey /= L;
    ez /= L;
  } else if (Math.abs(ny) < 0.9) {
    const l = Math.hypot(nz, nx) || 1;
    ex = -nz / l;
    ey = 0;
    ez = nx / l;
  } else {
    ex = 1;
    ey = 0;
    ez = 0;
  }
  // in-plane perpendicular: n x e
  let sx = ny * ez - nz * ey;
  let sy = nz * ex - nx * ez;
  let sz = nx * ey - ny * ex;
  const sl = Math.hypot(sx, sy, sz) || 1;
  sx /= sl;
  sy /= sl;
  sz /= sl;
  const pad = radius * padK;
  b.set('aW', radius, gain, phase, mode);
  b.set('aCol', col[0], col[1], col[2]);
  const v = (along: number, across: number): number => {
    b.set('aT', along, across, L);
    return b.vert(ax + ex * along + sx * across, ay + ey * along + sy * across, az + ez * along + sz * across, 0, 0, 0);
  };
  const p0 = v(-pad, -pad);
  const p1 = v(L + pad, -pad);
  const p2 = v(L + pad, pad);
  const p3 = v(-pad, pad);
  b.quad(p0, p1, p2, p3);
}

/** A glowing point visible from every direction: three perpendicular quads. */
export function addPointGlow(b: MeshBuilder, x: number, y: number, z: number, radius: number, gain: number, col: RGB, phase: number, mode: number, padK = 6): void {
  addCapsule(b, x, y, z, x, y, z, 1, 0, 0, radius, gain, col, phase, mode, padK);
  addCapsule(b, x, y, z, x, y, z, 0, 1, 0, radius, gain, col, phase, mode, padK);
  addCapsule(b, x, y, z, x, y, z, 0, 0, 1, radius, gain, col, phase, mode, padK);
}

/** A tube in free 3D space: two crossed quads so it reads from any side. */
export function addLine3D(b: MeshBuilder, ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number, gain: number, col: RGB, phase: number, mode: number, padK = 6): void {
  let ex = bx - ax;
  let ey = by - ay;
  let ez = bz - az;
  const L = Math.hypot(ex, ey, ez) || 1;
  ex /= L;
  ey /= L;
  ez /= L;
  // n1: any unit vector perpendicular to e
  let n1x: number;
  let n1y: number;
  let n1z: number;
  if (Math.abs(ey) < 0.9) {
    // e x up
    n1x = ey * 0 - ez * 1;
    n1y = ez * 0 - ex * 0;
    n1z = ex * 1 - ey * 0;
  } else {
    n1x = 1;
    n1y = 0;
    n1z = 0;
  }
  const l1 = Math.hypot(n1x, n1y, n1z) || 1;
  n1x /= l1;
  n1y /= l1;
  n1z /= l1;
  const n2x = ey * n1z - ez * n1y;
  const n2y = ez * n1x - ex * n1z;
  const n2z = ex * n1y - ey * n1x;
  addCapsule(b, ax, ay, az, bx, by, bz, n1x, n1y, n1z, radius, gain, col, phase, mode, padK);
  addCapsule(b, ax, ay, az, bx, by, bz, n2x, n2y, n2z, radius, gain, col, phase, mode, padK);
}
