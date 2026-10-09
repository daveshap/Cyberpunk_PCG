/**
 * District profiles: the attribute tables the generator looks up per zone,
 * the way Unreal's PCG reads a data asset per biome. Every number here is a
 * design default; the dials bias them at generation time.
 *
 * Style axes follow the four eras of the genre's visual language:
 *   grime  (entropism)    necessity over style: dirt, decay, clutter, dead lights
 *   edge   (neomilitarism) substance over style: monoliths, matte, cold light
 *   flash  (kitsch)        style over substance: neon, screens, saturated colour
 *   luxury (neokitsch)     substance and style: gold, stone, curves, gardens
 */
import type { Archetype, Culture, Dials, DialsInput, DistrictKind, DistrictTune, LandUse, RGB, Style } from './types';
import { DISTRICT_KINDS, LAND_USES, TUNE_KEYS } from './types';
import { clamp } from './rng';

export interface DistrictProfile {
  kind: DistrictKind;
  label: string;
  /** Minimap colour. */
  map: string;
  /** Typical building height range (m) before the height dial. */
  height: [number, number];
  /** Chance of a landmark spike and its height range. */
  spike: { p: number; h: [number, number] };
  /** Lot frontage range (m). */
  lot: [number, number];
  /** Fraction of a lot the footprint covers. */
  coverage: number;
  /** Local street spacing range, roadway and sidewalk widths, alley chance per block. */
  streets: { spacing: [number, number]; road: number; walk: number; alley: number };
  archetypes: Partial<Record<Archetype, number>>;
  style: { grime: number; edge: number; flash: number; luxury: number };
  culture: Record<Culture, number>;
  /** Light colours (hex). */
  palette: number[];
  /** Wall base colours (hex, sRGB). */
  walls: number[];
  /** Signs per 10 m of street frontage per floor band. */
  signs: number;
  /** Fraction of signs that are vertical. */
  vertical: number;
  /** Greeble density 0..1. */
  greeble: number;
  /** Relative fog density and tint (hex). */
  fog: { density: number; tint: number };
  /** Land-use mix inside the district (relative weights). */
  uses: Partial<Record<LandUse, number>>;
  /** Sky glow over the district (light pollution on the cloud deck): two hues, linear RGB. */
  sky: { a: RGB; b: RGB; horizon: RGB };
  /** Fraction of blocks left open (plaza, park, yard, rubble). */
  open: number;
  /** Site weight for the zoning growth (bigger grows larger districts). */
  weight: number;
  /** Default number of districts of this kind in a 3 km city. */
  sites: number;
}

