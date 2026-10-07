/**
 * Assembles a CitySpec into renderable meshes.
 *  - merged geometry per (480 m chunk, category): walls, roofs, roads, plates,
 *    props, neon tubes, halos, glyphs, ink, screens, holograms, steam,
 *  - instanced kits per (480 m chunk, kit mesh, draw-distance class),
 *  - land, sea, seawall, traffic, rain and searchlights.
 * Materials are created once and shared by every rebuild.
 */
import * as THREE from 'three/webgpu';
import type { Building, CitySpec, District, Emitter, KitInstance, Tier } from '../core/types';
import type { OutskirtBuilding } from '../core/outskirts';
import { rectPoly } from '../core/geom2d';
import { PROFILES } from '../core/profiles';
import { MeshBuilder, addRoofCap, addSlopedWall, addWall, addBox } from './geometry';
import { FACADE_EXTRAS, STYLE_ID, makeFacadeMaterial, makeRoofMaterial } from './facade';
import { PLATE_EXTRAS, ROAD_EXTRAS, addPlate, addRoadPiece, buildLandAndSea, makeLandMaterial, makePlateMaterial, makeRoadMaterial, makeSeawallMaterial, makeWaterMaterial } from './ground';
import { CLS, KitBatch, LOD_DIST, makeKitMaterial, type Inst, type KitGeom, type LodClass } from './kits';
import { TUBE_EXTRAS } from './neon';
import { GLYPH_EXTRAS, SCREEN_EXTRAS, addSign } from './signs';
import { PROP2_EXTRAS, addHighway, addRelief, addStructure, highwayEmitters, makePropMaterial } from './structures';
import { makeBeamMaterial, makeGlyphMaterial, makeHaloMaterial, makeHoloMaterial, makeInkMaterial, makeScreenMaterial, makeSteamMaterial, makeTubeMaterial } from './neonmats';
import { bakeLights } from './lightvolume';
import { bakeLocalLights, updateHalos } from './locallights';
import { U } from './tsl';
import { Traffic } from './traffic';
import { MetroTrains, addMetro } from './metro';
import { buildSpectacle } from './spectacle';
import { FlyersRender } from './flyers';
import { Rain } from './rain';
import { createSky } from './sky';
import { PROMENADE_H, buildCityLights, promenade, type CityLights } from './lights';

const CHUNK = 480;

type Cat = 'wall' | 'roof' | 'road' | 'plate' | 'prop' | 'tube' | 'halo' | 'glyph' | 'ink' | 'screen' | 'holo' | 'steam';

const ROOF_EXTRAS = { aR: 4, aRc: 4, aRb: 4 };
const STEAM_EXTRAS = { aS: 4 };

const SPEC: Record<Cat, { extras: Record<string, number>; uv?: boolean; normals?: boolean; cull: number; order: number }> = {
  wall: { extras: FACADE_EXTRAS, cull: Infinity, order: 0 },
  roof: { extras: ROOF_EXTRAS, cull: Infinity, order: 0 },
  road: { extras: ROAD_EXTRAS, cull: 2600, order: 0 },
  plate: { extras: PLATE_EXTRAS, cull: 2600, order: 0 },
  prop: { extras: PROP2_EXTRAS, cull: 1500, order: 0 },
  screen: { extras: SCREEN_EXTRAS, cull: 3500, order: 0 },
  ink: { extras: GLYPH_EXTRAS, normals: false, cull: 900, order: 1 },
  steam: { extras: STEAM_EXTRAS, cull: 900, order: 2 },
  halo: { extras: TUBE_EXTRAS, uv: false, normals: false, cull: 2600, order: 3 },
  holo: { extras: SCREEN_EXTRAS, cull: 3000, order: 4 },
  glyph: { extras: GLYPH_EXTRAS, normals: false, cull: 1800, order: 5 },
  tube: { extras: TUBE_EXTRAS, uv: false, normals: false, cull: 1600, order: 5 },
};

