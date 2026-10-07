// @ts-nocheck -- TSL node graphs are dynamically typed.
/**
 * The procedural kit library and its instancing. Every small repeated thing in
 * the city (AC units, tanks, lamps, balcony slabs, fins, parapets, sign
 * backings, containers...) is one of a dozen meshes generated here, drawn as
 * instances of a plain Mesh with an InstancedBufferGeometry. Instance data is
 * four vec4s: position + yaw, scale + emissive gain, albedo + class/seed,
 * emissive colour + flicker mode. Static instances move only with the camera,
 * so TRAA's velocity stays correct without per-instance matrix copies.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  abs,
  attribute,
  cos,
  float,
  floor,
  fract,
  max,
  mix,
  normalize,
  positionGeometry,
  positionPrevious,
  normalGeometry,
  sin,
  smoothstep,
  step,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
  positionWorld,
  mrt,
  output,
} from 'three/tsl';
import { MeshBuilder, addBox, addCylinder, addSphere } from './geometry';
import { U, flicker, fogAtten, hash12, shade, vnoise } from './tsl';

export type KitGeom = 'box' | 'ac' | 'cyl' | 'tank' | 'dish' | 'fan' | 'lamp' | 'tree' | 'beacon' | 'cage' | 'container' | 'stack' | 'vent' | 'car';

/** Body classes for part 0 (encoded as the integer part of iC.w). */
export const CLS = { concrete: 0, metal: 1, glass: 2, corrugated: 3, foliage: 4, painted: 5, grille: 6, rust: 7, lightbox: 8, stone: 9, gold: 10, water: 11 } as const;

const PART = { body: 0, emit: 1, grille: 2, louver: 3, head: 4 };

function mb(): MeshBuilder {
  return new MeshBuilder({ aPart: 1 });
}
function part(b: MeshBuilder, p: number): void {
  b.set('aPart', p);
}

function geomBox(frontPart = PART.body): MeshBuilder {
  const b = mb();
  part(b, PART.body);
  // unit cube on the ground plane (y 0..1); front face +z may get another part
  addBox(b, 0, 0.5, 0, 1, 1, 1, 0);
  if (frontPart !== PART.body) {
    // overwrite the +z face part: it is the third face added by addBox (+x, -x, +z)
    const parts = b.cur('aPart');
    void parts;
  }
  return b;
}