export const PROFILES: Record<DistrictKind, DistrictProfile> = {
  corporate: {
    kind: 'corporate',
    label: 'Corporate Core',
    map: '#5aa9ff',
    height: [110, 360],
    spike: { p: 0.16, h: [380, 560] },
    lot: [48, 84],
    coverage: 0.58,
    streets: { spacing: [118, 150], road: 16, walk: 6, alley: 0 },
    archetypes: { tower: 0.22, monolith: 0.12, needle: 0.05, podium: 0.12, taper: 0.05, cantilever: 0.05, twist: 0.04, disc: 0.04, flare: 0.04, arch: 0.04, pyramid: 0.02, egg: 0.09, prism: 0.09, helix: 0.08, bundle: 0.07, lean: 0.05, skyship: 0.04 },
    style: { grime: 0.1, edge: 0.85, flash: 0.45, luxury: 0.55 },
    culture: { us: 0.6, jp: 0.25, cn: 0.15 },
    palette: [0xdde8ff, 0x2ec5ff, 0xff3355, 0x8a7cff],
    walls: [0x1c2533, 0x2a3242, 0x3a414c, 0x141a24, 0x4a5260],
    signs: 0.25,
    vertical: 0.3,
    greeble: 0.25,
    fog: { density: 0.75, tint: 0x4a6aa8 },
    sky: { a: [0.22, 0.32, 0.7], b: [0.45, 0.2, 0.62], horizon: [0.028, 0.039, 0.072] },
    uses: { commercial: 0.62, residential: 0.14, nightlife: 0.1, civic: 0.08, green: 0.06 },
    open: 0.14,
    weight: 1.15,
    sites: 1,
  },
  jpmarket: {
    kind: 'jpmarket',
    label: 'Lantern Market',
    map: '#ff4fb0',
    height: [10, 42],
    spike: { p: 0.06, h: [70, 150] },
    lot: [6, 15],
    coverage: 0.95,
    streets: { spacing: [38, 58], road: 8, walk: 2.4, alley: 0.55 },
    archetypes: { shophouse: 0.52, midrise: 0.3, spire: 0.04, cantilever: 0.03, twist: 0.02, stack: 0.07 },
    style: { grime: 0.35, edge: 0.4, flash: 0.95, luxury: 0.3 },
    culture: { us: 0.12, jp: 0.8, cn: 0.08 },
    palette: [0xff3fa4, 0x2fd8ff, 0xf4f6ff, 0xffb347],
    walls: [0x4a4f5a, 0x6b6f78, 0x8a8478, 0x3d4350, 0x786a62],
    signs: 2.6,
    vertical: 0.72,
    greeble: 0.6,
    fog: { density: 1.15, tint: 0x7a3a8c },
    sky: { a: [0.62, 0.08, 0.42], b: [0.12, 0.32, 0.6], horizon: [0.055, 0.022, 0.061] },
    uses: { commercial: 0.36, residential: 0.32, nightlife: 0.26, civic: 0.03, green: 0.03 },
    open: 0.03,
    weight: 0.9,
    sites: 2,
  },
  cnmarket: {
    kind: 'cnmarket',
    label: 'Red Gate Market',
    map: '#ff5a3c',
    height: [14, 58],
    spike: { p: 0.05, h: [70, 140] },
    lot: [5, 13],
    coverage: 0.97,
    streets: { spacing: [34, 54], road: 8, walk: 2.0, alley: 0.65 },
    archetypes: { shophouse: 0.4, midrise: 0.48, ziggurat: 0.03, stilts: 0.02, stack: 0.09 },
    style: { grime: 0.6, edge: 0.32, flash: 0.85, luxury: 0.15 },
    culture: { us: 0.1, jp: 0.1, cn: 0.8 },
    palette: [0xff2a2a, 0xffc83d, 0x22e3a0, 0x3d6bff],
    walls: [0x6a5f55, 0x7d7468, 0x5a5e5c, 0x8a7f70, 0x5c5048],
    signs: 2.1,
    vertical: 0.76,
    greeble: 0.88,
    fog: { density: 1.35, tint: 0x8a3a24 },
    sky: { a: [0.62, 0.14, 0.06], b: [0.5, 0.32, 0.08], horizon: [0.061, 0.025, 0.022] },
    uses: { commercial: 0.38, residential: 0.42, nightlife: 0.14, industrial: 0.04, civic: 0.02 },
    open: 0.02,
    weight: 0.9,
    sites: 2,
  },
  megablock: {
    kind: 'megablock',
    label: 'Megablocks',
    map: '#f4a63c',
    height: [80, 230],
    spike: { p: 0.08, h: [240, 320] },
    lot: [62, 140],
    coverage: 0.55,
    streets: { spacing: [130, 170], road: 12, walk: 4, alley: 0.1 },
    archetypes: { megablock: 0.46, midrise: 0.12, arcology: 0.08, ziggurat: 0.08, stilts: 0.08, cantilever: 0.04, pyramid: 0.02, stack: 0.12, lean: 0.06, bundle: 0.04, skyship: 0.03 },
    style: { grime: 0.55, edge: 0.6, flash: 0.4, luxury: 0.12 },
    culture: { us: 0.5, jp: 0.2, cn: 0.3 },
    palette: [0xff9e3d, 0xcff5d8, 0x6f8cff, 0xff4fa0],
    walls: [0x6e6a64, 0x5c5f63, 0x7a756c, 0x4e5258, 0x67625a],
    signs: 0.5,
    vertical: 0.4,
    greeble: 0.72,
    fog: { density: 1.05, tint: 0x4a6a6a },
    sky: { a: [0.14, 0.38, 0.36], b: [0.5, 0.3, 0.12], horizon: [0.028, 0.039, 0.039] },
    uses: { residential: 0.66, commercial: 0.16, civic: 0.06, green: 0.07, nightlife: 0.05 },
    open: 0.1,
    weight: 1.1,
    sites: 3,
  },
  industrial: {
    kind: 'industrial',
    label: 'Harbor Works',
    map: '#c8b23a',
    height: [8, 24],
    spike: { p: 0.0, h: [0, 0] },
    lot: [40, 150],
    coverage: 0.6,
    streets: { spacing: [160, 220], road: 14, walk: 2, alley: 0 },
    archetypes: { shed: 0.72, tankfarm: 0.28 },
    style: { grime: 0.78, edge: 0.7, flash: 0.15, luxury: 0.04 },
    culture: { us: 0.78, jp: 0.07, cn: 0.15 },
    palette: [0xffa040, 0xffd000, 0x9fe8e0, 0xff2020],
    walls: [0x5a4a3c, 0x4a4f52, 0x6b5b45, 0x3e4446, 0x55524a],
    signs: 0.12,
    vertical: 0.1,
    greeble: 0.85,
    fog: { density: 1.5, tint: 0x8a5a2a },
    sky: { a: [0.6, 0.3, 0.07], b: [0.35, 0.2, 0.1], horizon: [0.055, 0.033, 0.017] },
    uses: { industrial: 0.78, commercial: 0.08, residential: 0.08, nightlife: 0.06 },
    open: 0.24,
    weight: 1.2,
    sites: 2,
  },
  decayed: {
    kind: 'decayed',
    label: 'Ash Flats',
    map: '#9a7b5a',
    height: [6, 52],
    spike: { p: 0.09, h: [70, 130] },
    lot: [14, 46],
    coverage: 0.66,
    streets: { spacing: [55, 92], road: 9, walk: 2, alley: 0.3 },
    archetypes: { ruin: 0.4, shack: 0.28, midrise: 0.2, stilts: 0.03, ziggurat: 0.02, stack: 0.07 },
    style: { grime: 0.95, edge: 0.42, flash: 0.15, luxury: 0.0 },
    culture: { us: 0.72, jp: 0.12, cn: 0.16 },
    palette: [0xff6a1f, 0xb87333, 0x9acd32, 0xc0306a],
    walls: [0x5f5a52, 0x6b655c, 0x4f4b45, 0x77705f, 0x5a5048],
    signs: 0.32,
    vertical: 0.5,
    greeble: 0.62,
    fog: { density: 1.4, tint: 0x7a7040 },
    sky: { a: [0.38, 0.3, 0.12], b: [0.3, 0.14, 0.1], horizon: [0.044, 0.039, 0.022] },
    uses: { residential: 0.46, industrial: 0.18, commercial: 0.16, nightlife: 0.12, green: 0.08 },
    open: 0.2,
    weight: 1.0,
    sites: 2,
  },
  luxury: {
    kind: 'luxury',
    label: 'Gilded Shore',
    map: '#7ff0d8',
    height: [10, 30],
    spike: { p: 0.0, h: [0, 0] },
    lot: [30, 70],
    coverage: 0.32,
    streets: { spacing: [110, 150], road: 10, walk: 5, alley: 0 },
    archetypes: { villa: 0.46, spire: 0.3, cantilever: 0.1, disc: 0.07, twist: 0.03, egg: 0.06, helix: 0.06, skyship: 0.05 },
    style: { grime: 0.04, edge: 0.3, flash: 0.25, luxury: 0.95 },
    culture: { us: 0.6, jp: 0.32, cn: 0.08 },
    palette: [0xffd8a8, 0xe8c068, 0x5fe0d0, 0xb9a2ff],
    walls: [0xb8ab95, 0x8a7560, 0xd6cbb8, 0x5b4a3a, 0xa29a8c],
    signs: 0.08,
    vertical: 0.2,
    greeble: 0.1,
    fog: { density: 0.6, tint: 0xb09a70 },
    sky: { a: [0.55, 0.36, 0.18], b: [0.22, 0.42, 0.5], horizon: [0.05, 0.039, 0.039] },
    uses: { residential: 0.56, commercial: 0.14, green: 0.2, nightlife: 0.05, civic: 0.05 },
    open: 0.24,
    weight: 1.0,
    sites: 2,
  },
};

