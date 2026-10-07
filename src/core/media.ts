/**
 * LED media facades (comps: the riverfront skylines of Chongqing and Shanghai,
 * Hong Kong's harbour front at night). Tall towers carry LED lines on their
 * floor slabs and corners: most are static outlines in warm, cool or gold
 * white; the tallest towers near the water join a city-wide light show, whose
 * scenes the renderer runs on one clock so the whole waterfront moves together.
 *
 * Runs after massing. Each building rolls on a hash of its own seed, so editing
 * one district never reshuffles another.
 */
import type { Building, District, DistrictKind, MediaKind } from './types';
import { clamp, hash01 } from './rng';

/** Base chance per district kind, and the minimum height for each kind to carry lines. */
const BASE: Record<DistrictKind, { p: number; h: number; show: number }> = {
  corporate: { p: 0.34, h: 100, show: 0.55 },
  luxury: { p: 0.3, h: 70, show: 0.35 },
  megablock: { p: 0.26, h: 60, show: 0.15 },
  cnmarket: { p: 0.3, h: 50, show: 0.1 },
  jpmarket: { p: 0.08, h: 60, show: 0.2 },
  industrial: { p: 0.02, h: 80, show: 0 },
  decayed: { p: 0.0, h: 999, show: 0 },
};

/** Distance (m) from the waterline within which towers count as waterfront. */
const FRONT = 650;

export interface MediaStats {
  outline: number;
  show: number;
}

export function assignMedia(buildings: Building[], districts: readonly District[], coastZ: (x: number) => number): MediaStats {
  const stats: MediaStats = { outline: 0, show: 0 };
  for (const b of buildings) {
    const d = districts[b.district];
    if (!d) continue;
    const base = BASE[b.kind];
    if (b.height < base.h) continue;
    const cx = (b.rect.x0 + b.rect.x1) / 2;
    const cz = (b.rect.z0 + b.rect.z1) / 2;
    // the coast lies to the south (+z): waterfront towers stand just north of it
    const toWater = coastZ(cx) - cz;
    const front = toWater > 0 && toWater < FRONT ? 1 - toWater / FRONT : 0;
    const flash = d.style.flash;
    const p = clamp(base.p * (0.55 + 0.9 * flash) * (1 + 0.6 * d.tune.neon + 0.3 * d.tune.budget - 0.8 * Math.max(0, d.tune.decay)) + 0.4 * front * (base.p > 0 ? 1 : 0), 0, 0.92);
    const key = Math.floor(b.seed * 1e9);
    if (hash01(key, 71, 3) >= p) continue;
    const tall = clamp((b.height - base.h) / 160, 0, 1);
    const showP = clamp(base.show * (0.4 + 0.6 * tall) + 0.5 * front * (base.show > 0 ? 1 : 0), 0, 0.9);
    const kind: MediaKind = hash01(key, 72, 5) < showP ? 'show' : 'outline';
    stats[kind]++;
    // podiums and low tiers keep their own look; the lines run on the tower
    b.tiers = b.tiers.map((t) => (t.y1 > 24 && t.y1 - t.y0 > 6 ? { ...t, facade: { ...t.facade, media: kind } } : t));
  }
  return stats;
}
