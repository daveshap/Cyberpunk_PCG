import { describe, expect, it } from 'vitest';
import { FlightWorld, generateCity } from '../src/core';
import type { CitySpec, Vec2 } from '../src/core';
import { polyArea } from '../src/core/geom2d';
import { Flight } from '../src/game/flight';
import { Autopilot } from '../src/game/autopilot';

const strip = (s: CitySpec): string => JSON.stringify({ ...s, stats: { ...s.stats, ms: 0, stages: {} } });

const cache = new Map<string, CitySpec>();
function city(seed: string, dials = {}): CitySpec {
  const k = seed + JSON.stringify(dials);
  let c = cache.get(k);
  if (!c) {
    c = generateCity({ seed, dials });
    cache.set(k, c);
  }
  return c;
}

describe('generator', () => {
  it('is deterministic for a seed and dials', () => {
    expect(strip(generateCity({ seed: 'det', dials: { size: 2 } }))).toBe(strip(generateCity({ seed: 'det', dials: { size: 2 } })));
  });

  it('different seeds give different cities', () => {
    expect(strip(generateCity({ seed: 'a', dials: { size: 2 } }))).not.toBe(strip(generateCity({ seed: 'b', dials: { size: 2 } })));
  });

  it('places every district kind in a default city, each one contiguous', () => {
    const s = city('sprawl');
    const kinds = new Set(s.districts.map((d) => d.kind));
    expect(kinds.size).toBe(7);
    for (const d of s.districts) {
      if (d.cells.length === 0) continue;
      const cells = new Set(d.cells);
      const seen = new Set<number>([d.cells[0]!]);
      const stack = [d.cells[0]!];
      while (stack.length) {
        const c = stack.pop()!;
        const sb = s.superblocks[c]!;
        for (const o of s.superblocks) {
          if (!cells.has(o.id) || seen.has(o.id)) continue;
          if (Math.abs(o.i - sb.i) + Math.abs(o.j - sb.j) === 1) {
            seen.add(o.id);
            stack.push(o.id);
          }
        }
      }
      expect(seen.size).toBe(cells.size);
    }
  });

  it('builds convex counter-clockwise tiers inside their lots and blocks', () => {
    const s = city('sprawl');
    for (const b of s.buildings) {
      const lot = s.lots[b.lot]!;
      const blk = s.blocks[lot.block]!;
      for (const t of b.tiers) {
        expect(polyArea(t.poly as Vec2[])).toBeGreaterThan(0);
        expect(t.y1).toBeGreaterThan(t.y0);
        if (t.top) {
          expect(t.top.length).toBe(t.poly.length);
          expect(polyArea(t.top as Vec2[])).toBeGreaterThan(0);
        }
        for (const [x, z] of [...t.poly, ...(t.top ?? [])]) {
          expect(x).toBeGreaterThanOrEqual(blk.rect.x0 - 0.01);
          expect(x).toBeLessThanOrEqual(blk.rect.x1 + 0.01);
          expect(z).toBeGreaterThanOrEqual(blk.rect.z0 - 0.01);
          expect(z).toBeLessThanOrEqual(blk.rect.z1 + 0.01);
        }
      }
    }
  });

  it('keeps buildings off the roads', () => {
    const s = city('sprawl');
    const roads = s.roads.map((r) => r.rect);
    let overlaps = 0;
    for (const b of s.buildings) {
      for (const t of b.tiers) {
        if (!t.grounded) continue;
        const xs = t.poly.map((p) => p[0]);
        const zs = t.poly.map((p) => p[1]);
        const r = { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
        for (const q of roads) if (r.x0 < q.x1 - 0.05 && r.x1 > q.x0 + 0.05 && r.z0 < q.z1 - 0.05 && r.z1 > q.z0 + 0.05) overlaps++;
      }
    }
    expect(overlaps).toBe(0);
  });

  it('dials move the city the way they say', () => {
    const base = city('dials', { size: 2.2 });
    const grimy = city('dials', { size: 2.2, grime: 1 });
    const edgy = city('dials', { size: 2.2, edge: 1 });
    const east = city('dials', { size: 2.2, east: 1 });
    const lux = city('dials', { size: 2.2, luxury: 1 });
    const avg = (s: CitySpec, f: (b: CitySpec['buildings'][number]) => number): number => s.buildings.reduce((a, b) => a + f(b), 0) / s.buildings.length;
    expect(avg(grimy, (b) => b.style.grime)).toBeGreaterThan(avg(base, (b) => b.style.grime) + 0.15);
    expect(edgy.buildings.filter((b) => b.archetype === 'monolith').length).toBeGreaterThan(base.buildings.filter((b) => b.archetype === 'monolith').length);
    const eastShare = (s: CitySpec): number => s.buildings.filter((b) => b.culture !== 'us').length / s.buildings.length;
    expect(eastShare(east)).toBeGreaterThan(eastShare(base) + 0.1);
    const luxFacades = (s: CitySpec): number => s.buildings.filter((b) => b.tiers.some((t) => t.facade.style === 'lux')).length;
    expect(luxFacades(lux)).toBeGreaterThanOrEqual(luxFacades(base));
  });

  it('per-district tuning moves only its own district kind', () => {
    const base = city('tune', { size: 2.2 });
    const big = city('tune', { size: 2.2, tune: { corporate: { scale: 1 } } });
    const avgH = (s: CitySpec, kind: string): number => {
      const bs = s.buildings.filter((b) => b.kind === kind);
      return bs.reduce((a, b) => a + b.height, 0) / Math.max(1, bs.length);
    };
    expect(avgH(big, 'corporate')).toBeGreaterThan(avgH(base, 'corporate') * 1.35);
    // other districts keep their character (same seed, untouched kinds)
    expect(Math.abs(avgH(big, 'luxury') - avgH(base, 'luxury'))).toBeLessThan(avgH(base, 'luxury') * 0.25);

    const shabby = city('tune', { size: 2.2, tune: { luxury: { decay: 1, budget: -0.6 } } });
    const grime = (s: CitySpec, kind: string): number => {
      const bs = s.buildings.filter((b) => b.kind === kind);
      return bs.reduce((a, b) => a + b.style.grime, 0) / Math.max(1, bs.length);
    };
    expect(grime(shabby, 'luxury')).toBeGreaterThan(grime(base, 'luxury') + 0.3);
    expect(shabby.buildings.some((b) => b.kind === 'luxury' && (b.archetype === 'ruin' || b.archetype === 'shack'))).toBe(true);

    const loud = city('tune', { size: 2.2, tune: { jpmarket: { neon: 1 } } });
    const signsIn = (s: CitySpec, kind: string): number => {
      const ids = new Set(s.districts.filter((d) => d.kind === kind).map((d) => d.id));
      return s.buildings.filter((b) => ids.has(b.district)).length ? s.signs.length : 0;
    };
    expect(signsIn(loud, 'jpmarket')).toBeGreaterThan(signsIn(base, 'jpmarket'));

    const packed = city('tune', { size: 2.2, tune: { cnmarket: { density: 1 } } });
    const lotsIn = (s: CitySpec, kind: string): number => {
      const ids = new Set(s.districts.filter((d) => d.kind === kind).map((d) => d.id));
      return s.lots.filter((l) => ids.has(l.district)).length;
    };
    expect(lotsIn(packed, 'cnmarket')).toBeGreaterThan(lotsIn(base, 'cnmarket') * 1.2);
  });

  it('builds megastructures by the alien dial, with one landmark', () => {
    const s = city('sprawl');
    const alien = new Set(['pyramid', 'ziggurat', 'taper', 'cantilever', 'twist', 'disc', 'flare', 'arch', 'stilts']);
    expect(s.superblocks.filter((sb) => sb.landmark).length).toBe(1);
    const landmark = s.buildings.find((b) => b.archetype === 'pyramid' && b.height > 300);
    expect(landmark).toBeDefined();
    const megas = s.buildings.filter((b) => alien.has(b.archetype));
    expect(megas.length).toBeGreaterThan(45);
    // the archetype on a building is what was built: sloped kinds have tapered tiers, the rest overhang
    for (const b of megas) {
      if (b.archetype === 'pyramid' || b.archetype === 'ziggurat' || b.archetype === 'taper' || b.archetype === 'flare') expect(b.tiers.some((t) => t.top)).toBe(true);
      else expect(b.tiers.some((t) => t.under)).toBe(true);
    }
    expect(s.lots.some((l) => l.mega)).toBe(true);
    const wild = city('sprawl', { alien: 0.95 });
    expect(wild.buildings.filter((b) => alien.has(b.archetype)).length).toBeGreaterThan(megas.length * 1.3);
    expect(s.structures.filter((x) => x.kind === 'bridge').length).toBeGreaterThan(20);
    const plain = city('sprawl', { alien: 0 });
    expect(plain.superblocks.some((sb) => sb.landmark)).toBe(false);
    expect(plain.buildings.filter((b) => alien.has(b.archetype)).length).toBe(0);
  });

  it('places giant holograms and light pillars over the city', () => {
    const s = city('sprawl');
    const { holos, pillars } = s.spectacle;
    expect(holos.length).toBeGreaterThanOrEqual(4);
    // the centrepiece koi rings the landmark, clear of its slope
    const lm = s.buildings.find((b) => b.archetype === 'pyramid' && b.height > 300)!;
    const koi = holos[0]!;
    expect(koi.kind).toBe('koi');
    expect(Math.hypot(koi.x - (lm.rect.x0 + lm.rect.x1) / 2, koi.z - (lm.rect.z0 + lm.rect.z1) / 2)).toBeLessThan(1);
    expect(koi.radius).toBeGreaterThan(((lm.rect.x1 - lm.rect.x0) / 2) * (1 - koi.y / lm.height));
    for (const h of holos) {
      expect(Number.isFinite(h.x + h.y + h.z + h.radius + h.speed + h.size)).toBe(true);
      expect(h.y).toBeGreaterThan(80);
      expect(h.size).toBeGreaterThan(20);
    }
    expect(holos.some((h) => h.kind !== 'koi')).toBe(true);
    expect(pillars.length).toBeGreaterThanOrEqual(2);
    for (const p of pillars) expect(p.y0).toBeGreaterThan(200);
    // decayed districts stay dark
    const decayed = new Set(s.districts.filter((d) => d.kind === 'decayed').map((d) => d.id));
    expect(holos.filter((h, i) => i > 0 && decayed.has(h.district)).length).toBe(0);
  });

  it('routes airships, police, medevac and haulers clear of the towers', () => {
    const s = city('sprawl');
    const { routes, incidents } = s.flyers;
    const kinds = new Set(routes.map((r) => r.kind));
    for (const k of ['blimp', 'police', 'medevac', 'hauler']) expect(kinds.has(k as never)).toBe(true);
    const world = new FlightWorld(s.boxes);
    for (const r of routes) {
      expect(r.pts.length).toBeGreaterThanOrEqual(4);
      expect(r.count).toBeGreaterThan(0);
      // sample every loop: nothing solid along it (police, medevac and haulers fly over arterials)
      for (let i = 0; i < r.pts.length; i++) {
        const a = r.pts[i]!;
        const b = r.pts[(i + 1) % r.pts.length]!;
        for (let t = 0; t <= 1; t += 0.05) {
          const p = { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, z: a[2] + (b[2] - a[2]) * t };
          expect(world.blocked(p, r.kind === 'blimp' ? 20 : 4)).toBe(false);
        }
      }
    }
    expect(incidents.length).toBeGreaterThan(0);
    for (const i of incidents) expect(world.blocked({ x: i.x, y: i.y, z: i.z }, 4)).toBe(false);
  });

  it('keeps the outskirts on land and outside the city', () => {
    const s = city('sprawl');
    expect(s.outskirts.length).toBeGreaterThan(500);
    const B = s.bounds;
    const shoreW = s.coast.z[0]!;
    const shoreE = s.coast.z[s.coast.z.length - 1]!;
    for (const o of s.outskirts) {
      const r = o.rect;
      const inside = r.x1 > B.x0 && r.x0 < B.x1 && r.z1 > B.z0 && r.z0 < B.z1;
      expect(inside).toBe(false);
      const shore = (r.x0 + r.x1) / 2 < B.x0 ? shoreW : (r.x0 + r.x1) / 2 > B.x1 ? shoreE : B.z0;
      expect(r.z1).toBeLessThanOrEqual(shore);
      expect(o.h).toBeGreaterThan(0);
    }
  });

  it('generates a default city in under three seconds', () => {
    const t0 = performance.now();
    generateCity({ seed: 'timing' });
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('emitters and signs are finite and inside the world', () => {
    const s = city('sprawl');
    for (const e of s.emitters) {
      expect(Number.isFinite(e.x + e.y + e.z + e.r + e.g + e.b + e.radius)).toBe(true);
      expect(e.radius).toBeGreaterThan(0);
    }
    for (const g of s.signs) expect(Number.isFinite(g.x + g.y + g.z + g.w + g.h)).toBe(true);
  });
});

describe('flight', () => {
  it('spawns in free air', () => {
    const s = city('sprawl');
    const w = new FlightWorld(s.boxes);
    expect(w.blocked(s.spawn, 2.6)).toBe(false);
  });

  it('random flying never ends inside a building', () => {
    const s = city('sprawl');
    const w = new FlightWorld(s.boxes);
    const f = new Flight(w);
    f.teleport(s.spawn.x, s.spawn.y, s.spawn.z, s.spawn.yaw);
    let r = 7;
    const rnd = (): number => {
      r = (r * 1664525 + 1013904223) >>> 0;
      return r / 4294967296;
    };
    const c = { x: 0, y: 1, z: 0, boost: false, lookX: 0, lookY: 0 };
    for (let i = 0; i < 6000; i++) {
      if (i % 30 === 0) {
        c.x = Math.round(rnd() * 2 - 1);
        c.y = rnd() < 0.8 ? 1 : -1;
        c.z = Math.round(rnd() * 2 - 1);
        c.boost = rnd() < 0.3;
        c.lookX = (rnd() - 0.5) * 300;
        c.lookY = (rnd() - 0.5) * 120;
      } else {
        c.lookX = 0;
        c.lookY = 0;
      }
      f.update(1 / 60, c);
      expect(w.blocked({ x: f.x, y: f.y, z: f.z }, 2.4)).toBe(false);
      expect(Number.isFinite(f.x + f.y + f.z)).toBe(true);
    }
  });

  it('guided flight tours the city without getting stuck', () => {
    const s = city('sprawl');
    const w = new FlightWorld(s.boxes);
    const f = new Flight(w);
    f.teleport(s.spawn.x, s.spawn.y, s.spawn.z, s.spawn.yaw);
    const ap = new Autopilot(s, w);
    ap.start(f);
    const c = { x: 0, y: 0, z: 0, boost: false, lookX: 0, lookY: 0 };
    let travelled = 0;
    let hits = 0;
    let px = f.x;
    let pz = f.z;
    for (let i = 0; i < 60 * 60; i++) {
      ap.drive(f, 1 / 60, c);
      f.lastHit = 0;
      f.update(1 / 60, c);
      if (f.lastHit > 4) hits++;
      travelled += Math.hypot(f.x - px, f.z - pz);
      px = f.x;
      pz = f.z;
    }
    expect(travelled).toBeGreaterThan(1500);
    expect(hits).toBeLessThan(6);
  });
});
