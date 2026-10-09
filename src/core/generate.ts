/**
 * The generation pipeline, in the order a PCG graph would run it:
 * zoning (arterials, coast, districts) -> streets and plates -> lots ->
 * massing -> dressing (signs, kits, structures, emitters) -> traffic ->
 * collision boxes. Pure: same seed and dials, same city.
 */
import type { CityOptions, CitySpec, District } from './types';
import { resolveDials } from './profiles';
import { Rng } from './rng';
import { makeZoning } from './zoning';
import { makeStreets } from './streets';
import { makeLots } from './lots';
import { makeBuildings } from './massing';
import { dress } from './dressing';
import { HIVE_BANDS, makeLanes } from './traffic';
import { FlightWorld, buildBoxes } from './collision';
import { makeOutskirts } from './outskirts';
import { assignUses } from './landuse';
import { makeTransit, transitBoxes, transitDressing } from './transit';
import { makeHiveBridges, makeSkybridges } from './skybridges';
import { makeSpectacle } from './spectacle';
import { makeFlyers } from './flyers';
import { assignMedia } from './media';
import { boltOn } from './greebles';

export function generateCity(options: CityOptions = {}, now: () => number = () => 0): CitySpec {
  const t0 = now();
  const stages: Record<string, number> = {};
  let tPrev = t0;
  const mark = (name: string): void => {
    const t = now();
    stages[name] = t - tPrev;
    tPrev = t;
  };
  const seedText = String(options.seed ?? 'sprawl');
  const dials = resolveDials(options.dials);
  const root = new Rng(seedText);

  const zoning = makeZoning(root.fork('zoning'), dials);
  mark('zoning');
  const { streets, roads, blocks } = makeStreets(zoning, root.fork('streets'), dials.density);
  mark('streets');
  assignUses(zoning, blocks, streets, root.fork('uses'), dials);
  mark('uses');
  const lots = makeLots(blocks, zoning.districts, root.fork('lots'), dials.density, dials.alien, zoning.hive);
  mark('lots');
  const structures: CitySpec['structures'] = [];
  const buildings = makeBuildings(zoning, lots, root.fork('massing'), dials.height, structures, dials.alien);
  mark('massing');
  structures.push(...(zoning.hive ? makeHiveBridges(buildings, root.fork('bridges'), [...HIVE_BANDS, 97, 157, 310, 530]) : makeSkybridges(buildings, streets, roads, root.fork('bridges'), dials.alien)));
  mark('skybridges');
  assignMedia(buildings, zoning.districts, zoning.coastZ);
  mark('media');
  const dressed = dress(zoning, buildings, lots, blocks, streets, roads, root.fork('dressing'), structures);
  mark('dressing');
  dressed.kits.push(...boltOn(buildings, lots, zoning.districts, root.fork('greebles')));
  mark('greebles');
  const spectacle = makeSpectacle(zoning, buildings, lots, root.fork('spectacle'));
  dressed.emitters.push(...spectacle.emitters);
  mark('spectacle');
  const transit = makeTransit(zoning, streets, root.fork('transit'));
  const td = transitDressing(transit);
  dressed.emitters.push(...td.emitters);
  dressed.signs.push(...td.signs);
  mark('transit');
  const { lanes, highways } = makeLanes(zoning, streets, root.fork('traffic'), transit);
  const flyers = makeFlyers(zoning, buildings, streets, root.fork('flyers'));
  dressed.emitters.push(...flyers.emitters);
  mark('traffic');
  const outskirts = makeOutskirts(root.fork('outskirts'), zoning.bounds, zoning.coastZ(zoning.bounds.x0 + 1), zoning.coastZ(zoning.bounds.x1 - 1), dials, zoning.hive ? 2600 : 2100);
  mark('outskirts');
  const boxes = buildBoxes(buildings, highways, structures);
  for (const o of outskirts.buildings) boxes.push({ x0: o.rect.x0, z0: o.rect.z0, x1: o.rect.x1, z1: o.rect.z1, y0: 0, y1: o.h });
  boxes.push(...transitBoxes(transit));
  mark('boxes');

  // ---- spawn: at the edge of the corporate core, looking down an arterial into it
  const core = zoning.districts.find((d) => d.kind === 'corporate') ?? (zoning.districts[0] as District | undefined);
  let spawn = { x: 0, y: 70, z: 0, yaw: -Math.PI / 2 };
  if (core) {
    let line = zoning.linesZ[0];
    for (const l of zoning.linesZ) if (Math.abs(l.pos - core.z) < Math.abs((line?.pos ?? 1e9) - core.z)) line = l;
    const half = zoning.size / 2;
    const fromWest = core.x > zoning.bounds.x0 + 700;
    const x = Math.max(-half + 60, Math.min(half - 60, core.x + (fromWest ? -520 : 520)));
    // (in the hive: halfway up a canyon, with towers above and below)
    spawn = { x, y: zoning.hive ? 236 : 62, z: line?.pos ?? core.z, yaw: fromWest ? -Math.PI / 2 : Math.PI / 2 };
    const world = new FlightWorld(boxes);
    const p = { x: spawn.x, y: spawn.y, z: spawn.z };
    let guard = 0;
    while (world.blocked(p, 4) && guard++ < 60) p.y += 6;
    spawn.y = p.y;
  }
  mark('spawn');

  const coastSamples: number[] = [];
  const step = 20;
  for (let x = zoning.bounds.x0; x <= zoning.bounds.x1 + 1e-6; x += step) coastSamples.push(zoning.coastZ(x));

  return {
    version: 1,
    seed: seedText,
    dials,
    bounds: zoning.bounds,
    coast: { x0: zoning.bounds.x0, step, z: coastSamples },
    districts: zoning.districts,
    superblocks: zoning.superblocks,
    streets,
    roads,
    blocks,
    lots,
    buildings,
    signs: dressed.signs,
    kits: dressed.kits,
    structures,
    emitters: dressed.emitters,
    steam: dressed.steam,
    lanes,
    highways,
    boxes,
    outskirts: outskirts.buildings,
    outskirtsGrid: outskirts.grid,
    transit,
    spectacle: { holos: spectacle.holos, pillars: spectacle.pillars },
    flyers: { routes: flyers.routes, incidents: flyers.incidents },
    spawn,
    stats: {
      buildings: buildings.length,
      tiers: buildings.reduce((a, b) => a + b.tiers.length, 0),
      signs: dressed.signs.length,
      kits: dressed.kits.length,
      emitters: dressed.emitters.length,
      ms: now() - t0,
      stages,
    },
  };
}