/** Light palettes that the style axes pull a building toward. */
export const STYLE_PALETTES = {
  edge: [0xe8f0ff, 0xff2b3a, 0x39a0ff],
  flash: [0xff2fa0, 0xffe14a, 0x2fffe0, 0x9d4bff],
  luxury: [0xffc870, 0xffe8c8, 0x4fe0c8],
  grime: [0xff8a2a, 0xa8ff4a, 0xc83a3a],
} as const;

const KINDS = DISTRICT_KINDS;

export const NEUTRAL_TUNE: DistrictTune = { scale: 0, budget: 0, decay: 0, density: 0, neon: 0 };

const neutralTunes = (): Record<DistrictKind, DistrictTune> =>
  Object.fromEntries(KINDS.map((k) => [k, { ...NEUTRAL_TUNE }])) as Record<DistrictKind, DistrictTune>;

export const DEFAULT_DIALS: Dials = {
  world: 'city',
  grime: 0,
  edge: 0,
  flash: 0,
  luxury: 0,
  east: 0,
  jpcn: 0,
  density: 1,
  height: 1,
  size: 2.8,
  alien: 0.5,
  mix: { corporate: 1, jpmarket: 1, cnmarket: 1, megablock: 1, industrial: 1, decayed: 1, luxury: 1 },
  tune: neutralTunes(),
  uses: { residential: 1, commercial: 1, nightlife: 1, industrial: 1, civic: 1, green: 1 },
};