interface Shared {
  mats: Record<Cat | 'kit' | 'land' | 'water' | 'seawall' | 'beam', THREE.Material>;
  sky: THREE.Mesh;
}
let SHARED: Shared | null = null;
function shared(): Shared {
  if (SHARED) return SHARED;
  const mats = {
    wall: makeFacadeMaterial(),
    roof: makeRoofMaterial(),
    road: makeRoadMaterial(),
    plate: makePlateMaterial(),
    prop: makePropMaterial(),
    screen: makeScreenMaterial(),
    ink: makeInkMaterial(),
    steam: makeSteamMaterial(),
    halo: makeHaloMaterial(),
    holo: makeHoloMaterial(),
    glyph: makeGlyphMaterial(),
    tube: makeTubeMaterial(),
    kit: makeKitMaterial(false),
    land: makeLandMaterial(),
    water: makeWaterMaterial(),
    seawall: makeSeawallMaterial(),
    beam: makeBeamMaterial(),
  } as Shared['mats'];
  SHARED = { mats, sky: createSky() };
  return SHARED;
}

class Chunks {
  private readonly map = new Map<string, Map<Cat, MeshBuilder>>();
  constructor(private readonly size = CHUNK) {}
  get(cat: Cat, x: number, z: number): MeshBuilder {
    const k = Math.floor(x / this.size) + ':' + Math.floor(z / this.size);
    let c = this.map.get(k);
    if (!c) {
      c = new Map();
      this.map.set(k, c);
    }
    let b = c.get(cat);
    if (!b) {
      const s = SPEC[cat];
      b = new MeshBuilder(s.extras, { uv: s.uv ?? true, normals: s.normals ?? true });
      c.set(cat, b);
    }
    return b;
  }
  *all(): Generator<[Cat, MeshBuilder]> {
    for (const c of this.map.values()) for (const e of c) yield e;
  }
}

const ROOF_CODE: Record<string, number> = { flat: 0, helipad: 1, garden: 2, crown: 3 };

const MEDIA_CODE: Record<string, number> = { outline: 1, show: 2 };

function addWalls(b: Building, B: MeshBuilder): void {
  for (const t of b.tiers) {
    const f = t.facade;
    const media = MEDIA_CODE[f.media ?? ''] ?? 0;
    B.set('aF0', STYLE_ID[f.style], f.floorH, f.bayW, f.win);
    B.set('aF1', f.lit, f.warm, f.grime, f.seed);
    B.set('aF2', f.base[0], f.base[1], f.base[2], f.strips);
    const n = t.poly.length;
    for (let i = 0; i < n; i++) {
      const a = t.poly[i]!;
      const q = t.poly[(i + 1) % n]!;
      const len = Math.hypot(q[0] - a[0], q[1] - a[1]);
      if (len < 0.05) continue;
      const nx = (q[1] - a[1]) / len;
      const nz = -(q[0] - a[0]) / len;
      B.set('aF3', f.accent[0], f.accent[1], f.accent[2], len);
      if (t.top) {
        // sloped wall: the taper (along-edge inset per metre) lets corner lights follow the slope
        const a2 = t.top[i]!;
        const q2 = t.top[(i + 1) % n]!;
        const insA = (a2[0] - a[0]) * (-nz) + (a2[1] - a[1]) * nx;
        const insB = len - ((q2[0] - a[0]) * (-nz) + (q2[1] - a[1]) * nx);
        B.set('aF4', 0, t.y1 - t.y0, (insA + insB) / 2 / Math.max(1e-3, t.y1 - t.y0), media);
        addSlopedWall(B, a, q, a2, q2, t.y0, t.y1, nx, nz);
      } else {
        B.set('aF4', t.shopEdges.includes(i) ? t.shopH : 0, t.y1 - t.y0, 0, media);
        addWall(B, a[0], a[1], q[0], q[1], t.y0, t.y1, nx, nz, t.y0);
      }
    }
  }
}

function capFrame(poly: readonly [number, number][]): [number, number, number] {
  const xs = poly.map((p) => p[0]);
  const zs = poly.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  const half = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) / 2;
  return [cx, cz, half];
}

function addRoofs(b: Building, B: MeshBuilder): void {
  for (const t of b.tiers) {
    const f = t.facade;
    const cap = t.top ?? t.poly;
    const [cx, cz, half] = capFrame(cap);
    const bright = f.style === 'glass' || f.style === 'panel' ? 0.7 : 1.0;
    if (half > 0.05) {
      B.set('aR', ROOF_CODE[t.roof] ?? 0, f.grime, f.seed, half);
      B.set('aRc', f.accent[0], f.accent[1], f.accent[2], f.strips);
      B.set('aRb', cx, cz, half, bright);
      addRoofCap(B, cap, t.y1);
    }
    if (t.under) {
      // lit soffit under an overhang: edge light line and a grid of downlights
      const [ux, uz, uh] = capFrame(t.poly);
      B.set('aR', 4, f.grime, f.seed, uh);
      B.set('aRc', f.accent[0], f.accent[1], f.accent[2], Math.max(0.35, f.strips));
      B.set('aRb', ux, uz, uh, bright);
      addRoofCap(B, t.poly, t.y0, true);
    }
  }
}

