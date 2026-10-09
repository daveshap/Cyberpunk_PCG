/**
 * Data model for a generated city. Everything is plain JSON-serialisable data:
 * no classes, no functions, no three.js types. The renderer reads it, the tests
 * validate it, and a headless simulator or another engine could use it as-is.
 *
 * Coordinates: metres, +x east, +y up, +z south (three.js convention).
 * Footprints are convex polygons in the XZ plane, counter-clockwise in the
 * mathematical sense (positive shoelace area with x right and z up).
 */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** Linear RGB, 0..1 (may exceed 1 for HDR emitters). */
export type RGB = [number, number, number];

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

// ------------------------------------------------------------------ districts

export type DistrictKind = 'corporate' | 'jpmarket' | 'cnmarket' | 'megablock' | 'industrial' | 'decayed' | 'luxury';

export const DISTRICT_KINDS: readonly DistrictKind[] = ['corporate', 'jpmarket', 'cnmarket', 'megablock', 'industrial', 'decayed', 'luxury'];

/** Signage and street-clutter culture. */
export type Culture = 'us' | 'jp' | 'cn';

export const CULTURES: readonly Culture[] = ['us', 'jp', 'cn'];

/**
 * The style dials. The four style axes and the two culture axes are biases
 * added to each district's own values (0 = the district's defaults), so a
 * district keeps its character while the whole city leans one way.
 */
/**
 * Per-district-kind scalars on top of the global style dials, -1..1 with 0 the
 * profile default. Together with the style axes they make a possibility space:
 * a luxury district can be small and shabby or vast and pristine.
 */
export interface DistrictTune {
  /** Building height and volume: footprints, lots and block size. */
  scale: number;
  /** Wealth and build quality: glass and screens over raw concrete, upkeep, lit windows, greenery. */
  budget: number;
  /** Dirt, damage and dereliction: grime, ruins, boarded windows, dead signs and lamps. */
  decay: number;
  /** Packing: street spacing, lot size, clutter. */
  density: number;
  /** Signage: how many signs and how bright. */
  neon: number;
}

export const TUNE_KEYS: readonly (keyof DistrictTune)[] = ['scale', 'budget', 'decay', 'density', 'neon'];

/**
 * Land use: a second, nested zoning layer inside each district. The district sets
 * style, culture and wealth; the use sets the building programme (shopfronts or
 * front doors, offices or flats, how much signage, what clutter, what light).
 */
export type LandUse = 'residential' | 'commercial' | 'nightlife' | 'industrial' | 'civic' | 'green';

export const LAND_USES: readonly LandUse[] = ['residential', 'commercial', 'nightlife', 'industrial', 'civic', 'green'];

/**
 * What kind of city: a coastal city of a few million, or the hive, a city-planet whose
 * towers are kilometres tall, packed shoulder to shoulder over canyons with no ground
 * in sight and no edge.
 */
export type World = 'city' | 'hive';

export interface Dials {
  /** The coastal city or the hive (kilometre-scale towers, no coast, no edge). */
  world: World;
  /** Entropism: dirt, decay, clutter, dead lights. -1..1 */
  grime: number;
  /** Neomilitarism: monolithic, angular, matte, cold light. -1..1 */
  edge: number;
  /** Kitsch: neon density, saturated colour, screens. -1..1 */
  flash: number;
  /** Neokitsch: gold, stone, curves, gardens, warm light. -1..1 */
  luxury: number;
  /** Western (-1) to East Asian (+1) signage and clutter. */
  east: number;
  /** Within East Asian: Japanese (-1) to Chinese (+1). */
  jpcn: number;
  /** Building and lot density multiplier, 0.6..1.4. */
  density: number;
  /** Building height multiplier, 0.5..1.8. */
  height: number;
  /** City extent in km, 1.6..3.6. */
  size: number;
  /** Megastructures and alien massing (pyramids, cantilevers, twisted towers, spans), 0..1. */
  alien: number;
  /** Relative share of each district kind, 0..2 (1 = default). */
  mix: Record<DistrictKind, number>;
  /** Per-district-kind scalars (see DistrictTune). */
  tune: Record<DistrictKind, DistrictTune>;
  /** Relative share of each land use across all districts, 0..2 (1 = default). */
  uses: Record<LandUse, number>;
}

