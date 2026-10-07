/**
 * Spectacle: the genre's set pieces above the street. Building-sized
 * holograms swim slow circuits over the busiest districts (a giant koi rings
 * the landmark at the centre), and columns of light stand on the tallest
 * crowns. This stage only places them; the renderer animates them.
 *
 * Each circuit is fitted to the skyline: the radius and height are searched so
 * the body clears the towers along its path where it can.
 */
import type { Building, DistrictKind, Emitter, GiantHolo, HoloKind, LightPillar, Lot, RGB, Spectacle } from './types';
import type { Zoning } from './zoning';
import { clamp, lerp, type Rng } from './rng';

interface Species {
  /** Body length (or bell diameter), metres. */
  size: [number, number];
  alt: [number, number];
  radius: [number, number];
  /** Speed along the circuit, m/s. */
  speed: [number, number];
  /** Half the body's width as a share of its size, and how far it hangs below its centre. */
  half: number;
  below: number;
}

const SPECIES: Record<HoloKind, Species> = {
  koi: { size: [70, 115], alt: [110, 240], radius: [140, 260], speed: [8, 12], half: 0.16, below: 0.12 },
  serpent: { size: [170, 250], alt: [110, 220], radius: [150, 240], speed: [11, 16], half: 0.08, below: 0.1 },
  manta: { size: [70, 105], alt: [150, 280], radius: [170, 280], speed: [9, 13], half: 0.5, below: 0.1 },
  jelly: { size: [34, 56], alt: [130, 240], radius: [16, 45], speed: [1.2, 2.2], half: 0.55, below: 2.4 },
};

/** Which species each district kind favours (decayed districts have none). */
const BY_DISTRICT: Record<DistrictKind, [HoloKind, number][]> = {
  corporate: [
    ['koi', 1],
    ['jelly', 0.6],
    ['manta', 0.5],
  ],
  jpmarket: [
    ['koi', 1],
    ['jelly', 0.6],
  ],
  cnmarket: [
    ['serpent', 1],
    ['koi', 0.4],
  ],
  megablock: [
    ['jelly', 1],
    ['manta', 0.5],
  ],
  luxury: [
    ['manta', 1],
    ['jelly', 0.7],
    ['koi', 0.4],
  ],
  industrial: [['jelly', 0.25]],
  decayed: [],
};

/** Hologram colour pairs per species: body and pattern. */
const COLOURS: Record<HoloKind, [RGB, RGB][]> = {
  koi: [
    [
      [0.2, 0.75, 1.0],
      [1.0, 0.38, 0.1],
    ],
    [
      [0.3, 0.5, 1.0],
      [1.0, 0.2, 0.35],
    ],
    [
      [0.25, 1.0, 0.85],
      [1.0, 0.62, 0.12],
    ],
  ],
  serpent: [
    [
      [1.0, 0.28, 0.2],
      [1.0, 0.78, 0.3],
    ],
    [
      [0.3, 1.0, 0.75],
      [1.0, 0.85, 0.35],
    ],
  ],
  manta: [
    [
      [0.15, 0.7, 1.0],
      [0.75, 0.3, 1.0],
    ],
    [
      [0.35, 0.4, 1.0],
      [0.2, 1.0, 0.75],
    ],
  ],
  jelly: [
    [
      [0.75, 0.45, 1.0],
      [1.0, 0.45, 0.8],
    ],
    [
      [0.35, 0.8, 1.0],
      [0.75, 0.5, 1.0],
    ],
    [
      [1.0, 0.5, 0.75],
      [0.5, 0.85, 1.0],
    ],
  ],
};

function centreOf(b: Building): [number, number] {
  return [(b.rect.x0 + b.rect.x1) / 2, (b.rect.z0 + b.rect.z1) / 2];
}

/**
 * How badly a circuit cuts through the skyline: the summed height by which
 * towers along the ring rise into the body's band.
 */