/** Land-use labels and minimap colours. */
export const USE_INFO: Record<LandUse, { label: string; map: string }> = {
  residential: { label: 'Residential', map: '#e0b070' },
  commercial: { label: 'Commercial', map: '#62c8ff' },
  nightlife: { label: 'Nightlife', map: '#ff3d9a' },
  industrial: { label: 'Industrial', map: '#c8b23a' },
  civic: { label: 'Civic', map: '#b8a8ff' },
  green: { label: 'Green', map: '#4fd27a' },
};

/** Scale factor for a tune value: f^v (v in -1..1). */
export const tuneMul = (v: number, f: number): number => Math.pow(f, v);

export function resolveDials(d: DialsInput | undefined): Dials {
  const tune = neutralTunes();
  for (const k of KINDS) {
    const src = d?.tune?.[k];
    if (!src) continue;
    for (const key of TUNE_KEYS) tune[k][key] = clamp(Number(src[key] ?? 0) || 0, -1, 1);
  }
  const uses = { ...DEFAULT_DIALS.uses };
  for (const u of LAND_USES) if (d?.uses?.[u] !== undefined) uses[u] = clamp(Number(d.uses[u]) || 0, 0, 2);
  const out: Dials = { ...DEFAULT_DIALS, ...(d ?? {}), mix: { ...DEFAULT_DIALS.mix, ...(d?.mix ?? {}) }, tune, uses };
  out.grime = clamp(out.grime, -1, 1);
  out.edge = clamp(out.edge, -1, 1);
  out.flash = clamp(out.flash, -1, 1);
  out.luxury = clamp(out.luxury, -1, 1);
  out.east = clamp(out.east, -1, 1);
  out.jpcn = clamp(out.jpcn, -1, 1);
  out.density = clamp(out.density, 0.6, 1.4);
  out.height = clamp(out.height, 0.5, 1.8);
  out.size = clamp(out.size, 1.6, 3.6);
  out.alien = clamp(Number(out.alien ?? 0.5), 0, 1);
  out.world = out.world === 'hive' ? 'hive' : 'city';
  for (const k of Object.keys(out.mix) as DistrictKind[]) out.mix[k] = clamp(out.mix[k], 0, 2);
  return out;
}

/** sRGB hex to linear RGB. */
export function hexToLinear(hex: number): RGB {
  const f = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return [f((hex >> 16) & 255), f((hex >> 8) & 255), f(hex & 255)];
}

/** Light colour from hex, normalised so its brightest channel is 1. */
export function lightColor(hex: number): RGB {
  const c = hexToLinear(hex);
  const m = Math.max(c[0], c[1], c[2], 1e-4);
  return [c[0] / m, c[1] / m, c[2] / m];
}