/** Dials as callers write them: anything left out takes its default. */
export type DialsInput = Partial<Omit<Dials, 'mix' | 'tune' | 'uses'>> & {
  mix?: Partial<Record<DistrictKind, number>>;
  tune?: Partial<Record<DistrictKind, Partial<DistrictTune>>>;
  uses?: Partial<Record<LandUse, number>>;
};

export interface CityOptions {
  seed?: string | number;
  dials?: DialsInput;
}

/** Resolved style of one place (district centre, lot, building). All 0..1. */
export interface Style {
  grime: number;
  edge: number;
  flash: number;
  luxury: number;
  /** Culture weights, sum to 1. */
  us: number;
  jp: number;
  cn: number;
}

export interface District {
  id: number;
  kind: DistrictKind;
  /** Site point the district grew from. */
  x: number;
  z: number;
  /** Superblock cells (indices into spec.superblocks). */
  cells: number[];
  /** Resolved style at the district core (base profile + dials). */
  style: Style;
  /** The district kind's tuning scalars. */
  tune: DistrictTune;
  /** Light palette, linear RGB, HDR-normalised to peak 1. */
  palette: RGB[];
  fog: { density: number; tint: RGB };
  name: string;
}

// -------------------------------------------------------------------- streets

export type StreetKind = 'highway' | 'arterial' | 'local' | 'alley';

export interface Street {
  id: number;
  /** Stable identity (survives edits elsewhere in the city; seeds its random streams). */
  key: string;
  axis: 'x' | 'z';
  /** Centre-line coordinate on the perpendicular axis. */
  pos: number;
  /** Extent along the axis. */
  lo: number;
  hi: number;
  kind: StreetKind;
  /** Roadway width. */
  road: number;
  /** Sidewalk width per side (0 for alleys). */
  walk: number;
  /** District that owns it (local streets), or -1 for arterials. */
  district: number;
  /** Set on a district's nightlife strip. */
  use?: LandUse;
}

/** A piece of asphalt between junctions, or a junction square. */
export interface RoadPiece {
  rect: Rect;
  /** 'x'/'z' for a segment running along that axis, 'j' for a junction. */
  axis: 'x' | 'z' | 'j';
  kind: StreetKind;
  streetId: number;
  /** Number of lanes per direction (for markings). */
  lanes: number;
}

export interface Superblock {
  id: number;
  /** Interior rect between arterial road edges. */
  rect: Rect;
  /** Grid indices. */
  i: number;
  j: number;
  district: number;
  /** Land (true) or water (false); coastal cells are partly land. */
  land: boolean;
  /** A whole superblock given to one megastructure (no local streets inside). */
  landmark?: Landmark;
}

/** Megastructures that take a whole superblock. */
export type Landmark = 'pyramid';

export interface Block {
  id: number;
  /** Stable identity: superblock, plate cell and part. */
  key: string;
  /** Buildable area (inside the sidewalks). */
  rect: Rect;
  /** Raised plate including the sidewalks, bounded by road edges. */
  plate: Rect;
  /** Sidewalk width on each side: [-x, +x, -z, +z]. */
  walk: [number, number, number, number];
  district: number;
  superblock: number;
  /** Plaza, park, yard or rubble instead of buildings. */
  open: 'none' | 'plaza' | 'park' | 'yard' | 'rubble';
  /** Land use (set by the land-use pass). */
  use: LandUse;
  /** Set when the block is a whole landmark superblock. */
  landmark?: Landmark;
}

export interface Lot {
  id: number;
  /** Stable identity: block key and lot index. */
  key: string;
  block: number;
  rect: Rect;
  district: number;
  use: LandUse;
  landmark?: Landmark;
  /** A whole (or half) block kept for a megastructure. */
  mega?: boolean;
  /** Which sides face a street: [-x, +x, -z, +z]. */
  front: [boolean, boolean, boolean, boolean];
}

// ------------------------------------------------------------------ buildings