/** An outskirts block: four walls and a flat roof with the shared facade and roof materials. */
function addOutskirt(o: OutskirtBuilding, W: MeshBuilder, R: MeshBuilder): void {
  const poly = rectPoly(o.rect);
  W.set('aF0', STYLE_ID[o.style], o.floorH, o.bayW, o.win);
  W.set('aF1', o.lit, o.warm, o.grime, o.seed);
  W.set('aF2', o.base[0], o.base[1], o.base[2], o.strips);
  for (let i = 0; i < 4; i++) {
    const a = poly[i]!;
    const q = poly[(i + 1) % 4]!;
    const len = Math.hypot(q[0] - a[0], q[1] - a[1]);
    W.set('aF3', o.accent[0], o.accent[1], o.accent[2], len);
    W.set('aF4', 0, o.h, 0, 0);
    addWall(W, a[0], a[1], q[0], q[1], 0, o.h, (q[1] - a[1]) / len, -(q[0] - a[0]) / len, 0);
  }
  const cx = (o.rect.x0 + o.rect.x1) / 2;
  const cz = (o.rect.z0 + o.rect.z1) / 2;
  const half = Math.min(o.rect.x1 - o.rect.x0, o.rect.z1 - o.rect.z0) / 2;
  R.set('aR', 0, o.grime, o.seed, half);
  R.set('aRc', o.accent[0], o.accent[1], o.accent[2], o.strips);
  R.set('aRb', cx, cz, half, 0.85);
  addRoofCap(R, poly, o.h);
}

/** Steam plume loft (see the steam material). */
function addPlume(B: MeshBuilder, x: number, y0: number, z: number, height: number, r0: number, r1: number, phase: number): void {
  const SEG = 10;
  const RINGS = 6;
  B.set('aS', phase, height, r0, r1);
  const ids: number[][] = [];
  for (let j = 0; j <= RINGS; j++) {
    const v = j / RINGS;
    const r = r0 + (r1 - r0) * Math.pow(v, 0.75);
    const y = y0 + height * v;
    const row: number[] = [];
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      row.push(B.vert(x + Math.cos(a) * r, y, z + Math.sin(a) * r, Math.cos(a), 0.15, Math.sin(a), i / SEG, v));
    }
    ids.push(row);
  }
  for (let j = 0; j < RINGS; j++)
    for (let i = 0; i < SEG; i++) {
      const i1 = (i + 1) % SEG;
      B.quad(ids[j]![i1]!, ids[j]![i]!, ids[j + 1]![i]!, ids[j + 1]![i1]!);
    }
}