function buildGeometries(): Record<KitGeom, THREE.BufferGeometry> {
  const out = {} as Record<KitGeom, THREE.BufferGeometry>;
  // box
  out.box = geomBox().build();
  // ac: cabinet + recessed grille plate on the front
  {
    const b = mb();
    part(b, PART.body);
    addBox(b, 0, 0.5, -0.04, 1, 1, 0.92, 0);
    part(b, PART.grille);
    addBox(b, 0, 0.5, 0.42, 0.86, 0.82, 0.04, 0);
    out.ac = b.build();
  }
  // cylinder
  {
    const b = mb();
    part(b, PART.body);
    addCylinder(b, 0, 0, 0, 1, 1, 1, 12, true);
    out.cyl = b.build();
  }
  // stack: chimney with two emissive bands near the top
  {
    const b = mb();
    part(b, PART.body);
    addCylinder(b, 0, 0, 0, 1, 0.92, 0.86, 12, false);
    part(b, PART.emit);
    addCylinder(b, 0, 0.86, 0, 0.93, 0.93, 0.025, 12, false);
    part(b, PART.body);
    addCylinder(b, 0, 0.885, 0, 0.92, 0.9, 0.09, 12, false);
    part(b, PART.emit);
    addCylinder(b, 0, 0.975, 0, 0.91, 0.91, 0.025, 12, true);
    out.stack = b.build();
  }
  // water tank on legs with a conical roof (unit radius, unit height)
  {
    const b = mb();
    part(b, PART.body);
    for (const [x, z] of [
      [0.6, 0.6],
      [-0.6, 0.6],
      [0.6, -0.6],
      [-0.6, -0.6],
    ] as const)
      addBox(b, x, 0.15, z, 0.08, 0.3, 0.08, 0);
    addCylinder(b, 0, 0.28, 0, 1, 1, 0.55, 14, false);
    addCylinder(b, 0, 0.83, 0, 1.04, 0.05, 0.17, 14, true);
    out.tank = b.build();
  }
  // dish: post + tilted bowl, facing +z
  {
    const b = mb();
    part(b, PART.body);
    addCylinder(b, 0, 0, 0, 0.06, 0.06, 0.7, 6, false);
    const bowl = mb();
    part(bowl, PART.body);
    addCylinder(bowl, 0, 0, 0, 0.08, 0.6, 0.22, 12, true);
    const g = bowl.build();
    g.rotateX(Math.PI / 2 - 0.6);
    g.translate(0, 0.85, 0.05);
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const base = b.vertexCount;
    for (let i = 0; i < pos.count; i++) b.vert(pos.getX(i), pos.getY(i), pos.getZ(i), nor.getX(i), nor.getY(i), nor.getZ(i), 0, 0);
    const idx = g.getIndex();
    for (let i = 0; i < idx.count; i += 3) b.tri(base + idx.getX(i), base + idx.getX(i + 1), base + idx.getX(i + 2));
    out.dish = b.build();
  }
  // fan unit: low box with a louvered round top
  {
    const b = mb();
    part(b, PART.body);
    addBox(b, 0, 0.35, 0, 1, 0.7, 1, 0);
    part(b, PART.louver);
    addCylinder(b, 0, 0.7, 0, 0.42, 0.42, 0.3, 14, true);
    out.fan = b.build();
  }
  // vent: louvered box
  {
    const b = mb();
    part(b, PART.louver);
    addBox(b, 0, 0.5, 0, 1, 1, 1, 0);
    out.vent = b.build();
  }
  // street lamp, authored 8 m tall: pole, arm toward +z, emissive head
  {
    const b = mb();
    part(b, PART.body);
    addCylinder(b, 0, 0, 0, 0.12, 0.08, 8, 8, false);
    addBox(b, 0, 7.9, 0.9, 0.1, 0.1, 1.9, 0);
    addBox(b, 0, 7.8, 1.8, 0.5, 0.2, 0.9, 0);
    part(b, PART.emit);
    addBox(b, 0, 7.68, 1.8, 0.42, 0.04, 0.8, 0);
    out.lamp = b.build();
  }
  // tree, authored 7 m tall: trunk + three blobs
  {
    const b = mb();
    part(b, PART.body);
    addCylinder(b, 0, 0, 0, 0.16, 0.1, 3.2, 6, false);
    part(b, PART.louver); // foliage uses the louver slot on trees (see material)
    addSphere(b, 0, 4.6, 0, 2.1, 1.7, 2.1, 7, 5);
    addSphere(b, 0.8, 5.6, 0.4, 1.3, 1.2, 1.3, 6, 4);
    addSphere(b, -0.7, 5.3, -0.5, 1.2, 1.1, 1.2, 6, 4);
    out.tree = b.build();
  }
  // beacon: small emissive sphere (radius 0.5)
  {
    const b = mb();
    part(b, PART.emit);
    addSphere(b, 0, 0.5, 0, 0.5, 0.5, 0.5, 6, 4);
    out.beacon = b.build();
  }
  // cage: open grille box (window cage)
  {
    const b = mb();
    part(b, PART.grille);
    addBox(b, 0, 0.5, 0, 1, 1, 1, 0, { skipBottom: false });
    out.cage = b.build();
  }
  // shipping container (corrugated walls via the material)
  {
    const b = mb();
    part(b, PART.louver);
    addBox(b, 0, 0.5, 0, 1, 1, 1, 0);
    out.container = b.build();
  }
  // flying car, 4.6 m long, nose toward +z: hull, cabin, tail light bar, head lights, thruster pods
  {
    const b = mb();
    part(b, PART.body);
    addBox(b, 0, 0.42, 0, 1.9, 0.55, 4.4, 0);
    addBox(b, 0, 0.82, -0.35, 1.4, 0.42, 2.2, 0);
    addBox(b, 0, 0.32, 2.05, 1.6, 0.36, 0.6, 0);
    for (const sx of [-1, 1]) addCylinder(b, sx * 1.05, 0.12, -1.3, 0.28, 0.28, 0.3, 8, true);
    part(b, PART.emit);
    addBox(b, 0, 0.5, -2.21, 1.7, 0.09, 0.04, 0);
    for (const sx of [-1, 1]) addCylinder(b, sx * 1.05, 0.08, -1.3, 0.22, 0.22, 0.05, 8, true);
    part(b, PART.head);
    for (const sx of [-1, 1]) addBox(b, sx * 0.62, 0.42, 2.36, 0.42, 0.1, 0.04, 0);
    out.car = b.build();
  }
  return out;
}