export type Archetype =
  | 'tower'
  | 'monolith'
  | 'needle'
  | 'podium'
  | 'shophouse'
  | 'midrise'
  | 'megablock'
  | 'shed'
  | 'tankfarm'
  | 'ruin'
  | 'shack'
  | 'villa'
  | 'spire'
  | 'arcology'
  // megastructures and alien massing
  | 'pyramid'
  | 'ziggurat'
  | 'taper'
  | 'cantilever'
  | 'twist'
  | 'disc'
  | 'flare'
  | 'arch'
  | 'stilts'
  // shaped towers (core/forms.ts): lathed, faceted, twisted, leaning, accreted
  | 'egg'
  | 'prism'
  | 'helix'
  | 'lean'
  | 'stack'
  | 'bundle'
  | 'skyship'
  | 'hulk';

/**
 * Structure drawn over a facade: a diagrid of diagonal members, vertical ribs,
 * horizontal spandrel bands, or a megaframe of giant cross braces.
 */
export type Skin = 'diagrid' | 'ribs' | 'bands' | 'frame';

/** Facade material families; the renderer maps each to a shader branch. */
export type FacadeStyle = 'glass' | 'panel' | 'grid' | 'shop' | 'balcony' | 'metal' | 'raw' | 'lux';

export const FACADE_STYLES: readonly FacadeStyle[] = ['glass', 'panel', 'grid', 'shop', 'balcony', 'metal', 'raw', 'lux'];

export type RoofKind = 'flat' | 'helipad' | 'garden' | 'sawtooth' | 'pagoda' | 'crown' | 'open' | 'dome';

export interface Facade {
  style: FacadeStyle;
  /** Storey height. */
  floorH: number;
  /** Window bay width. */
  bayW: number;
  /** Fraction of a bay that is glazing, 0..1. */
  win: number;
  /** Fraction of windows lit at night. */
  lit: number;
  /** Window light colour temperature, 0 cool .. 1 warm. */
  warm: number;
  /** Wall base colour, linear RGB. */
  base: RGB;
  /** Accent light colour for strips and trims, linear RGB (HDR). */
  accent: RGB;
  /** Emissive edge/floor strip amount 0..1. */
  strips: number;
  grime: number;
  seed: number;
  /** LED media facade: static outline lines, or part of the city-wide light show (see core/media.ts). */
  media?: MediaKind;
}

export type MediaKind = 'outline' | 'show';

export interface Tier {
  poly: Vec2[];
  y0: number;
  y1: number;
  facade: Facade;
  roof: RoofKind;
  /** Bottom tier standing on the ground (gets shops and a collider). */
  grounded: boolean;
  /** Edge indices with a ground-floor storefront band. */
  shopEdges: number[];
  /** Height of the storefront band, if any. */
  shopH: number;
  /** Polygon at y1 for a tapered (or flared) tier: same vertex count and order as `poly`. */
  top?: Vec2[];
  /** Draw the underside: the tier overhangs what is below it (cantilevers, discs, stilts). */
  under?: boolean;
  /**
   * The tier carries on into the one above as one surface (a lathed or twisted shell):
   * no roof, parapet or crown light at its top.
   */
  seam?: boolean;
  /** The walls are facets of one curved surface: shaded smooth, windows run on round it. */
  smooth?: boolean;
  /** Structure drawn over the facade. */
  skin?: Skin;
}

export interface Building {
  id: number;
  lot: number;
  district: number;
  kind: DistrictKind;
  archetype: Archetype;
  use: LandUse;
  rect: Rect;
  height: number;
  tiers: Tier[];
  style: Style;
  /** Dominant culture for signage. */
  culture: Culture;
  /** Building light palette (subset of the district palette). */
  palette: RGB[];
  seed: number;
}

// --------------------------------------------------------------------- signs

export type SignKind =
  | 'fascia'
  | 'blade'
  | 'frame'
  | 'banner'
  | 'billboard'
  | 'roof'
  | 'marquee'
  | 'holo'
  | 'logo'
  | 'lanterns'
  | 'screen';

