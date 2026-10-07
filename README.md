# Neon Sprawl

A procedurally generated cyberpunk city you fly through in a hover car. Everything is made from code and
shaders: no meshes, textures or other assets are loaded. Three.js r186 runs it with the WebGPU renderer
(WebGL2 fallback) and TSL node materials.

Over the street grid sit megastructures (whole-block pyramids, ziggurats, cantilevered stacks, twisting
towers, sky discs, arches, slabs on stilts, skybridges), building-sized holograms (a koi ringing the
landmark pyramid, serpents, jellyfish, mantas), columns of light on the tallest crowns, building-sized
ad walls, and the official traffic: ad airships, police patrols, medevac flyers and cargo haulers.

The city is built the way Unreal's PCG / City Sample builds one: a **zone graph** decides where each
district goes, and each district's **attribute table** drives everything downstream. That covers street
grids, lots, building archetypes, facades, signage, clutter, light, fog and the sky glow. A second,
nested layer of **land use** varies the blocks inside each district. Global **style dials** bias the whole
city, and **per-district scalars** bias one district kind.

## Run it

```bash
npm install
npm run dev            # http://localhost:5173
npm test               # generator, megastructures, holograms, flyer routes, collision, flight
npm run artifact       # one self-contained HTML file in dist-artifact/
```

Chrome or Edge 113+ (WebGPU) gives the full look. Firefox and Safari use the WebGL2 path, which is the
same city with screen-space reflections off by default.

## Controls

| Input | Action |
| --- | --- |
| Mouse | steer (click to capture the pointer; drag works too) |
| W / S | thrust / brake |
| A / D | strafe |
| Space or E / C or Q | climb / dive |
| Shift | boost |
| F | guided flight (a tour along the avenues) |
| 1–7 | jump to a district |
| T · G · M · H | rain · zoning deck · map · HUD |
| R | back to the start |
| Wheel | camera distance |
| Map click | fly there. Click the legend to switch the map between districts and land use. |

## The districts

| Kind | Name | Character |
| --- | --- | --- |
| corporate | Corporate Core | glass and panel towers, crowns and logos, plazas, searchlights, cool light |
| jpmarket | Lantern Market | 2–8 floor shophouses, vertical sign stacks, wires, festoon bulbs, magenta haze |
| cnmarket | Red Gate Market | dense midrises, projecting framed signs, window cages, red lanterns |
| megablock | Megablocks | slab housing with skybridges and screens, teal smog |
| industrial | Harbor Works | sawtooth sheds, tank farms, stacks, container yards, cranes, sodium haze |
| decayed | Ash Flats | ruins and bare frames, shacks, rubble lots, barrel fires, dusty air |
| luxury | Gilded Shore | villas with roof gardens and pools, spires, parks, warm light |

Each district carries its own fog tint and density, and the sky glow over the camera blends the palettes
of the districts around it. The haze gets darker with distance, not brighter: far away you see the
city's lights, not a lit fog.

## Megastructures

The **Alien** dial (City section) sets how much of the city is megastructure. Whole blocks (and at alien ≥ 0.2
a whole superblock for the landmark) are kept as single lots and given to one of nine grammars:

| Archetype | Shape |
| --- | --- |
| pyramid | stepped glass pyramid with terraces and an apex lantern; the landmark is 350–620 m |
| ziggurat | arcology with battered (sloped) walls and garden terraces over a plumb shop storey |
| taper | obelisk on a podium |
| cantilever | boxes shoved off-centre, each overhanging the one below with a lit underside |
| twist | square floor plates each turned a few degrees from the last |
| disc | a slim core holding one or two sky discs with lit undersides |
| flare | a stalk flaring into a wide head |
| arch | two legs bridged by a mass across the top |
| stilts | a slab lifted on pylons over a glass lobby |

Skybridges join tall neighbours across local streets. Sloped walls keep their windows and corner light
lines on the slope; overhangs get soffits with downlights.

## Spectacle and traffic

- **Giant holograms**: building-sized koi, serpents, jellyfish and mantas on slow circuits fitted to the
  skyline, animated entirely in the vertex shader (a swimming wave, fins, pulsing bells, tentacles).
- **Light pillars** on the three tallest crowns and the landmark apex.
- **Ad walls**: building-sized LED screens high on tall towers playing posters of huge invented glyphs,
  a koi pond and a product spin; projected glyph holograms over rooftops in the markets and on the strips.