function clash(near: readonly Building[], cx: number, cz: number, R: number, alt: number, half: number, below: number, skip: Building | null): number {
  let p = 0;
  for (const b of near) {
    if (b === skip) continue;
    const [bx, bz] = centreOf(b);
    const rb = Math.hypot(b.rect.x1 - b.rect.x0, b.rect.z1 - b.rect.z0) / 2;
    const d = Math.hypot(bx - cx, bz - cz);
    if (Math.abs(d - R) > rb + half) continue;
    const over = b.height - (alt - below);
    if (over > 0) p += Math.min(over, 120) * rb;
  }
  return p;
}

/** Search a circuit radius and height for a species around (cx, cz). */
function fitCircuit(buildings: readonly Building[], sp: Species, size: number, cx: number, cz: number, r: Rng, skip: Building | null, minR = 0): { R: number; alt: number } {
  const reach = sp.radius[1] + size + 80;
  const near = buildings.filter((b) => {
    const [bx, bz] = centreOf(b);
    return Math.abs(bx - cx) < reach && Math.abs(bz - cz) < reach && b.height > 40;
  });
  const half = sp.half * size;
  const below = sp.below * size;
  let best = { R: lerp(sp.radius[0], sp.radius[1], r.next()), alt: lerp(sp.alt[0], sp.alt[1], r.next()), score: Infinity };
  for (let i = 0; i < 6; i++) {
    const R = Math.max(minR, lerp(sp.radius[0], sp.radius[1], (i + r.next() * 0.5) / 6));
    for (let j = 0; j < 7; j++) {
      const alt = lerp(sp.alt[0], sp.alt[1], j / 6);
      // a mild preference for lower circuits: they read against the towers, not the sky
      const score = clash(near, cx, cz, R, alt, half, below, skip) + (alt - sp.alt[0]) * 2;
      if (score < best.score) best = { R, alt, score };
    }
  }
  return { R: best.R, alt: best.alt };
}

function pickKind(r: Rng, table: [HoloKind, number][]): HoloKind | null {
  if (table.length === 0) return null;
  return r.weighted(
    table.map((t) => t[0]),
    table.map((t) => t[1]),
  );
}