export interface SignSpec {
  kind: SignKind;
  culture: Culture;
  /** Centre of the sign panel. */
  x: number;
  y: number;
  z: number;
  /** Unit horizontal normal of the front face. */
  nx: number;
  nz: number;
  /** Unit horizontal outward normal of the wall it is mounted on. */
  wnx: number;
  wnz: number;
  w: number;
  h: number;
  depth: number;
  /** Distance from the wall to the panel centre (projecting signs). */
  arm: number;
  /** Latin text, may be empty. */
  text: string;
  /** Seeds for invented glyphs (kana-like for jp, block glyphs for cn), may be empty. */
  glyphs: number[];
  vertical: boolean;
  col: RGB;
  col2: RGB;
  /** HDR multiplier. */
  intensity: number;
  /** 0 steady, 1 buzz, 2 broken letters, 3 dead. */
  flicker: 0 | 1 | 2 | 3;
  /** Backlit panel with dark letters instead of neon letters on a dark panel. */
  lightbox: boolean;
  frame: boolean;
  twoSided: boolean;
  seed: number;
  /**
   * Screens and holograms: what plays on them. Screens: 0 street ads, 1 a
   * building-sized ad wall (posters of big glyphs, a koi pond, a product spin).
   * Holograms: 0 emblem, 1 a column of glyphs.
   */
  program?: number;
}

// --------------------------------------------------------- kits and dressing

/** Instanced kit pieces generated in code. */
export type KitKind =
  | 'ac'
  | 'dish'
  | 'antenna'
  | 'tank'
  | 'vent'
  | 'fan'
  | 'pipeV'
  | 'pipeH'
  | 'duct'
  | 'box'
  | 'container'
  | 'stack'
  | 'lamp'
  | 'tree'
  | 'laundry'
  | 'cage'
  | 'barrel'
  | 'planter'
  | 'pylon'
  | 'beacon'
  // bolted-on detail (core/greebles.ts)
  | 'module'
  | 'pod'
  | 'truss'
  | 'shaft';

export interface KitInstance {
  kind: KitKind;
  x: number;
  y: number;
  z: number;
  /** Rotation about Y. */
  rot: number;
  sx: number;
  sy: number;
  sz: number;
  /** Albedo (or emissive colour) and emissive gain. */
  col: RGB;
  emit: number;
  seed: number;
}

/**
 * Larger one-off structures built as merged geometry. Parameters by kind:
 *  crane    [x, z, rot, height, boom]
 *  bridge   [x0, y, z0, x1, y, z1, width, height]
 *  scaffold [ax, az, bx, bz, y0, y1, depth]
 *  frame    [x0, z0, x1, z1, y0, y1, floorH]    open concrete frame (unfinished floors)
 *  sawtooth [x0, z0, x1, z1, y, tooth, axis]
 *  pool     [x0, z0, x1, z1, y]
 *  dock     [x0, z0, x1, z1, y]
 *  wires    [x0, y0, z0, x1, y1, z1, sag, count]
 *  cables   [x0, y0, z0, x1, y1, z1, sag, lanterns]
 *  awning   [ax, az, bx, bz, y, depth]
 */
export type StructureKind = 'crane' | 'bridge' | 'scaffold' | 'frame' | 'sawtooth' | 'pool' | 'pond' | 'dock' | 'wires' | 'cables' | 'awning' | 'laundry';

export interface Structure {
  kind: StructureKind;
  /** Parameters; meaning depends on kind (see StructureKind). */
  p: number[];
  col: RGB;
  col2: RGB;
  seed: number;
}

/**
 * What an emitter stands for. Signs, street lamps, fires and festoon strings are also
 * drawn as local lights by the renderer (signs from their SignSpec); the rest (window
 * glow, crowns, soffits, beacons...) only feed the baked light volume.
 */
export type EmitterSrc = 'sign' | 'lamp' | 'fire' | 'festoon' | 'window';

/** A coloured light source used to bake the light volume and ground light map. */
export interface Emitter {
  x: number;
  y: number;
  z: number;
  /** Linear RGB times intensity. */
  r: number;
  g: number;
  b: number;
  /** Influence radius in metres. */
  radius: number;
  /** What it stands for; untagged emitters only feed the baked light. */
  src?: EmitterSrc;
}

export interface SteamVent {
  x: number;
  z: number;
  h: number;
  seed: number;
}