let GEOMS: Record<KitGeom, THREE.BufferGeometry> | null = null;
export function kitGeometries(): Record<KitGeom, THREE.BufferGeometry> {
  if (!GEOMS) GEOMS = buildGeometries();
  return GEOMS;
}

/** One instance as raw numbers. */
export interface Inst {
  x: number;
  y: number;
  z: number;
  rot: number;
  sx: number;
  sy: number;
  sz: number;
  emit: number;
  r: number;
  g: number;
  b: number;
  /** class + seed fraction. */
  cs: number;
  er: number;
  eg: number;
  eb: number;
  mode: number;
}

/** Draw-distance classes; small things vanish first. */
export type LodClass = 'tiny' | 'small' | 'mid' | 'big' | 'huge';
export const LOD_DIST: Record<LodClass, number> = { tiny: 420, small: 700, mid: 1300, big: 2400, huge: 6000 };

interface Group {
  geom: KitGeom;
  lod: LodClass;
  data: number[];
  count: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export class KitBatch {
  private readonly groups = new Map<string, Group>();
  constructor(private readonly chunk = 400) {}

  add(geom: KitGeom, lod: LodClass, i: Inst): void {
    const cx = Math.floor(i.x / this.chunk);
    const cz = Math.floor(i.z / this.chunk);
    const key = geom + '|' + lod + '|' + cx + '|' + cz;
    let g = this.groups.get(key);
    if (!g) {
      g = { geom, lod, data: [], count: 0, minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
      this.groups.set(key, g);
    }
    g.data.push(i.x, i.y, i.z, i.rot, i.sx, i.sy, i.sz, i.emit, i.r, i.g, i.b, i.cs, i.er, i.eg, i.eb, i.mode);
    g.count++;
    const ext = Math.max(Math.abs(i.sx), Math.abs(i.sz), 1) * (geom === 'lamp' || geom === 'tree' ? 3 : 1);
    g.minX = Math.min(g.minX, i.x - ext);
    g.maxX = Math.max(g.maxX, i.x + ext);
    g.minZ = Math.min(g.minZ, i.z - ext);
    g.maxZ = Math.max(g.maxZ, i.z + ext);
    g.minY = Math.min(g.minY, i.y);
    g.maxY = Math.max(g.maxY, i.y + Math.abs(i.sy) * (geom === 'lamp' ? 8 : geom === 'tree' ? 7 : 1));
  }

  get instanceCount(): number {
    let n = 0;
    for (const g of this.groups.values()) n += g.count;
    return n;
  }

  build(material: THREE.Material): { mesh: THREE.Mesh; lod: LodClass; cx: number; cz: number; r: number; tris: number }[] {
    const geoms = kitGeometries();
    const out: { mesh: THREE.Mesh; lod: LodClass; cx: number; cz: number; r: number; tris: number }[] = [];
    for (const g of this.groups.values()) {
      const base = geoms[g.geom];
      const ig = new THREE.InstancedBufferGeometry();
      ig.index = base.index;
      for (const name of ['position', 'normal', 'uv', 'aPart']) ig.setAttribute(name, base.getAttribute(name));
      const arr = new Float32Array(g.data);
      const ib = new THREE.InstancedInterleavedBuffer(arr, 16, 1);
      ig.setAttribute('iA', new THREE.InterleavedBufferAttribute(ib, 4, 0));
      ig.setAttribute('iB', new THREE.InterleavedBufferAttribute(ib, 4, 4));
      ig.setAttribute('iC', new THREE.InterleavedBufferAttribute(ib, 4, 8));
      ig.setAttribute('iD', new THREE.InterleavedBufferAttribute(ib, 4, 12));
      ig.instanceCount = g.count;
      const cx = (g.minX + g.maxX) / 2;
      const cy = (g.minY + g.maxY) / 2;
      const cz = (g.minZ + g.maxZ) / 2;
      const r = Math.hypot(g.maxX - g.minX, g.maxY - g.minY, g.maxZ - g.minZ) / 2 + 2;
      ig.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), r);
      ig.boundingBox = new THREE.Box3(new THREE.Vector3(g.minX, g.minY, g.minZ), new THREE.Vector3(g.maxX, g.maxY, g.maxZ));
      const mesh = new THREE.Mesh(ig, material);
      mesh.matrixAutoUpdate = false;
      mesh.name = 'kit:' + g.geom + ':' + g.lod;
      out.push({ mesh, lod: g.lod, cx, cz, r, tris: ((base.index ? base.index.count : 0) / 3) * g.count });
    }
    return out;
  }
}