export function makeSpectacle(z: Zoning, buildings: readonly Building[], lots: readonly Lot[], rng: Rng): Spectacle & { emitters: Emitter[] } {
  const holos: GiantHolo[] = [];
  const pillars: LightPillar[] = [];
  const emitters: Emitter[] = [];
  const glowAround = (h: GiantHolo): void => {
    // the light they cast is baked as a faint ring of colour along the circuit
    const n = h.kind === 'jelly' ? 1 : 6;
    const k = h.kind === 'jelly' ? 0.7 : 0.3;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = h.kind === 'jelly' ? 0 : h.radius;
      emitters.push({ x: h.x + Math.cos(a) * rr, y: h.y, z: h.z + Math.sin(a) * rr, r: h.col[0] * k, g: h.col[1] * k, b: h.col[2] * k, radius: clamp(h.size * 0.6, 30, 80) });
    }
  };

  const make = (kind: HoloKind, r: Rng, cx: number, cz: number, district: number, sizeK: number, skip: Building | null, minR = 0, fixed?: { R: number; alt: number }): GiantHolo => {
    const sp = SPECIES[kind];
    const size = lerp(sp.size[0], sp.size[1], r.next()) * sizeK;
    const fit = fixed ?? fitCircuit(buildings, sp, size, cx, cz, r, skip, minR);
    const pal = COLOURS[kind][r.int(COLOURS[kind].length)] as [RGB, RGB];
    return {
      kind,
      x: cx,
      y: fit.alt,
      z: cz,
      radius: fit.R,
      speed: lerp(sp.speed[0], sp.speed[1], r.next()) * r.sign(),
      size,
      bob: kind === 'jelly' ? r.range(6, 14) : r.range(4, 10),
      col: pal[0],
      col2: pal[1],
      phase: r.next(),
      district,
    };
  };

  // ---- the centrepiece: a giant koi ringing the landmark, or the tallest crown in the core
  const landmarkLot = lots.find((l) => l.landmark);
  const landmark = landmarkLot ? buildings.find((b) => b.lot === landmarkLot.id) ?? null : null;
  const core = z.districts.find((d) => d.kind === 'corporate');
  {
    const r = rng.fork('centrepiece');
    if (landmark) {
      const [cx, cz] = centreOf(landmark);
      const halfBase = (landmark.rect.x1 - landmark.rect.x0) / 2;
      const alt = landmark.height * r.range(0.42, 0.5);
      // the pyramid narrows with height: clear its slope at the circuit's height
      const slopeHalf = halfBase * (1 - alt / landmark.height) * Math.SQRT2;
      const h = make('koi', r, cx, cz, landmark.district, 1.7, landmark, 0, { R: slopeHalf + r.range(90, 130), alt });
      holos.push(h);
      glowAround(h);
    } else if (core) {
      const tallest = buildings.filter((b) => b.district === core.id).sort((a, b) => b.height - a.height)[0];
      const [cx, cz] = tallest ? centreOf(tallest) : [core.x, core.z];
      const h = make('koi', r, cx, cz, core.id, 1.5, null, 160);
      holos.push(h);
      glowAround(h);
    }
  }

  // ---- one or two per district, by how loud it is
  for (const d of z.districts) {
    const r = rng.fork('holo' + d.id);
    const table = BY_DISTRICT[d.kind];
    if (table.length === 0) continue;
    const loud = clamp(0.25 + 0.9 * d.style.flash + 0.3 * d.tune.neon - 0.3 * Math.max(0, d.tune.decay), 0, 1.4);
    const n = (r.chance(Math.min(1, loud)) ? 1 : 0) + (r.chance(Math.max(0, loud - 0.75)) ? 1 : 0);
    for (let k = 0; k < n; k++) {
      const kind = pickKind(r, table);
      if (!kind) continue;
      const a = r.range(0, Math.PI * 2);
      const off = r.range(40, 160);
      const cx = d.x + Math.cos(a) * off;
      const cz = d.z + Math.sin(a) * off;
      // keep clear of holograms already placed
      if (holos.some((h) => Math.hypot(h.x - cx, h.z - cz) < h.radius + 140)) continue;
      const h = make(kind, r, cx, cz, d.id, 1, null);
      holos.push(h);
      glowAround(h);
    }
  }

  // ---- light pillars: the three tallest crowns at least 220 m apart, and the landmark apex
  {
    const r = rng.fork('pillars');
    const cand = buildings
      .filter((b) => b.height >= 260 && b !== landmark && (b.kind === 'corporate' || b.kind === 'megablock' || b.kind === 'luxury'))
      .sort((a, b) => b.height - a.height);
    const chosen: Building[] = [];
    for (const b of cand) {
      if (chosen.length >= 3) break;
      const [x, zz] = centreOf(b);
      if (chosen.some((c) => Math.hypot(centreOf(c)[0] - x, centreOf(c)[1] - zz) < 220)) continue;
      chosen.push(b);
    }
    const tints: RGB[] = [
      [0.78, 0.88, 1.0],
      [0.55, 0.9, 1.0],
      [1.0, 0.55, 0.85],
    ];
    chosen.forEach((b, i) => {
      const [x, zz] = centreOf(b);
      const col = i === 0 ? (tints[0] as RGB) : (tints[r.int(tints.length)] as RGB);
      pillars.push({ x, z: zz, y0: b.height, radius: r.range(3.5, 6), col, intensity: r.range(0.9, 1.2), seed: r.next() });
      emitters.push({ x, y: b.height + 6, z: zz, r: col[0] * 2.5, g: col[1] * 2.5, b: col[2] * 2.5, radius: 45 });
    });
    if (landmark) {
      const [x, zz] = centreOf(landmark);
      const acc = landmark.tiers[landmark.tiers.length - 1]?.facade.accent ?? [1, 0.8, 0.5];
      const col: RGB = [0.6 + 0.4 * acc[0], 0.6 + 0.4 * acc[1], 0.6 + 0.4 * acc[2]];
      pillars.push({ x, z: zz, y0: landmark.height, radius: 8, col, intensity: 1.3, seed: r.next() });
      emitters.push({ x, y: landmark.height + 8, z: zz, r: col[0] * 3, g: col[1] * 3, b: col[2] * 3, radius: 60 });
    }
  }

  return { holos, pillars, emitters };
}