/** Spec kit instance -> kit mesh, draw distance and instance data. */
function convertKit(k: KitInstance): [KitGeom, LodClass, Inst] | null {
  const base = (geom: KitGeom, lod: LodClass, sx: number, sy: number, sz: number, cls: number, extra: Partial<Inst> = {}): [KitGeom, LodClass, Inst] => [
    geom,
    lod,
    { x: k.x, y: k.y, z: k.z, rot: k.rot, sx, sy, sz, emit: k.emit, r: k.col[0], g: k.col[1], b: k.col[2], cs: cls + (k.seed % 1) * 0.999, er: 0, eg: 0, eb: 0, mode: 0, ...extra },
  ];
  switch (k.kind) {
    case 'ac':
      return base('ac', 'tiny', k.sx, k.sy, k.sz, CLS.painted);
    case 'cage':
      return base('cage', 'tiny', k.sx, k.sy, k.sz, CLS.grille, { y: k.y - k.sy / 2 });
    case 'dish':
      return base('dish', 'small', k.sx, k.sx, k.sx, CLS.metal);
    case 'antenna':
      return base('cyl', k.sy > 20 ? 'big' : 'mid', k.sx, k.sy, k.sx, CLS.metal);
    case 'tank':
      return k.sx > 4 ? base('cyl', 'huge', k.sx, k.sy, k.sx, CLS.metal) : base('tank', 'small', k.sx, k.sy, k.sx, CLS.rust);
    case 'vent':
      return base('vent', 'small', k.sx, k.sy, k.sz, CLS.metal);
    case 'fan':
      return base('fan', 'small', k.sx, k.sy, k.sz, CLS.metal);
    case 'pipeV':
      return base('cyl', 'small', k.sx, k.sy, k.sx, CLS.rust);
    case 'box':
      return base('box', 'small', k.sx, k.sy, k.sz, CLS.concrete);
    case 'container':
      return base('container', 'mid', k.sx, k.sy, k.sz, CLS.corrugated, { rot: k.rot + Math.PI / 2 });
    case 'stack':
      return base('stack', 'huge', k.sx, k.sy, k.sx, CLS.concrete, { emit: 4, er: 1, eg: 0.08, eb: 0.05, mode: 4 });
    case 'lamp': {
      const s = k.sy / 8;
      return base('lamp', 'mid', s, s, s, CLS.metal, { r: 0.13, g: 0.13, b: 0.14, emit: Math.max(2.5, k.emit), er: k.col[0], eg: k.col[1], eb: k.col[2] });
    }
    case 'tree': {
      const s = k.sy / 7;
      return base('tree', 'small', s, s, s, CLS.foliage);
    }
    case 'barrel':
      return base('cyl', 'tiny', k.sx, k.sy, k.sx, CLS.rust);
    case 'planter':
      return base('box', 'tiny', k.sx, k.sy, k.sz, CLS.foliage);
    case 'beacon':
      return base('beacon', 'big', k.sx * 2, k.sx * 2, k.sx * 2, CLS.concrete, { emit: k.emit, er: k.col[0], eg: k.col[1], eb: k.col[2], mode: 4 });
    default:
      return base('box', 'small', k.sx, k.sy, k.sz, CLS.concrete);
  }
}

export interface CityRender {
  root: THREE.Group;
  sky: THREE.Mesh;
  rain: Rain;
  traffic: Traffic;
  flyers: FlyersRender;
  lights: CityLights;
  update(camera: THREE.Camera, dt: number): void;
  dispose(): void;
  stats: { meshes: number; triangles: number; instances: number; buildMs: number; bakeMs: number; localLights: number };
}

interface CullEntry {
  mesh: THREE.Object3D;
  cx: number;
  cz: number;
  r: number;
  max: number;
}