/**
 * The shared material for every kit instance. `moving` instances also carry
 * their previous pose (iP) so TRAA gets true motion vectors.
 */
export function makeKitMaterial(moving = false): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = moving ? 'kits-moving' : 'kits';
  m.fog = false;
  const iA = attribute('iA', 'vec4');
  const iB = attribute('iB', 'vec4');
  const place = (pos, A, Bs) => {
    const p = pos.mul(Bs);
    const c = cos(A.w);
    const s = sin(A.w);
    // local +z maps to (sin, cos): x' = x c + z s, z' = -x s + z c
    return vec3(p.x.mul(c).add(p.z.mul(s)), p.y, p.x.negate().mul(s).add(p.z.mul(c))).add(A.xyz);
  };
  // object (= world) position: scale, yaw, translate
  m.positionNode = Fn(() => {
    const p = place(positionGeometry, iA, iB.xyz);
    // the velocity pass needs the previous position in the same space
    positionPrevious.assign(moving ? place(positionGeometry, attribute('iP', 'vec4'), iB.xyz) : p);
    return p;
  })();
  const nWorld = varying(
    Fn(() => {
      const n = normalGeometry.div(max(abs(iB.xyz), vec3(0.0001)));
      const c = cos(iA.w);
      const s = sin(iA.w);
      return normalize(vec3(n.x.mul(c).add(n.z.mul(s)), n.y, n.x.negate().mul(s).add(n.z.mul(c))));
    })(),
    'vKitN',
  );
  const nLocal = varying(normalGeometry, 'vKitNL');
  const vPart = varying(attribute('aPart', 'float'), 'vKitPart');
  const vB = varying(iB, 'vKitB');
  const vC = varying(attribute('iC', 'vec4'), 'vKitC');
  const vD = varying(attribute('iD', 'vec4'), 'vKitD');
  const vLoc = varying(positionGeometry, 'vKitL');

  const col = Fn(() => {
    const n = normalize(nWorld);
    const wp = positionWorld;
    const cls = floor(vC.w);
    const seed = fract(vC.w);
    const partId = floor(vPart.add(0.5));
    const alb = vC.rgb.toVar();
    const spec = float(0.08).toVar();
    const rough = float(0.8).toVar();
    // per-instance tonal variation
    alb.mulAssign(mix(0.82, 1.15, hash12(vec2(seed.mul(91.0), seed.mul(7.1)))));
    // body classes
    const grain = vnoise(wp.xz.mul(1.7).add(wp.y.mul(0.9))).mul(0.25).add(0.87);
    alb.mulAssign(grain);
    // metal: brighter spec
    spec.assign(mix(spec, float(0.6), step(0.5, cls).mul(step(cls, 1.5))));
    rough.assign(mix(rough, float(0.4), step(0.5, cls).mul(step(cls, 1.5))));
    // glass railing: dark, reflective
    const isGlass = step(1.5, cls).mul(step(cls, 2.5));
    alb.assign(mix(alb, alb.mul(0.25), isGlass));
    spec.assign(mix(spec, float(0.9), isGlass));
    rough.assign(mix(rough, float(0.15), isGlass));
    // corrugated / louvered surfaces: ribs across the local x or y
    const isLouver = step(2.5, partId).mul(step(partId, 3.5)).add(step(2.5, cls).mul(step(cls, 3.5))).min(1.0);
    const rib = fract(vLoc.x.mul(9.0).add(vLoc.z.mul(9.0))).sub(0.5).abs().mul(2.0);
    const louv = fract(vLoc.y.mul(14.0)).sub(0.5).abs().mul(2.0);
    const ribs = mix(rib, louv, step(0.6, abs(nLocal.x).max(abs(nLocal.z))).mul(step(cls, 2.5)));
    alb.assign(mix(alb, alb.mul(mix(0.55, 1.1, ribs)), isLouver));
    // foliage (trees use the louver part with class foliage)
    const isLeaf = step(3.5, cls).mul(step(cls, 4.5)).mul(step(2.5, partId));
    const leaf = vnoise(wp.xz.mul(2.3).add(wp.y.mul(1.7)));
    alb.assign(mix(alb, vC.rgb.mul(mix(0.5, 1.4, leaf)), isLeaf));
    // grille: dark mesh with bright wires
    const isGrille = step(1.5, partId).mul(step(partId, 2.5)).add(step(5.5, cls).mul(step(cls, 6.5))).min(1.0);
    const g2 = uv().mul(vec2(12.0, 9.0));
    const wire = max(smoothstep(0.82, 0.95, abs(fract(g2.x).sub(0.5)).mul(2.0)), smoothstep(0.82, 0.95, abs(fract(g2.y).sub(0.5)).mul(2.0)));
    alb.assign(mix(alb, mix(vec3(0.015), vC.rgb.mul(1.2), wire), isGrille));
    // rust streaks on rust class
    const isRust = step(6.5, cls).mul(step(cls, 7.5));
    const streak = vnoise(vec2(wp.x.mul(2.0).add(wp.z.mul(2.0)), wp.y.mul(0.15)));
    alb.assign(mix(alb, mix(alb, vec3(0.16, 0.06, 0.02), streak), isRust));
    // gold
    const isGold = step(9.5, cls).mul(step(cls, 10.5));
    spec.assign(mix(spec, float(0.85), isGold));
    rough.assign(mix(rough, float(0.3), isGold));
    // grime toward the bottom of tall things
    const lit = shade(alb, n, wp, spec, rough);
    // emissive
    const isEmit = step(0.5, partId).mul(step(partId, 1.5)).add(step(7.5, cls).mul(step(cls, 8.5)).mul(step(partId, 0.5))).add(step(10.5, cls).mul(step(cls, 11.5))).min(1.0);
    const isHead = step(3.5, partId).mul(step(partId, 4.5));
    const fl = flicker(seed.mul(13.0), vD.w);
    // lamp heads take the lamp's own colour (sodium, white, pink) rather than plain white
    const headC = vD.rgb.mul(0.75).add(vec3(0.25, 0.23, 0.2));
    const e = vD.rgb.mul(vB.w).mul(fl).mul(isEmit).add(headC.mul(isHead).mul(vB.w.max(1.5).mul(0.75))).mul(U.neon);
    // lightbox faces: soft gradient so panels read as backlit acrylic
    const lb = step(7.5, cls).mul(step(cls, 8.5));
    const lbShade = mix(1.0, smoothstep(0.0, 0.5, uv().y).mul(0.35).add(0.75), lb);
    return vec4(lit.add(e.mul(lbShade)), 1.0);
  })();
  m.colorNode = col;
  // glow MRT slot stays zero for opaque kits
  void mrt;
  void output;
  void fogAtten;
  return m;
}