/** A district's style with the dials applied. Biases move a value up to 0.6 toward 0 or 1. */
export function styleFor(kind: DistrictKind, dials: Dials): Style {
  const p = PROFILES[kind];
  const bias = (v: number, b: number): number => clamp(b >= 0 ? v + (1 - v) * b * 0.85 : v + v * b * 0.85, 0, 1);
  const s = p.style;
  let us = p.culture.us;
  let jp = p.culture.jp;
  let cn = p.culture.cn;
  // east dial: scale East Asian weights up and Western down (or the reverse)
  const e = dials.east;
  us *= Math.max(0.02, 1 - e * 0.95);
  jp *= Math.max(0.02, 1 + e * 2.2);
  cn *= Math.max(0.02, 1 + e * 2.2);
  // jp/cn dial
  jp *= Math.max(0.02, 1 - dials.jpcn * 0.95);
  cn *= Math.max(0.02, 1 + dials.jpcn * 0.95);
  const t = us + jp + cn;
  // per-district tuning: budget buys luxury and upkeep, decay adds grime, neon adds kitsch
  const tn = dials.tune?.[kind] ?? NEUTRAL_TUNE;
  return {
    grime: bias(bias(s.grime, dials.grime), clamp(tn.decay * 0.9 - tn.budget * 0.35, -1, 1)),
    edge: bias(s.edge, dials.edge),
    flash: bias(bias(s.flash, dials.flash), tn.neon * 0.8),
    luxury: bias(bias(s.luxury, dials.luxury), clamp(tn.budget * 0.8 - Math.max(0, tn.decay) * 0.25, -1, 1)),
    us: us / t,
    jp: jp / t,
    cn: cn / t,
  };
}

/** Linear blend of two styles. */
export function blendStyle(a: Style, b: Style, t: number): Style {
  const m = (x: number, y: number): number => x + (y - x) * t;
  return { grime: m(a.grime, b.grime), edge: m(a.edge, b.edge), flash: m(a.flash, b.flash), luxury: m(a.luxury, b.luxury), us: m(a.us, b.us), jp: m(a.jp, b.jp), cn: m(a.cn, b.cn) };
}

export function dominantCulture(s: Style, r: number): Culture {
  // weighted pick with r in [0,1)
  if (r < s.us) return 'us';
  if (r < s.us + s.jp) return 'jp';
  return 'cn';
}

const NAMES: Record<DistrictKind, { a: string[]; b: string[] }> = {
  corporate: { a: ['Meridian', 'Apex', 'Sable', 'Vantage', 'Halcyon', 'Obsidian', 'Zenith', 'Paragon'], b: ['Plaza', 'Spires', 'Crown', 'Center', 'Heights'] },
  jpmarket: { a: ['Hoshi', 'Kumo', 'Tsuki', 'Akari', 'Yoru', 'Sora', 'Kiri', 'Hotaru'], b: ['Row', 'Lanes', 'Alley', 'Arcade', 'Street'] },
  cnmarket: { a: ['Jade', 'Lotus', 'Lantern', 'Silk', 'Vermilion', 'Golden Koi', 'Ninefold', 'Red Gate'], b: ['Market', 'Quarter', 'Walk', 'Bazaar', 'Lanes'] },
  megablock: { a: ['Stacks', 'Hive', 'Block', 'Towers', 'Terraces', 'Arcology'], b: ['Seven', 'Nine', 'Twelve', 'Forty', 'One', 'Delta'] },
  industrial: { a: ['Harbor', 'Foundry', 'Brine', 'Cinder', 'Ironside', 'Saltline'], b: ['Yards', 'Works', 'Docks', 'Terminal'] },
  decayed: { a: ['Ash', 'Dust', 'Rust', 'Scrap', 'Breakwater', 'Hollow', 'Gutter'], b: ['Flats', 'Heights', 'Hollow', 'End', 'Reach'] },
  luxury: { a: ['Gilded', 'Palm', 'Silver', 'Aurelia', 'Coral', 'Amber'], b: ['Shore', 'Terrace', 'Bay', 'Heights', 'Gardens'] },
};

export function districtName(kind: DistrictKind, r1: number, r2: number): string {
  const n = NAMES[kind];
  const a = n.a[Math.floor(r1 * n.a.length)] ?? n.a[0]!;
  const b = n.b[Math.floor(r2 * n.b.length)] ?? n.b[0]!;
  return kind === 'megablock' ? `${a} ${b}` : `${a} ${b}`;
}