// ------------------------------------------------------------------- traffic

export interface AirLane {
  /** Polyline points (x, y, z); cars loop along it. */
  pts: Vec3[];
  speed: number;
  count: number;
  /** Lane direction: +1 runs the polyline forward, -1 backward. */
  dir: number;
  col: RGB;
  seed: number;
}

export interface Highway {
  axis: 'x' | 'z';
  pos: number;
  lo: number;
  hi: number;
  y: number;
  width: number;
  /** Pillar spacing. */
  span: number;
}

// --------------------------------------------------------------- collisions

/** Axis-aligned box used by the flight collision and the camera arm. */
export interface Box3 {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

// ---------------------------------------------------------------------- city

import type { OutskirtBuilding, OutskirtGrid } from './outskirts';
import type { Transit } from './transit';

// ------------------------------------------------------------------ spectacle

/** Giant hologram species (all original designs). */
export type HoloKind = 'koi' | 'jelly' | 'serpent' | 'manta';

/**
 * A building-sized hologram on a slow circuit. Swimmers follow a circle of
 * `radius` around (x, z) at height y, head first; jellyfish drift on a small one.
 */
export interface GiantHolo {
  kind: HoloKind;
  x: number;
  y: number;
  z: number;
  radius: number;
  /** Speed along the circuit in m/s (sign is the direction). */
  speed: number;
  /** Body length (swimmers) or bell diameter (jellyfish), metres. */
  size: number;
  /** Vertical bob amplitude, metres. */
  bob: number;
  col: RGB;
  col2: RGB;
  phase: number;
  district: number;
}

/** A column of light standing on a crown, up into the cloud. */
export interface LightPillar {
  x: number;
  z: number;
  /** Base height (the roof it stands on). */
  y0: number;
  radius: number;
  col: RGB;
  intensity: number;
  seed: number;
}

export interface Spectacle {
  holos: GiantHolo[];
  pillars: LightPillar[];
}

// ------------------------------------------------------------------ flyers

/** Big and official traffic: ad airships, police patrols, medevac flyers, cargo haulers. */
export type FlyerKind = 'blimp' | 'police' | 'medevac' | 'hauler';

export interface FlyerRoute {
  kind: FlyerKind;
  /** A closed loop: the last point joins the first. */
  pts: Vec3[];
  /** m/s along the loop. */
  speed: number;
  /** Craft spread evenly along the loop. */
  count: number;
  seed: number;
}

/** A police scene: units hover in a slow ring over a street, searchlights on one spot. */
export interface Incident {
  x: number;
  z: number;
  /** Hover height of the ring. */
  y: number;
  radius: number;
  units: number;
  seed: number;
}

export interface Flyers {
  routes: FlyerRoute[];
  incidents: Incident[];
}

export interface CitySpec {
  version: 1;
  seed: string;
  dials: Dials;
  /** Land extent (the sea extends beyond on the coast side). */
  bounds: Rect;
  /** Coastline: z coordinate of the shore as samples along x (sea is z > shore). */
  coast: { x0: number; step: number; z: number[] };
  districts: District[];
  superblocks: Superblock[];
  streets: Street[];
  roads: RoadPiece[];
  blocks: Block[];
  lots: Lot[];
  buildings: Building[];
  signs: SignSpec[];
  kits: KitInstance[];
  structures: Structure[];
  emitters: Emitter[];
  steam: SteamVent[];
  lanes: AirLane[];
  highways: Highway[];
  boxes: Box3[];
  /** Plain blocks beyond the city limits that carry the sprawl to the horizon. */
  outskirts: OutskirtBuilding[];
  /** The sprawl's street grid (lamps and traffic run along it). */
  outskirtsGrid: OutskirtGrid;
  /** Elevated metro and subway entrances. */
  transit: Transit;
  /** Giant holograms and light pillars. */
  spectacle: Spectacle;
  /** Airships, police, medevac and cargo flyers. */
  flyers: Flyers;
  /** Suggested start pose for the flight. */
  spawn: { x: number; y: number; z: number; yaw: number };
  stats: { buildings: number; tiers: number; signs: number; kits: number; emitters: number; ms: number; stages: Record<string, number> };
}