export function buildCityRender(spec: CitySpec): CityRender {
  const t0 = performance.now();
  const root = new THREE.Group();
  root.name = 'city';
  const { mats, sky } = shared();

  // ---- emitters (+ highway lamps) baked into the light textures
  const emitters: Emitter[] = spec.emitters.slice();
  for (const h of spec.highways) highwayEmitters(h, emitters);
  const bake = bakeLights({ ...spec, emitters }, 0.6);
  // signs, lamps, fires and festoons as local lights (and the halo candidates)
  const local = bakeLocalLights(spec, bake.rect);
  U.cityRect.value.set(spec.bounds.x0, spec.bounds.z0, spec.bounds.x1, spec.bounds.z1);

  const chunks = new Chunks();
  const kits = new KitBatch(CHUNK);
  const kitSink = (geom: KitGeom, lod: LodClass, i: Inst): void => kits.add(geom, lod, i);
  const propFor = (x: number, z: number): MeshBuilder => chunks.get('prop', x, z);

  // ---- buildings
  for (const b of spec.buildings) {
    const cx = (b.rect.x0 + b.rect.x1) / 2;
    const cz = (b.rect.z0 + b.rect.z1) / 2;
    addWalls(b, chunks.get('wall', cx, cz));
    addRoofs(b, chunks.get('roof', cx, cz));
    addRelief(b, kitSink, propFor);
  }

  // ---- the sprawl beyond the limits, in large chunks
  const outer = new Chunks(1440);
  for (const o of spec.outskirts) {
    const cx = (o.rect.x0 + o.rect.x1) / 2;
    const cz = (o.rect.z0 + o.rect.z1) / 2;
    addOutskirt(o, outer.get('wall', cx, cz), outer.get('roof', cx, cz));
  }

  // ---- signs
  for (const s of spec.signs) {
    addSign(s, {
      kit: kitSink,
      glyph: chunks.get('glyph', s.x, s.z),
      ink: chunks.get('ink', s.x, s.z),
      tube: chunks.get('tube', s.x, s.z),
      halo: chunks.get('halo', s.x, s.z),
      screen: chunks.get('screen', s.x, s.z),
      holo: chunks.get('holo', s.x, s.z),
    });
  }

  // ---- structures, highways, kits
  for (const s of spec.structures) addStructure(s, kitSink, propFor);
  for (const h of spec.highways) addHighway(h, kitSink);
  addMetro(spec.transit, kitSink);
  for (const k of spec.kits) {
    const c = convertKit(k);
    if (c) kits.add(c[0], c[1], c[2]);
  }
  // promenade lamps on the city's sea front, arms reaching back over the walk
  for (const p of promenade(spec)) {
    if (!p.inCity) continue;
    const s = PROMENADE_H / 8;
    kits.add('lamp', 'mid', { x: p.x, y: 0.15, z: p.z, rot: Math.PI, sx: s, sy: s, sz: s, emit: 2.5, r: 0.13, g: 0.13, b: 0.14, cs: CLS.metal + 0.5, er: 1, eg: 0.72, eb: 0.44, mode: 0 });
  }

  // ---- steam: road vents (grate + plume), barrel fires, industrial stacks
  for (const v of spec.steam) {
    const B = chunks.get('steam', v.x, v.z);
    if (v.h < 2) addPlume(B, v.x, v.h, v.z, 4, 0.3, 1.4, v.seed);
    else if (v.h < 9) {
      kitSink('box', 'tiny', { x: v.x, y: 0.0, z: v.z, rot: 0, sx: 0.9, sy: 0.04, sz: 0.9, emit: 1.2, r: 0.03, g: 0.03, b: 0.035, cs: CLS.grille + 0.5, er: 1, eg: 0.45, eb: 0.2, mode: 0 });
      addPlume(B, v.x, 0.03, v.z, Math.min(8.5, v.h * 1.05), 0.35, 2.2, v.seed);
    } else addPlume(B, v.x, v.h, v.z, 26, 1.5, 9, v.seed);
  }

  // ---- ground
  for (const rp of spec.roads) {
    const st = spec.streets[rp.streetId]!;
    const cx = (rp.rect.x0 + rp.rect.x1) / 2;
    const cz = (rp.rect.z0 + rp.rect.z1) / 2;
    addRoadPiece(chunks.get('road', cx, cz), rp, st);
  }
  for (const blk of spec.blocks) {
    const d = spec.districts[blk.district] as District;
    const code = Object.keys(PROFILES).indexOf(d.kind);
    addPlate(chunks.get('plate', (blk.plate.x0 + blk.plate.x1) / 2, (blk.plate.z0 + blk.plate.z1) / 2), blk, code, (blk.id * 0.618) % 1, d.style.grime);
  }

  // ---- build meshes
  const culls: CullEntry[] = [];
  let triangles = 0;
  let meshes = 0;
  for (const [cat, B] of [...chunks.all(), ...outer.all()]) {
    if (B.isEmpty) continue;
    triangles += B.triangleCount;
    const geo = B.build();
    const mesh = new THREE.Mesh(geo, mats[cat]);
    mesh.matrixAutoUpdate = false;
    mesh.name = cat;
    mesh.renderOrder = SPEC[cat].order;
    root.add(mesh);
    meshes++;
    const bs = geo.boundingSphere!;
    culls.push({ mesh, cx: bs.center.x, cz: bs.center.z, r: bs.radius, max: SPEC[cat].cull });
  }
  for (const k of kits.build(mats.kit)) {
    root.add(k.mesh);
    meshes++;
    triangles += k.tris;
    culls.push({ mesh: k.mesh, cx: k.cx, cz: k.cz, r: k.r, max: LOD_DIST[k.lod] });
  }

  // ---- land, sea, seawall
  const ls = buildLandAndSea(spec);
  const land = new THREE.Mesh(ls.land, mats.land);
  const sea = new THREE.Mesh(ls.sea, mats.water);
  const wall = new THREE.Mesh(ls.wall, mats.seawall);
  land.name = 'land';
  sea.name = 'sea';
  wall.name = 'seawall';
  for (const m of [land, sea, wall]) {
    m.matrixAutoUpdate = false;
    m.frustumCulled = false;
    root.add(m);
  }

  // ---- traffic and rain
  const traffic = new Traffic(spec.lanes);
  root.add(traffic.mesh);
  const trains = new MetroTrains(spec.transit);
  root.add(trains.mesh);
  const rain = new Rain();
  root.add(rain.mesh);

  // ---- point lights: lamps, beacons, the sprawl, the promenade, ground and flying traffic
  const lights = buildCityLights(spec, traffic.mesh.geometry as THREE.InstancedBufferGeometry);
  root.add(lights.group);

  // ---- giant holograms and light pillars
  const spectacle = buildSpectacle(spec.spectacle);
  root.add(spectacle.group);

  // ---- airships, police, medevac and haulers
  const flyers = new FlyersRender(spec.flyers);
  root.add(flyers.group);

  // ---- searchlights from the tallest corporate crowns (not the ones carrying a light pillar)
  const beams: { mesh: THREE.Mesh; base: number; speed: number; tilt: number }[] = [];
  const pillarAt = (b: (typeof spec.buildings)[number]): boolean =>
    spec.spectacle.pillars.some((p) => p.x > b.rect.x0 - 1 && p.x < b.rect.x1 + 1 && p.z > b.rect.z0 - 1 && p.z < b.rect.z1 + 1);
  const tall = spec.buildings
    .filter((b) => b.kind === 'corporate' && b.height > 150 && !pillarAt(b))
    .sort((a, b) => b.height - a.height)
    .slice(0, 6);
  const beamGeo = makeBeamGeometry();
  tall.forEach((b, i) => {
    const m = new THREE.Mesh(beamGeo, mats.beam);
    m.name = 'beam';
    const cx = (b.rect.x0 + b.rect.x1) / 2;
    const cz = (b.rect.z0 + b.rect.z1) / 2;
    m.position.set(cx, b.height + 2, cz);
    m.frustumCulled = false;
    m.renderOrder = 6;
    root.add(m);
    beams.push({ mesh: m, base: i * 1.7, speed: 0.07 + (i % 3) * 0.03, tilt: 0.3 + (i % 4) * 0.07 });
  });

  if (!sky.parent) root.add(sky);

  const cam = new THREE.Vector3();
  let time = 0;
  return {
    root,
    sky,
    rain,
    traffic,
    flyers,
    lights,
    stats: { meshes, triangles, instances: kits.instanceCount, buildMs: performance.now() - t0, bakeMs: bake.ms + local.ms, localLights: local.lights },
    update(camera: THREE.Camera, dt: number): void {
      time += dt;
      camera.getWorldPosition(cam);
      U.camY.value = cam.y;
      (U.camPos.value as THREE.Vector3).copy(cam);
      updateHalos(camera as THREE.PerspectiveCamera);
      sky.position.copy(cam);
      sky.updateMatrixWorld();
      for (const e of culls) {
        const d = Math.hypot(e.cx - cam.x, e.cz - cam.z) - e.r;
        e.mesh.visible = d < e.max && !e.mesh.userData.forceHidden;
      }
      traffic.update(dt);
      lights.update(camera as THREE.PerspectiveCamera, dt);
      trains.update(dt);
      spectacle.update(dt);
      flyers.update(dt);
      rain.update(camera, dt);
      for (const b of beams) {
        const a = b.base + time * b.speed;
        b.mesh.rotation.set(Math.cos(a * 1.3) * b.tilt, a, Math.sin(a) * b.tilt, 'YXZ');
        b.mesh.updateMatrixWorld();
      }
    },
    dispose(): void {
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m !== sky) m.geometry.dispose();
      });
      traffic.dispose();
      lights.dispose();
      trains.dispose();
      spectacle.dispose();
      flyers.dispose();
    },
  };
}

function makeBeamGeometry(): THREE.BufferGeometry {
  const B = new MeshBuilder({ aB: 4, aCol: 3 });
  B.set('aB', 0.42, 1.0, 0.3, 0);
  B.set('aCol', 0.75, 0.85, 1.0);
  const SEG = 20;
  const L = 1300;
  const r0 = 1.4;
  const r1 = 75;
  const ring = (t: number, r: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      out.push(B.vert(Math.cos(a) * r, t * L, Math.sin(a) * r, Math.cos(a), 0, Math.sin(a), i / SEG, t));
    }
    return out;
  };
  const a = ring(0, r0);
  const b = ring(1, r1);
  for (let i = 0; i < SEG; i++) B.quad(a[i]!, a[i + 1]!, b[i + 1]!, b[i]!);
  void addBox;
  return B.build();
}

export type { Tier };