- **Flyers**: ad airships with LED flanks and floodlights over the skyline, police units with red and blue
  light bars patrolling the arterials and ringing street incidents with searchlights, teal and white medevac
  flyers, and cargo haulers on the low bands.

## Dials

**Style** (whole city; each axis is one of the genre's visual eras, see `docs/ART_BIBLE.md`)

- *Grime*: pristine ↔ rotting (dirt, dead lights, clutter)
- *Edge*: soft ↔ monolithic (matte slabs, cold light)
- *Flash*: dim ↔ neon kitsch (sign density, screens, saturated colour)
- *Luxury*: cheap ↔ gilded (gold, stone, gardens, warm light)

**Culture**: Western ↔ East Asian signage and clutter, and Japanese ↔ Chinese within that.

**City**: density, height, size (km), alien (familiar ↔ megastructures).

**District mix**: how much of the city each district kind takes.

**District tuning**: pick a district kind and set its own scalars (−1…1):

- *Scale*: building height and volume (footprints, lots, blocks)
- *Budget*: wealth and build quality (glass and screens or raw concrete, upkeep, lit windows, greenery)
- *Decay*: dirt, damage and dereliction (ruins and shacks appear, dead signs and lamps, rubble lots)
- *Density*: how packed (street spacing, lot size, clutter)
- *Neon*: how many signs and how bright

**Land use**: the share of homes, commerce, nightlife, industry, civic and green across all districts.

**Atmosphere (live, no rebuild)**: haze, rain, neon, traffic, exposure. **Quality**: low, medium, high, ultra
(high and ultra add screen-space reflections). A governor steps quality down if the frame rate stays low.

Presets: Default, Boom town, Fallen glory, Night strip, Vertical slum, Rain market, Walled city, Corporate,
Rust belt, Gilded coast.

## URL parameters

`seed`, `preset` (e.g. `night-strip`), `size`, `alien`, `q` (`low|medium|high|ultra`), `gl` (force WebGL2),
`ssr` / `nossr`, `auto` (start in guided flight), `fog`, `rain`, `neon`, `exposure`, `dry`, `tm=agx`, and for
screenshots and debugging: `still`, `nohud`, `notaa`, `debug=fog|depth`, `hdbg=tmax|zone|light`,
`hide=name,prefix*`, `holot` (freeze the holograms at a clock time), `screen=N` (force every LED screen to one
scene), `lightgain` (scale the baked city light).

## How it is built

```
generateCity(seed, dials)                      src/core (pure, deterministic, tested)
  zoning      arterial grid, coast, district sites grown over the superblock graph, border blending
  streets     per-district local grids and alleys, junctions, block plates
  land use    nested zones: noise patches by share, one nightlife strip per district, civic and parks
  lots        recursive splits sized by district and tuning; whole blocks kept for megastructures
  massing     23 archetype grammars -> convex tiers (sloped tiers carry a top polygon, overhangs a soffit)
  skybridges  enclosed bridges between tall neighbours across local streets
  dressing    signs by culture and use, ad walls, rooftop holograms, AC units, laundry, lamps, emitters
  spectacle   giant hologram circuits fitted to the skyline, light pillars
  transit     elevated metro loop with stations, subway kiosks
  traffic     air lanes and highway decks; airship, police, medevac and hauler routes, police incidents
  outskirts   a ring of plain blocks to the horizon
  collision   boxes for the flight
        |
        v  CitySpec (plain JSON)
buildCityRender(spec)                          src/render
  merged geometry per 480 m chunk and material, instanced kits, signs as glyph quads and SDF tubes,
  a baked light atlas (32 height layers) + ground light map + district zone map,
  one facade shader (parallax windows into raymarched rooms, LOD to averages, sloped walls), wet ground,
  vertex-animated holograms and light pillars, instanced flyers and searchlight cones,
  post: volumetric haze (raymarched, district-tinted, analytic far tail), screen-space reflections,
  neon glow layer, TRAA, bloom, grade, chromatic edge, vignette, grain
```

## PCG in one paragraph

"PCG" (procedural content generation) is the common name in games, and Unreal's framework is literally
called PCG. The pattern used here is the one its city tools use. A coarse **zone graph** (here, superblocks
grown from district seeds) carries **attribute sets**. Every later stage reads those attributes instead of
hard-coding a look: street spacing, lot frontage, archetype weights, sign density, palettes, fog. Each stage
also samples with a seeded random stream keyed by a stable identity (a block's or lot's key), so changing
one district does not reshuffle the rest of the city.

## License

MIT. See `LICENSE` and `THIRD_PARTY.md`.
